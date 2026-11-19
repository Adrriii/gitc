use std::time::{Duration, Instant};

use eframe::egui::{
    self, Color32, CornerRadius, FontId, Id, Key, Margin, Modifiers, Pos2, Rect, RichText, Sense, Stroke, Ui, Vec2,
};

use super::tabbar::galley;
use super::{App, icons};
use crate::engine::api::Request;
use crate::engine::types::Listing;

const DEBOUNCE: Duration = Duration::from_millis(120);
const ROW_H: f32 = 24.0;
const LIST_MAX_H: f32 = 300.0;

/// A completing path field over a directory listing that marks repositories before you enter them.
#[derive(Default)]
pub struct Picker {
    value: String,
    listing: Option<Listing>,
    active: usize,
    loading: bool,
    request: u64,
    /// The machine being browsed ("" for this one); None until the first listing is asked for.
    host: Option<String>,
    edited: Option<Instant>,
    focus: bool,
    scroll_to: Option<f32>,
    offset: f32,
    view_h: f32,
    entered_repo: Option<String>,
}

/// Where the app keeps a picker, so a listing that arrives later finds it.
pub type Which = fn(&mut App) -> &mut Picker;

/// Draws the picker browsing `host` ("" for this machine); returns a path the user chose to open.
pub fn show(app: &mut App, ui: &mut Ui, which: Which, host: &str) -> Option<String> {
    let mut picker = std::mem::take(which(app));
    let opened = draw(app, ui, &mut picker, which, host);
    *which(app) = picker;
    opened
}

fn draw(app: &mut App, ui: &mut Ui, pk: &mut Picker, which: Which, host: &str) -> Option<String> {
    let p = app.palette;
    if pk.host.as_deref() != Some(host) {
        *pk = Picker { host: Some(host.to_string()), focus: true, request: pk.request, ..Picker::default() };
        load(app, pk, which, "");
    }
    if let Some(at) = pk.edited {
        if at.elapsed() >= DEBOUNCE {
            pk.edited = None;
            if !pk.value.is_empty() {
                let value = pk.value.clone();
                load(app, pk, which, &value);
            }
        } else {
            ui.ctx().request_repaint_after(DEBOUNCE.saturating_sub(at.elapsed()));
        }
    }

    let prefix = pk.listing.as_ref().map(|l| l.prefix.to_lowercase()).unwrap_or_default();
    let matches: Vec<usize> = pk.listing.as_ref().map_or_else(Vec::new, |l| {
        l.entries
            .iter()
            .enumerate()
            .filter(|(_, e)| prefix.is_empty() || e.name.to_lowercase().starts_with(&prefix))
            .map(|(i, _)| i)
            .collect()
    });
    let parent_row = pk.listing.as_ref().is_some_and(|l| l.parent.is_some());
    let mut open: Option<String> = None;

    let id = Id::unique(("repo-picker", host));
    let focused = ui.memory(|m| m.has_focus(id));
    let (mut down, mut up, mut tab, mut enter) = (false, false, false, false);
    if focused {
        ui.input_mut(|i| {
            down = i.consume_key(Modifiers::NONE, Key::ArrowDown);
            up = i.consume_key(Modifiers::NONE, Key::ArrowUp);
            tab = i.consume_key(Modifiers::NONE, Key::Tab);
            enter = i.consume_key(Modifiers::NONE, Key::Enter);
        });
    }

    let can_open = pk.listing.as_ref().is_some_and(|l| l.repo) && prefix.is_empty();
    let mut open_clicked = false;
    egui::Frame::new()
        .fill(p.bg_inset)
        .stroke(Stroke::new(1.0, if focused { p.accent } else { p.line }))
        .corner_radius(3.0)
        .inner_margin(Margin::symmetric(8, 0))
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 7.0;
                icons::show(ui, "search", 13.0, p.fg_faint);
                let edit = egui::TextEdit::singleline(&mut pk.value)
                    .id(id)
                    .frame(egui::Frame::NONE)
                    .margin(Margin::symmetric(0, 7))
                    .font(FontId::monospace(12.0))
                    .text_color(p.fg)
                    .lock_focus(true)
                    .desired_width((ui.available_width() - 60.0).max(40.0));
                let resp = ui.add(edit);
                if resp.changed() {
                    pk.edited = Some(Instant::now());
                }
                if pk.focus {
                    pk.focus = false;
                    resp.request_focus();
                }
                let (fill, line, fg) = if can_open {
                    (p.accent_line, p.accent_line, p.accent_fg)
                } else {
                    (Color32::TRANSPARENT, p.line, p.fg_faint)
                };
                let button = egui::Button::new(RichText::new("Open").size(12.0).color(fg))
                    .fill(fill)
                    .stroke(Stroke::new(1.0, line))
                    .corner_radius(3.0)
                    .min_size(Vec2::new(52.0, 22.0));
                open_clicked = ui.add_enabled(can_open, button).on_hover_text("Open this repository").clicked();
            });
        });

    let count = matches.len();
    if down && count > 0 {
        pk.active = (pk.active + 1).min(count - 1);
        scroll_into_view(pk, pk.active + usize::from(parent_row));
    }
    if up {
        pk.active = pk.active.saturating_sub(1);
        scroll_into_view(pk, pk.active + usize::from(parent_row));
    }
    let hit =
        matches.get(pk.active).and_then(|&i| pk.listing.as_ref()?.entries.get(i)).map(|e| (e.name.clone(), e.repo));
    if tab {
        if let Some((name, _)) = &hit {
            walk_into(app, pk, which, name);
        }
    }
    if enter {
        match &hit {
            Some((name, repo)) if !prefix.is_empty() => {
                if *repo {
                    open = child(pk, name);
                } else {
                    walk_into(app, pk, which, name);
                }
            }
            _ => open = current(pk),
        }
    }
    if open_clicked {
        open = current(pk);
    }

    if let Some(listing) = pk.listing.as_ref().filter(|l| l.repo || pk.loading) {
        ui.add_space(6.0);
        ui.horizontal(|ui| {
            if listing.repo {
                badge(ui, "git repository", p.green_bg, p.green_fg);
            }
            if pk.loading {
                ui.label(RichText::new("...").size(11.0).color(p.fg_faint));
            }
        });
    }
    ui.add_space(6.0);

    let mut clicked: Option<usize> = None;
    let mut hovered: Option<usize> = None;
    let mut double = false;
    let rows = matches.len() + usize::from(parent_row);
    let listing = pk.listing.as_ref();
    let active = pk.active;
    let wanted = pk.scroll_to.take();
    let output = egui::Frame::new()
        .fill(p.bg_2)
        .stroke(Stroke::new(1.0, p.line))
        .corner_radius(3.0)
        .inner_margin(Margin::symmetric(0, 3))
        .show(ui, |ui| {
            ui.spacing_mut().item_spacing = Vec2::ZERO;
            let mut area = egui::ScrollArea::vertical()
                .id_salt(("repo-picker-list", host))
                .max_height(LIST_MAX_H)
                .auto_shrink([false, true]);
            if let Some(offset) = wanted {
                area = area.vertical_scroll_offset(offset);
            }
            let out = area.show_rows(ui, ROW_H, rows, |ui, range| {
                for row in range {
                    let (rect, resp) = ui.allocate_exact_size(Vec2::new(ui.available_width(), ROW_H), Sense::click());
                    if resp.double_clicked() {
                        double = true;
                    }
                    if parent_row && row == 0 {
                        let color = if resp.hovered() { p.fg } else { p.fg_dim };
                        paint_row(ui, rect, "folder", p.fg_faint, "..", color, None, p);
                        if resp.clicked() {
                            clicked = Some(usize::MAX);
                        }
                        continue;
                    }
                    let i = row - usize::from(parent_row);
                    let Some(entry) = matches.get(i).and_then(|&e| listing?.entries.get(e)) else { continue };
                    let is_active = i == active;
                    if is_active {
                        ui.painter().rect_filled(rect, 0.0, p.bg_4);
                    }
                    let color = if is_active {
                        p.fg_bright
                    } else if resp.hovered() || entry.repo {
                        p.fg
                    } else {
                        p.fg_dim
                    };
                    let (icon, icon_color) = if entry.repo { ("branch", p.green) } else { ("folder", p.fg_faint) };
                    let tag = entry.repo.then_some("repo");
                    paint_row(ui, rect, icon, icon_color, &entry.name, color, tag, p);
                    if resp.hovered() && ui.input(|inp| inp.pointer.delta() != Vec2::ZERO) {
                        hovered = Some(i);
                    }
                    let resp =
                        if entry.repo { resp.on_hover_text("Double-click to open this repository") } else { resp };
                    if resp.clicked() {
                        clicked = Some(i);
                    }
                }
            });
            if let Some(l) = listing {
                if matches.is_empty() {
                    let text = if l.entries.is_empty() { "No folders here" } else { "Nothing matches" };
                    note(ui, text, p.fg_faint);
                }
                if l.truncated {
                    note(ui, "Only the first 500 folders are listed.", p.fg_faint);
                }
            }
            out
        })
        .inner;
    pk.offset = output.state.clamped_offset().y;
    pk.view_h = output.inner_rect.height();

    if let Some(i) = hovered {
        pk.active = i;
    }
    match clicked {
        Some(usize::MAX) => go_up(app, pk, which),
        Some(i) => {
            let entry =
                matches.get(i).and_then(|&e| pk.listing.as_ref()?.entries.get(e)).map(|e| (e.name.clone(), e.repo));
            if let Some((name, repo)) = entry {
                pk.entered_repo = if repo { child(pk, &name) } else { None };
                walk_into(app, pk, which, &name);
            }
        }
        None => {}
    }
    if double {
        if let Some(path) = pk.entered_repo.take() {
            open = Some(path);
        }
    }
    open
}

fn load(app: &mut App, pk: &mut Picker, which: Which, path: &str) {
    pk.request += 1;
    let id = pk.request;
    pk.loading = true;
    let req = Request::Ls { path: path.to_string(), host: pk.host.clone().unwrap_or_default() };
    app.jobs.request(req, move |app, result: Result<Listing, String>| {
        let pk = which(app);
        if pk.request != id {
            return;
        }
        pk.loading = false;
        match result {
            Ok(listing) => {
                if pk.value.is_empty() {
                    pk.value = with_sep(&listing.path, &listing.sep);
                }
                pk.listing = Some(listing);
                pk.active = 0;
                pk.scroll_to = Some(0.0);
            }
            Err(_) => pk.listing = None,
        }
    });
}

fn walk_into(app: &mut App, pk: &mut Picker, which: Which, name: &str) {
    let Some(listing) = pk.listing.as_ref() else { return };
    let next = format!("{}{}{}", with_sep(&listing.path, &listing.sep), name, listing.sep);
    pk.value = next.clone();
    pk.edited = None;
    pk.focus = true;
    load(app, pk, which, &next);
}

fn go_up(app: &mut App, pk: &mut Picker, which: Which) {
    let Some(listing) = pk.listing.as_ref() else { return };
    let Some(parent) = listing.parent.as_ref() else { return };
    let next = with_sep(parent, &listing.sep);
    pk.value = next.clone();
    pk.edited = None;
    pk.focus = true;
    load(app, pk, which, &next);
}

fn child(pk: &Picker, name: &str) -> Option<String> {
    let listing = pk.listing.as_ref()?;
    Some(format!("{}{}", with_sep(&listing.path, &listing.sep), name))
}

fn current(pk: &Picker) -> Option<String> {
    let path = pk.value.trim().trim_end_matches(['/', '\\']);
    (!path.is_empty()).then(|| path.to_string())
}

fn with_sep(path: &str, sep: &str) -> String {
    let sep = if sep.is_empty() { "/" } else { sep };
    format!("{}{sep}", path.trim_end_matches(['/', '\\']))
}

fn scroll_into_view(pk: &mut Picker, row: usize) {
    let top = row as f32 * ROW_H;
    if top < pk.offset {
        pk.scroll_to = Some(top);
    } else if top + ROW_H > pk.offset + pk.view_h {
        pk.scroll_to = Some(top + ROW_H - pk.view_h);
    }
}

#[allow(clippy::too_many_arguments)]
fn paint_row(
    ui: &Ui,
    rect: Rect,
    icon: &str,
    icon_color: Color32,
    name: &str,
    color: Color32,
    tag: Option<&str>,
    p: super::theme::Palette,
) {
    let cy = rect.center().y;
    icons::paint(
        ui,
        Rect::from_center_size(Pos2::new(rect.left() + 10.0 + 6.5, cy), Vec2::splat(13.0)),
        icon,
        icon_color,
    );
    let tag_w = tag.map_or(0.0, |_| 44.0);
    let text = galley(ui, name, 12.0, color, (rect.width() - 31.0 - 10.0 - tag_w).max(0.0));
    ui.painter().galley(Pos2::new(rect.left() + 31.0, cy - text.size().y / 2.0), text, color);
    if let Some(tag) = tag {
        let t = galley(ui, tag, 10.0, p.green_fg, f32::INFINITY);
        let r = Rect::from_min_size(
            Pos2::new(rect.right() - 10.0 - t.size().x - 10.0, cy - 7.0),
            Vec2::new(t.size().x + 10.0, 14.0),
        );
        ui.painter().rect_filled(r, CornerRadius::same(7), p.green_bg);
        ui.painter().galley(Pos2::new(r.left() + 5.0, cy - t.size().y / 2.0), t, p.green_fg);
    }
}

fn badge(ui: &mut Ui, text: &str, bg: Color32, fg: Color32) {
    let t = galley(ui, text, 10.0, fg, f32::INFINITY);
    let (r, _) = ui.allocate_exact_size(Vec2::new(t.size().x + 12.0, 15.0), Sense::hover());
    ui.painter().rect_filled(r, CornerRadius::same(7), bg);
    ui.painter().galley(Pos2::new(r.left() + 6.0, r.center().y - t.size().y / 2.0), t, fg);
}

fn note(ui: &mut Ui, text: &str, color: Color32) {
    egui::Frame::new().inner_margin(Margin::symmetric(10, 8)).show(ui, |ui| {
        ui.label(RichText::new(text).size(11.0).color(color));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn separators() {
        assert_eq!(with_sep("C:\\Users\\me", "\\"), "C:\\Users\\me\\");
        assert_eq!(with_sep("/home/me/", "/"), "/home/me/");
        assert_eq!(with_sep("/", "/"), "/");
        let pk = Picker { value: " /code/repo/ ".into(), ..Picker::default() };
        assert_eq!(current(&pk).as_deref(), Some("/code/repo"));
    }
}
