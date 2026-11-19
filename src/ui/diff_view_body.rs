use eframe::egui::{
    self, Align, Align2, Color32, CursorIcon, FontId, Layout, Painter, Pos2, Rect, Response, RichText, ScrollArea,
    Sense, Stroke, Ui, UiBuilder, Vec2, pos2,
    text::{LayoutJob, TextFormat},
};

use super::highlight::{Syn, Token};
use super::words::Span;
use super::{LineExtra, Mode, apply, copy_text, media, patch};
use crate::engine::types::{DiffLine, DiffTarget, FileDiff};
use crate::ui::App;
use crate::ui::dialogs::{Confirm, MenuItem};
use crate::ui::theme::Palette;

const ROW_H: f32 = 16.0;
const HEAD_H: f32 = 28.0;
const NUM_W: f32 = 44.0;
const MARK_W: f32 = 14.0;
const PAD_R: f32 = 16.0;
const FONT: f32 = 12.0;

#[derive(Clone, Copy, Debug)]
enum Row {
    Head(usize),
    Line(usize, usize),
    Pair(usize, Option<usize>, Option<usize>),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Side {
    Unified,
    Left,
    Right,
}

struct Pick {
    side: Side,
    from: usize,
    to: usize,
    dragging: bool,
}

/// The rows on screen and their measured heights, rebuilt only when the diff, the mode or the width changes.
#[derive(Default)]
pub struct View {
    rows: Vec<Row>,
    rows_for: Option<(u64, Mode, bool)>,
    prefix: Vec<f32>,
    max_cols: usize,
    layout_for: Option<(u64, Mode, bool, usize, usize)>,
    pick: Option<Pick>,
    pub confirm_discard: Option<usize>,
    /// -1 or 1 when the toolbar asked for the previous or next change.
    pub step: i32,
    scroll_to: Option<f32>,
    offset: f32,
}

struct Ctx<'a> {
    diff: &'a FileDiff,
    extra: &'a [Vec<LineExtra>],
    p: &'a Palette,
    generation: u64,
    mode: Mode,
    file_view: bool,
    ws: bool,
    wrap: bool,
    tab: usize,
    can_apply: bool,
    staged: bool,
    busy: bool,
}

#[derive(Default)]
struct Outcome {
    apply: Option<(&'static str, String)>,
    menu: Option<(Pos2, Vec<MenuItem>)>,
    copy: Option<String>,
}

impl View {
    pub fn reset(&mut self) {
        self.pick = None;
        self.confirm_discard = None;
        self.scroll_to = Some(0.0);
    }
}

pub fn show(app: &mut App, ui: &mut Ui, id: &str) {
    let p = app.palette;
    let Some(repo) = app.repos.get_mut(id) else { return };
    let busy = repo.busy;
    let Some(open) = &repo.open_file else { return };
    let (editable, staged) = match &open.target {
        DiffTarget::Wip { worktree: None, staged, .. } => (true, *staged),
        _ => (false, false),
    };
    let st = &mut repo.diff;
    if let Some(e) = &st.error {
        note(ui, e, &p);
        return;
    }
    let Some((_, loaded)) = &st.loaded else {
        note(ui, "Loading diff...", &p);
        return;
    };
    if let Some(kind) = st.media_kind {
        media::show(ui, &st.media, kind, &p);
        return;
    }
    let diff = &loaded.diff;
    let empty = if diff.too_large {
        Some("File is too large to display.")
    } else if diff.binary {
        Some("Binary file, no textual diff.")
    } else if diff.hunks.is_empty() {
        Some("No changes to this file in the selection.")
    } else {
        None
    };
    if let Some(text) = empty {
        note(ui, text, &p);
        return;
    }
    let c = Ctx {
        diff,
        extra: &loaded.extra,
        p: &p,
        generation: st.generation,
        mode: st.mode,
        file_view: st.file_view,
        ws: st.ws,
        wrap: app.settings.diff_wrap,
        tab: app.settings.tab_size.max(1),
        can_apply: editable && st.mode == Mode::Unified && !st.file_view && patch::can_apply_hunks(diff),
        staged,
        busy,
    };
    let out = draw(ui, &mut st.view, &c, id);

    if let Some(text) = out.copy {
        copy_text(app, id, text);
    }
    if let Some((mode, patch)) = out.apply {
        app.later.add(move |app| apply(app, mode, patch));
    }
    if let Some((pos, items)) = out.menu {
        let ctx = app.ctx.clone();
        app.overlay.menu(&ctx, pos, items);
    }
}

fn draw(ui: &mut Ui, view: &mut View, c: &Ctx, tab_id: &str) -> Outcome {
    let mono = FontId::monospace(FONT);
    let cw = ui.fonts_mut(|f| f.glyph_width(&mono, 'M')).max(1.0);
    let split = c.mode == Mode::Split && !c.file_view;
    let text_x = if split { NUM_W } else { 2.0 * NUM_W + MARK_W };
    let avail = (ui.available_width() - 4.0).max(200.0);
    let room = if split { avail / 2.0 - NUM_W - PAD_R } else { avail - text_x - PAD_R };
    let cpr = if c.wrap { ((room / cw).floor() as usize).max(8) } else { 0 };

    let rows_key = (c.generation, c.mode, c.file_view);
    if view.rows_for != Some(rows_key) {
        view.rows = build_rows(c.diff, c.mode, c.file_view);
        view.rows_for = Some(rows_key);
        view.layout_for = None;
        view.pick = None;
    }
    let layout_key = (c.generation, c.mode, c.file_view, cpr, c.tab);
    if view.layout_for != Some(layout_key) {
        (view.prefix, view.max_cols) = measure(&view.rows, c.diff, cpr, c.tab);
        view.layout_for = Some(layout_key);
    }
    let total = view.prefix.last().copied().unwrap_or(0.0);
    let natural = view.max_cols as f32 * cw + PAD_R;
    let half = if !split {
        0.0
    } else if c.wrap {
        avail / 2.0
    } else {
        (avail / 2.0).max(NUM_W + natural)
    };
    let width = if split {
        half * 2.0
    } else if c.wrap {
        avail
    } else {
        avail.max(text_x + natural)
    };
    let wrap_px = (cpr > 0).then_some(cpr as f32 * cw + 0.5);

    if view.step != 0 {
        if let Some(y) = step_target(view, c, view.step) {
            view.scroll_to = Some(y);
        }
        view.step = 0;
    }

    let mut area =
        if c.wrap { ScrollArea::vertical() } else { ScrollArea::both() }.id_salt("diff-body").auto_shrink(false);
    if let Some(y) = view.scroll_to.take() {
        area = area.vertical_scroll_offset(y);
    }
    let mut out = Outcome::default();
    area.show_viewport(ui, |ui, viewport| {
        view.offset = viewport.min.y;
        let (rect, response) = ui.allocate_exact_size(Vec2::new(width, total), Sense::click_and_drag());
        let geo = Geo { rect, split, half, text_x };
        interact(ui, &response, &geo, view, c, tab_id, &mut out);

        let painter = ui.painter().clone();
        let first = view.prefix.partition_point(|&y| y <= viewport.min.y).saturating_sub(1);
        for i in first..view.rows.len() {
            let (Some(&top), Some(&bottom), Some(&row)) =
                (view.prefix.get(i), view.prefix.get(i + 1), view.rows.get(i))
            else {
                break;
            };
            if top > viewport.max.y {
                break;
            }
            let row_rect =
                Rect::from_min_max(pos2(rect.left(), rect.top() + top), pos2(rect.right(), rect.top() + bottom));
            let picked = view.pick.as_ref().filter(|p| p.from.min(p.to) <= i && i <= p.from.max(p.to)).map(|p| p.side);
            match row {
                Row::Head(h) => {
                    paint_head(&painter, row_rect, c, h, if split { 52.0 } else { 92.0 });
                    if c.can_apply {
                        hunk_buttons(ui, row_rect, view, c, h, &mut out);
                    }
                }
                Row::Line(h, l) => paint_unified(&painter, row_rect, c, h, l, picked.is_some(), wrap_px),
                Row::Pair(h, a, b) => {
                    let left = Rect::from_min_max(row_rect.min, pos2(rect.left() + half, row_rect.bottom()));
                    let right = Rect::from_min_max(pos2(rect.left() + half, row_rect.top()), row_rect.max);
                    paint_cell(&painter, left, c, h, a, Side::Left, picked == Some(Side::Left), wrap_px);
                    paint_cell(&painter, right, c, h, b, Side::Right, picked == Some(Side::Right), wrap_px);
                    painter.vline(left.right() - 0.5, left.y_range(), Stroke::new(1.0, c.p.bg_3));
                }
            }
        }
    });
    out
}

struct Geo {
    rect: Rect,
    split: bool,
    half: f32,
    text_x: f32,
}

impl Geo {
    fn side(&self, pos: Pos2) -> Side {
        match (self.split, pos.x - self.rect.left() < self.half) {
            (false, _) => Side::Unified,
            (true, true) => Side::Left,
            (true, false) => Side::Right,
        }
    }

    fn in_gutter(&self, pos: Pos2) -> bool {
        let x = pos.x - self.rect.left();
        if !self.split {
            return x < self.text_x;
        }
        let x = if x >= self.half { x - self.half } else { x };
        x < NUM_W
    }
}

fn interact(ui: &Ui, response: &Response, geo: &Geo, view: &mut View, c: &Ctx, tab_id: &str, out: &mut Outcome) {
    let row_at = |pos: Pos2| -> Option<usize> {
        let y = pos.y - geo.rect.top();
        if y < 0.0 {
            return None;
        }
        view.prefix.partition_point(|&t| t <= y).checked_sub(1).filter(|&i| i < view.rows.len())
    };
    let hover = response.hover_pos();
    if let Some(pos) = hover
        && response.hovered()
        && geo.in_gutter(pos)
    {
        ui.ctx().set_cursor_icon(CursorIcon::Copy);
    }
    let pointer = ui.input(|i| i.pointer.interact_pos());
    if response.hovered() && ui.input(|i| i.pointer.primary_pressed()) {
        view.confirm_discard = None;
        view.pick = None;
        if let Some(pos) = pointer
            && geo.in_gutter(pos)
            && let Some(r) = row_at(pos)
            && view.rows.get(r).and_then(|row| line_at(*row, geo.side(pos))).is_some()
        {
            view.pick = Some(Pick { side: geo.side(pos), from: r, to: r, dragging: true });
        }
    }
    let dragged_to = pointer.and_then(row_at);
    if let Some(pick) = view.pick.as_mut()
        && pick.dragging
    {
        if let Some(r) = dragged_to {
            pick.to = r;
        }
        if !ui.input(|i| i.pointer.primary_down()) {
            pick.dragging = false;
            let (from, to, side) = (pick.from.min(pick.to), pick.from.max(pick.to), pick.side);
            out.copy = Some(texts(view, c, from, to, side).join("\n"));
        }
    }
    if response.secondary_clicked()
        && let Some(pos) = response.interact_pointer_pos()
        && let Some(r) = row_at(pos)
    {
        let items = line_menu(view, c, r, geo.side(pos), tab_id);
        if !items.is_empty() {
            out.menu = Some((pos, items));
        }
    }
}

fn line_menu(view: &View, c: &Ctx, r: usize, side: Side, tab_id: &str) -> Vec<MenuItem> {
    let (from, to) = match &view.pick {
        Some(p) if p.side == side && p.from.min(p.to) <= r && r <= p.from.max(p.to) => {
            (p.from.min(p.to), p.from.max(p.to))
        }
        _ => (r, r),
    };
    let picks: Vec<(usize, usize)> =
        (from..=to).filter_map(|i| view.rows.get(i).and_then(|row| line_at(*row, side))).collect();
    if picks.is_empty() {
        return Vec::new();
    }
    let text = texts(view, c, from, to, side).join("\n");
    let tab = tab_id.to_string();
    let label = if picks.len() == 1 { "Copy line".to_string() } else { format!("Copy {} lines", picks.len()) };
    let mut items = vec![MenuItem::new(label, move |app| copy_text(app, &tab, text))];
    if !c.can_apply {
        return items;
    }
    let changed =
        picks.iter().filter(|&&(h, l)| line(c.diff, h, l).is_some_and(|x| x.kind == "add" || x.kind == "del")).count();
    if changed == 0 {
        return items;
    }
    let noun = if changed == 1 { "line".to_string() } else { format!("{changed} lines") };
    items.push(MenuItem::separator());
    if c.staged {
        if let Some(patch) = patch::lines_patch(c.diff, &picks, true) {
            items.push(
                MenuItem::new(format!("Unstage {noun}"), move |app| apply(app, "unstage", patch)).disabled(c.busy),
            );
        }
        return items;
    }
    if let Some(patch) = patch::lines_patch(c.diff, &picks, false) {
        items.push(MenuItem::new(format!("Stage {noun}"), move |app| apply(app, "stage", patch)).disabled(c.busy));
    }
    if let Some(patch) = patch::lines_patch(c.diff, &picks, true) {
        let tab = tab_id.to_string();
        let title = format!("Discard {noun}?");
        let discard = move |app: &mut App| {
            let mut confirm =
                Confirm::new(title, "The change is thrown away; there is no undo.", "Discard", move |app| {
                    apply(app, "discard", patch)
                });
            confirm.destructive = true;
            confirm.tab_id = Some(tab);
            app.overlay.confirm(confirm);
        };
        items.push(MenuItem::new(format!("Discard {noun}"), discard).danger().disabled(c.busy));
    }
    items
}

fn hunk_buttons(ui: &mut Ui, row: Rect, view: &mut View, c: &Ctx, h: usize, out: &mut Outcome) {
    let Some(hunk) = c.diff.hunks.get(h) else { return };
    let builder = UiBuilder::new()
        .id_salt(("diff-hunk", h))
        .max_rect(row.shrink2(Vec2::new(10.0, 0.0)))
        .layout(Layout::right_to_left(Align::Center));
    let mut child = ui.new_child(builder);
    child.spacing_mut().item_spacing.x = 6.0;
    let enabled = !c.busy;
    if c.staged {
        if small_button(&mut child, "Unstage hunk", false, enabled, c.p)
            .on_hover_text("Take this hunk back out of the index")
            .clicked()
        {
            out.apply = Some(("unstage", patch::hunk_patch(c.diff, hunk)));
        }
        return;
    }
    let confirming = view.confirm_discard == Some(h);
    let label = if confirming { "Discard for good?" } else { "Discard hunk" };
    if small_button(&mut child, label, confirming, enabled, c.p)
        .on_hover_text("Throw this hunk away, there is no undo")
        .clicked()
    {
        if confirming {
            out.apply = Some(("discard", patch::hunk_patch(c.diff, hunk)));
            view.confirm_discard = None;
        } else {
            view.confirm_discard = Some(h);
        }
    }
    if small_button(&mut child, "Stage hunk", false, enabled, c.p).on_hover_text("Stage only this hunk").clicked() {
        out.apply = Some(("stage", patch::hunk_patch(c.diff, hunk)));
    }
}

fn small_button(ui: &mut Ui, text: &str, danger: bool, enabled: bool, p: &Palette) -> Response {
    let (fg, fill, stroke) =
        if danger { (p.red_fg, p.red_bg, p.red_fg) } else { (p.fg_dim, Color32::TRANSPARENT, p.line) };
    let button = egui::Button::new(RichText::new(text).size(11.0).color(fg))
        .fill(fill)
        .stroke(Stroke::new(1.0, stroke))
        .corner_radius(3.0)
        .min_size(Vec2::new(0.0, 18.0));
    ui.add_enabled(enabled, button)
}

fn paint_head(painter: &Painter, row: Rect, c: &Ctx, h: usize, indent: f32) {
    let Some(hunk) = c.diff.hunks.get(h) else { return };
    let p = c.p;
    painter.hline(row.x_range(), row.top() + 0.5, Stroke::new(1.0, p.bg_3));
    painter.hline(row.x_range(), row.bottom() - 2.5, Stroke::new(1.0, p.bg_3));
    let range = format!("@@ -{},{} +{},{} @@", hunk.old_start, hunk.old_count, hunk.new_start, hunk.new_count);
    let galley = painter.layout_no_wrap(range, FontId::monospace(FONT), p.fg_muted);
    let y = row.center().y - 1.0;
    let end = row.left() + indent + galley.size().x;
    painter.galley(pos2(row.left() + indent, y - galley.size().y / 2.0), galley, p.fg_muted);
    if !hunk.heading.is_empty() {
        painter.text(pos2(end + 10.0, y), Align2::LEFT_CENTER, &hunk.heading, FontId::proportional(FONT), p.fg_dim);
    }
}

fn paint_unified(painter: &Painter, row: Rect, c: &Ctx, h: usize, l: usize, picked: bool, wrap_px: Option<f32>) {
    let Some(line) = line(c.diff, h, l) else { return };
    let p = c.p;
    let bg = match line.kind.as_str() {
        "add" => p.green_bg,
        "del" => p.red_bg,
        _ => Color32::TRANSPARENT,
    };
    painter.rect_filled(row, 0.0, bg);
    if picked {
        painter.rect_filled(row, 0.0, p.accent.gamma_multiply(0.22));
    }
    number(painter, pos2(row.left() + NUM_W - 8.0, row.top()), line.old_no, p);
    number(painter, pos2(row.left() + 2.0 * NUM_W - 8.0, row.top()), line.new_no, p);
    let marker = match line.kind.as_str() {
        "add" if !c.file_view => "+",
        "del" if !c.file_view => "-",
        _ => "",
    };
    if !marker.is_empty() {
        let at = pos2(row.left() + 2.0 * NUM_W + MARK_W / 2.0, row.top() + 1.0);
        painter.text(at, Align2::CENTER_TOP, marker, FontId::monospace(FONT), p.fg_muted);
    }
    text(painter, row, row.left() + 2.0 * NUM_W + MARK_W, c, h, l, line, wrap_px);
}

#[allow(clippy::too_many_arguments)]
fn paint_cell(
    painter: &Painter,
    cell: Rect,
    c: &Ctx,
    h: usize,
    l: Option<usize>,
    side: Side,
    picked: bool,
    wrap_px: Option<f32>,
) {
    let p = c.p;
    let Some((l, line)) = l.and_then(|l| line(c.diff, h, l).map(|x| (l, x))) else {
        hatch(painter, cell, p);
        return;
    };
    let bg = match (side, line.kind.as_str()) {
        (Side::Left, "del") => p.red_line,
        (Side::Right, "add") => p.green_line,
        _ => Color32::TRANSPARENT,
    };
    painter.rect_filled(cell, 0.0, bg);
    if picked {
        painter.rect_filled(cell, 0.0, p.accent.gamma_multiply(0.22));
    }
    let n = if side == Side::Left { line.old_no } else { line.new_no };
    number(painter, pos2(cell.left() + NUM_W - 8.0, cell.top()), n, p);
    text(painter, cell, cell.left() + NUM_W, c, h, l, line, wrap_px);
}

#[allow(clippy::too_many_arguments)]
fn text(painter: &Painter, area: Rect, x: f32, c: &Ctx, h: usize, l: usize, line: &DiffLine, wrap_px: Option<f32>) {
    let extra = c.extra.get(h).and_then(|e| e.get(l));
    let mark = if line.kind == "del" { c.p.red } else { c.p.green }.gamma_multiply(0.22);
    let job = line_job(&line.text, extra, c, mark, wrap_px);
    let galley = painter.layout_job(job);
    let clip = painter.clip_rect().intersect(area);
    painter.with_clip_rect(clip).galley(pos2(x, area.top()), galley, c.p.fg);
}

fn number(painter: &Painter, at: Pos2, n: Option<u64>, p: &Palette) {
    if let Some(n) = n {
        painter.text(at + Vec2::new(0.0, 1.0), Align2::RIGHT_TOP, n.to_string(), FontId::monospace(FONT), p.fg_faint);
    }
}

fn hatch(painter: &Painter, cell: Rect, p: &Palette) {
    painter.rect_filled(cell, 0.0, p.bg_0);
    let clip = painter.with_clip_rect(painter.clip_rect().intersect(cell));
    let stroke = Stroke::new(1.0, p.line_strong);
    let mut sum = ((cell.left() + cell.top()) / 5.0).ceil() * 5.0;
    while sum < cell.right() + cell.bottom() {
        clip.line_segment([pos2(sum - cell.bottom(), cell.bottom()), pos2(sum - cell.top(), cell.top())], stroke);
        sum += 5.0;
    }
}

fn note(ui: &mut Ui, text: &str, p: &Palette) {
    ui.add_space(24.0);
    ui.horizontal(|ui| {
        ui.add_space(24.0);
        ui.label(RichText::new(text).size(12.0).color(p.fg_muted));
    });
}

/// One line's text with tabs expanded, highlighting, changed-word marks and, when asked, visible whitespace.
fn line_job(text: &str, extra: Option<&LineExtra>, c: &Ctx, mark_bg: Color32, wrap_px: Option<f32>) -> LayoutJob {
    let text = text.strip_suffix('\r').unwrap_or(text);
    let mut job = LayoutJob::default();
    job.wrap.max_width = wrap_px.unwrap_or(f32::INFINITY);
    job.wrap.break_anywhere = true;
    let trail = if c.ws { text.trim_end_matches(' ').len() } else { text.len() };
    let (syn, marks): (&[Token], &[Span]) = extra.map_or((&[], &[]), |e| (&e.syn, &e.marks));
    let (mut si, mut mi, mut col) = (0, 0, 0);
    let mut run = String::new();
    let mut format: Option<(Color32, Color32, bool)> = None;
    for (i, ch) in text.char_indices() {
        while syn.get(si).is_some_and(|t| t.end <= i) {
            si += 1;
        }
        while marks.get(mi).is_some_and(|m| m.end <= i) {
            mi += 1;
        }
        let tok = syn.get(si).filter(|t| t.start <= i).map(|t| t.syn);
        let mut color = tok.map_or(c.p.fg, |s| s.color(c.p));
        let bg = if marks.get(mi).is_some_and(|m| m.start <= i) { mark_bg } else { Color32::TRANSPARENT };
        let (glyph, width) = match ch {
            '\t' => (if c.ws { '\u{2192}' } else { ' ' }, c.tab - col % c.tab),
            ' ' if c.ws && i >= trail => ('\u{00b7}', 1),
            _ => (ch, 1),
        };
        if glyph != ch {
            color = c.p.fg_faint;
        }
        let want = (color, bg, tok == Some(Syn::Comment));
        if format != Some(want) {
            flush(&mut job, &mut run, format);
            format = Some(want);
        }
        run.push(glyph);
        run.extend(std::iter::repeat_n(' ', width - 1));
        col += width;
    }
    flush(&mut job, &mut run, format);
    job
}

fn flush(job: &mut LayoutJob, run: &mut String, format: Option<(Color32, Color32, bool)>) {
    let Some((color, background, italics)) = format else { return };
    if run.is_empty() {
        return;
    }
    let format = TextFormat {
        font_id: FontId::monospace(FONT),
        color,
        background,
        italics,
        line_height: Some(ROW_H),
        ..Default::default()
    };
    job.append(run, 0.0, format);
    run.clear();
}

fn build_rows(diff: &FileDiff, mode: Mode, file_view: bool) -> Vec<Row> {
    let mut rows = Vec::new();
    for (h, hunk) in diff.hunks.iter().enumerate() {
        if mode == Mode::Split && !file_view {
            if !diff.whole {
                rows.push(Row::Head(h));
            }
            let (mut dels, mut adds) = (Vec::new(), Vec::new());
            for (l, line) in hunk.lines.iter().enumerate() {
                match line.kind.as_str() {
                    "del" => dels.push(l),
                    "add" => adds.push(l),
                    _ => {
                        pair_up(&mut rows, h, &mut dels, &mut adds);
                        rows.push(Row::Pair(h, Some(l), Some(l)));
                    }
                }
            }
            pair_up(&mut rows, h, &mut dels, &mut adds);
            continue;
        }
        if mode == Mode::Unified && !file_view {
            rows.push(Row::Head(h));
        }
        for (l, line) in hunk.lines.iter().enumerate() {
            if !(file_view && line.kind == "del") {
                rows.push(Row::Line(h, l));
            }
        }
    }
    rows
}

fn pair_up(rows: &mut Vec<Row>, h: usize, dels: &mut Vec<usize>, adds: &mut Vec<usize>) {
    for i in 0..dels.len().max(adds.len()) {
        rows.push(Row::Pair(h, dels.get(i).copied(), adds.get(i).copied()));
    }
    dels.clear();
    adds.clear();
}

/// Each row's top edge (plus the total at the end) and the widest line in columns.
fn measure(rows: &[Row], diff: &FileDiff, cpr: usize, tab: usize) -> (Vec<f32>, usize) {
    let mut prefix = Vec::with_capacity(rows.len() + 1);
    let mut max_cols = 0;
    let mut y = 0.0;
    prefix.push(y);
    let mut height = |h: usize, l: Option<usize>| -> usize {
        let Some(line) = l.and_then(|l| line(diff, h, l)) else { return 1 };
        let cols = columns(&line.text, tab);
        max_cols = max_cols.max(cols);
        if cpr == 0 { 1 } else { cols.div_ceil(cpr).max(1) }
    };
    for row in rows {
        y += match *row {
            Row::Head(_) => HEAD_H,
            Row::Line(h, l) => height(h, Some(l)) as f32 * ROW_H,
            Row::Pair(h, a, b) => height(h, a).max(height(h, b)) as f32 * ROW_H,
        };
        prefix.push(y);
    }
    (prefix, max_cols)
}

fn columns(text: &str, tab: usize) -> usize {
    let text = text.strip_suffix('\r').unwrap_or(text);
    text.chars().fold(0, |col, ch| if ch == '\t' { col + tab - col % tab } else { col + 1 })
}

fn step_target(view: &View, c: &Ctx, dir: i32) -> Option<f32> {
    let kind = |h: usize, l: Option<usize>| l.and_then(|l| line(c.diff, h, l)).map_or("", |x| x.kind.as_str());
    let changed = |row: Option<&Row>| match row.copied() {
        Some(Row::Line(h, l)) => !c.file_view && matches!(kind(h, Some(l)), "add" | "del"),
        Some(Row::Pair(h, a, b)) => kind(h, a) == "del" || kind(h, b) == "add",
        _ => false,
    };
    let top = view.offset + 40.0;
    let mut starts = (0..view.rows.len())
        .filter(|&i| changed(view.rows.get(i)) && !(i > 0 && changed(view.rows.get(i - 1))))
        .filter_map(|i| view.prefix.get(i).copied());
    let y = if dir > 0 { starts.find(|&y| y > top + 4.0) } else { starts.rfind(|&y| y < top - 4.0) };
    y.map(|y| (y - 40.0).max(0.0))
}

fn texts<'a>(view: &View, c: &Ctx<'a>, from: usize, to: usize, side: Side) -> Vec<&'a str> {
    (from..=to)
        .filter_map(|i| view.rows.get(i).and_then(|row| line_at(*row, side)))
        .filter_map(|(h, l)| line(c.diff, h, l))
        .map(|x| x.text.as_str())
        .collect()
}

fn line_at(row: Row, side: Side) -> Option<(usize, usize)> {
    match (row, side) {
        (Row::Line(h, l), _) => Some((h, l)),
        (Row::Pair(h, Some(l), _), Side::Left) => Some((h, l)),
        (Row::Pair(h, _, Some(l)), Side::Right) => Some((h, l)),
        _ => None,
    }
}

fn line(diff: &FileDiff, h: usize, l: usize) -> Option<&DiffLine> {
    diff.hunks.get(h)?.lines.get(l)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::types::Hunk;

    fn diff() -> FileDiff {
        let line = |kind: &str| DiffLine { kind: kind.into(), text: "x".into(), ..Default::default() };
        let hunk = Hunk {
            lines: vec![line("context"), line("del"), line("del"), line("add"), line("context")],
            ..Default::default()
        };
        FileDiff { hunks: vec![hunk], ..Default::default() }
    }

    #[test]
    fn split_pairs_runs_and_fills_the_short_side() {
        let rows = build_rows(&diff(), Mode::Split, false);
        let shape: Vec<String> = rows.iter().map(|r| format!("{r:?}")).collect();
        assert_eq!(
            shape,
            vec![
                "Head(0)",
                "Pair(0, Some(0), Some(0))",
                "Pair(0, Some(1), Some(3))",
                "Pair(0, Some(2), None)",
                "Pair(0, Some(4), Some(4))"
            ]
        );
    }

    #[test]
    fn file_view_drops_removed_lines_and_headers() {
        assert_eq!(build_rows(&diff(), Mode::Unified, true).len(), 3);
        assert_eq!(build_rows(&diff(), Mode::Unified, false).len(), 6);
    }

    #[test]
    fn tabs_count_to_the_next_stop() {
        assert_eq!(columns("\tab", 4), 6);
        assert_eq!(columns("ab\tc", 4), 5);
        assert_eq!(columns("abc\r", 4), 3);
    }
}
