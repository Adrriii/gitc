use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use eframe::egui::text::{LayoutJob, TextWrapping};
use eframe::egui::{
    self, Align, Align2, Color32, CursorIcon, FontId, Frame, Key, Margin, Order, Painter, Pos2, Rect, Response,
    RichText, Sense, Shape, Stroke, StrokeKind, TextFormat, Ui, UiBuilder, Vec2, pos2, vec2,
};

use super::repo::Repo;
use super::settings::Settings;
use super::theme::Palette;
use super::{App, actions, avatar, icons};
use crate::engine::types::{Commit, GraphPayload, GraphRow};

#[path = "graph_model.rs"]
mod model;
use model::{
    GroupKind, RefGroup, group_refs, is_wip, markers, range_select, toggle_select, worktree_label, worktree_labels,
};

const ROW_H: f32 = 26.0;
const HEADER_H: f32 = 17.0;
const LANE_W: f32 = 22.0;
const NODE_R: f32 = 10.0;
const MERGE_R: f32 = 6.0;
const PAD_X: f32 = 14.0;
const CORNER: f32 = 7.0;
const STROKE: f32 = 2.0;
const RADIUS: f32 = 3.0;
const CHIPS_PAD_L: f32 = 8.0;
const CHIPS_PAD_R: f32 = 5.0;
const CHIPS_W_MIN: f32 = 40.0;
const CHIPS_W_MAX: f32 = 420.0;
const CHIP_H: f32 = 18.0;
const CHIP_ICON: f32 = 11.0;
const CHIP_GAP: f32 = 4.0;
const CHIP_PAD: f32 = 6.0;
const CHIP_OPEN_MAX: f32 = 340.0;
const GRAPH_W_MIN: f32 = 60.0;
const GRAPH_W_MAX: f32 = 900.0;
const STASH_NODE: f32 = 18.0;
const NODE_SIZE: f32 = 22.0;
const PILE_COLLAPSED: f32 = 7.0;
const PILE_EXPANDED: f32 = 20.0;
const PILE_MAX: usize = 3;
const WIDTH_SCAN: usize = 12;
const POP_ROW_H: f32 = 22.0;
const QUICK_W: f32 = 180.0;

/// The graph's derived data, rebuilt when the repository's `version` moves, plus view state.
#[derive(Default)]
pub struct State {
    built: Option<u64>,
    markers: HashMap<usize, String>,
    groups: HashMap<usize, Vec<RefGroup>>,
    deepest: usize,
    wip: WipCounts,
    quick: String,
    pop: Option<Pop>,
    opened_chip: Option<(usize, Rect)>,
    ensure: Option<usize>,
}

#[derive(Default, Clone, Copy)]
struct WipCounts {
    modified: usize,
    added: usize,
    staged: usize,
}

struct Pop {
    row: usize,
    rect: Rect,
    pinned: bool,
}

enum Event {
    Select { hash: String, ctrl: bool, shift: bool },
    CommitMenu(Pos2, String),
    ChipMenu(Pos2, &'static str, String),
    Checkout(&'static str, String),
    OpenWorktree(String),
    QuickCommit(String),
    Save,
}

struct Widths {
    chips: f32,
    graph: Option<f32>,
}

struct Env<'a> {
    tab: &'a str,
    palette: Palette,
    menu_open: bool,
    overlay_open: bool,
}

struct View<'a> {
    ui: &'a Ui,
    data: &'a GraphPayload,
    state: &'a State,
    palette: &'a Palette,
    selected: &'a [String],
    origin: Pos2,
    width: f32,
    chips_w: f32,
    graph_w: f32,
    hover: Option<Pos2>,
    hovered_row: Option<usize>,
}

#[derive(Default)]
struct Drawn {
    opened: Option<(usize, Rect)>,
    cell_hovered: Option<usize>,
    tip: Option<String>,
    wip_row: Option<usize>,
}

pub fn show(app: &mut App, ui: &mut Ui) {
    avatar::set_enabled(app.settings.avatars);
    let Some(id) = app.active_id() else { return };
    let mut widths =
        Widths { chips: app.settings.chips_width.clamp(CHIPS_W_MIN, CHIPS_W_MAX), graph: app.settings.graph_width };
    let env = Env {
        tab: &id,
        palette: app.palette,
        menu_open: app.overlay.menu.is_some(),
        overlay_open: app.overlay.is_open(),
    };
    let Some(repo) = app.repos.get_mut(&id) else { return };
    let events = draw(ui, repo, &env, &mut widths);
    app.settings.chips_width = widths.chips;
    app.settings.graph_width = widths.graph;
    for event in events {
        apply(app, &id, event);
    }
}

impl State {
    fn rebuild(&mut self, data: &GraphPayload) {
        let labels = worktree_labels(&data.worktrees);
        let head = data.head.branch.as_deref();
        self.groups = data
            .commits
            .iter()
            .enumerate()
            .filter_map(|(i, c)| {
                let groups = match c.hash.strip_prefix("WIP:") {
                    Some(name) => group_refs(&[format!("worktree:{name}")], None, &labels),
                    None if c.refs.is_empty() => return None,
                    None => group_refs(&c.refs, head, &labels),
                };
                (!groups.is_empty()).then_some((i, groups))
            })
            .collect();
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
        self.markers = markers(&data.commits, now);
        self.deepest = data.rows.iter().map(|r| r.width).max().unwrap_or(0);
        self.wip = WipCounts {
            modified: data.status.iter().filter(|f| !f.untracked).count(),
            added: data.status.iter().filter(|f| f.untracked).count(),
            staged: data.status.iter().filter(|f| f.staged).count(),
        };
        self.pop = None;
        self.opened_chip = None;
    }
}

fn draw(ui: &mut Ui, repo: &mut Repo, env: &Env, widths: &mut Widths) -> Vec<Event> {
    let mut events = Vec::new();
    let Repo { data, graph: state, selected, anchor, reveal, version, stale, loading, .. } = repo;
    let Some(data) = data.as_ref() else { return events };
    if state.built != Some(*version) {
        state.rebuild(data);
        state.built = Some(*version);
    }
    keyboard(ui, data, selected, anchor.as_deref(), env, state, &mut events);

    let palette = env.palette;
    let full = ui.available_rect_before_wrap();
    let body = Rect::from_min_max(pos2(full.left(), full.top() + HEADER_H), full.max);
    let total = data.commits.len().min(data.rows.len());
    let mut graph_w = widths.graph.unwrap_or(GRAPH_W_MIN);
    let mut origin = body.min;
    let mut drawn = Drawn::default();

    let mut body_ui = ui.new_child(UiBuilder::new().id_salt("graph-body").max_rect(body));
    egui::ScrollArea::vertical().id_salt(("graph", env.tab)).auto_shrink(false).show_viewport(
        &mut body_ui,
        |ui, viewport| {
            origin = ui.max_rect().min;
            let width = ui.max_rect().width();
            ui.set_min_size(vec2(width, total as f32 * ROW_H));
            let first = ((viewport.min.y / ROW_H).floor().max(0.0) as usize).min(total);
            let last = ((viewport.max.y / ROW_H).ceil().max(0.0) as usize).min(total);
            let auto = visible_width(&data.rows, first.saturating_sub(WIDTH_SCAN), (last + WIDTH_SCAN).min(total));
            graph_w = widths.graph.unwrap_or(auto);

            if let Some(hash) = reveal.as_deref() {
                match data.commits.iter().position(|c| c.hash == hash) {
                    Some(i) => {
                        let top = i as f32 * ROW_H;
                        if top < viewport.min.y || top + ROW_H > viewport.max.y {
                            ui.scroll_to_rect(row_rect(origin, width, i), Some(Align::Center));
                        }
                        *reveal = None;
                    }
                    None if !*stale && !*loading => *reveal = None,
                    None => {}
                }
            }
            if let Some(i) = state.ensure.take() {
                ui.scroll_to_rect(row_rect(origin, width, i), None);
            }

            let hover = ui
                .ctx()
                .pointer_hover_pos()
                .filter(|p| ui.clip_rect().contains(*p) && ui.ctx().layer_id_at(*p) == Some(ui.layer_id()));
            let span = Rect::from_min_size(
                origin + vec2(0.0, first as f32 * ROW_H),
                vec2(width, (last - first) as f32 * ROW_H),
            );
            let hovered_row = hover.filter(|p| span.contains(*p)).map(|p| ((p.y - origin.y) / ROW_H) as usize);
            let rows = ui.interact(span, ui.scope_id().with("rows"), Sense::click());
            row_clicks(ui, &rows, data, origin, &mut events);

            {
                let view = View {
                    ui,
                    data,
                    state,
                    palette: &palette,
                    selected,
                    origin,
                    width,
                    chips_w: widths.chips,
                    graph_w,
                    hover,
                    hovered_row,
                };
                for i in first..last {
                    draw_row(&view, i, &mut events, &mut drawn);
                }
            }
            if let Some(tip) = drawn.tip.take() {
                let _ = rows.on_hover_text(tip);
            } else if hovered_row.is_some() {
                let _ = rows.on_hover_cursor(CursorIcon::PointingHand);
            }
            if let Some(i) = drawn.wip_row {
                let left = origin.x + widths.chips + graph_w + 2.0 + 8.0;
                quick_commit(ui, state, &palette, row_rect(origin, width, i), left, hover, &mut events);
            }
        },
    );

    state.opened_chip = drawn.opened;
    pop_list(ui, state, env, origin, drawn.cell_hovered, &mut events);
    header(ui, full, widths.chips, graph_w, &palette);
    resizers(ui, full, widths, graph_w, state.deepest, &palette, &mut events);
    events
}

fn apply(app: &mut App, id: &str, event: Event) {
    match event {
        Event::Select { hash, ctrl, shift } => {
            if let Some(repo) = app.repos.get_mut(id) {
                select(repo, &hash, ctrl, shift);
            }
        }
        Event::CommitMenu(pos, hash) => actions::commit_menu(app, pos, &hash),
        Event::ChipMenu(pos, kind, name) => actions::chip_menu(app, pos, kind, &name),
        Event::Checkout(kind, name) => actions::checkout_ref(app, kind, &name),
        Event::OpenWorktree(name) => actions::edit_worktree(app, &name),
        Event::QuickCommit(summary) => actions::quick_commit(app, summary),
        Event::Save => app.save_settings(),
    }
}

/// Click semantics: WIP rows select alone; shift extends from the anchor; ctrl grows or shrinks the run.
fn select(repo: &mut Repo, hash: &str, ctrl: bool, shift: bool) {
    let Repo { data, selected, anchor, .. } = repo;
    let Some(data) = data.as_ref() else { return };
    if is_wip(hash) {
        *selected = vec![hash.to_string()];
        *anchor = None;
        return;
    }
    if selected.iter().any(|h| is_wip(h)) {
        *selected = vec![hash.to_string()];
        *anchor = Some(hash.to_string());
        return;
    }
    if let Some(from) = anchor.clone().or_else(|| selected.first().cloned()).filter(|_| shift) {
        *selected = range_select(&data.commits, &from, hash);
        return;
    }
    *anchor = Some(hash.to_string());
    *selected = if ctrl { toggle_select(&data.commits, selected, hash) } else { vec![hash.to_string()] };
}

fn keyboard(
    ui: &Ui,
    data: &GraphPayload,
    selected: &[String],
    anchor: Option<&str>,
    env: &Env,
    state: &mut State,
    events: &mut Vec<Event>,
) {
    if env.overlay_open || ui.memory(|m| m.focused().is_some()) {
        return;
    }
    let (up, down, shift) =
        ui.input(|i| (i.key_pressed(Key::ArrowUp), i.key_pressed(Key::ArrowDown), i.modifiers.shift));
    if up == down {
        return;
    }
    let cursor = match (selected.first(), selected.last()) {
        (Some(first), Some(last)) if shift && selected.len() > 1 => {
            if anchor == Some(last.as_str()) {
                first
            } else {
                last
            }
        }
        (first, _) => match first {
            Some(h) => h,
            None => "",
        },
    };
    let target = match data.commits.iter().position(|c| c.hash == cursor) {
        None => 0,
        Some(0) if up => return,
        Some(i) if up => i - 1,
        Some(i) => i + 1,
    };
    let Some(commit) = data.commits.get(target) else { return };
    events.push(Event::Select { hash: commit.hash.clone(), ctrl: false, shift: shift && !is_wip(&commit.hash) });
    state.ensure = Some(target);
}

fn row_clicks(ui: &Ui, rows: &Response, data: &GraphPayload, origin: Pos2, events: &mut Vec<Event>) {
    let Some(pos) = rows.interact_pointer_pos() else { return };
    let Some(commit) = data.commits.get(((pos.y - origin.y) / ROW_H).max(0.0) as usize) else { return };
    if rows.clicked() {
        let m = ui.input(|i| i.modifiers);
        events.push(Event::Select { hash: commit.hash.clone(), ctrl: m.command, shift: m.shift });
    }
    if !rows.secondary_clicked() || commit.hash == "WIP" {
        return;
    }
    match commit.refs.iter().find_map(|r| r.strip_prefix("stash:")) {
        Some(selector) => events.push(Event::ChipMenu(pos, "stash", selector.to_string())),
        None => events.push(Event::CommitMenu(pos, commit.hash.clone())),
    }
}

fn draw_row(v: &View, i: usize, events: &mut Vec<Event>, drawn: &mut Drawn) {
    let (Some(c), Some(row)) = (v.data.commits.get(i), v.data.rows.get(i)) else { return };
    let other = c.hash.strip_prefix("WIP:").map(|name| v.data.worktrees.iter().find(|w| w.name == name));
    if other.is_some_and(|w| w.is_none()) {
        return;
    }
    let other = other.flatten();
    let own_wip = c.hash == "WIP";
    let wip = own_wip || other.is_some();
    let stash = c.refs.iter().any(|r| r.starts_with("stash:"));
    let merge = c.parents.len() > 1;
    let rect = row_rect(v.origin, v.width, i);
    let mid = rect.center().y;
    let pal = v.palette;
    let lane = pal.lane(row.color);
    let sel = v.selected.contains(&c.hash);
    let hovered = v.hovered_row == Some(i);
    let is_head = !wip && v.data.head.hash.as_deref() == Some(c.hash.as_str());
    let groups = v.state.groups.get(&i).filter(|g| !g.is_empty());
    let graph_left = rect.left() + v.chips_w;
    let graph_right = graph_left + v.graph_w;
    let node = pos2(graph_left + lane_x(row.lane), mid);
    let msg = Rect::from_min_max(pos2(graph_right + 2.0, rect.top()), rect.max);
    let p = v.ui.painter();

    if sel {
        p.rect_filled(msg, 0.0, pal.accent_bg);
    } else if hovered {
        p.rect_filled(msg, 0.0, pal.fg.gamma_multiply(0.04));
    }
    if is_head {
        p.rect_filled(Rect::from_min_size(rect.min, vec2(3.0, ROW_H)), 0.0, pal.green);
    }
    if groups.is_some() {
        let (alpha, h) = if is_head {
            (1.0, 2.0)
        } else if hovered || sel {
            (0.25, 1.0)
        } else {
            (0.125, 1.0)
        };
        let line = Rect::from_min_max(pos2(graph_left - CHIPS_PAD_R, mid - 1.0), pos2(node.x, mid - 1.0 + h));
        p.rect_filled(line, 0.0, lane.gamma_multiply(alpha));
    }

    let cell = Rect::from_min_max(pos2(graph_left, rect.top()), pos2(graph_right, rect.bottom()));
    let gp = p.with_clip_rect(cell.intersect(v.ui.clip_rect()));
    if !wip {
        let band = Rect::from_min_max(pos2(node.x, rect.top() + 3.0), pos2(graph_right, rect.bottom() - 3.0));
        gp.rect_filled(band, 0.0, lane.gamma_multiply(if sel { 0.5 } else { 0.1 }));
    }
    lanes(&gp, row, cell.min, pal);
    if wip {
        gp.circle_filled(node, NODE_R, pal.bg_0);
        gp.extend(Shape::dashed_line(&circle_points(node, NODE_R), Stroke::new(STROKE, lane), 3.0, 3.0));
    } else if stash {
        let square = Rect::from_center_size(node, Vec2::splat(STASH_NODE));
        gp.rect_filled(square, 2.0, pal.bg_0);
        let corners =
            [square.left_top(), square.right_top(), square.right_bottom(), square.left_bottom(), square.left_top()];
        gp.extend(Shape::dashed_line(&corners, Stroke::new(STROKE, lane), 2.0, 3.0));
    } else if merge {
        gp.circle_filled(node, MERGE_R, lane);
    } else {
        pile(v, c, i, node, lane, graph_right - node.x + NODE_R + 1.0, hovered, drawn);
    }
    if !wip {
        let strip =
            Rect::from_min_max(pos2(graph_right, rect.top() + 3.0), pos2(graph_right + 2.0, rect.bottom() - 3.0));
        p.rect_filled(strip, 0.0, lane);
    }

    let text_left = msg.left() + 8.0;
    let text_right = msg.right() - 10.0;
    if own_wip {
        drawn.wip_row = Some(i);
        counts(v.ui, text_left + QUICK_W + 8.0, mid, v.state.wip.modified, v.state.wip.added, pal);
    } else if let Some(w) = other {
        let on = w.branch.as_deref().filter(|_| !w.detached).map(|b| format!(" on {b}")).unwrap_or_default();
        let mut job = LayoutJob {
            wrap: TextWrapping::truncate_at_width((text_right - text_left).max(0.0)),
            ..Default::default()
        };
        let format =
            TextFormat { font_id: FontId::proportional(12.0), color: pal.fg_dim, italics: true, ..Default::default() };
        job.append(&format!("// WIP{on}"), 0.0, format);
        let galley = p.layout_job(job);
        let end = text_left + galley.size().x + 10.0;
        p.galley(pos2(text_left, mid - galley.size().y / 2.0), galley, pal.fg_dim);
        let modified = w.status.iter().filter(|f| !f.untracked).count();
        let added = w.status.len() - modified;
        counts(v.ui, end, mid, modified, added, pal);
        if hovered && v.hover.is_some_and(|h| h.x > graph_right) {
            drawn.tip = Some(format!(
                "{} - {}\nclick to look at its changes, double-click the chip to open it",
                worktree_label(w),
                w.path
            ));
        }
    } else {
        message(v, c, i, merge, text_left, text_right, mid);
    }

    if let Some(groups) = groups {
        chips(v, i, rect, c, groups, lane, hovered || sel, events, drawn);
    }
}

fn message(v: &View, c: &Commit, i: usize, merge: bool, left: f32, mut right: f32, mid: f32) {
    let p = v.ui.painter();
    let pal = v.palette;
    if let Some(marker) = v.state.markers.get(&i) {
        let galley = p.layout_no_wrap(marker.clone(), FontId::proportional(11.0), pal.fg_muted);
        let size = galley.size() + vec2(12.0, 2.0);
        let r = Rect::from_min_size(pos2(right - size.x, mid - size.y / 2.0), size);
        p.rect_filled(r, RADIUS, pal.bg_2);
        p.galley(r.min + vec2(6.0, 1.0), galley, pal.fg_muted);
        right = r.left() - 8.0;
    }
    let font = FontId::proportional(12.0);
    let mut job = LayoutJob { wrap: TextWrapping::truncate_at_width((right - left).max(0.0)), ..Default::default() };
    job.append(&c.subject, 0.0, TextFormat::simple(font.clone(), if merge { pal.fg_bright } else { pal.fg }));
    if let Some(line) = c.body.lines().next().filter(|l| !l.trim().is_empty()) {
        job.append(line, 8.0, TextFormat::simple(font, pal.fg_muted));
    }
    let galley = p.layout_job(job);
    p.galley(pos2(left, mid - galley.size().y / 2.0), galley, pal.fg);
}

#[allow(clippy::too_many_arguments)]
fn pile(v: &View, c: &Commit, i: usize, center: Pos2, lane: Color32, band: f32, hovered: bool, drawn: &mut Drawn) {
    let shown = c.co_authors.get(..c.co_authors.len().min(PILE_MAX)).unwrap_or(&[]);
    let extra = c.co_authors.len() - shown.len();
    let items = 1 + shown.len() + usize::from(extra > 0);
    let gap = if items > 1 {
        let open = ((band - NODE_SIZE).max(0.0) / (items - 1) as f32).clamp(PILE_COLLAPSED, PILE_EXPANDED);
        let t = v.ui.ctx().animate_bool(v.ui.scope_id().with(("pile", i)), hovered);
        PILE_COLLAPSED + (open - PILE_COLLAPSED) * t
    } else {
        0.0
    };
    let p = v.ui.painter();
    let at = |k: usize| center + vec2(k as f32 * gap, 0.0);
    if extra > 0 {
        let ctr = at(items - 1);
        p.circle_filled(ctr, NODE_SIZE / 2.0, v.palette.bg_2);
        p.circle_stroke(ctr, NODE_R, Stroke::new(STROKE, lane));
        p.text(ctr, Align2::CENTER_CENTER, format!("+{extra}"), FontId::proportional(9.0), v.palette.fg_dim);
    }
    for (k, person) in shown.iter().enumerate().rev() {
        face(v, at(k + 1), &person.name, &person.email, lane);
    }
    face(v, center, &c.author, &c.email, lane);

    let Some(h) = v.hover else { return };
    let hit = (0..items).rev().find(|k| at(*k).distance(h) <= NODE_SIZE / 2.0);
    drawn.tip = match hit {
        Some(0) => Some(person_tip(&c.author, &c.email)),
        Some(k) => match shown.get(k - 1) {
            Some(person) => Some(person_tip(&person.name, &person.email)),
            None => Some(c.co_authors.iter().skip(PILE_MAX).map(|p| p.name.as_str()).collect::<Vec<_>>().join(", ")),
        },
        None => drawn.tip.take(),
    };
}

fn face(v: &View, center: Pos2, name: &str, email: &str, lane: Color32) {
    let p = v.ui.painter();
    p.circle_filled(center, NODE_SIZE / 2.0, v.palette.bg_4);
    avatar::paint(v.ui, Rect::from_center_size(center, Vec2::splat(NODE_SIZE - 4.0)), name, email);
    p.circle_stroke(center, NODE_R, Stroke::new(STROKE, lane));
}

#[allow(clippy::too_many_arguments)]
fn chips(
    v: &View,
    i: usize,
    rect: Rect,
    c: &Commit,
    groups: &[RefGroup],
    lane: Color32,
    bright: bool,
    events: &mut Vec<Event>,
    drawn: &mut Drawn,
) {
    let Some(first) = groups.first() else { return };
    let pal = v.palette;
    let p = v.ui.painter();
    let mid = rect.center().y;
    let cell = Rect::from_min_size(rect.min, vec2(v.chips_w, ROW_H));
    let in_open = v.state.opened_chip.is_some_and(|(row, r)| row == i && v.hover.is_some_and(|h| r.contains(h)));
    let cell_hovered = in_open || v.hover.is_some_and(|h| cell.contains(h));
    let row_hovered = v.hovered_row == Some(i);
    let rest = groups.len() - 1;
    let font = FontId::proportional(11.0);
    let inner_left = cell.left() + CHIPS_PAD_L;
    let inner_right = cell.right() - CHIPS_PAD_R;

    let more = (rest > 0).then(|| p.layout_no_wrap(format!("+{rest}"), font.clone(), Color32::from_white_alpha(191)));
    let more_w = more.as_ref().map_or(0.0, |g| (g.size().x + 8.0).max(20.0));
    let chip_right = inner_right - if rest > 0 { more_w + 3.0 } else { 0.0 };

    let op = if bright || first.is_head { 1.0 } else { 0.5 };
    let color = if first.is_head {
        pal.chip_head_fg
    } else if first.kind == GroupKind::Branch && !first.local {
        pal.fg_dim
    } else {
        pal.fg
    }
    .gamma_multiply(op);
    let lead = if first.is_head {
        Some("check")
    } else {
        match first.kind {
            GroupKind::Tag => Some("tag"),
            GroupKind::Worktree => Some("worktree"),
            GroupKind::Branch => None,
        }
    };
    let places = where_icons(first);
    let kebab = row_hovered;
    let fixed = CHIP_PAD * 2.0
        + lead.map_or(0.0, |_| CHIP_ICON + CHIP_GAP)
        + places.len() as f32 * (CHIP_GAP + CHIP_ICON)
        + if kebab { CHIP_GAP + CHIP_ICON - 2.0 } else { 0.0 };
    let name = p.layout_no_wrap(first.name.clone(), font.clone(), color);
    let natural = fixed + name.size().x;
    let avail = (chip_right - inner_left).max(0.0);
    let expanded = cell_hovered && natural > avail;
    let (chip_left, chip_w) = if expanded {
        (inner_left, natural.min(CHIP_OPEN_MAX))
    } else {
        let w = natural.min(avail);
        (chip_right - w, w)
    };
    let chip = Rect::from_min_size(pos2(chip_left, mid - CHIP_H / 2.0), vec2(chip_w, CHIP_H));
    let name = if natural > chip_w {
        let mut job = LayoutJob::simple_singleline(first.name.clone(), font.clone(), color);
        job.wrap = TextWrapping::truncate_at_width((chip_w - fixed).max(0.0));
        p.layout_job(job)
    } else {
        name
    };

    p.rect_filled(chip, RADIUS, pal.bg_0);
    p.rect_filled(chip, RADIUS, lane.gamma_multiply(if first.is_head { 0.5 } else { 0.25 } * op));
    if first.is_head {
        p.rect_stroke(chip, RADIUS, Stroke::new(1.0, lane), StrokeKind::Outside);
    }
    let cp = p.with_clip_rect(chip.intersect(v.ui.clip_rect()));
    let mut x = chip.left() + CHIP_PAD;
    let icon_at = |x: f32| Rect::from_min_size(pos2(x, mid - CHIP_ICON / 2.0), Vec2::splat(CHIP_ICON));
    if let Some(icon) = lead {
        icons::paint(v.ui, icon_at(x), icon, color.gamma_multiply(0.85));
        x += CHIP_ICON + CHIP_GAP;
    }
    let name_w = name.size().x;
    cp.galley(pos2(x, mid - name.size().y / 2.0), name, color);
    x += name_w;
    for icon in &places {
        x += CHIP_GAP;
        if x + CHIP_ICON <= chip.right() {
            icons::paint(v.ui, icon_at(x), icon, color.gamma_multiply(0.6));
        }
        x += CHIP_ICON;
    }

    let more_left = if expanded { chip.right() + 3.0 } else { chip_right + 3.0 };
    let more_rect = Rect::from_min_size(pos2(more_left, mid - CHIP_H / 2.0), vec2(more_w, CHIP_H));
    if let Some(galley) = more {
        p.rect_filled(more_rect, RADIUS, pal.chip_head);
        p.galley(more_rect.center() - galley.size() / 2.0, galley, pal.fg);
    }
    if expanded {
        drawn.opened = Some((i, chip.union(cell).union(if rest > 0 { more_rect } else { chip })));
    }
    if cell_hovered && rest > 0 {
        drawn.cell_hovered = Some(i);
    }

    let id = v.ui.scope_id().with(("chip", i));
    let response = v.ui.interact(chip, id, Sense::click());
    if response.clicked() {
        let m = v.ui.input(|i| i.modifiers);
        events.push(Event::Select { hash: c.hash.clone(), ctrl: m.command, shift: m.shift });
    }
    if response.double_clicked() {
        events.push(checkout(first));
    }
    if response.secondary_clicked() {
        let pos = response.interact_pointer_pos().unwrap_or(chip.left_bottom());
        events.push(Event::ChipMenu(pos, first.action_kind, first.action_name.clone()));
    }
    let _ = response.on_hover_cursor(CursorIcon::ContextMenu).on_hover_text(chip_tip(first));

    if !kebab {
        return;
    }
    let k = Rect::from_min_size(
        pos2(chip.right() - CHIP_PAD - CHIP_ICON + 2.0, mid - CHIP_ICON / 2.0),
        Vec2::splat(CHIP_ICON),
    );
    let response = v.ui.interact(k, id.with("kebab"), Sense::click());
    let tint = if response.hovered() { pal.fg_bright } else { pal.fg_dim };
    icons::paint(v.ui, k, "kebab", tint);
    if response.clicked() {
        events.push(Event::ChipMenu(k.right_bottom(), first.action_kind, first.action_name.clone()));
    }
    let _ = response.on_hover_cursor(CursorIcon::PointingHand).on_hover_text("Actions");
}

fn pop_list(ui: &Ui, state: &mut State, env: &Env, origin: Pos2, cell_hovered: Option<usize>, events: &mut Vec<Event>) {
    let hover = ui.ctx().pointer_hover_pos();
    let kept = state.pop.as_ref().filter(|p| (p.pinned && env.menu_open) || hover.is_some_and(|h| p.rect.contains(h)));
    let pinned = kept.is_some_and(|p| p.pinned && env.menu_open);
    let Some(row) = cell_hovered.filter(|_| !pinned).or(kept.map(|p| p.row)) else {
        state.pop = None;
        return;
    };
    let Some(groups) = state.groups.get(&row) else {
        state.pop = None;
        return;
    };
    let pal = env.palette;
    let font = FontId::proportional(11.0);
    let any_head = groups.iter().any(|g| g.is_head);
    let gutter = if any_head { CHIP_ICON + 5.0 } else { 0.0 };
    let names: Vec<_> = groups
        .iter()
        .map(|g| {
            let color = if g.is_head { pal.fg_bright } else { pal.chip_head_fg };
            ui.painter().layout_no_wrap(g.name.clone(), font.clone(), color)
        })
        .collect();
    let width = groups
        .iter()
        .zip(&names)
        .map(|(g, n)| 14.0 + gutter + n.size().x + where_icons(g).len() as f32 * (CHIP_ICON + 5.0))
        .fold(126.0_f32, f32::max)
        .min(414.0);
    let pos = pos2(origin.x + CHIPS_PAD_L, origin.y + (row + 1) as f32 * ROW_H);
    let mut pin = pinned;
    let shown = egui::Area::new(ui.scope_id().with(("refpop", env.tab))).order(Order::Foreground).fixed_pos(pos).show(
        ui.ctx(),
        |ui| {
            Frame::new()
                .fill(pal.chip_head)
                .stroke(Stroke::new(1.0, pal.accent_line))
                .corner_radius(RADIUS)
                .inner_margin(3.0)
                .shadow(egui::Shadow { offset: [0, 6], blur: 18, spread: 0, color: Color32::from_black_alpha(128) })
                .show(ui, |ui| {
                    ui.spacing_mut().item_spacing = Vec2::ZERO;
                    egui::ScrollArea::vertical().max_height(320.0).show(ui, |ui| {
                        for (g, name) in groups.iter().zip(names) {
                            let (r, response) = ui.allocate_exact_size(vec2(width, POP_ROW_H), Sense::click());
                            let p = ui.painter();
                            if g.is_head || response.hovered() {
                                p.rect_filled(r, RADIUS, pal.accent_line);
                            }
                            let mid = r.center().y;
                            let mut x = r.left() + 7.0;
                            let icon_at =
                                |x: f32| Rect::from_min_size(pos2(x, mid - CHIP_ICON / 2.0), Vec2::splat(CHIP_ICON));
                            if g.is_head {
                                icons::paint(ui, icon_at(x), "check", pal.green_fg);
                            }
                            x += gutter;
                            let name_w = name.size().x;
                            let color = if g.is_head { pal.fg_bright } else { pal.chip_head_fg };
                            p.galley(pos2(x, mid - name.size().y / 2.0), name, color);
                            x += name_w + 5.0;
                            for icon in where_icons(g) {
                                icons::paint(ui, icon_at(x), icon, color.gamma_multiply(0.6));
                                x += CHIP_ICON + 5.0;
                            }
                            if response.double_clicked() {
                                events.push(checkout(g));
                            }
                            if response.secondary_clicked() {
                                pin = true;
                                let at = response.interact_pointer_pos().unwrap_or(r.left_bottom());
                                events.push(Event::ChipMenu(at, g.action_kind, g.action_name.clone()));
                            }
                            let act = if g.kind == GroupKind::Worktree || !g.elsewhere.is_empty() {
                                "double-click to open that worktree"
                            } else {
                                "double-click to check out"
                            };
                            let _ = response.on_hover_text(format!("{} - {act}, right-click for actions", g.name));
                        }
                    });
                });
        },
    );
    state.pop = Some(Pop { row, rect: shown.response.rect, pinned: pin });
}

fn quick_commit(
    ui: &mut Ui,
    state: &mut State,
    pal: &Palette,
    row: Rect,
    left: f32,
    hover: Option<Pos2>,
    events: &mut Vec<Event>,
) {
    let field = Rect::from_min_size(pos2(left, row.center().y - 10.0), vec2(QUICK_W, 20.0));
    let id = ui.scope_id().with("quick-commit");
    let focused = ui.memory(|m| m.has_focus(id));
    if focused {
        ui.painter().rect_filled(field, RADIUS, pal.bg_inset);
    }
    let staged = state.wip.staged;
    let edit = egui::TextEdit::singleline(&mut state.quick)
        .id(id)
        .hint_text(RichText::new("// WIP").italics().color(pal.fg_muted))
        .frame(Frame::NONE)
        .margin(Margin::symmetric(6, 2))
        .font(FontId::proportional(12.0))
        .text_color(pal.fg)
        .desired_width(QUICK_W - 12.0);
    let response = ui.put(field, edit);
    let border = if focused {
        Some(pal.accent)
    } else if hover.is_some_and(|h| field.contains(h)) {
        Some(pal.bg_4)
    } else {
        None
    };
    if let Some(color) = border {
        ui.painter().rect_stroke(field, RADIUS, Stroke::new(1.0, color), StrokeKind::Inside);
    }
    let tip = if staged > 0 {
        format!("Commit {staged} staged file{}", if staged == 1 { "" } else { "s" })
    } else {
        "Stage something first, in the panel on the right".to_string()
    };
    let response = response.on_hover_text(tip);
    if !response.lost_focus() {
        return;
    }
    let (enter, escape) = ui.input(|i| (i.key_pressed(Key::Enter), i.key_pressed(Key::Escape)));
    let summary = state.quick.trim().to_string();
    if enter && staged > 0 && !summary.is_empty() {
        events.push(Event::QuickCommit(summary));
        state.quick.clear();
    } else if escape {
        state.quick.clear();
    }
}

fn header(ui: &Ui, full: Rect, chips_w: f32, graph_w: f32, pal: &Palette) {
    let rect = Rect::from_min_size(full.min, vec2(full.width(), HEADER_H));
    let p = ui.painter_at(rect);
    p.rect_filled(rect, 0.0, pal.bg_1);
    let font = FontId::proportional(10.0);
    let y = rect.center().y;
    let label = |x: f32, text: &str| {
        p.text(pos2(x, y), Align2::LEFT_CENTER, text, font.clone(), pal.fg_muted);
    };
    label(rect.left() + 8.0, "BRANCH / TAG");
    label(rect.left() + chips_w, "GRAPH");
    label(rect.left() + chips_w + graph_w + 9.0, "COMMIT MESSAGE");
}

fn resizers(
    ui: &Ui,
    full: Rect,
    widths: &mut Widths,
    graph_w: f32,
    deepest: usize,
    pal: &Palette,
    events: &mut Vec<Event>,
) {
    let handle = |x: f32, salt: &str| {
        let rect = Rect::from_min_max(pos2(x - 3.0, full.top()), pos2(x + 4.0, full.bottom()));
        let response = ui.interact(rect, ui.scope_id().with(salt), Sense::click_and_drag());
        if response.hovered() || response.dragged() {
            ui.painter().vline(x, full.y_range(), Stroke::new(1.0, pal.accent));
        }
        response.on_hover_cursor(CursorIcon::ResizeColumn)
    };

    let chips = handle(full.left() + widths.chips, "chips-resize");
    if chips.dragged() {
        widths.chips = (widths.chips + chips.drag_delta().x).clamp(CHIPS_W_MIN, CHIPS_W_MAX);
    }
    if chips.double_clicked() {
        widths.chips = Settings::default().chips_width;
    }
    if chips.drag_stopped() || chips.double_clicked() {
        events.push(Event::Save);
    }
    let _ = chips.on_hover_text("Drag to resize the branch column, double-click to reset");

    let graph = handle(full.left() + widths.chips + graph_w, "graph-resize");
    if graph.dragged() {
        widths.graph = Some((graph_w + graph.drag_delta().x).clamp(GRAPH_W_MIN, GRAPH_W_MAX));
    }
    if graph.double_clicked() {
        widths.graph = None;
    }
    if graph.drag_stopped() || graph.double_clicked() {
        events.push(Event::Save);
    }
    let tip = match widths.graph {
        None => format!("Auto-sized to the rows on screen ({} lanes deepest). Drag to pin a width.", deepest + 1),
        Some(_) => "Manual width, double-click to return to automatic".to_string(),
    };
    let _ = graph.on_hover_text(tip);
}

fn checkout(g: &RefGroup) -> Event {
    if g.kind == GroupKind::Worktree || !g.holder.is_empty() {
        return Event::OpenWorktree(g.holder.clone());
    }
    Event::Checkout(g.action_kind, g.action_name.clone())
}

fn chip_tip(g: &RefGroup) -> String {
    let place = match g.kind {
        GroupKind::Tag => "tag".to_string(),
        GroupKind::Worktree => "worktree, detached".to_string(),
        GroupKind::Branch => {
            let mut parts: Vec<&str> = Vec::new();
            if g.local {
                parts.push("local");
            }
            parts.extend(g.remotes.iter().map(String::as_str));
            parts.join(", ")
        }
    };
    let head = if g.is_head { " - checked out" } else { "" };
    let held = if g.kind == GroupKind::Branch && !g.elsewhere.is_empty() {
        format!(" - checked out in worktree {}", g.elsewhere)
    } else {
        String::new()
    };
    let act = if g.kind == GroupKind::Worktree || !g.elsewhere.is_empty() {
        "double-click to open that worktree"
    } else {
        "double-click to check out"
    };
    format!("{} - {place}{head}{held}\n{act}, right-click for actions", g.name)
}

fn person_tip(name: &str, email: &str) -> String {
    if email.is_empty() { name.to_string() } else { format!("{name} <{email}>") }
}

fn where_icons(g: &RefGroup) -> Vec<&'static str> {
    if g.kind != GroupKind::Branch {
        return Vec::new();
    }
    let mut out = Vec::new();
    if !g.elsewhere.is_empty() {
        out.push("worktree");
    }
    if g.local {
        out.push("monitor");
    }
    out.extend(g.remotes.iter().map(|_| "cloud"));
    out
}

fn counts(ui: &Ui, mut x: f32, mid: f32, modified: usize, added: usize, pal: &Palette) {
    let p = ui.painter();
    let font = FontId::proportional(12.0);
    if modified > 0 {
        icons::paint(ui, Rect::from_min_size(pos2(x, mid - 6.0), Vec2::splat(12.0)), "edit", pal.amber);
        let r = p.text(pos2(x + 16.0, mid), Align2::LEFT_CENTER, modified, font.clone(), pal.amber);
        x = r.right() + 10.0;
    }
    if added > 0 {
        p.text(pos2(x, mid), Align2::LEFT_CENTER, format!("+ {added}"), font, pal.green);
    }
}

fn lanes(p: &Painter, row: &GraphRow, top_left: Pos2, pal: &Palette) {
    let (left, top) = (top_left.x, top_left.y);
    let mid = top + ROW_H / 2.0;
    let bottom = top + ROW_H;
    let x = left + lane_x(row.lane);
    let stroke = |color: usize| Stroke::new(STROKE, pal.lane(color));
    for t in &row.through {
        let tx = left + lane_x(t.lane);
        p.line_segment([pos2(tx, top), pos2(tx, bottom)], stroke(t.color));
    }
    for m in &row.merges {
        p.add(Shape::line(elbow_up(left + lane_x(m.from), x, top, mid), stroke(m.color)));
    }
    for f in &row.forks {
        p.add(Shape::line(elbow_down(x, left + lane_x(f.to), mid, bottom), stroke(f.color)));
    }
    if row.has_top {
        p.line_segment([pos2(x, top), pos2(x, mid)], stroke(row.color));
    }
    if row.has_bottom {
        p.line_segment([pos2(x, mid), pos2(x, bottom)], stroke(row.color));
    }
}

fn elbow_up(from: f32, to: f32, top: f32, mid: f32) -> Vec<Pos2> {
    let dir = if to > from { 1.0 } else { -1.0 };
    let r = CORNER.min((to - from).abs() / 2.0).min(mid - top);
    if r <= 0.5 {
        return vec![pos2(from, top), pos2(from, mid)];
    }
    let mut points = vec![pos2(from, top), pos2(from, mid - r)];
    quad(&mut points, pos2(from, mid - r), pos2(from, mid), pos2(from + dir * r, mid));
    points.push(pos2(to, mid));
    points
}

fn elbow_down(from: f32, to: f32, mid: f32, bottom: f32) -> Vec<Pos2> {
    let dir = if to > from { 1.0 } else { -1.0 };
    let r = CORNER.min((to - from).abs() / 2.0).min(bottom - mid);
    if r <= 0.5 {
        return vec![pos2(from, mid), pos2(from, bottom)];
    }
    let mut points = vec![pos2(from, mid), pos2(to - dir * r, mid)];
    quad(&mut points, pos2(to - dir * r, mid), pos2(to, mid), pos2(to, mid + r));
    points.push(pos2(to, bottom));
    points
}

fn quad(points: &mut Vec<Pos2>, a: Pos2, control: Pos2, b: Pos2) {
    const STEPS: usize = 6;
    for k in 1..=STEPS {
        let t = k as f32 / STEPS as f32;
        let u = 1.0 - t;
        points.push((a.to_vec2() * (u * u) + control.to_vec2() * (2.0 * u * t) + b.to_vec2() * (t * t)).to_pos2());
    }
}

fn circle_points(center: Pos2, r: f32) -> Vec<Pos2> {
    const STEPS: usize = 40;
    (0..=STEPS)
        .map(|k| {
            let a = k as f32 / STEPS as f32 * std::f32::consts::TAU;
            center + vec2(a.cos(), a.sin()) * r
        })
        .collect()
}

fn visible_width(rows: &[GraphRow], from: usize, to: usize) -> f32 {
    let max = rows.get(from..to).unwrap_or(&[]).iter().map(|r| r.width).max().unwrap_or(0);
    ((max + 1) as f32 * LANE_W + PAD_X * 2.0).max(GRAPH_W_MIN)
}

fn row_rect(origin: Pos2, width: f32, i: usize) -> Rect {
    Rect::from_min_size(origin + vec2(0.0, i as f32 * ROW_H), vec2(width, ROW_H))
}

fn lane_x(lane: usize) -> f32 {
    PAD_X + lane as f32 * LANE_W
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn elbows_stay_on_their_columns() {
        let up = elbow_up(14.0, 58.0, 0.0, 13.0);
        assert_eq!(up.first(), Some(&pos2(14.0, 0.0)));
        assert_eq!(up.last(), Some(&pos2(58.0, 13.0)));
        let down = elbow_down(58.0, 14.0, 13.0, 26.0);
        assert_eq!(down.first(), Some(&pos2(58.0, 13.0)));
        assert_eq!(down.last(), Some(&pos2(14.0, 26.0)));
        assert_eq!(elbow_down(14.0, 14.0, 13.0, 26.0).len(), 2);
    }

    #[test]
    fn graph_column_fits_the_visible_rows() {
        let rows = vec![GraphRow { width: 0, ..GraphRow::default() }, GraphRow { width: 4, ..GraphRow::default() }];
        assert_eq!(visible_width(&rows, 0, 1), GRAPH_W_MIN);
        assert_eq!(visible_width(&rows, 0, 2), 5.0 * LANE_W + PAD_X * 2.0);
        assert_eq!(visible_width(&rows, 5, 9), GRAPH_W_MIN);
    }
}
