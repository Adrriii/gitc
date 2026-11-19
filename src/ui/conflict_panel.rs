use eframe::egui::text::{LayoutJob, TextFormat, TextWrapping};
use eframe::egui::{
    Align2, Color32, FontId, Id, Rect, RichText, ScrollArea, Sense, Stroke, Ui, UiBuilder, Vec2, pos2, vec2,
};

use super::merge_editor::{Look, button, button_at, label};
use super::theme::Palette;
use super::{App, actions, icons};
use crate::engine::api::Request;
use crate::engine::types::{ConflictFile, ConflictState, OpArgs};

const HEAD: f32 = 34.0;
const SECTION: f32 = 30.0;
const FILE_ROW: f32 = 70.0;
const RESOLVED_ROW: f32 = 24.0;

#[derive(Default)]
pub struct State {
    error: Option<String>,
    working: bool,
}

enum Intent {
    Open(String),
    Side(String, &'static str),
    All,
    Op(&'static str),
}

struct Labels {
    ours: String,
    theirs: String,
}

pub fn show(app: &mut App, ui: &mut Ui) {
    let Some(id) = app.active_id() else { return };
    let p = app.palette;
    let Some(repo) = app.repos.get(&id) else { return };
    let Some(state) = repo.conflicts.as_ref() else { return };
    let disabled = repo.busy || repo.conflict.working;
    let open = if repo.merge_file.is_some() {
        repo.merge_file.as_deref()
    } else {
        repo.open_file.as_ref().map(|f| f.path.as_str())
    };
    let intent = draw(ui, state, &repo.conflict, open, disabled, &p);
    let Some(intent) = intent else { return };
    let operation = state.operation.clone();
    let all: Vec<String> = state.conflicted.iter().map(|f| f.path.clone()).collect();
    match intent {
        Intent::Open(path) => {
            let Some(repo) = app.repos.get_mut(&id) else { return };
            if repo.merge_file.as_deref() != Some(path.as_str()) {
                repo.merge = Default::default();
                repo.merge_file = Some(path);
            }
            repo.open_file = None;
        }
        Intent::Side(path, side) => resolve(app, &id, path, side.to_string(), Vec::new()),
        Intent::All => resolve(app, &id, String::new(), String::new(), all),
        Intent::Op(op) => actions::run_op(app, OpArgs { op: op.to_string(), r#ref: operation, ..Default::default() }),
    }
}

fn resolve(app: &mut App, id: &str, path: String, side: String, paths: Vec<String>) {
    let Some(repo) = app.repos.get_mut(id) else { return };
    repo.conflict.working = true;
    repo.conflict.error = None;
    let tab = id.to_string();
    let req = Request::Resolve { id: id.to_string(), path, side, content: String::new(), paths };
    app.jobs.request(req, move |app, result: Result<ConflictState, String>| {
        let Some(repo) = app.repos.get_mut(&tab) else { return };
        repo.conflict.working = false;
        match result {
            Ok(state) => {
                let still = repo.merge_file.as_ref().is_some_and(|m| state.conflicted.iter().any(|f| &f.path == m));
                if !still {
                    repo.merge_file = None;
                }
                repo.conflicts = Some(state);
                repo.refresh();
            }
            Err(e) => repo.conflict.error = Some(e),
        }
    });
}

fn draw(
    ui: &mut Ui,
    state: &ConflictState,
    st: &State,
    open: Option<&str>,
    disabled: bool,
    p: &Palette,
) -> Option<Intent> {
    let mut intent = None;
    let labels = Labels::of(state);
    let bare = state.operation == "unmerged";
    let full = ui.available_rect_before_wrap();
    ui.allocate_rect(full, Sense::hover());
    let painter = ui.painter().clone();

    let head = Rect::from_min_size(full.min, vec2(full.width(), HEAD));
    painter.rect_filled(head, 0.0, p.amber_bg);
    icons::paint(
        ui,
        Rect::from_center_size(pos2(head.left() + 19.0, head.center().y), Vec2::splat(14.0)),
        "warning",
        p.amber,
    );
    let title = if bare {
        "Conflicts to resolve".to_string()
    } else {
        format!("{} conflicts detected", capitalize(&state.operation))
    };
    painter.text(
        pos2(head.left() + 34.0, head.center().y),
        Align2::LEFT_CENTER,
        title,
        FontId::proportional(12.0),
        p.amber_fg,
    );

    let mut flow = ui.new_child(
        UiBuilder::new()
            .id_salt("conflict_flow")
            .max_rect(Rect::from_min_max(pos2(full.left(), head.bottom()), full.max)),
    );
    flow.spacing_mut().item_spacing = Vec2::ZERO;
    let width = full.width();
    let subject = |ui: &mut Ui, add: &mut dyn FnMut(&mut Ui)| {
        let frame = eframe::egui::Frame::new().inner_margin(eframe::egui::Margin::symmetric(12, 10));
        frame.show(ui, |ui| {
            ui.set_width(width - 24.0);
            ui.spacing_mut().item_spacing = vec2(4.0, 4.0);
            add(ui);
        });
        let y = ui.min_rect().bottom();
        ui.painter().hline(full.x_range(), y - 0.5, Stroke::new(1.0, p.line));
    };
    if bare {
        subject(&mut flow, &mut |ui| {
            ui.label(
                RichText::new("Your changes were restored onto this branch and clashed with it. Resolve the files below; there is no operation to finish.")
                    .size(12.0)
                    .color(p.fg_dim),
            );
            if state.stashes > 0 {
                let entries = if state.stashes > 1 { format!(" ({} entries)", state.stashes) } else { String::new() };
                ui.label(
                    RichText::new(format!("A copy is still held in the stash{entries} until you drop it."))
                        .size(11.0)
                        .color(p.fg_muted),
                );
            }
        });
    }
    if let Some(progress) = state.progress.as_ref().filter(|_| state.operation == "rebase") {
        let onto = if progress.onto_name.is_empty() { progress.onto.clone() } else { progress.onto_name.clone() };
        subject(&mut flow, &mut |ui| {
            ui.horizontal_wrapped(|ui| {
                ui.label(RichText::new("Rebasing").size(12.0).color(p.fg_dim));
                chip(ui, &progress.branch, p);
                ui.label(RichText::new("onto").size(12.0).color(p.fg_dim));
                chip(ui, &onto, p);
            });
        });
    }
    if let Some(error) = st.error.as_deref() {
        eframe::egui::Frame::new().outer_margin(eframe::egui::Margin::symmetric(12, 8)).show(&mut flow, |ui| {
            eframe::egui::Frame::new()
                .fill(p.red_bg)
                .stroke(Stroke::new(1.0, p.red_line))
                .corner_radius(3.0)
                .inner_margin(eframe::egui::Margin::symmetric(9, 6))
                .show(ui, |ui| {
                    ui.set_width(width - 42.0);
                    ui.label(RichText::new(error).size(11.0).color(p.red_fg));
                });
        });
    }

    let footer_h = footer_height(state, bare);
    let lists_top = flow.min_rect().bottom().max(head.bottom());
    let footer = Rect::from_min_max(pos2(full.left(), (full.bottom() - footer_h).max(lists_top)), full.max);
    let room = (footer.top() - lists_top - SECTION * 2.0).max(0.0);
    let main_h = (room * 2.0 / 3.0).floor();

    let mut y = lists_top;
    let section = Rect::from_min_size(pos2(full.left(), y), vec2(width, SECTION));
    section_head(ui, section, &format!("Conflicted Files ({})", state.conflicted.len()), p);
    if !state.conflicted.is_empty() {
        let look = if disabled {
            Look::new(Color32::TRANSPARENT, p.line, p.fg_faint)
        } else {
            Look::new(Color32::TRANSPARENT, p.amber, p.amber_fg).hover(p.amber.gamma_multiply(0.16), p.amber_fg)
        };
        let text = "Mark All Resolved";
        let w = label(ui, text, 11.0, f32::INFINITY, p.fg).size().x + 14.0;
        let at = pos2(section.right() - 12.0 - w, section.top() + 19.0);
        let clicked = button_at(ui, Id::unique("conflict_mark_all"), at, 20.0, text, 11.0, look, p)
            .on_hover_text("Stage every conflicted file as it currently stands on disk")
            .clicked();
        if clicked && !disabled {
            intent = Some(Intent::All);
        }
    }
    y = section.bottom();
    let main = Rect::from_min_size(pos2(full.left(), y), vec2(width, main_h));
    list(ui, main, "conflict_list", state.conflicted.len(), FILE_ROW, |ui, i, rect| {
        let Some(file) = state.conflicted.get(i) else { return };
        if let Some(chosen) = file_row(ui, rect, file, &labels, open, disabled, p) {
            intent = Some(chosen);
        }
    });
    if state.conflicted.is_empty() {
        let text = format!("Everything resolved: continue the {}.", state.operation);
        let text = if bare { "Everything resolved.".to_string() } else { text };
        painter.text(
            pos2(main.left() + 12.0, main.top() + 4.0),
            Align2::LEFT_TOP,
            text,
            FontId::proportional(11.0),
            p.fg_faint,
        );
    }
    y = main.bottom();

    let section = Rect::from_min_size(pos2(full.left(), y), vec2(width, SECTION));
    section_head(ui, section, &format!("Resolved Files ({})", state.resolved.len()), p);
    let rest = Rect::from_min_max(pos2(full.left(), section.bottom()), pos2(full.right(), footer.top()));
    list(ui, rest, "resolved_list", state.resolved.len(), RESOLVED_ROW, |ui, i, rect| {
        let Some(file) = state.resolved.get(i) else { return };
        let response = ui.interact(rect, Id::unique(("resolved_row", i)), Sense::hover());
        if response.hovered() {
            ui.painter().rect_filled(rect, 0.0, p.bg_3);
        }
        icons::paint(
            ui,
            Rect::from_center_size(pos2(rect.left() + 18.0, rect.center().y), Vec2::splat(12.0)),
            "check",
            p.green,
        );
        let undo_w = if response.hovered() { 50.0 } else { 0.0 };
        let name = file_name(ui, &file.path, rect.width() - 31.0 - 12.0 - undo_w, p);
        ui.painter().galley(pos2(rect.left() + 31.0, rect.center().y - name.size().y / 2.0), name, p.fg);
        if response.hovered() && !disabled {
            let look = Look::new(Color32::TRANSPARENT, p.line, p.fg_muted).hover(p.bg_4, p.fg);
            let undo = button_at(
                ui,
                Id::unique(("resolved_undo", i)),
                pos2(rect.right() - 12.0 - 42.0, rect.center().y),
                18.0,
                "Undo",
                10.0,
                look,
                p,
            );
            if undo.on_hover_text("Put this file back into conflict").clicked() {
                intent = Some(Intent::Side(file.path.clone(), "unresolve"));
            }
        }
    });
    if state.resolved.is_empty() {
        painter.text(
            pos2(rest.left() + 12.0, rest.top() + 4.0),
            Align2::LEFT_TOP,
            "Nothing resolved yet",
            FontId::proportional(11.0),
            p.fg_faint,
        );
    }

    if let Some(op) = footer_ui(ui, footer, state, bare, disabled, p) {
        intent = Some(op);
    }
    intent
}

fn file_row(
    ui: &Ui,
    rect: Rect,
    file: &ConflictFile,
    labels: &Labels,
    open: Option<&str>,
    disabled: bool,
    p: &Palette,
) -> Option<Intent> {
    let mut intent = None;
    let painter = ui.painter();
    let row = ui.interact(
        rect,
        Id::unique(("conflict_row", &file.path)),
        if file.deletion { Sense::hover() } else { Sense::click() },
    );
    let active = open == Some(file.path.as_str());
    if active {
        painter.rect_filled(rect, 0.0, p.accent_bg);
    } else if row.hovered() {
        painter.rect_filled(rect, 0.0, p.bg_3);
    }
    painter.hline(rect.x_range(), rect.bottom() - 0.5, Stroke::new(1.0, p.bg_2));
    let left = rect.left() + 12.0;
    icons::paint(
        ui,
        Rect::from_center_size(pos2(left + 6.0, rect.top() + 14.0), Vec2::splat(12.0)),
        "warning",
        p.amber,
    );
    let name = file_name(ui, &file.path, rect.width() - 31.0 - 12.0, p);
    painter.galley(pos2(left + 19.0, rect.top() + 14.0 - name.size().y / 2.0), name, p.fg);
    let why = label(ui, &describe(file, labels), 11.0, rect.width() - 31.0 - 12.0, p.fg_muted);
    painter.galley(pos2(left + 19.0, rect.top() + 24.0), why, p.fg_muted);

    let look = Look::new(p.bg_3, p.line, p.fg_dim).hover(p.bg_4, p.fg);
    let off = Look::new(p.bg_2, p.line, p.fg_faint);
    let buttons: [(String, &'static str, String); 2] = if file.deletion {
        let keep = if file.kind == "deleted-by-them" { "ours" } else { "theirs" };
        [("Keep the file".into(), keep, String::new()), ("Delete it".into(), "delete", String::new())]
    } else {
        [
            (cut(&format!("Take {}", labels.ours), 22), "ours", format!("Take the version from {}", labels.ours)),
            (cut(&format!("Take {}", labels.theirs), 22), "theirs", format!("Take the version from {}", labels.theirs)),
        ]
    };
    let mut x = left + 19.0;
    let cy = rect.top() + 52.0;
    for (text, side, tip) in buttons {
        let id = Id::unique(("conflict_side", &file.path, side));
        let response = button_at(ui, id, pos2(x, cy), 22.0, &text, 11.0, if disabled { off } else { look }, p);
        x = response.rect.right() + 5.0;
        let response = if tip.is_empty() { response } else { response.on_hover_text(tip) };
        if response.clicked() && !disabled {
            intent = Some(Intent::Side(file.path.clone(), side));
        }
    }
    if intent.is_none() && row.clicked() {
        intent = Some(Intent::Open(file.path.clone()));
    }
    let tip = if file.deletion { file.path.clone() } else { format!("{}: click to resolve", file.path) };
    row.on_hover_text(tip);
    intent
}

fn footer_ui(
    ui: &mut Ui,
    rect: Rect,
    state: &ConflictState,
    bare: bool,
    disabled: bool,
    p: &Palette,
) -> Option<Intent> {
    let painter = ui.painter();
    painter.hline(rect.x_range(), rect.top() + 0.5, Stroke::new(1.0, p.line));
    let inner = rect.shrink2(vec2(12.0, 10.0));
    let mut y = inner.top();
    if let Some(progress) = state.progress.as_ref().filter(|pr| pr.total > 0) {
        painter.text(
            pos2(inner.left(), y),
            Align2::LEFT_TOP,
            format!("Rebasing commit {} of {}", progress.current, progress.total),
            FontId::proportional(11.0),
            p.fg_muted,
        );
        let subject = label(ui, &progress.subject, 13.0, inner.width(), p.fg_bright);
        painter.galley(pos2(inner.left(), y + 16.0), subject, p.fg_bright);
        let bar = Rect::from_min_size(pos2(inner.left(), y + 38.0), vec2(inner.width(), 3.0));
        painter.rect_filled(bar, 2.0, p.bg_3);
        let done = (progress.current as f32 / progress.total as f32).clamp(0.0, 1.0);
        painter.rect_filled(Rect::from_min_size(bar.min, vec2(bar.width() * done, 3.0)), 2.0, p.accent);
        y += 51.0;
    }
    if bare {
        let text = if state.conflicted.is_empty() {
            "All resolved: the files are staged and ready to commit."
        } else {
            "Resolve the files above to finish."
        };
        let galley = ui.painter().layout(text.to_string(), FontId::proportional(12.0), p.fg_dim, inner.width());
        painter.galley(pos2(inner.left(), y), galley, p.fg_dim);
        return None;
    }
    let mut intent = None;
    let op = state.operation.as_str();
    let can_continue = state.conflicted.is_empty();
    let row = Rect::from_min_max(pos2(inner.left(), y), pos2(inner.right(), y + 32.0));
    let mut buttons = ui.new_child(
        UiBuilder::new()
            .id_salt("conflict_buttons")
            .max_rect(row)
            .layout(eframe::egui::Layout::right_to_left(eframe::egui::Align::Center)),
    );
    buttons.spacing_mut().item_spacing.x = 8.0;
    let pad = vec2(12.0, 8.0);
    let abort = Look::new(p.red_line, p.red_line, p.red_fg);
    if button(&mut buttons, &format!("Abort {op}"), 12.0, pad, 160.0, abort, !disabled, p).clicked() {
        intent = Some(Intent::Op("abort"));
    }
    if matches!(op, "rebase" | "cherry-pick" | "revert") {
        let skip = Look::new(p.bg_4, p.line, p.fg);
        if button(&mut buttons, "Skip", 12.0, pad, 80.0, skip, !disabled, p)
            .on_hover_text("Skip the commit being applied")
            .clicked()
        {
            intent = Some(Intent::Op("skip"));
        }
    }
    let go = Look::new(p.green_bg, p.green_line, p.green_fg).hover(p.green_line, p.green_fg);
    let tip =
        if can_continue { format!("Continue the {op}") } else { "Resolve the remaining conflicts first".to_string() };
    let w = buttons.available_width();
    let text = format!("Continue {op}");
    let galley = label(&buttons, &text, 12.0, w - 20.0, p.green_fg);
    let (rect, response) = buttons.allocate_exact_size(
        vec2(w, galley.size().y + 16.0),
        if can_continue && !disabled { Sense::click() } else { Sense::hover() },
    );
    let enabled = can_continue && !disabled;
    let (fill, stroke, fg) = if !enabled {
        (p.bg_2, p.line, p.fg_faint)
    } else if response.hovered() {
        (go.hover_fill, go.stroke, go.fg)
    } else {
        (go.fill, go.stroke, go.fg)
    };
    buttons.painter().rect(rect, 3.0, fill, Stroke::new(1.0, stroke), eframe::egui::StrokeKind::Inside);
    buttons.painter().galley_with_override_text_color(rect.center() - galley.size() / 2.0, galley, fg);
    if response.on_hover_text(tip).clicked() && enabled {
        intent = Some(Intent::Op("continue"));
    }
    intent
}

fn footer_height(state: &ConflictState, bare: bool) -> f32 {
    let progress = if state.progress.as_ref().is_some_and(|p| p.total > 0) { 51.0 } else { 0.0 };
    let body = if bare { 36.0 } else { 32.0 };
    progress + body + 22.0
}

fn section_head(ui: &Ui, rect: Rect, text: &str, p: &Palette) {
    let painter = ui.painter();
    painter.rect_filled(rect, 0.0, p.bg_1);
    let cy = rect.top() + 12.0 + 7.0;
    icons::paint(
        ui,
        Rect::from_center_size(pos2(rect.left() + 17.0, cy), Vec2::splat(11.0)),
        "chevronDown",
        p.fg_muted,
    );
    painter.text(pos2(rect.left() + 28.0, cy), Align2::LEFT_CENTER, text, FontId::proportional(12.0), p.fg_dim);
}

fn list(ui: &mut Ui, rect: Rect, salt: &str, count: usize, row_h: f32, mut row: impl FnMut(&mut Ui, usize, Rect)) {
    if rect.height() <= 0.0 || count == 0 {
        return;
    }
    let mut child = ui.new_child(UiBuilder::new().id_salt(salt).max_rect(rect));
    child.set_clip_rect(rect.intersect(ui.clip_rect()));
    child.spacing_mut().item_spacing = Vec2::ZERO;
    ScrollArea::vertical().id_salt(salt).auto_shrink(false).show_rows(&mut child, row_h, count, |ui, range| {
        let width = ui.available_width();
        for i in range {
            let (rect, _) = ui.allocate_exact_size(vec2(width, row_h), Sense::hover());
            row(ui, i, rect);
        }
    });
}

fn chip(ui: &mut Ui, text: &str, p: &Palette) {
    eframe::egui::Frame::new()
        .fill(p.chip_head)
        .corner_radius(3.0)
        .inner_margin(eframe::egui::Margin::symmetric(7, 1))
        .show(ui, |ui| ui.label(RichText::new(text).size(11.0).color(p.chip_head_fg)));
}

fn file_name(ui: &Ui, path: &str, width: f32, p: &Palette) -> std::sync::Arc<eframe::egui::Galley> {
    let mut job = LayoutJob::default();
    let font = FontId::proportional(12.0);
    let cut = path.rfind('/').map_or(0, |i| i + 1);
    let (dir, base) = path.split_at(cut);
    job.append(dir, 0.0, TextFormat::simple(font.clone(), p.fg_muted));
    job.append(base, 0.0, TextFormat::simple(font, p.fg));
    job.wrap = TextWrapping::truncate_at_width(width.max(20.0));
    ui.painter().layout_job(job)
}

fn describe(file: &ConflictFile, labels: &Labels) -> String {
    match file.kind.as_str() {
        "both-modified" => "changed on both sides".into(),
        "both-added" => "added on both sides".into(),
        "both-deleted" => "deleted on both sides".into(),
        "deleted-by-them" => format!("kept on {}, deleted on {}", labels.ours, labels.theirs),
        "deleted-by-us" => format!("deleted on {}, kept on {}", labels.ours, labels.theirs),
        "added-by-us" => format!("added on {} only", labels.ours),
        "added-by-them" => format!("added on {} only", labels.theirs),
        _ => "conflicted".into(),
    }
}

impl Labels {
    /// During a rebase git's "ours" is the branch being rebased onto, so nothing here says ours or theirs.
    fn of(state: &ConflictState) -> Labels {
        match state.progress.as_ref().filter(|_| state.operation == "rebase") {
            Some(p) => Labels {
                ours: first_of(&[&p.onto_name, &p.onto], "the base"),
                theirs: first_of(&[&p.branch], "the replayed commit"),
            },
            None => Labels { ours: "current branch".into(), theirs: "incoming".into() },
        }
    }
}

fn first_of(names: &[&String], fallback: &str) -> String {
    names.iter().find(|n| !n.is_empty()).map_or_else(|| fallback.to_string(), |n| n.to_string())
}

fn capitalize(word: &str) -> String {
    let mut chars = word.chars();
    chars.next().map(|c| c.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

fn cut(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut short: String = text.chars().take(max.saturating_sub(3)).collect();
    short.push_str("...");
    short
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::types::RebaseProgress;

    #[test]
    fn rebase_labels_name_the_branches() {
        let progress = RebaseProgress {
            onto_name: String::new(),
            onto: "abc123".into(),
            branch: "topic".into(),
            ..Default::default()
        };
        let state = ConflictState { operation: "rebase".into(), progress: Some(progress), ..Default::default() };
        let labels = Labels::of(&state);
        assert_eq!((labels.ours.as_str(), labels.theirs.as_str()), ("abc123", "topic"));
        let merge = Labels::of(&ConflictState { operation: "merge".into(), ..Default::default() });
        assert_eq!(merge.ours, "current branch");
        let file = ConflictFile { path: "a".into(), kind: "deleted-by-them".into(), deletion: true };
        assert_eq!(describe(&file, &labels), "kept on abc123, deleted on topic");
    }

    #[test]
    fn helpers() {
        assert_eq!(capitalize("rebase"), "Rebase");
        assert_eq!(cut("abcdefgh", 5), "ab...");
        assert_eq!(cut("abc", 5), "abc");
    }
}
