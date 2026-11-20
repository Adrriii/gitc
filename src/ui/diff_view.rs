#[path = "diff_view_body.rs"]
mod body;
#[path = "diff_view_highlight.rs"]
pub mod highlight;
#[path = "diff_view_media.rs"]
mod media;
#[path = "diff_view_patch.rs"]
mod patch;
#[path = "diff_view_words.rs"]
mod words;

use std::collections::HashMap;
use std::time::{Duration, Instant};

use base64::Engine as _;
use eframe::egui::{
    self, Align, Color32, CornerRadius, FontId, Key as KeyCode, Layout, Modifiers, RichText, Sense, Stroke, StrokeKind,
    TextureOptions, Ui, UiBuilder, Vec2, text::LayoutJob,
};

use super::dialogs::MenuItem;
use super::settings::TAB_SIZES;
use super::theme::Palette;
use super::{App, actions, icons};
use crate::engine::api::{self, Request};
use crate::engine::types::{DiffTarget, FileDiff, Media, OpArgs, OpResult};
use highlight::Token;
use media::{MediaKind, Pane, PaneState};
use words::Span;

#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
enum Mode {
    #[default]
    Unified,
    Inline,
    Split,
}

#[derive(Clone, PartialEq, Debug)]
struct Key {
    path: String,
    target: DiffTarget,
    whole: bool,
}

#[derive(Default, Clone)]
struct LineExtra {
    syn: Vec<Token>,
    marks: Vec<Span>,
}

struct Loaded {
    diff: FileDiff,
    /// Per hunk, per line: what highlighting and the word diff found.
    extra: Vec<Vec<LineExtra>>,
}

struct Draft {
    text: String,
    crlf: bool,
    saving: bool,
}

#[derive(Default)]
pub struct State {
    mode: Mode,
    file_view: bool,
    ws: bool,
    requested: Option<(Key, u64)>,
    seq: u64,
    loading: bool,
    error: Option<String>,
    loaded: Option<(Key, Loaded)>,
    generation: u64,
    view: body::View,
    media: Vec<Pane>,
    media_kind: Option<MediaKind>,
    copied: Option<Instant>,
    draft: Option<Draft>,
    edit_error: Option<String>,
}

pub fn show(app: &mut App, ui: &mut Ui) {
    let Some(id) = app.active_id() else { return };
    let Some(tab) = app.active_tab() else { return };
    let remote = tab.host.is_some();
    let repo_path = tab.path.clone();
    request_if_needed(app, &id);
    path_bar(app, ui, &id, &repo_path, remote);
    toolbar(app, ui, &id, remote);
    if app.repos.get(&id).is_some_and(|r| r.diff.draft.is_some()) {
        editor(app, ui, &id);
        return;
    }
    body::show(app, ui, &id);
}

fn request_if_needed(app: &mut App, id: &str) {
    let Some(repo) = app.repos.get_mut(id) else { return };
    let Some(open) = &repo.open_file else { return };
    let st = &mut repo.diff;
    let key =
        Key { path: open.path.clone(), target: open.target.clone(), whole: st.mode != Mode::Unified || st.file_view };
    if st.requested.as_ref().is_some_and(|(k, v)| *k == key && *v == repo.version) {
        return;
    }
    if st.loaded.as_ref().is_none_or(|(k, _)| *k != key) {
        st.loaded = None;
        st.draft = None;
        st.edit_error = None;
        st.media.clear();
        st.media_kind = None;
        st.view.reset();
    }
    st.error = None;
    st.loading = true;
    st.seq += 1;
    st.requested = Some((key.clone(), repo.version));
    let seq = st.seq;
    let req =
        Request::Diff { id: id.to_string(), target: key.target.clone(), path: key.path.clone(), whole: key.whole };
    let path = key.path.clone();
    let full = (!key.whole && highlight::supported(&path)).then(|| Request::Diff {
        id: id.to_string(),
        target: key.target.clone(),
        path: key.path.clone(),
        whole: true,
    });
    let tab = id.to_string();
    app.jobs.run(
        move || {
            api::call::<FileDiff>(req).map(|d| {
                let whole = full.filter(|_| !d.hunks.is_empty()).and_then(|r| api::call::<FileDiff>(r).ok());
                prepare(d, whole.as_ref(), &path)
            })
        },
        move |app, result| arrived(app, &tab, seq, key, result),
    );
}

fn arrived(app: &mut App, tab: &str, seq: u64, key: Key, result: Result<Loaded, String>) {
    let Some(repo) = app.repos.get_mut(tab) else { return };
    let st = &mut repo.diff;
    if st.seq != seq {
        return;
    }
    st.loading = false;
    let loaded = match result {
        Ok(loaded) => loaded,
        Err(e) => {
            st.loaded = None;
            st.error = Some(e);
            return;
        }
    };
    let diff = &loaded.diff;
    let kind = media::media_for(&key.path).filter(|_| diff.binary || diff.too_large);
    let (status, old_path) = (diff.status.clone(), diff.old_path.clone());
    st.media_kind = kind;
    st.generation += 1;
    st.view.confirm_discard = None;
    st.loaded = Some((key.clone(), loaded));
    if kind.is_none() {
        st.media.clear();
        return;
    }
    st.media = media::panes(&status);
    let sides: Vec<&'static str> = st.media.iter().map(|p| p.side).collect();
    for side in sides {
        let req = Request::Media {
            id: tab.to_string(),
            target: key.target.clone(),
            path: key.path.clone(),
            old_path: old_path.clone(),
            side: side.to_string(),
        };
        let path = key.path.clone();
        let tab = tab.to_string();
        app.jobs.run(
            move || media::load(req, &path),
            move |app, result| {
                let texture = match &result {
                    Ok(decoded) => decoded.image.clone().map(|image| {
                        let name = format!("diff-media-{tab}-{side}");
                        app.ctx.load_texture(name, image, TextureOptions::LINEAR)
                    }),
                    Err(_) => None,
                };
                let Some(repo) = app.repos.get_mut(&tab) else { return };
                if repo.diff.seq != seq {
                    return;
                }
                let Some(pane) = repo.diff.media.iter_mut().find(|p| p.side == side) else { return };
                pane.state = match result {
                    Ok(decoded) => {
                        let size = texture.as_ref().map_or([0, 0], |t| t.size());
                        PaneState::Ready { texture, size, bytes: decoded.bytes }
                    }
                    Err(e) => PaneState::Failed(e),
                };
            },
        );
    }
}

/// Highlights the old and new side of `whole` (of each hunk when it is missing) and finds the changed words.
/// Runs off the UI thread.
fn prepare(diff: FileDiff, whole: Option<&FileDiff>, path: &str) -> Loaded {
    let source = whole.unwrap_or(&diff);
    let (old, new) = (side_tokens(source, path, true), side_tokens(source, path, false));
    let extra = diff
        .hunks
        .iter()
        .map(|hunk| {
            let lines = &hunk.lines;
            let mut extra: Vec<LineExtra> = lines
                .iter()
                .map(|l| {
                    let toks = match l.kind.as_str() {
                        "del" => l.old_no.and_then(|n| old.get(&n)),
                        _ => l.new_no.and_then(|n| new.get(&n)),
                    };
                    LineExtra { syn: toks.cloned().unwrap_or_default(), marks: Vec::new() }
                })
                .collect();
            let kinds: Vec<&str> = lines.iter().map(|l| l.kind.as_str()).collect();
            for (i, partner) in words::pair_runs(&kinds).into_iter().enumerate() {
                let (Some(j), Some(line)) = (partner, lines.get(i)) else { continue };
                let Some(other) = lines.get(j) else { continue };
                let marks = if line.kind == "del" {
                    words::word_diff(&line.text, &other.text).0
                } else {
                    words::word_diff(&other.text, &line.text).1
                };
                if let Some(e) = extra.get_mut(i) {
                    e.marks = marks;
                }
            }
            extra
        })
        .collect();
    Loaded { diff, extra }
}

/// Tokens by line number for one side of `diff`, each hunk's side parsed as one document.
fn side_tokens(diff: &FileDiff, path: &str, old: bool) -> HashMap<u64, Vec<Token>> {
    let mut out = HashMap::new();
    let total: usize = diff.hunks.iter().flat_map(|h| &h.lines).map(|l| l.text.len() + 1).sum();
    if total > highlight::MAX_CHARS {
        return out;
    }
    for hunk in &diff.hunks {
        let side: Vec<(u64, &str)> = hunk
            .lines
            .iter()
            .filter_map(|l| if old { l.old_no } else { l.new_no }.map(|n| (n, l.text.as_str())))
            .collect();
        let texts: Vec<&str> = side.iter().map(|(_, t)| *t).collect();
        out.extend(side.iter().map(|(n, _)| *n).zip(highlight::tokens(path, &texts)));
    }
    out
}

fn path_bar(app: &mut App, ui: &mut Ui, id: &str, repo_path: &str, remote: bool) {
    let p = app.palette;
    let Some(repo) = app.repos.get(id) else { return };
    let Some(open) = &repo.open_file else { return };
    let path = open.path.clone();
    let label = format!("in {}", open.label);
    let other_worktree = matches!(open.target, DiffTarget::Wip { worktree: Some(_), .. });
    let copied = repo.diff.copied.is_some_and(|t| t.elapsed() < Duration::from_millis(1500));
    if copied {
        ui.ctx().request_repaint_after(Duration::from_millis(1500));
    }
    let (dir, base) = match path.rfind('/') {
        Some(cut) => (path.get(..=cut).unwrap_or(""), path.get(cut + 1..).unwrap_or("")),
        None => ("", path.as_str()),
    };

    let mut close = false;
    let mut copy = false;
    let mut menu_at = None;
    bar(ui, 28.0, p.bg_1, p.line, |ui| {
        egui::containers::Sides::new().height(28.0).shrink_left().truncate().show(
            ui,
            |ui| {
                icons::show(ui, "file", 13.0, p.amber);
                let chip_w = text_width(ui, &label, 11.0) + 14.0;
                let room = (ui.available_width() - chip_w - 40.0).max(40.0);
                let mut job = LayoutJob::default();
                job.append(dir, 0.0, egui::TextFormat::simple(FontId::proportional(12.0), p.fg_muted));
                job.append(base, 0.0, egui::TextFormat::simple(FontId::proportional(12.0), p.fg_bright));
                ui.scope(|ui| {
                    ui.set_max_width(room);
                    let shown = ui.add(egui::Label::new(job).truncate().sense(Sense::click()));
                    if shown.secondary_clicked() {
                        menu_at = shown.interact_pointer_pos();
                    }
                });
                let tip = if copied { "Copied" } else { "Copy path (right-click the path for the full one)" };
                if icons::button(ui, if copied { "check" } else { "copy" }, 12.0, tip).clicked() {
                    copy = true;
                }
                ui.add_space(4.0);
                let chip = egui::Label::new(RichText::new(&label).size(11.0).color(p.fg_muted)).truncate();
                egui::Frame::new().fill(p.bg_2).corner_radius(3.0).inner_margin(egui::Margin::symmetric(7, 1)).show(
                    ui,
                    |ui| {
                        ui.add(chip);
                    },
                );
            },
            |ui| {
                if icons::button(ui, "close", 14.0, "Close diff (Esc)").clicked() {
                    close = true;
                }
                ui.label(RichText::new("UTF-8").size(10.0).color(p.fg_muted));
            },
        );
    });

    if copy {
        copy_text(app, id, path.clone());
    }
    if let Some(pos) = menu_at {
        let full = (!remote && !other_worktree).then(|| media::absolute_path(repo_path, &path));
        let tab = id.to_string();
        let mut items = vec![{
            let (tab, text) = (tab.clone(), path.clone());
            MenuItem::new("Copy path", move |app| copy_text(app, &tab, text)).hint(path.clone())
        }];
        if let Some(full) = full {
            let (tab, text) = (tab.clone(), full.clone());
            items.push(MenuItem::new("Copy full path", move |app| copy_text(app, &tab, text)).hint(full));
        }
        let (name, text) = (base.to_string(), base.to_string());
        items.push(MenuItem::new("Copy file name", move |app| copy_text(app, &tab, text)).hint(name));
        let ctx = app.ctx.clone();
        app.overlay.menu(&ctx, pos, items);
    }
    if close && let Some(repo) = app.repos.get_mut(id) {
        repo.open_file = None;
    }
}

fn toolbar(app: &mut App, ui: &mut Ui, id: &str, remote: bool) {
    let p = app.palette;
    let (wrap, tab_size) = (app.settings.diff_wrap, app.settings.tab_size);
    let Some(repo) = app.repos.get_mut(id) else { return };
    let Some(open) = &repo.open_file else { return };
    let path = open.path.clone();
    let other_worktree = matches!(open.target, DiffTarget::Wip { worktree: Some(_), .. });
    let st = &mut repo.diff;
    let drafting = st.draft.as_ref().map(|d| d.saving);
    let edit_error = st.edit_error.clone();

    #[derive(PartialEq)]
    enum Do {
        Nothing,
        Edit,
        Save,
        Cancel,
        Wrap,
        TabSize,
    }
    let mut todo = Do::Nothing;
    bar(ui, 34.0, p.bg_4, p.line_hard, |ui| {
        ui.spacing_mut().item_spacing.x = 8.0;
        let (left, right) = egui::containers::Sides::new().height(34.0).show(
            ui,
            |ui| {
                let mut todo = Do::Nothing;
                match drafting {
                    Some(saving) => {
                        if group(ui, &p, &[("Save", false, "Write it to the working tree (Ctrl+S)")]).is_some()
                            && !saving
                        {
                            todo = Do::Save;
                        }
                        if group(ui, &p, &[("Cancel", false, "Drop the edits")]).is_some() {
                            todo = Do::Cancel;
                        }
                    }
                    None if !other_worktree => {
                        let tip = if remote { "Edit this file here" } else { "Open this file in your editor" };
                        if group(ui, &p, &[("Edit This File", false, tip)]).is_some() {
                            todo = Do::Edit;
                        }
                    }
                    None => {}
                }
                if let Some(e) = &edit_error {
                    ui.add(egui::Label::new(RichText::new(e).size(11.0).color(p.red_fg)).truncate());
                }
                todo
            },
            |ui| {
                if drafting.is_some() {
                    return Do::Nothing;
                }
                let mut todo = Do::Nothing;
                let wrap_tip = if wrap {
                    "Wrapping long lines, click to scroll instead"
                } else {
                    "Scrolling long lines, click to wrap"
                };
                let tab_label = format!("Tab {tab_size}");
                let whitespace = group(
                    ui,
                    &p,
                    &[
                        ("@pilcrow", st.ws, "Show whitespace"),
                        ("@wrap", wrap, wrap_tip),
                        (tab_label.as_str(), false, "Tab width"),
                    ],
                );
                match whitespace {
                    Some(0) => st.ws = !st.ws,
                    Some(1) => todo = Do::Wrap,
                    Some(2) => todo = Do::TabSize,
                    _ => {}
                }
                let modes = [Mode::Unified, Mode::Inline, Mode::Split];
                let picked = group(
                    ui,
                    &p,
                    &[
                        ("@unified", st.mode == Mode::Unified, "Unified View: changed hunks only"),
                        ("@inline", st.mode == Mode::Inline, "Inline View: whole file, changes in place"),
                        ("@split", st.mode == Mode::Split, "Split View: old and new side by side"),
                    ],
                );
                if let Some(mode) = picked.and_then(|i| modes.get(i)) {
                    st.mode = *mode;
                }
                match group(ui, &p, &[("@arrowUp", false, "Previous change"), ("@arrowDown", false, "Next change")]) {
                    Some(0) => st.view.step = -1,
                    Some(1) => st.view.step = 1,
                    _ => {}
                }
                match group(ui, &p, &[("File View", st.file_view, ""), ("Diff View", !st.file_view, "")]) {
                    Some(0) => st.file_view = true,
                    Some(1) => st.file_view = false,
                    _ => {}
                }
                todo
            },
        );
        todo = if left != Do::Nothing { left } else { right };
    });

    match todo {
        Do::Nothing => {}
        Do::Cancel => st.draft = None,
        Do::Save => save_draft(app, id),
        Do::Edit if remote => start_draft(app, id, path),
        Do::Edit => {
            st.edit_error = None;
            app.later
                .add(move |app| actions::run_op(app, OpArgs { op: "editFile".into(), path, ..Default::default() }));
        }
        Do::Wrap | Do::TabSize => {
            if todo == Do::Wrap {
                app.settings.diff_wrap = !wrap;
            } else {
                let at = TAB_SIZES.iter().position(|&s| s == tab_size).map_or(0, |i| (i + 1) % TAB_SIZES.len());
                app.settings.tab_size = TAB_SIZES.get(at).copied().unwrap_or(4);
            }
            app.later.add(|app| app.save_settings());
        }
    }
}

fn editor(app: &mut App, ui: &mut Ui, id: &str) {
    let p = app.palette;
    let Some(draft) = app.repos.get_mut(id).and_then(|r| r.diff.draft.as_mut()) else { return };
    let save = ui.input_mut(|i| i.consume_key(Modifiers::COMMAND, KeyCode::S));
    egui::Frame::new().fill(p.bg_0).inner_margin(8.0).show(ui, |ui| {
        egui::ScrollArea::both().id_salt("diff-draft").auto_shrink(false).show(ui, |ui| {
            ui.add(
                egui::TextEdit::multiline(&mut draft.text)
                    .code_editor()
                    .frame(egui::Frame::NONE)
                    .desired_width(f32::INFINITY)
                    .desired_rows(40),
            );
        });
    });
    if save {
        save_draft(app, id);
    }
}

fn start_draft(app: &mut App, id: &str, path: String) {
    if let Some(repo) = app.repos.get_mut(id) {
        repo.diff.edit_error = None;
    }
    let target = DiffTarget::Wip { staged: false, untracked: false, worktree: None };
    let req = Request::Media { id: id.to_string(), target, path, old_path: None, side: "new".into() };
    let tab = id.to_string();
    app.jobs.run(
        move || -> Result<String, String> {
            let media: Media = api::call(req)?;
            let bytes = base64::engine::general_purpose::STANDARD.decode(media.data).map_err(|e| e.to_string())?;
            String::from_utf8(bytes).map_err(|_| "not UTF-8 text, it cannot be edited here".to_string())
        },
        move |app, result| {
            let Some(repo) = app.repos.get_mut(&tab) else { return };
            match result {
                Ok(text) => {
                    let crlf = text.contains("\r\n");
                    repo.diff.draft = Some(Draft { text: text.replace("\r\n", "\n"), crlf, saving: false });
                }
                Err(e) => repo.diff.edit_error = Some(e),
            }
        },
    );
}

fn save_draft(app: &mut App, id: &str) {
    let Some(repo) = app.repos.get_mut(id) else { return };
    let Some(path) = repo.open_file.as_ref().map(|o| o.path.clone()) else { return };
    let Some(draft) = repo.diff.draft.as_mut() else { return };
    if draft.saving {
        return;
    }
    draft.saving = true;
    repo.diff.edit_error = None;
    let message = if draft.crlf { draft.text.replace('\n', "\r\n") } else { draft.text.clone() };
    let req = Request::Op {
        id: id.to_string(),
        args: OpArgs { op: "writeFile".into(), path, message, ..Default::default() },
    };
    let tab = id.to_string();
    app.jobs.request(req, move |app, result: Result<OpResult, String>| {
        let Some(repo) = app.repos.get_mut(&tab) else { return };
        if let Some(d) = repo.diff.draft.as_mut() {
            d.saving = false;
        }
        match result {
            Ok(r) if r.ok => {
                repo.diff.draft = None;
                repo.refresh();
            }
            Ok(r) => repo.diff.edit_error = Some(r.note),
            Err(e) => repo.diff.edit_error = Some(e),
        }
    });
}

fn copy_text(app: &mut App, id: &str, text: String) {
    app.ctx.copy_text(text);
    if let Some(repo) = app.repos.get_mut(id) {
        repo.diff.copied = Some(Instant::now());
    }
}

/// Runs a patch through `git apply`: mode is "stage" | "unstage" | "discard".
fn apply(app: &mut App, mode: &str, patch: String) {
    actions::run_op(app, OpArgs { op: "applyPatch".into(), mode: mode.into(), patch, ..Default::default() });
}

fn bar(ui: &mut Ui, height: f32, fill: Color32, line: Color32, add: impl FnOnce(&mut Ui)) {
    let (rect, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), height), Sense::hover());
    ui.painter().rect_filled(rect, 0.0, fill);
    ui.painter().hline(rect.x_range(), rect.bottom() - 0.5, Stroke::new(1.0, line));
    let inner = rect.shrink2(Vec2::new(8.0, 0.0));
    let mut child = ui.new_child(UiBuilder::new().max_rect(inner).layout(Layout::left_to_right(Align::Center)));
    add(&mut child);
}

/// A row of joined buttons; "@name" is an icon. Returns the index clicked.
fn group(ui: &mut Ui, p: &Palette, items: &[(&str, bool, &str)]) -> Option<usize> {
    let widths: Vec<f32> = items
        .iter()
        .map(|(label, _, _)| if label.starts_with('@') { 30.0 } else { text_width(ui, label, 12.0) + 18.0 })
        .collect();
    let (rect, _) = ui.allocate_exact_size(Vec2::new(widths.iter().sum(), 22.0), Sense::hover());
    let mut x = rect.left();
    let mut clicked = None;
    let last = items.len().saturating_sub(1);
    for (i, ((label, on, tip), w)) in items.iter().zip(&widths).enumerate() {
        let cell = egui::Rect::from_min_size(egui::pos2(x, rect.top()), Vec2::new(*w, rect.height()));
        x += w;
        let id = ui.make_persistent_id(("diff-group", rect.left() as i32, rect.top() as i32, i));
        let mut response = ui.interact(cell, id, Sense::click());
        if !tip.is_empty() {
            response = response.on_hover_text(*tip);
        }
        if response.clicked() {
            clicked = Some(i);
        }
        let radius = CornerRadius {
            nw: if i == 0 { 3 } else { 0 },
            sw: if i == 0 { 3 } else { 0 },
            ne: if i == last { 3 } else { 0 },
            se: if i == last { 3 } else { 0 },
        };
        let (fill, fg, stroke) = match (*on, response.hovered()) {
            (true, _) => (p.accent_line, p.accent_fg, p.accent_line),
            (false, true) => (p.bg_4, p.fg, p.line),
            (false, false) => (p.bg_3, p.fg_dim, p.line),
        };
        let painter = ui.painter();
        painter.rect_filled(cell, radius, fill);
        painter.rect_stroke(cell, radius, Stroke::new(1.0, stroke), StrokeKind::Inside);
        match label.strip_prefix('@') {
            Some(icon) => icons::paint(ui, egui::Rect::from_center_size(cell.center(), Vec2::splat(14.0)), icon, fg),
            None => {
                painter.text(cell.center(), egui::Align2::CENTER_CENTER, *label, FontId::proportional(12.0), fg);
            }
        }
    }
    clicked
}

fn text_width(ui: &Ui, text: &str, size: f32) -> f32 {
    ui.painter().layout_no_wrap(text.to_string(), FontId::proportional(size), Color32::WHITE).size().x
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::types::{DiffLine, Hunk};

    fn line(kind: &str, old_no: Option<u64>, new_no: Option<u64>, text: &str) -> DiffLine {
        DiffLine { kind: kind.into(), old_no, new_no, text: text.into(), no_newline: false }
    }

    #[test]
    fn a_hunk_cut_inside_a_comment_is_coloured_from_the_whole_file() {
        let cut =
            vec![line("context", Some(2), Some(2), "still comment"), line("add", None, Some(3), "more comment */")];
        let all = vec![
            line("context", Some(1), Some(1), "/* open"),
            line("context", Some(2), Some(2), "still comment"),
            line("add", None, Some(3), "more comment */"),
        ];
        let hunk = |lines: Vec<DiffLine>| Hunk { lines, ..Default::default() };
        let diff = FileDiff { hunks: vec![hunk(cut)], ..Default::default() };
        let whole = FileDiff { hunks: vec![hunk(all)], ..Default::default() };
        let loaded = prepare(diff, Some(&whole), "x.js");
        let first = loaded.extra.first().and_then(|h| h.first()).map(|e| e.syn.clone()).unwrap_or_default();
        assert_eq!(first, vec![Token { start: 0, end: "still comment".len(), syn: highlight::Syn::Comment }]);
    }
}
