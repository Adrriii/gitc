use std::collections::HashSet;
use std::sync::Arc;

use eframe::egui::text::{LayoutJob, TextWrapping};
use eframe::egui::{
    self, Color32, CornerRadius, FontId, Galley, Id, Pos2, Rect, Response, Sense, Stroke, StrokeKind, Ui, Vec2, pos2,
    vec2,
};

use super::theme::Palette;
use super::{App, actions, icons};
use crate::engine::types::{GraphPayload, Ref, Submodule};

#[path = "sidebar_tree.rs"]
mod tree;
use tree::Tree;

const ROW_H: f32 = 22.0;
const HEAD_H: f32 = 27.0;
const INDENT: f32 = 11.0;
const DIM: f32 = 0.45;

pub struct State {
    filter: String,
    expanded: &'static str,
    collapsed: HashSet<String>,
    rows: Vec<Row>,
    counts: Counts,
    built: Option<Key>,
    dirty: bool,
    dates: Vec<i64>,
    dates_version: Option<u64>,
}

impl Default for State {
    fn default() -> Self {
        State {
            filter: String::new(),
            expanded: "LOCAL",
            collapsed: HashSet::new(),
            rows: Vec::new(),
            counts: Counts::default(),
            built: None,
            dirty: true,
            dates: Vec::new(),
            dates_version: None,
        }
    }
}

#[derive(PartialEq, Clone, Copy)]
struct Key {
    version: u64,
    hidden: usize,
    submodules: usize,
    folders: bool,
}

#[derive(Default)]
struct Counts {
    local: usize,
    remote: usize,
    tags: usize,
}

enum Row {
    Folder { key: String, name: String, path: String, depth: usize, refs: Vec<usize>, hidden: bool },
    Ref { index: usize, label: String, depth: usize, hidden: bool },
    Remote { key: String, name: String, refs: Vec<usize>, hidden: bool },
    Tag { index: usize, hidden: bool },
    Stash(usize),
    Worktree(usize),
    Submodule(usize),
}

enum Act {
    Reveal(String),
    Checkout(String, String),
    RefMenu(Pos2, Ref),
    RemoteMenu(Pos2, String),
    FolderMenu(Pos2, String, Vec<String>),
    StashMenu(Pos2, String),
    SubmoduleMenu(Pos2, Submodule),
    WorktreeMenu(Pos2, String),
    Hide(Vec<String>, bool),
    NewBranch,
    AddRemote,
    ToggleFolders,
    ViewWorktree(String),
    EditWorktree(String),
    OpenSubmodule(Submodule),
    Toggle(String),
}

struct View<'a> {
    data: &'a GraphPayload,
    submodules: &'a [Submodule],
    p: &'a Palette,
    now: i64,
}

pub fn show(app: &mut App, ui: &mut Ui) {
    let Some(id) = app.active_id() else { return };
    let folders = app.settings.branch_folders;
    let palette = app.palette;
    let Some(repo) = app.repos.get_mut(&id) else { return };
    let Some(data) = repo.data.as_ref() else { return };
    let submodules = repo.submodules.as_deref().unwrap_or(&data.submodules);
    let state = &mut repo.sidebar;
    let view = View { data, submodules, p: &palette, now: crate::engine::git::now_ms() as i64 };

    ui.spacing_mut().item_spacing = Vec2::ZERO;
    let mut act = top(state, &view, folders, ui);
    state.refresh(data, submodules.len(), repo.version, folders);
    if let Some(a) = sections(state, &view, &id, ui) {
        act = Some(a);
    }
    let Some(act) = act else { return };
    apply(app, &id, act);
}

impl State {
    fn refresh(&mut self, data: &GraphPayload, submodules: usize, version: u64, folders: bool) {
        let key = Key { version, hidden: data.hidden.len(), submodules, folders };
        if !self.dirty && self.built == Some(key) {
            return;
        }
        self.dirty = false;
        self.built = Some(key);
        if self.dates_version != Some(version) || self.dates.len() != data.refs.len() {
            self.dates = ref_dates(data);
            self.dates_version = Some(version);
        }

        let filter = self.filter.trim().to_lowercase();
        let filtering = !filter.is_empty();
        let hidden: HashSet<&str> = data.hidden.iter().map(String::as_str).collect();
        let mut locals: Vec<(usize, &str)> = Vec::new();
        let mut tags: Vec<usize> = Vec::new();
        let mut remotes: Vec<(&str, Vec<(usize, &str)>)> = Vec::new();
        let mut remote_count = 0;
        for (i, r) in data.refs.iter().enumerate() {
            if filtering && !r.short.to_lowercase().contains(&filter) {
                continue;
            }
            match r.kind.as_str() {
                "local" => locals.push((i, r.short.as_str())),
                "tag" => tags.push(i),
                "remote" => {
                    remote_count += 1;
                    let remote = r.remote.as_deref().unwrap_or("origin");
                    let path = r.short.get(remote.len() + 1..).unwrap_or(&r.short);
                    match remotes.iter_mut().find(|(name, _)| *name == remote) {
                        Some((_, list)) => list.push((i, path)),
                        None => remotes.push((remote, vec![(i, path)])),
                    }
                }
                _ => {}
            }
        }
        self.counts = Counts { local: locals.len(), remote: remote_count, tags: tags.len() };

        let arrange = |items: &[(usize, &str)]| {
            if folders { Tree::build(items, &self.dates) } else { Tree::flat(items, &self.dates) }
        };
        let mut rows = Vec::new();
        let walk = Walk { refs: &data.refs, hidden: &hidden, collapsed: &self.collapsed, filtering };
        match self.expanded {
            "LOCAL" => {
                let tree = arrange(&locals);
                walk.push(&mut rows, &tree, &tree.roots, 0, "local");
            }
            "REMOTE" => {
                let mut names: Vec<&str> = data.remote_detail.iter().map(|r| r.name.as_str()).collect();
                for (name, _) in &remotes {
                    if !names.contains(name) {
                        names.push(*name);
                    }
                }
                for name in names {
                    let items = remotes.iter().find(|(n, _)| *n == name).map(|(_, l)| l.as_slice()).unwrap_or(&[]);
                    let tree = arrange(items);
                    let refs = tree.all_items();
                    let key = format!("remote|{name}");
                    let open = filtering || !self.collapsed.contains(&key);
                    rows.push(Row::Remote { key, name: name.to_string(), hidden: walk.all_hidden(&refs), refs });
                    if open {
                        walk.push(&mut rows, &tree, &tree.roots, 1, &format!("remote:{name}"));
                    }
                }
            }
            "TAGS" => rows.extend(tags.iter().map(|&i| Row::Tag { index: i, hidden: walk.is_hidden(i) })),
            "STASHES" => rows.extend((0..data.stashes.len()).map(Row::Stash)),
            "WORKTREES" => rows.extend((0..data.worktrees.len()).map(Row::Worktree)),
            "SUBMODULES" => rows.extend((0..submodules).map(Row::Submodule)),
            _ => {}
        }
        self.rows = rows;
    }
}

struct Walk<'a> {
    refs: &'a [Ref],
    hidden: &'a HashSet<&'a str>,
    collapsed: &'a HashSet<String>,
    filtering: bool,
}

impl Walk<'_> {
    fn push(&self, rows: &mut Vec<Row>, tree: &Tree, level: &[usize], depth: usize, scope: &str) {
        for &n in level {
            let Some(node) = tree.node(n) else { continue };
            let folder = !node.children.is_empty();
            let key = format!("{scope}|{}", node.path);
            let open = folder && (self.filtering || !self.collapsed.contains(&key));
            if folder {
                let mut refs = Vec::new();
                tree.items_under(n, &mut refs);
                let hidden = self.all_hidden(&refs);
                rows.push(Row::Folder { key, name: node.name.clone(), path: node.path.clone(), depth, refs, hidden });
            }
            if let Some(index) = node.item {
                let depth = if folder { depth + 1 } else { depth };
                rows.push(Row::Ref { index, label: node.name.clone(), depth, hidden: self.is_hidden(index) });
            }
            if open {
                self.push(rows, tree, &node.children, depth + 1, scope);
            }
        }
    }

    fn is_hidden(&self, index: usize) -> bool {
        self.refs.get(index).is_some_and(|r| self.hidden.contains(r.short.as_str()))
    }

    fn all_hidden(&self, refs: &[usize]) -> bool {
        !refs.is_empty() && refs.iter().all(|&i| self.is_hidden(i))
    }
}

fn top(state: &mut State, view: &View, folders: bool, ui: &mut Ui) -> Option<Act> {
    let p = view.p;
    let mut act = None;
    egui::Frame::new().inner_margin(8.0).show(ui, |ui| {
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 6.0;
            let id = Id::unique("sidebar-filter");
            let focused = ui.memory(|m| m.has_focus(id));
            let frame = egui::Frame::new()
                .fill(p.bg_inset)
                .stroke(Stroke::new(1.0, if focused { p.accent } else { p.line }))
                .corner_radius(3.0)
                .inner_margin(egui::Margin::symmetric(7, 4));
            let edit = egui::TextEdit::singleline(&mut state.filter)
                .id(id)
                .hint_text("Filter")
                .font(FontId::proportional(12.0))
                .frame(frame)
                .desired_width(ui.available_width() - 30.0);
            if ui.add(edit).changed() {
                state.dirty = true;
            }
            let (rect, resp) = ui.allocate_exact_size(Vec2::splat(24.0), Sense::click());
            let hover = resp.contains_pointer();
            let (fill, line, fg) = match (folders, hover) {
                (true, _) => (p.accent_bg, p.accent_line, p.accent),
                (false, true) => (p.bg_inset, p.line_strong, p.fg),
                (false, false) => (p.bg_inset, p.line, p.fg_muted),
            };
            ui.painter().rect_filled(rect, 3.0, fill);
            ui.painter().rect_stroke(rect, 3.0, Stroke::new(1.0, line), StrokeKind::Inside);
            icons::paint(ui, Rect::from_center_size(rect.center(), Vec2::splat(13.0)), "folder", fg);
            let tip = if folders {
                "Grouping branches into folders by name. Click to flatten the list and show every branch by date."
            } else {
                "Showing every branch by date, most recent first. Click to group them into folders by name."
            };
            if resp.on_hover_text(tip).clicked() {
                act = Some(Act::ToggleFolders);
            }
        });
    });
    act
}

fn sections(state: &mut State, view: &View, repo_id: &str, ui: &mut Ui) -> Option<Act> {
    let data = view.data;
    let mut list: Vec<(&'static str, usize)> = vec![("LOCAL", state.counts.local)];
    if data.worktrees.len() > 1 {
        list.push(("WORKTREES", data.worktrees.len()));
    }
    list.push(("REMOTE", state.counts.remote));
    list.push(("TAGS", state.counts.tags));
    if !data.stashes.is_empty() {
        list.push(("STASHES", data.stashes.len()));
    }
    if !view.submodules.is_empty() {
        list.push(("SUBMODULES", view.submodules.len()));
    }
    if !list.iter().any(|(name, _)| *name == state.expanded) && !state.expanded.is_empty() {
        state.expanded = "LOCAL";
        state.dirty = true;
    }

    let body_h = (ui.available_height() - HEAD_H * list.len() as f32).max(0.0);
    let mut act = None;
    for (name, count) in list {
        let open = state.expanded == name;
        let add = match name {
            "LOCAL" => Some(("Create a branch", Act::NewBranch)),
            "REMOTE" => Some(("Add a remote", Act::AddRemote)),
            _ => None,
        };
        let (toggled, added) = header(ui, view.p, name, count, open, add.as_ref().map(|(tip, _)| *tip));
        if added {
            act = add.map(|(_, a)| a);
        } else if toggled {
            state.expanded = if open { "" } else { name };
            state.dirty = true;
        }
        if !open {
            continue;
        }
        let width = ui.available_width();
        ui.allocate_ui(vec2(width, body_h), |ui| {
            ui.set_min_size(vec2(width, body_h));
            egui::ScrollArea::vertical()
                .id_salt(("sidebar", repo_id, name))
                .auto_shrink([false, false])
                .max_height(body_h)
                .show_rows(ui, ROW_H, state.rows.len(), |ui, range| {
                    for i in range {
                        if let Some(a) = draw_row(&state.rows, &state.dates, view, i, ui) {
                            act = Some(a);
                        }
                    }
                });
        });
    }
    if let Some(Act::Toggle(key)) = act {
        toggle(state, key);
        return None;
    }
    act
}

fn header(ui: &mut Ui, p: &Palette, name: &str, count: usize, open: bool, add: Option<&str>) -> (bool, bool) {
    let (rect, resp) = ui.allocate_exact_size(vec2(ui.available_width(), HEAD_H), Sense::click());
    let hover = resp.contains_pointer();
    let painter = ui.painter();
    if hover {
        painter.rect_filled(rect, 0.0, p.bg_3);
    }
    painter.hline(rect.x_range(), rect.bottom() - 0.5, Stroke::new(1.0, p.line));
    let cy = rect.center().y;
    let chevron = if open { "chevronDown" } else { "chevronRight" };
    icons::paint(ui, Rect::from_center_size(pos2(rect.left() + 16.0, cy), Vec2::splat(12.0)), chevron, p.fg_muted);
    let label = layout(ui, name, 11.0, p.fg_dim, rect.width());
    put(ui, label, rect.left() + 29.0, cy, p.fg_dim);

    let right = rect.right() - 10.0;
    let mut added = false;
    if let (Some(tip), true) = (add, hover) {
        let button = Rect::from_min_max(pos2(right - 18.0, cy - 9.0), pos2(right + 2.0, cy + 9.0));
        let resp = ui.interact(button, resp.id.with("add"), Sense::click());
        let fill = if resp.contains_pointer() { p.green_line } else { p.green_bg };
        ui.painter().rect_filled(button, 3.0, fill);
        ui.painter().rect_stroke(button, 3.0, Stroke::new(1.0, p.green_line), StrokeKind::Inside);
        icons::paint(ui, Rect::from_center_size(button.center(), Vec2::splat(12.0)), "plus", p.green_fg);
        added = resp.on_hover_text(tip).clicked();
    } else {
        let text = layout(ui, &count.to_string(), 11.0, p.fg_muted, 60.0);
        let w = text.size().x;
        put(ui, text, right - w, cy, p.fg_muted);
    }
    (resp.clicked() && !added, added)
}

fn draw_row(rows: &[Row], dates: &[i64], view: &View, i: usize, ui: &mut Ui) -> Option<Act> {
    let data = view.data;
    let p = view.p;
    match rows.get(i)? {
        Row::Ref { index, label, depth, hidden } => {
            let r = data.refs.get(*index)?;
            let current = r.kind == "local" && data.head.branch.as_deref() == Some(r.short.as_str());
            let age = dates.get(*index).copied().filter(|d| *d > 0).map(|d| ago(view.now - d * 1000));
            let (resp, hover) = row(ui, p, current);
            let fade = if *hidden { DIM } else { 1.0 };
            let rect = resp.rect;
            let cy = rect.center().y;
            let mut x = rect.left() + 4.0 + *depth as f32 * INDENT;
            let mut act = None;
            if eye(ui, p, &resp, x, *hidden, hover) {
                act = Some(Act::Hide(vec![r.short.clone()], !hidden));
            }
            x += 24.0;
            let icon_color = if current { p.green } else { p.fg_faint };
            icons::paint(
                ui,
                Rect::from_center_size(pos2(x + 6.0, cy), Vec2::splat(12.0)),
                if current { "check" } else { "branch" },
                icon_color.gamma_multiply(fade),
            );
            x += 18.0;
            let right = rect.right() - 10.0 - 18.0;
            let mut name_end = right;
            if let (Some(age), false) = (age, hover) {
                let text = layout(ui, &age, 10.0, p.fg_faint, 60.0);
                let w = text.size().x;
                put(ui, text, right - w, cy, p.fg_faint.gamma_multiply(fade));
                name_end = right - w - 4.0;
            }
            let color = match (current, hover) {
                (true, true) => p.fg_bright,
                (true, false) => p.chip_head_fg,
                (false, true) => p.fg,
                (false, false) => p.fg_dim,
            }
            .gamma_multiply(fade);
            let name = layout(ui, label, 12.0, color, name_end - x - 4.0);
            put(ui, name, x, cy, color);
            if let Some(pos) = kebab(ui, p, &resp, *hidden, hover) {
                act = Some(Act::RefMenu(pos, r.clone()));
            }
            let resp = tip(resp, || format!("{}\nclick to find it in the graph, double-click to check out", r.short));
            if act.is_some() {
                return act;
            }
            if resp.double_clicked() {
                return Some(Act::Checkout(r.kind.clone(), r.short.clone()));
            }
            if resp.clicked() {
                return Some(Act::Reveal(r.hash.clone()));
            }
            if resp.secondary_clicked() {
                return Some(Act::RefMenu(pointer(&resp), r.clone()));
            }
            None
        }
        Row::Folder { key, name, path, depth, refs, hidden } => {
            let (resp, hover) = row(ui, p, false);
            let fade = if *hidden { DIM } else { 1.0 };
            let rect = resp.rect;
            let cy = rect.center().y;
            let mut x = rect.left() + 4.0 + *depth as f32 * INDENT;
            let shorts = || refs.iter().filter_map(|&i| data.refs.get(i)).map(|r| r.short.clone()).collect::<Vec<_>>();
            let mut act = None;
            if eye(ui, p, &resp, x, *hidden, hover) {
                act = Some(Act::Hide(shorts(), !hidden));
            }
            x += 24.0;
            icons::paint(
                ui,
                Rect::from_center_size(pos2(x + 6.0, cy), Vec2::splat(12.0)),
                "folder",
                p.fg_faint.gamma_multiply(fade),
            );
            x += 18.0;
            let right = rect.right() - 10.0 - 18.0;
            let count = layout(ui, &refs.len().to_string(), 10.0, p.fg_faint, 60.0);
            let w = count.size().x;
            put(ui, count, right - w, cy, p.fg_faint.gamma_multiply(fade));
            let color = if hover { p.fg } else { p.fg_dim }.gamma_multiply(fade);
            let text = layout(ui, name, 12.0, color, right - w - 10.0 - x);
            put(ui, text, x, cy, color);
            if let Some(pos) = kebab(ui, p, &resp, *hidden, hover) {
                act = Some(Act::FolderMenu(pos, path.clone(), shorts()));
            }
            let resp = tip(resp, || path.clone());
            if act.is_some() {
                return act;
            }
            if resp.secondary_clicked() {
                return Some(Act::FolderMenu(pointer(&resp), path.clone(), shorts()));
            }
            if resp.clicked() {
                return Some(Act::Toggle(key.clone()));
            }
            None
        }
        Row::Remote { key, name, refs, hidden } => {
            let (resp, hover) = row(ui, p, false);
            let fade = if *hidden { DIM } else { 1.0 };
            let rect = resp.rect;
            let cy = rect.center().y;
            let mut x = rect.left() + 8.0;
            let shorts = || refs.iter().filter_map(|&i| data.refs.get(i)).map(|r| r.short.clone()).collect::<Vec<_>>();
            let mut act = None;
            if eye(ui, p, &resp, x, *hidden, hover) {
                act = Some(Act::Hide(shorts(), !hidden));
            }
            x += 24.0;
            icons::paint(
                ui,
                Rect::from_center_size(pos2(x + 6.0, cy), Vec2::splat(12.0)),
                "cloud",
                p.fg_faint.gamma_multiply(fade),
            );
            x += 18.0;
            let right = rect.right() - 10.0 - 18.0;
            let color = if hover { p.fg } else { p.fg_dim }.gamma_multiply(fade);
            let text = layout(ui, name, 12.0, color, right - x - 4.0);
            let w = text.size().x;
            put(ui, text, x, cy, color);
            if refs.is_empty() {
                let hint = layout(ui, "no branches", 10.0, p.fg_faint, (right - x - w - 12.0).max(0.0));
                put(ui, hint, x + w + 6.0, cy, p.fg_faint);
            }
            if let Some(pos) = kebab(ui, p, &resp, *hidden, hover) {
                act = Some(Act::RemoteMenu(pos, name.clone()));
            }
            let resp = tip(resp, || format!("{name}\nright-click to fetch, edit or remove"));
            if act.is_some() {
                return act;
            }
            if resp.secondary_clicked() {
                return Some(Act::RemoteMenu(pointer(&resp), name.clone()));
            }
            if resp.clicked() {
                return Some(Act::Toggle(key.clone()));
            }
            None
        }
        Row::Tag { index, hidden } => {
            let r = data.refs.get(*index)?;
            let (resp, hover) = row(ui, p, false);
            let fade = if *hidden { DIM } else { 1.0 };
            let rect = resp.rect;
            let cy = rect.center().y;
            let mut x = rect.left() + 4.0;
            let mut act = None;
            if eye(ui, p, &resp, x, *hidden, hover) {
                act = Some(Act::Hide(vec![r.short.clone()], !hidden));
            }
            x += 24.0;
            icons::paint(
                ui,
                Rect::from_center_size(pos2(x + 6.0, cy), Vec2::splat(12.0)),
                "tag",
                p.fg_faint.gamma_multiply(fade),
            );
            x += 18.0;
            let right = rect.right() - 10.0 - 18.0;
            let color = if hover { p.fg } else { p.fg_dim }.gamma_multiply(fade);
            let text = layout(ui, &r.short, 12.0, color, right - x - 4.0);
            put(ui, text, x, cy, color);
            if let Some(pos) = kebab(ui, p, &resp, *hidden, hover) {
                act = Some(Act::RefMenu(pos, r.clone()));
            }
            let resp = tip(resp, || format!("{}\nclick to find it in the graph, right-click for more", r.short));
            if act.is_some() {
                return act;
            }
            if resp.secondary_clicked() {
                return Some(Act::RefMenu(pointer(&resp), r.clone()));
            }
            if resp.clicked() {
                return Some(Act::Reveal(r.hash.clone()));
            }
            None
        }
        Row::Stash(index) => {
            let st = data.stashes.get(*index)?;
            let (resp, hover) = row(ui, p, false);
            let rect = resp.rect;
            let cy = rect.center().y;
            let x = rect.left() + 4.0;
            icons::paint(ui, Rect::from_center_size(pos2(x + 6.0, cy), Vec2::splat(12.0)), "stash", p.fg_faint);
            let right = rect.right() - 10.0 - 18.0;
            let color = if hover { p.fg } else { p.fg_dim };
            let text = layout(ui, tree::stash_name(&st.subject), 12.0, color, right - x - 22.0);
            put(ui, text, x + 18.0, cy, color);
            let menu = kebab(ui, p, &resp, false, hover);
            let resp = tip(resp, || format!("{} - {}\nright-click to apply, pop or delete", st.selector, st.subject));
            if let Some(pos) = menu {
                return Some(Act::StashMenu(pos, st.selector.clone()));
            }
            if resp.secondary_clicked() {
                return Some(Act::StashMenu(pointer(&resp), st.selector.clone()));
            }
            None
        }
        Row::Worktree(index) => worktree_row(data.worktrees.get(*index)?, view, ui),
        Row::Submodule(index) => submodule_row(view.submodules.get(*index)?, p, ui),
    }
}

fn worktree_row(w: &crate::engine::types::Worktree, view: &View, ui: &mut Ui) -> Option<Act> {
    let p = view.p;
    let (resp, hover) = row(ui, p, w.current);
    let fade = if w.prunable { DIM } else { 1.0 };
    let rect = resp.rect;
    let cy = rect.center().y;
    let x = rect.left() + 4.0;
    let label = tree::worktree_label(w);
    let icon_color = if w.current { p.green } else { p.fg_faint };
    icons::paint(
        ui,
        Rect::from_center_size(pos2(x + 6.0, cy), Vec2::splat(12.0)),
        if w.current { "check" } else { "worktree" },
        icon_color.gamma_multiply(fade),
    );
    let x = x + 18.0;

    let mut right = rect.right() - 10.0;
    let mut act = None;
    if hover && !w.current && !w.prunable {
        for (icon, tip_text, edit) in
            [("edit", "Open it to edit", true), ("eye", "Look at its changes here - read-only", false)]
        {
            let button = Rect::from_min_max(pos2(right - 18.0, cy - 9.0), pos2(right, cy + 9.0));
            let b = ui.interact(button, resp.id.with(icon), Sense::click());
            let color = if b.contains_pointer() {
                ui.painter().rect_filled(button, 3.0, Color32::from_white_alpha(23));
                p.fg
            } else {
                p.fg_faint
            };
            icons::paint(ui, Rect::from_center_size(button.center(), Vec2::splat(13.0)), icon, color);
            if b.on_hover_text(tip_text).clicked() {
                act = Some(if edit { Act::EditWorktree(w.name.clone()) } else { Act::ViewWorktree(w.name.clone()) });
            }
            right -= 20.0;
        }
    } else if let Some((text, tone)) = tree::worktree_badge(w) {
        right -= pill(ui, p, &text, tone, right, cy) + 4.0;
    }
    if tree::worktree_active(w) {
        ui.painter().circle_filled(pos2(right - 3.0, cy), 3.0, p.green);
        right -= 12.0;
    }
    let branch = if w.detached { "detached" } else { w.branch.as_deref().unwrap_or("") };
    if !branch.is_empty() && branch != label {
        let text = layout(ui, branch, 10.0, p.fg_faint, rect.width() * 0.45);
        let bw = text.size().x;
        put(ui, text, right - bw, cy, p.fg_faint.gamma_multiply(fade));
        right -= bw + 6.0;
    }
    let color = match (w.current, hover) {
        (true, true) => p.fg_bright,
        (true, false) => p.chip_head_fg,
        (false, true) => p.fg,
        (false, false) => p.fg_dim,
    }
    .gamma_multiply(fade);
    let name = layout(ui, label, 12.0, color, right - x - 4.0);
    put(ui, name, x, cy, color);

    let resp = tip(resp, || worktree_tip(w, label));
    if act.is_some() {
        return act;
    }
    if resp.double_clicked() {
        return Some(Act::EditWorktree(w.name.clone()));
    }
    if resp.clicked() {
        return Some(Act::ViewWorktree(w.name.clone()));
    }
    if resp.secondary_clicked() {
        return Some(Act::WorktreeMenu(pointer(&resp), w.name.clone()));
    }
    None
}

fn submodule_row(sub: &Submodule, p: &Palette, ui: &mut Ui) -> Option<Act> {
    let (resp, hover) = row(ui, p, false);
    let fade = if sub.state == "uninitialized" { DIM } else { 1.0 };
    let rect = resp.rect;
    let cy = rect.center().y;
    let x = rect.left() + 4.0;
    icons::paint(
        ui,
        Rect::from_center_size(pos2(x + 6.0, cy), Vec2::splat(12.0)),
        "repo",
        p.fg_faint.gamma_multiply(fade),
    );
    let x = x + 18.0;
    let mut right = rect.right() - 10.0;
    let (short, tone) = submodule_state(&sub.state);
    if !short.is_empty() {
        right -= pill(ui, p, short, tone, right, cy) + 4.0;
    }
    let color = if hover { p.fg } else { p.fg_dim }.gamma_multiply(fade);
    let name = layout(ui, &sub.path, 12.0, color, right - x - 4.0);
    put(ui, name, x, cy, color);
    let resp = tip(resp, || {
        format!("{} - {}\ndouble-click to open it as a tab, right-click for more", sub.path, describe_submodule(sub))
    });
    if resp.double_clicked() {
        return Some(Act::OpenSubmodule(sub.clone()));
    }
    if resp.secondary_clicked() {
        return Some(Act::SubmoduleMenu(pointer(&resp), sub.clone()));
    }
    None
}

fn apply(app: &mut App, id: &str, act: Act) {
    match act {
        Act::Reveal(hash) => {
            if let Some(repo) = app.repos.get_mut(id) {
                repo.reveal_commit(&hash);
            }
        }
        Act::Checkout(kind, short) => actions::checkout_ref(app, &kind, &short),
        Act::RefMenu(pos, r) => actions::ref_menu(app, pos, &r),
        Act::RemoteMenu(pos, name) => actions::remote_menu(app, pos, &name),
        Act::FolderMenu(pos, label, refs) => actions::folder_menu(app, pos, &label, refs),
        Act::StashMenu(pos, selector) => actions::stash_menu(app, pos, &selector),
        Act::SubmoduleMenu(pos, sub) => actions::submodule_menu(app, pos, &sub),
        Act::WorktreeMenu(pos, name) => actions::worktree_menu(app, pos, &name),
        Act::Hide(refs, hide) => actions::set_hidden(app, refs, hide),
        Act::NewBranch => actions::new_branch(app),
        Act::AddRemote => actions::add_remote(app),
        Act::ToggleFolders => {
            app.settings.branch_folders = !app.settings.branch_folders;
            app.save_settings();
        }
        Act::ViewWorktree(name) => actions::view_worktree(app, &name),
        Act::EditWorktree(name) => actions::edit_worktree(app, &name),
        Act::OpenSubmodule(sub) => actions::open_submodule(app, &sub),
        Act::Toggle(_) => {}
    }
}

fn toggle(state: &mut State, key: String) {
    if !state.collapsed.remove(&key) {
        state.collapsed.insert(key);
    }
    state.dirty = true;
}

fn row(ui: &mut Ui, p: &Palette, current: bool) -> (Response, bool) {
    let (rect, resp) = ui.allocate_exact_size(vec2(ui.available_width(), ROW_H), Sense::click());
    let hover = resp.contains_pointer();
    let fill = match (current, hover) {
        (true, true) => Some(p.accent_line),
        (true, false) => Some(p.chip_head),
        (false, true) => Some(p.bg_3),
        (false, false) => None,
    };
    if let Some(fill) = fill {
        ui.painter().rect_filled(rect, 0.0, fill);
    }
    (resp, hover)
}

fn eye(ui: &mut Ui, p: &Palette, row: &Response, x: f32, hidden: bool, hover: bool) -> bool {
    let rect = Rect::from_min_size(pos2(x, row.rect.center().y - 9.0), Vec2::splat(18.0));
    let resp = ui.interact(rect, row.id.with("eye"), Sense::click());
    if !hover && !hidden {
        return false;
    }
    let color = if resp.contains_pointer() {
        ui.painter().rect_filled(rect, 3.0, Color32::from_white_alpha(23));
        p.fg
    } else {
        p.green
    };
    icons::paint(
        ui,
        Rect::from_center_size(rect.center(), Vec2::splat(13.0)),
        if hidden { "eyeOff" } else { "eye" },
        color,
    );
    resp.on_hover_text(if hidden { "Show in the graph" } else { "Hide in the graph" }).clicked()
}

fn kebab(ui: &mut Ui, p: &Palette, row: &Response, pinned: bool, hover: bool) -> Option<Pos2> {
    let right = row.rect.right() - 10.0;
    let rect =
        Rect::from_min_max(pos2(right - 18.0, row.rect.center().y - 9.0), pos2(right, row.rect.center().y + 9.0));
    let resp = ui.interact(rect, row.id.with("kebab"), Sense::click());
    if !hover && !pinned {
        return None;
    }
    let color = if resp.contains_pointer() {
        ui.painter().rect_filled(rect, 3.0, Color32::from_white_alpha(23));
        p.fg
    } else if pinned {
        p.green
    } else {
        p.fg_faint
    };
    icons::paint(ui, Rect::from_center_size(rect.center(), Vec2::splat(12.0)), "kebab", color);
    resp.on_hover_text("More").clicked().then_some(rect.right_bottom())
}

/// Draws a rounded state badge ending at `right`; returns its width.
fn pill(ui: &Ui, p: &Palette, text: &str, tone: u8, right: f32, cy: f32) -> f32 {
    let (bg, fg) = match tone {
        2 => (p.red_bg, p.red_fg),
        1 => (p.amber_bg, p.amber_fg),
        _ => (p.bg_3, p.fg_muted),
    };
    let galley = layout(ui, text, 10.0, fg, 120.0);
    let size = galley.size() + vec2(10.0, 2.0);
    let rect = Rect::from_min_size(pos2(right - size.x, cy - size.y / 2.0), size);
    ui.painter().rect_filled(rect, CornerRadius::same(255), bg);
    put(ui, galley, rect.left() + 5.0, cy, fg);
    size.x
}

fn tip(resp: Response, text: impl FnOnce() -> String) -> Response {
    if resp.hovered() { resp.on_hover_text(text()) } else { resp }
}

fn pointer(resp: &Response) -> Pos2 {
    resp.interact_pointer_pos().unwrap_or(resp.rect.left_bottom())
}

fn layout(ui: &Ui, text: &str, size: f32, color: Color32, max_width: f32) -> Arc<Galley> {
    let mut job = LayoutJob::simple_singleline(text.to_owned(), FontId::proportional(size), color);
    job.wrap = TextWrapping::truncate_at_width(max_width.max(1.0));
    ui.painter().layout_job(job)
}

fn put(ui: &Ui, galley: Arc<Galley>, x: f32, cy: f32, color: Color32) {
    let y = cy - galley.size().y / 2.0;
    ui.painter().galley(pos2(x, y), galley, color);
}

fn ref_dates(data: &GraphPayload) -> Vec<i64> {
    let mut at: std::collections::HashMap<&str, Vec<usize>> = std::collections::HashMap::new();
    for (i, r) in data.refs.iter().enumerate() {
        at.entry(r.hash.as_str()).or_default().push(i);
    }
    let mut dates = vec![0; data.refs.len()];
    for c in &data.commits {
        let Some(list) = at.get(c.hash.as_str()) else { continue };
        for &i in list {
            if let Some(d) = dates.get_mut(i) {
                *d = c.date;
            }
        }
    }
    dates
}

fn worktree_tip(w: &crate::engine::types::Worktree, label: &str) -> String {
    let where_ =
        if w.detached { "detached HEAD".to_string() } else { format!("on {}", w.branch.as_deref().unwrap_or("")) };
    let mut lines =
        vec![format!("{label} - {}", w.path), if w.current { "open in this tab".to_string() } else { where_ }];
    if w.locked {
        lines.push(if w.lock_reason.is_empty() { "locked".to_string() } else { format!("locked: {}", w.lock_reason) });
    }
    if tree::worktree_active(w) {
        lines.push(format!("changed {}s ago - something may be working in it", w.idle_ms / 1000));
    }
    if !w.current {
        lines.push("click to look at it here, double-click to open it to edit".to_string());
    }
    lines.join("\n")
}

fn submodule_state(state: &str) -> (&'static str, u8) {
    match state {
        "pending" => ("...", 0),
        "uninitialized" => ("not cloned", 0),
        "moved" => ("moved", 1),
        "dirty" => ("modified", 1),
        "conflicted" => ("conflicts", 2),
        _ => ("", 0),
    }
}

fn describe_submodule(sub: &Submodule) -> String {
    match sub.state.as_str() {
        "pending" => "reading its state".into(),
        "uninitialized" => "declared but not checked out".into(),
        "moved" => "at a different commit than this repository records".into(),
        "dirty" => "has uncommitted work inside it - nothing this repository can stage".into(),
        "conflicted" => "has merge conflicts".into(),
        _ if sub.label.is_empty() => "at the recorded commit".into(),
        _ => format!("at the recorded commit ({})", sub.label),
    }
}

/// A duration at the coarsest unit that still says something: "now", "42s", "5m", "3h", "12d", "2y".
fn ago(ms: i64) -> String {
    let secs = ms / 1000;
    if secs < 2 {
        return "now".into();
    }
    if secs < 60 {
        return format!("{secs}s");
    }
    let mins = secs / 60;
    if mins < 60 {
        return format!("{mins}m");
    }
    let hours = mins / 60;
    if hours < 24 {
        return format!("{hours}h");
    }
    let days = hours / 24;
    if days < 365 {
        return format!("{days}d");
    }
    format!("{}y", days / 365)
}
