use eframe::egui::text::{LayoutJob, TextFormat};
use eframe::egui::{
    Align, Align2, Color32, CursorIcon, FontId, Frame, Galley, Id, Layout, Margin, Painter, Pos2, Rect, RichText,
    ScrollArea, Sense, Stroke, StrokeKind, TextBuffer, TextEdit, Ui, UiBuilder, Vec2, pos2, vec2,
};

use super::super::diff_view::highlight as syntax;
use super::super::icons;
use super::super::theme::Palette;
use super::parse::{Pick, Side, Take};
use super::{Change, Doc, Intent, Labels, Look, Row, State, button, button_at, faded, label};

const ROW: f32 = 18.0;
const NUM_W: f32 = 40.0;
const TICK_W: f32 = 22.0;
const TEXT_X: f32 = NUM_W + TICK_W;
const MONO: f32 = 12.0;
const BAR: f32 = 30.0;
const HEAD: f32 = 26.0;
const GUTTER: i8 = 52;
const DONE_FADE: f32 = 0.78;

pub(super) fn draw(ui: &mut Ui, st: &mut State, p: &Palette, labels: &Labels, assist: bool) -> Vec<Intent> {
    let mut out = Vec::new();
    let full = ui.available_rect_before_wrap();
    ui.allocate_rect(full, Sense::hover());
    let bar = Rect::from_min_size(full.min, vec2(full.width(), BAR));
    path_bar(ui, bar, st, p, assist, &mut out);
    let mut top = bar.bottom();
    if let Some(error) = st.error.as_deref() {
        let strip = Rect::from_min_size(pos2(full.left(), top), vec2(full.width(), 34.0));
        error_strip(ui, strip.shrink2(vec2(8.0, 4.0)), error, p);
        top = strip.bottom();
    }
    let rest = Rect::from_min_max(pos2(full.left(), top), full.max);
    let (binary, loaded) = match st.doc.as_ref() {
        Some(doc) => (doc.binary, true),
        None => (false, false),
    };
    if !loaded || binary {
        let text = if binary {
            "Binary file: there are no lines to merge. Take one side from the panel."
        } else if st.loading {
            "Loading conflict..."
        } else {
            ""
        };
        ui.painter().text(rest.min + vec2(24.0, 24.0), Align2::LEFT_TOP, text, FontId::proportional(12.0), p.fg_muted);
        return out;
    }

    let split = if st.split > 0.0 { st.split } else { 0.55 };
    let room = (rest.height() - HEAD * 2.0).max(0.0);
    let sides_h = HEAD + room * split;
    let sides = Rect::from_min_size(rest.min, vec2(rest.width(), sides_h));
    let output = Rect::from_min_max(pos2(rest.left(), sides.bottom()), rest.max);

    let half = (sides.width() / 2.0).floor();
    let left = Rect::from_min_size(sides.min, vec2(half, sides.height()));
    let right = Rect::from_min_max(pos2(left.right(), sides.top()), sides.max);
    let body_h = (sides.height() - HEAD).max(0.0);
    if let Some(conflict) = st.scroll_to.take() {
        scroll_to(st, conflict, body_h, (output.height() - HEAD).max(0.0));
    }

    let a = pane(ui, left, Side::Ours, st, p, labels, &mut out);
    let b = pane(ui, right, Side::Theirs, st, p, labels, &mut out);
    ui.painter().vline(left.right() - 0.5, sides.y_range(), Stroke::new(1.0, p.bg_3));
    if st.sync.take().is_some() {
        st.last = a;
    } else if a != st.last {
        st.sync = Some(a);
        st.last = a;
        ui.ctx().request_repaint();
    } else if b != st.last {
        st.sync = Some(b);
        st.last = b;
        ui.ctx().request_repaint();
    }

    let handle = Rect::from_min_max(pos2(rest.left(), sides.bottom() - 3.0), pos2(rest.right(), sides.bottom() + 3.0));
    let drag = ui.interact(handle, Id::unique("merge_split"), Sense::drag());
    if drag.hovered() || drag.dragged() {
        ui.ctx().set_cursor_icon(CursorIcon::ResizeVertical);
    }
    if let Some(pointer) = drag.interact_pointer_pos().filter(|_| drag.dragged()) {
        if room > 0.0 {
            st.split = ((pointer.y - rest.top() - HEAD) / room).clamp(0.15, 0.85);
        }
    }
    output_pane(ui, output, st, p, &mut out);
    out
}

fn scroll_to(st: &mut State, conflict: usize, view_h: f32, out_view_h: f32) {
    let Some(doc) = st.doc.as_ref() else { return };
    let (head, len) = doc.block(conflict);
    let margin = ((view_h - len as f32 * ROW) / 2.0).max(0.0);
    st.sync = Some(vec2(st.last.x, (head as f32 * ROW - margin).max(0.0)));
    if st.manual {
        return;
    }
    if let Some(line) = st.starts.get(conflict) {
        st.out_jump = Some((*line as f32 * ROW - out_view_h / 3.0).max(0.0));
    }
}

fn path_bar(ui: &mut Ui, rect: Rect, st: &State, p: &Palette, assist: bool, out: &mut Vec<Intent>) {
    ui.painter().rect_filled(rect, 0.0, p.bg_1);
    ui.painter().hline(rect.x_range(), rect.bottom() - 0.5, Stroke::new(1.0, p.line));
    let mut bar = ui.new_child(
        UiBuilder::new()
            .id_salt("merge_bar")
            .max_rect(rect.shrink2(vec2(8.0, 0.0)))
            .layout(Layout::right_to_left(Align::Center)),
    );
    bar.spacing_mut().item_spacing.x = 8.0;
    let pad = vec2(10.0, 4.0);
    let loaded = st.doc.as_ref().is_some_and(|d| !d.binary);

    if icons::button(&mut bar, "close", 14.0, "Close (Esc)").clicked() {
        out.push(Intent::Close);
    }
    if loaded {
        let can = st.can_save();
        let look = Look::new(p.green_bg, p.green_line, p.green_fg).hover(p.green_line, p.green_fg);
        let text = if st.saving { "Saving..." } else { "Save & mark resolved" };
        let tip = if st.still_marked() {
            "The output still contains conflict markers"
        } else if !can {
            "Decide every conflict first, or edit the output by hand"
        } else {
            "Write the output and mark the file resolved (Ctrl+S)"
        };
        let saved =
            button(&mut bar, text, 11.0, pad, 240.0, look, can, p).on_hover_text(tip).on_disabled_hover_text(tip);
        if saved.clicked() {
            out.push(Intent::Save);
        }
        let total = st.picks.len();
        if icons::button(&mut bar, "arrowDown", 13.0, "Next conflict").clicked() {
            out.push(Intent::Jump(1));
        }
        if icons::button(&mut bar, "arrowUp", 13.0, "Previous conflict").clicked() {
            out.push(Intent::Jump(-1));
        }
        let at = if total == 0 { 0 } else { st.current + 1 };
        bar.label(RichText::new(format!("conflict {at} of {total}")).size(11.0).color(p.fg_muted));
        if assist {
            let look = Look::new(p.bg_2, p.line_strong, p.fg_dim).hover(p.bg_3, p.accent_fg);
            let offered = st.ai.as_ref().is_some_and(|picks| picks.iter().any(|a| a.reason.is_none()));
            if offered
                && button(&mut bar, "Accept all suggestions", 11.0, vec2(9.0, 3.0), 200.0, look, true, p)
                    .on_hover_text("Tick every suggested line in this file")
                    .clicked()
            {
                out.push(Intent::Change(Change::Accept(None)));
            }
            let text = if st.suggesting { "Suggesting..." } else { "Suggest picks" };
            let tip = "Ask the AI which lines to keep in each conflict of this file. It only picks lines, and says when a conflict needs more.";
            if button(&mut bar, text, 11.0, vec2(9.0, 3.0), 200.0, look, !st.suggesting && total > 0, p)
                .on_hover_text(tip)
                .clicked()
            {
                out.push(Intent::Suggest);
            }
            icons::show(&mut bar, "sparkle", 12.0, if st.suggesting { p.accent } else { p.fg_dim });
        }
    }
    bar.with_layout(Layout::left_to_right(Align::Center), |ui| {
        icons::show(ui, "warning", 13.0, p.amber);
        if loaded {
            let total = st.picks.len();
            let undecided = st.undecided();
            let (text, color) = if undecided > 0 {
                (format!("{undecided} of {total} still to decide"), p.amber)
            } else {
                (format!("all {total} resolved"), p.green_fg)
            };
            let room = ui.available_width();
            let count = label(ui, &text, 11.0, f32::INFINITY, color);
            let name = label(ui, &st.path, 12.0, (room - count.size().x - 8.0).max(30.0), p.fg_bright);
            put(ui, name, p.fg_bright).on_hover_text(&st.path);
            put(ui, count, color);
        } else {
            ui.label(RichText::new(&st.path).size(12.0).strong().color(p.fg_bright));
        }
    });
}

fn put(ui: &mut Ui, galley: std::sync::Arc<Galley>, color: Color32) -> eframe::egui::Response {
    let (rect, response) = ui.allocate_exact_size(galley.size(), Sense::hover());
    ui.painter().galley(rect.min, galley, color);
    response
}

fn error_strip(ui: &Ui, rect: Rect, error: &str, p: &Palette) {
    ui.painter().rect(rect, 3.0, p.red_bg, Stroke::new(1.0, p.red_line), StrokeKind::Inside);
    let text = label(ui, error.lines().next().unwrap_or(""), 11.0, rect.width() - 18.0, p.red_fg);
    ui.painter().galley(pos2(rect.left() + 9.0, rect.center().y - text.size().y / 2.0), text, p.red_fg);
}

fn pane(ui: &mut Ui, rect: Rect, side: Side, st: &State, p: &Palette, labels: &Labels, out: &mut Vec<Intent>) -> Vec2 {
    let Some(doc) = st.doc.as_ref() else { return Vec2::ZERO };
    let head = Rect::from_min_size(rect.min, vec2(rect.width(), HEAD));
    side_head(ui, head, side, p, labels);
    let body = Rect::from_min_max(pos2(rect.left(), head.bottom()), rect.max);
    let font = FontId::monospace(MONO);
    let char_w = ui.fonts_mut(|f| f.glyph_width(&font, 'x'));
    let content_w = TEXT_X + doc.widest as f32 * char_w + 24.0;
    let salt = if side == Side::Ours { "merge_a" } else { "merge_b" };
    let mut area = ScrollArea::both().id_salt(salt).auto_shrink(false);
    if let Some(offset) = st.sync {
        area = area.scroll_offset(offset);
    }
    let mut child = ui.new_child(UiBuilder::new().id_salt(salt).max_rect(body));
    child.set_clip_rect(body.intersect(ui.clip_rect()));
    child.spacing_mut().item_spacing = Vec2::ZERO;
    let shown = area.show_rows(&mut child, ROW, doc.rows.len(), |ui, range| {
        let width = ui.available_width().max(content_w);
        for index in range {
            let (rect, _) = ui.allocate_exact_size(vec2(width, ROW), Sense::hover());
            if let Some(row) = doc.rows.get(index) {
                paint_row(ui, rect, index, *row, side, st, doc, p, &font, out);
            }
        }
    });
    shown.state.clamped_offset()
}

fn side_head(ui: &Ui, rect: Rect, side: Side, p: &Palette, labels: &Labels) {
    let painter = ui.painter();
    painter.rect_filled(rect, 0.0, p.bg_1);
    painter.hline(rect.x_range(), rect.bottom() - 0.5, Stroke::new(1.0, p.line));
    let (tag, fill, fg, name, hint) = match (side, labels.operation.as_str()) {
        (Side::Ours, "rebase") => ("A", p.chip_head, p.chip_head_fg, &labels.ours, "the branch you are moving onto"),
        (Side::Ours, _) => ("A", p.chip_head, p.chip_head_fg, &labels.ours, "the branch you are on"),
        (Side::Theirs, "merge") => ("B", p.amber_bg, p.amber_fg, &labels.theirs, "the branch being merged in"),
        (Side::Theirs, "unmerged") => ("B", p.amber_bg, p.amber_fg, &labels.theirs, "the changes being restored"),
        (Side::Theirs, _) => ("B", p.amber_bg, p.amber_fg, &labels.theirs, "the change being applied"),
    };
    let box_rect = Rect::from_center_size(pos2(rect.left() + 19.0, rect.center().y), vec2(18.0, 18.0));
    painter.rect_filled(box_rect, 3.0, fill);
    painter.text(box_rect.center(), Align2::CENTER_CENTER, tag, FontId::proportional(11.0), fg);
    let room = (rect.width() - 46.0).max(20.0);
    let name = label(ui, name, 12.0, room * 0.6, p.fg_bright);
    let x = box_rect.right() + 8.0;
    let name_w = name.size().x;
    painter.galley(pos2(x, rect.center().y - name.size().y / 2.0), name, p.fg_bright);
    let hint = label(ui, hint, 11.0, (room - name_w - 8.0).max(0.0), p.fg_faint);
    painter.galley(pos2(x + name_w + 8.0, rect.center().y - hint.size().y / 2.0), hint, p.fg_faint);
}

#[allow(clippy::too_many_arguments)]
fn paint_row(
    ui: &Ui,
    rect: Rect,
    index: usize,
    row: Row,
    side: Side,
    st: &State,
    doc: &Doc,
    p: &Palette,
    font: &FontId,
    out: &mut Vec<Intent>,
) {
    let painter = ui.painter();
    let theirs = side == Side::Theirs;
    match row {
        Row::Stable { ours, theirs: other } => {
            let n = if theirs { other } else { ours };
            number(painter, rect, n, font, p.fg_faint);
            text(painter, rect, doc, side, n, font, p.fg, p);
        }
        Row::Head(conflict) => head_row(ui, rect, conflict, side, st, p, out),
        Row::Line { conflict, ours, theirs: other } => {
            let cell = if theirs { other } else { ours };
            let pick = st.picks.get(conflict);
            let fade = if pick.is_some_and(Pick::decided) { DONE_FADE } else { 1.0 };
            hunk_bg(painter, rect, side, conflict == st.current, fade, p);
            let last = !matches!(doc.rows.get(index + 1), Some(Row::Line { conflict: c, .. }) if *c == conflict);
            if last {
                painter.hline(rect.x_range(), rect.bottom() - 0.5, Stroke::new(1.0, p.bg_2));
            }
            let Some((line, n)) = cell else {
                hatch(painter, rect.intersect(ui.clip_rect()));
                return;
            };
            let picked = pick.and_then(|k| k.side(side).get(line).copied()).unwrap_or(false);
            let suggested = suggestion(st, conflict, side).is_some_and(|lines| lines.contains(&line));
            let response = ui.interact(rect, Id::unique(("merge_line", theirs, index)), Sense::click());
            if picked {
                painter.rect_filled(rect, 0.0, Color32::from_white_alpha(23));
            }
            if suggested {
                painter.rect_filled(rect, 0.0, p.accent.gamma_multiply(0.1));
                painter.rect_filled(Rect::from_min_size(rect.min, vec2(2.0, rect.height())), 0.0, p.accent);
            }
            if response.hovered() {
                painter.rect_filled(rect, 0.0, Color32::from_white_alpha(10));
            }
            number(painter, rect, n, font, faded(p.fg_faint, fade));
            checkbox(painter, pos2(rect.left() + NUM_W + TICK_W / 2.0, rect.center().y), picked, response.hovered(), p);
            text(painter, rect, doc, side, n, font, faded(p.fg, fade), p);
            let tip = if picked { "Leave this line out of the output" } else { "Put this line in the output" };
            if response.on_hover_text(tip).clicked() {
                out.push(Intent::Focus(conflict));
                out.push(Intent::Change(Change::Line { conflict, side, line, on: !picked }));
            }
        }
    }
}

fn head_row(ui: &Ui, rect: Rect, conflict: usize, side: Side, st: &State, p: &Palette, out: &mut Vec<Intent>) {
    let Some(pick) = st.picks.get(conflict) else { return };
    let theirs = side == Side::Theirs;
    let painter = ui.painter();
    let fade = if pick.decided() { DONE_FADE } else { 1.0 };
    hunk_bg(painter, rect, side, conflict == st.current, fade, p);
    painter.hline(rect.x_range(), rect.top() + 0.5, Stroke::new(1.0, p.bg_2));
    if ui.interact(rect, Id::unique(("merge_head", theirs, conflict)), Sense::click()).clicked() {
        out.push(Intent::Focus(conflict));
    }
    let cy = rect.center().y;
    let name = label(ui, &format!("conflict {}", conflict + 1), 11.0, f32::INFINITY, p.fg_muted);
    let mut x = rect.left() + NUM_W + name.size().x + 8.0;
    painter.galley(pos2(rect.left() + NUM_W, cy - name.size().y / 2.0), name, p.fg_muted);

    let plain = Look::new(Color32::from_white_alpha(13), p.line, p.fg_dim).hover(Color32::from_white_alpha(36), p.fg);
    let on = Look::new(p.green_bg, p.green_line, p.green_fg).hover(p.green_line, p.green_fg);
    let chip = |key: &str, text: &str, look: Look, tip: &str, x: &mut f32| {
        let response =
            button_at(ui, Id::unique(("merge_chip", key, theirs, conflict)), pos2(*x, cy), 15.0, text, 10.0, look, p);
        *x = response.rect.right() + 6.0;
        response.on_hover_text(tip).clicked()
    };

    let lines = pick.side(side).len();
    let taken = pick.taken(side);
    let (text, tip) = if taken {
        ("taken".to_string(), "Drop this side again".to_string())
    } else if lines == 0 {
        (
            "take (no lines)".to_string(),
            "This side has no lines here: take that, leaving the other side out".to_string(),
        )
    } else {
        (
            format!("take all {lines}"),
            format!("Take all {lines} line{} from this side only", if lines == 1 { "" } else { "s" }),
        )
    };
    if chip("take", &text, if taken { on } else { plain }, &tip, &mut x) {
        out.push(Intent::Focus(conflict));
        let change =
            if taken { Change::Drop { conflict, side } } else { Change::Take { conflict, take: Take::Only(side) } };
        out.push(Intent::Change(change));
    }

    if theirs {
        let (text, fill, fg) = if pick.decided() {
            ("resolved", p.green.gamma_multiply(0.22), p.green_fg)
        } else {
            ("not resolved", p.amber.gamma_multiply(0.2), p.amber_fg)
        };
        let tag = label(ui, text, 10.0, f32::INFINITY, fg);
        let right = rect.right().min(ui.clip_rect().right()) - 8.0;
        let pill = Rect::from_min_max(
            pos2((right - tag.size().x - 14.0).max(x), cy - 8.0),
            pos2(right.max(x + tag.size().x + 14.0), cy + 8.0),
        );
        painter.rect_filled(pill, 8.0, fill);
        painter.galley(pill.center() - tag.size() / 2.0, tag, fg);
        return;
    }

    let both_there = !pick.ours.is_empty() && !pick.theirs.is_empty();
    let both_taken = both_there && pick.taken(Side::Ours) && pick.taken(Side::Theirs);
    for (theirs_first, key, text, tip) in [
        (false, "ab", "both, A first", "Take both sides, A above B"),
        (true, "ba", "both, B first", "Take both sides, B above A"),
    ] {
        let active = both_taken && pick.theirs_first == theirs_first;
        if chip(key, text, if active { on } else { plain }, tip, &mut x) {
            out.push(Intent::Focus(conflict));
            out.push(Intent::Change(Change::Take { conflict, take: Take::Both { theirs_first } }));
        }
    }
    let mixed = pick.ours.iter().any(|b| *b) && pick.theirs.iter().any(|b| *b);
    if mixed && !both_taken {
        let tip = if pick.theirs_first {
            "B's lines are written first: put A's first"
        } else {
            "A's lines are written first: put B's first"
        };
        if chip("swap", "swap order", plain, tip, &mut x) {
            out.push(Intent::Focus(conflict));
            out.push(Intent::Change(Change::Swap(conflict)));
        }
    }
    let Some(ai) = st.ai.as_ref().and_then(|a| a.get(conflict)) else { return };
    match ai.reason.as_deref() {
        None => {
            let look = Look::new(Color32::from_white_alpha(13), p.accent_line, p.accent_fg)
                .hover(Color32::from_white_alpha(36), p.accent_fg);
            if chip("accept", "accept suggestion", look, "Tick the lines the suggestion picked, on both sides", &mut x)
            {
                out.push(Intent::Focus(conflict));
                out.push(Intent::Change(Change::Accept(Some(conflict))));
            }
        }
        Some(reason) => {
            let room = rect.right().min(ui.clip_rect().right()) - x - 8.0;
            if room > 30.0 {
                let mut job = LayoutJob::simple_singleline(
                    format!("no suggestion: {reason}"),
                    FontId::proportional(11.0),
                    p.fg_muted,
                );
                if let Some(section) = job.sections.first_mut() {
                    section.format.italics = true;
                }
                job.wrap = eframe::egui::text::TextWrapping::truncate_at_width(room);
                let galley = painter.layout_job(job);
                let at = Rect::from_min_size(pos2(x, cy - galley.size().y / 2.0), galley.size());
                painter.galley(at.min, galley, p.fg_muted);
                ui.interact(at, Id::unique(("merge_reason", conflict)), Sense::hover()).on_hover_text(reason);
            }
        }
    }
}

fn suggestion(st: &State, conflict: usize, side: Side) -> Option<&[usize]> {
    let ai = st.ai.as_ref()?.get(conflict)?;
    if ai.reason.is_some() {
        return None;
    }
    match side {
        Side::Ours => ai.ours.as_deref(),
        Side::Theirs => ai.theirs.as_deref(),
    }
}

fn output_pane(ui: &mut Ui, rect: Rect, st: &mut State, p: &Palette, out: &mut Vec<Intent>) {
    let head = Rect::from_min_size(rect.min, vec2(rect.width(), HEAD));
    ui.painter().rect_filled(head, 0.0, p.bg_1);
    ui.painter().hline(head.x_range(), head.top() + 0.5, Stroke::new(1.0, p.line_hard));
    ui.painter().hline(head.x_range(), head.bottom() - 0.5, Stroke::new(1.0, p.line));
    let mut bar = ui.new_child(
        UiBuilder::new()
            .id_salt("merge_out_head")
            .max_rect(head.shrink2(vec2(10.0, 0.0)))
            .layout(Layout::left_to_right(Align::Center)),
    );
    bar.spacing_mut().item_spacing.x = 10.0;
    bar.label(RichText::new("Output").size(12.0).strong().color(p.fg_bright));
    if st.manual {
        bar.label(RichText::new("edited by hand").size(11.0).color(p.amber_fg));
        let look = Look::new(p.bg_3, p.line, p.fg_dim).hover(p.bg_4, p.fg);
        if button(&mut bar, "rebuild from selections", 10.0, vec2(7.0, 2.0), 200.0, look, true, p)
            .on_hover_text("Rebuild the output from the selections")
            .clicked()
        {
            out.push(Intent::Rebuild);
        }
    }
    if st.still_marked() {
        bar.label(RichText::new("conflict markers still present").size(11.0).color(p.red_fg));
    }
    bar.with_layout(Layout::right_to_left(Align::Center), |ui| {
        ui.label(RichText::new("editable: type anything neither side has").size(11.0).color(p.fg_faint));
    });

    let body = Rect::from_min_max(pos2(rect.left(), head.bottom()), rect.max);
    let mut child = ui.new_child(UiBuilder::new().id_salt("merge_output").max_rect(body));
    child.set_clip_rect(body.intersect(ui.clip_rect()));
    let mut area = ScrollArea::both().id_salt("merge_output").auto_shrink(false);
    if let Some(y) = st.out_jump.take() {
        area = area.vertical_scroll_offset(y);
    }
    let font = FontId::monospace(MONO);
    let mut changed = false;
    let mut width = st.out_width;
    let path = st.path.as_str();
    let colors = &mut st.colors;
    area.show(&mut child, |ui| {
        let mut layouter = |ui: &Ui, buf: &dyn TextBuffer, _wrap: f32| {
            colors.follow(buf.as_str(), path);
            colors.galley(ui, &font, p, ROW)
        };
        let size = vec2(ui.available_width().max(st.out_width), ui.available_height());
        let edit = TextEdit::multiline(&mut st.output)
            .id(Id::unique("merge_output_text"))
            .code_editor()
            .font(font.clone())
            .desired_width(f32::INFINITY)
            .min_size(size)
            .frame(Frame::new().inner_margin(Margin { left: GUTTER, right: 12, top: 6, bottom: 6 }))
            .layouter(&mut layouter)
            .show(ui);
        changed = edit.response.changed();
        width = edit.galley.size().x + f32::from(GUTTER) + 24.0;
        gutter(ui, &edit.galley, edit.galley_pos, &font, p);
    });
    if changed {
        st.manual = true;
    }
    if !st.colors.exact && !st.colors.pending {
        out.push(Intent::Colorize);
    }
    if (width - st.out_width).abs() > 0.5 {
        st.out_width = width;
        ui.ctx().request_repaint();
    }
}

fn gutter(ui: &Ui, galley: &Galley, origin: Pos2, font: &FontId, p: &Palette) {
    let clip = ui.clip_rect();
    let strip = Rect::from_min_max(clip.min, pos2(clip.left() + f32::from(GUTTER) - 8.0, clip.bottom()));
    let painter = ui.painter();
    painter.rect_filled(strip, 0.0, p.bg_0);
    painter.vline(strip.right() - 0.5, strip.y_range(), Stroke::new(1.0, p.bg_2));
    let first = galley.rows.partition_point(|r| origin.y + r.pos.y + r.size.y < clip.top());
    for (i, row) in galley.rows.iter().enumerate().skip(first) {
        let y = origin.y + row.pos.y;
        if y > clip.bottom() {
            break;
        }
        painter.text(
            pos2(strip.right() - 8.0, y + row.size.y / 2.0),
            Align2::RIGHT_CENTER,
            (i + 1).to_string(),
            font.clone(),
            p.fg_faint,
        );
    }
}

fn hunk_bg(painter: &Painter, rect: Rect, side: Side, current: bool, fade: f32, p: &Palette) {
    let fill = if side == Side::Ours { p.chip_head } else { p.amber_bg };
    painter.rect_filled(rect, 0.0, faded(fill, fade));
    if current {
        painter.rect_filled(Rect::from_min_size(rect.min, vec2(3.0, rect.height())), 0.0, p.accent);
    }
}

fn hatch(painter: &Painter, rect: Rect) {
    if rect.width() <= 0.0 || rect.height() <= 0.0 {
        return;
    }
    let painter = painter.with_clip_rect(rect);
    let stroke = Stroke::new(1.0, Color32::from_white_alpha(13));
    let h = rect.height();
    let mut x = (rect.left() / 5.0).floor() * 5.0 - h;
    while x < rect.right() {
        painter.line_segment([pos2(x, rect.bottom()), pos2(x + h, rect.top())], stroke);
        x += 5.0;
    }
}

fn checkbox(painter: &Painter, center: Pos2, on: bool, hover: bool, p: &Palette) {
    let r = Rect::from_center_size(center, vec2(13.0, 13.0));
    if !on {
        let edge = if hover { p.fg_muted } else { p.fg_faint };
        painter.rect(r, 3.0, p.bg_inset, Stroke::new(1.0, edge), StrokeKind::Inside);
        return;
    }
    painter.rect(r, 3.0, p.accent, Stroke::new(1.0, p.accent), StrokeKind::Inside);
    let stroke = Stroke::new(2.0, p.bg_inset);
    let mid = pos2(r.left() + 5.5, r.bottom() - 3.5);
    painter.line_segment([pos2(r.left() + 3.0, r.center().y), mid], stroke);
    painter.line_segment([mid, pos2(r.right() - 3.0, r.top() + 3.5)], stroke);
}

fn number(painter: &Painter, rect: Rect, n: usize, font: &FontId, color: Color32) {
    painter.text(
        pos2(rect.left() + NUM_W - 8.0, rect.center().y),
        Align2::RIGHT_CENTER,
        (n + 1).to_string(),
        font.clone(),
        color,
    );
}

#[allow(clippy::too_many_arguments)]
fn text(painter: &Painter, rect: Rect, doc: &Doc, side: Side, n: usize, font: &FontId, color: Color32, p: &Palette) {
    let (lines, toks) = if side == Side::Ours { (&doc.ours, &doc.ours_toks) } else { (&doc.theirs, &doc.theirs_toks) };
    let Some(line) = lines.get(n).filter(|l| !l.is_empty()) else { return };
    let mut job = LayoutJob::default();
    let base = TextFormat::simple(font.clone(), color);
    syntax::append(&mut job, line, toks.get(n).map(Vec::as_slice).unwrap_or_default(), p, &base);
    let galley = painter.layout_job(job);
    painter.galley(pos2(rect.left() + TEXT_X, rect.center().y - galley.size().y / 2.0), galley, color);
}
