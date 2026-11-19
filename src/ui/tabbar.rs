use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use eframe::egui::text::{LayoutJob, TextFormat, TextWrapping};
use eframe::egui::{Color32, FontId, Galley, Id, Pos2, Rect, Sense, Stroke, Ui, Vec2};

use super::actions::same_path;
use super::dialogs::MenuItem;
use super::{App, actions, icons};
use crate::engine::api::Request;
use crate::engine::types::{RemoteState, Session, Tab, Worktree, WorktreeChanges};

const CHANGES_EVERY: Duration = Duration::from_secs(10);
const TAB_MAX: f32 = 150.0;
const TAB_MIN: f32 = 46.0;
const GEAR_W: f32 = 38.0;
const ADD_W: f32 = 30.0;

#[derive(Default)]
pub struct State {
    changes: HashMap<String, WorktreeChanges>,
    mains: HashMap<String, String>,
    asked_mains: HashSet<String>,
    queue: Vec<String>,
    asking: bool,
    last_poll: Option<Instant>,
    active_seen: (String, u64),
    shown: HashMap<String, String>,
    dragging: Option<String>,
}

struct Group {
    head: Tab,
    members: Vec<Tab>,
}

#[derive(serde::Deserialize, Default)]
#[serde(default)]
struct WorktreeList {
    worktrees: Vec<Worktree>,
}

pub fn show(app: &mut App, ui: &mut Ui) {
    let tabs: Vec<Tab> =
        app.session.tabs.iter().filter(|t| t.workspaces.contains(&app.session.workspace)).cloned().collect();
    poll(app, &tabs);
    let groups = group_tabs(&tabs, &app.tabbar.mains);
    let active = app.active_id();
    follow_worktree(&groups, active.as_deref(), &mut app.tabbar.shown);

    let p = app.palette;
    let bar = ui.max_rect();
    let painter = ui.painter().clone();
    painter.rect_filled(bar, 0.0, p.bg_0);
    painter.hline(bar.x_range(), bar.bottom() - 0.5, Stroke::new(1.0, p.line));

    let workspace = app.session.workspaces.iter().find(|w| w.id == app.session.workspace).map(|w| w.name.clone());
    let name = galley(ui, workspace.as_deref().unwrap_or("Workspace"), 12.0, p.fg_dim, 160.0 - 36.0);
    let ws_rect = Rect::from_min_size(bar.min, Vec2::new(name.size().x + 36.0, bar.height()));
    let ws = ui.interact(ws_rect, Id::unique("tabbar-workspace"), Sense::click()).on_hover_text("Switch workspace");
    let ws_color = if ws.hovered() { p.fg_bright } else { p.fg_dim };
    if ws.hovered() {
        painter.rect_filled(ws_rect, 0.0, p.bg_2);
    }
    painter.galley(Pos2::new(ws_rect.left() + 10.0, bar.center().y - name.size().y / 2.0), name, ws_color);
    icons::paint(
        ui,
        Rect::from_center_size(Pos2::new(ws_rect.right() - 15.0, bar.center().y), Vec2::splat(11.0)),
        "chevronDown",
        ws_color.gamma_multiply(0.55),
    );
    painter.vline(ws_rect.right() - 0.5, bar.y_range(), Stroke::new(1.0, p.line_strong));
    if ws.clicked() {
        actions::workspace_menu(app, ws_rect.left_bottom());
    }

    let strip = Rect::from_x_y_ranges(ws_rect.right()..=bar.right() - GEAR_W, bar.y_range());
    let clipped = painter.with_clip_rect(strip);
    let pointer = ui.ctx().pointer_interact_pos();
    let mut x = strip.left();
    let mut over: Option<(String, bool)> = None;
    let mut boxes: Vec<(String, Rect)> = Vec::with_capacity(groups.len());
    for g in &groups {
        let shown = shown_of(g, active.as_deref(), &app.tabbar.shown);
        let on_worktree = shown.id != g.head.id;
        let is_active = active.as_deref() == Some(shown.id.as_str());
        let dragged = app.tabbar.dragging.as_deref() == Some(g.head.id.as_str());
        let changes = app.tabbar.changes.get(&shown.id).filter(|c| c.files > 0).cloned();

        let worktree =
            on_worktree.then(|| galley(ui, &format!("/ {}", shown.name), 12.0, Color32::WHITE, f32::INFINITY));
        let more = (!g.members.is_empty())
            .then(|| galley(ui, &g.members.len().to_string(), 10.0, Color32::WHITE, f32::INFINITY));
        let dirty = changes.as_ref().map(|c| dirty_parts(ui, c, p));
        let dirty_w = dirty
            .as_ref()
            .map(|d| {
                d.iter().map(|(g, icon)| g.size().x + if *icon { 13.0 } else { 0.0 }).sum::<f32>()
                    + 3.0 * (d.len() as f32 - 1.0)
            })
            .unwrap_or(0.0);
        let fixed = 10.0
            + 13.0
            + 6.0
            + if g.head.host.is_some() { 13.0 } else { 0.0 }
            + worktree.as_ref().map_or(0.0, |w| w.size().x + 6.0)
            + more.as_ref().map_or(0.0, |m| m.size().x + 8.0 + 9.0 + 6.0)
            + if dirty.is_some() { dirty_w + 6.0 } else { 0.0 }
            + 6.0
            + 20.0
            + 6.0;
        let name_full = galley(ui, &g.head.name, 12.0, Color32::WHITE, f32::INFINITY).size().x;
        let cap = if on_worktree { f32::INFINITY } else { TAB_MAX };
        let width = (fixed + name_full).min(cap).max(TAB_MIN);
        let rect = Rect::from_min_size(Pos2::new(x, bar.top()), Vec2::new(width, bar.height() - 1.0));
        x += width;
        boxes.push((g.head.id.clone(), rect));

        let tip = match &shown.host {
            Some(h) => format!("{h}:{}", shown.path),
            None => shown.path.clone(),
        };
        let resp = ui.interact(rect.intersect(strip), Id::unique(("tab", &g.head.id)), Sense::click_and_drag());
        let hovered = ui.rect_contains_pointer(rect.intersect(strip));
        let fade = if dragged { 0.4 } else { 1.0 };
        let text = if is_active {
            p.fg_bright
        } else if hovered {
            p.fg_dim
        } else {
            p.fg_muted
        }
        .gamma_multiply(fade);
        if is_active {
            clipped.rect_filled(rect, 0.0, p.bg_1);
            clipped.rect_filled(Rect::from_min_size(rect.min, Vec2::new(width, 2.0)), 0.0, p.accent);
        } else if hovered {
            clipped.rect_filled(rect, 0.0, p.bg_2);
        }
        clipped.vline(rect.right() - 0.5, rect.y_range(), Stroke::new(1.0, p.line));

        let cy = rect.center().y;
        let mut cx = rect.left() + 10.0;
        let icon = if on_worktree { "worktree" } else { "repo" };
        paint_icon(
            ui,
            &clipped,
            Rect::from_center_size(Pos2::new(cx + 6.5, cy), Vec2::splat(13.0)),
            icon,
            text.gamma_multiply(0.55),
        );
        cx += 13.0 + 6.0;
        if let Some(host) = &g.head.host {
            let (led, title) = led(&app.remotes, host, p);
            clipped.circle_filled(Pos2::new(cx + 3.5, cy), 3.5, led.gamma_multiply(fade));
            let dot = Rect::from_center_size(Pos2::new(cx + 3.5, cy), Vec2::splat(9.0));
            ui.interact(dot, Id::unique(("tab-led", &g.head.id)), Sense::hover()).on_hover_text(title);
            cx += 13.0;
        }
        let name_w = (width - fixed).max(0.0);
        let name = galley(ui, &g.head.name, 12.0, text, name_w);
        clipped.galley(Pos2::new(cx, cy - name.size().y / 2.0), name, text);
        cx += name_w + 6.0;
        if let Some(w) = worktree {
            clipped.galley_with_override_text_color(Pos2::new(cx, cy - w.size().y / 2.0), w.clone(), text);
            cx += w.size().x + 6.0;
        }
        let mut more_clicked = None;
        if let Some(m) = more {
            let r = Rect::from_min_size(Pos2::new(cx, cy - 8.0), Vec2::new(m.size().x + 8.0 + 9.0, 16.0));
            let mr = ui
                .interact(r.intersect(strip), Id::unique(("tab-more", &g.head.id)), Sense::click())
                .on_hover_text(format!("Worktrees open from {}", g.head.name));
            let color = if mr.hovered() { p.fg } else { p.fg_dim }.gamma_multiply(fade);
            if mr.hovered() {
                clipped.rect_filled(r, 3.0, p.bg_3);
            }
            clipped.galley_with_override_text_color(Pos2::new(r.left() + 4.0, cy - m.size().y / 2.0), m.clone(), color);
            paint_icon(
                ui,
                &clipped,
                Rect::from_center_size(Pos2::new(r.right() - 8.5, cy), Vec2::splat(9.0)),
                "chevronDown",
                color,
            );
            if mr.clicked() {
                more_clicked = Some(r.left_bottom());
            }
            cx = r.right() + 6.0;
        }
        if let (Some(parts), Some(c)) = (dirty, changes.as_ref()) {
            let r = Rect::from_min_size(Pos2::new(cx, cy - 8.0), Vec2::new(dirty_w, 16.0));
            for (part, icon) in parts {
                if icon {
                    paint_icon(
                        ui,
                        &clipped,
                        Rect::from_center_size(Pos2::new(cx + 5.0, cy), Vec2::splat(10.0)),
                        "edit",
                        p.amber.gamma_multiply(fade),
                    );
                    cx += 13.0;
                }
                let w = part.size().x;
                clipped.galley(Pos2::new(cx, cy - part.size().y / 2.0), part, p.fg);
                cx += w + 3.0;
            }
            ui.interact(r, Id::unique(("tab-dirty", &g.head.id)), Sense::hover()).on_hover_text(changes_title(c));
        }
        let close_rect = Rect::from_center_size(Pos2::new(rect.right() - 6.0 - 10.0, cy), Vec2::splat(20.0));
        let mut close = false;
        if hovered || is_active {
            let cr = ui
                .interact(close_rect.intersect(strip), Id::unique(("tab-close", &g.head.id)), Sense::click())
                .on_hover_text(if on_worktree { "Close worktree" } else { "Close repository" });
            let color = if cr.hovered() {
                clipped.rect_filled(close_rect, 3.0, p.red_bg);
                p.red_fg
            } else {
                text.gamma_multiply(0.55)
            };
            paint_icon(ui, &clipped, close_rect.shrink(4.5), "close", color);
            close = cr.clicked();
        }

        if !dragged && app.tabbar.dragging.is_some() {
            if let Some(pos) = pointer.filter(|pos| rect.contains(*pos)) {
                over = Some((g.head.id.clone(), pos.x > rect.center().x));
            }
        }

        if resp.drag_started() {
            app.tabbar.dragging = Some(g.head.id.clone());
        }
        let resp = resp.on_hover_text(tip);
        if close || resp.middle_clicked() {
            actions::close_tab(app, &shown.id);
        } else if let Some(pos) = more_clicked {
            worktree_menu(app, g, active.as_deref(), pos);
        } else if resp.secondary_clicked() {
            let pos = resp.interact_pointer_pos().unwrap_or(rect.left_bottom());
            actions::tab_menu(app, pos, &shown.id);
        } else if resp.clicked() && (!is_active || app.prefs_open) {
            app.activate(&shown.id);
        }
    }

    if let Some((id, after)) = &over {
        if let Some((_, r)) = boxes.iter().find(|(b, _)| b == id) {
            let edge = if *after { r.right() - 1.0 } else { r.left() + 1.0 };
            clipped.vline(edge, r.y_range(), Stroke::new(2.0, p.accent));
        }
    }
    if app.tabbar.dragging.is_some() && ui.input(|i| !i.pointer.any_down()) {
        if let Some(dragging) = app.tabbar.dragging.take() {
            if let Some((id, after)) = over {
                drop_tab(app, &groups, &tabs, &dragging, &id, after);
            }
        }
    }

    let add_rect =
        Rect::from_min_size(Pos2::new(x.min(strip.right() - ADD_W), bar.top()), Vec2::new(ADD_W, bar.height() - 1.0));
    let add = ui.interact(add_rect, Id::unique("tabbar-add"), Sense::click()).on_hover_text("Open a repository");
    if add.hovered() {
        painter.rect_filled(add_rect, 0.0, p.bg_3);
    }
    icons::paint(
        ui,
        Rect::from_center_size(add_rect.center(), Vec2::splat(14.0)),
        "plus",
        if add.hovered() { p.fg } else { p.fg_dim },
    );
    if add.clicked() {
        app.session.active_id = None;
        app.prefs_open = false;
    }

    let gear_rect =
        Rect::from_min_max(Pos2::new(bar.right() - GEAR_W, bar.top()), Pos2::new(bar.right(), bar.bottom() - 1.0));
    let gear = ui.interact(gear_rect, Id::unique("tabbar-gear"), Sense::click()).on_hover_text("Preferences");
    if gear.hovered() {
        painter.rect_filled(gear_rect, 0.0, p.bg_2);
    }
    icons::paint(
        ui,
        Rect::from_center_size(gear_rect.center(), Vec2::splat(14.0)),
        "gear",
        if gear.hovered() { p.fg } else { p.fg_muted },
    );
    if gear.clicked() {
        app.prefs_open = true;
    }
}

/// Text laid out on one line, cut with an ellipsis past `max_width`.
pub fn galley(ui: &Ui, text: &str, size: f32, color: Color32, max_width: f32) -> Arc<Galley> {
    let mut job = LayoutJob::single_section(text.to_string(), TextFormat::simple(FontId::proportional(size), color));
    job.wrap = TextWrapping::truncate_at_width(max_width);
    ui.painter().layout_job(job)
}

fn poll(app: &mut App, tabs: &[Tab]) {
    let active = app.active_id();
    let focused = app.ctx.input(|i| i.focused);
    let version = active.as_ref().and_then(|id| app.repos.get(id)).map_or(0, |r| r.version);
    let st = &mut app.tabbar;
    let due = st.last_poll.is_none_or(|t| t.elapsed() >= CHANGES_EVERY);
    if focused && due && st.queue.is_empty() {
        st.last_poll = Some(Instant::now());
        st.queue = tabs
            .iter()
            .rev()
            .filter(|t| t.host.is_none() || active.as_ref() == Some(&t.id))
            .map(|t| t.id.clone())
            .collect();
    }
    if let Some(id) = &active {
        if st.active_seen.0 != *id || st.active_seen.1 != version {
            st.active_seen = (id.clone(), version);
            st.queue.retain(|q| q != id);
            st.queue.push(id.clone());
        }
    }
    if !st.asking {
        if let Some(id) = st.queue.pop() {
            st.asking = true;
            app.jobs.request(
                Request::Changes { id: id.clone() },
                move |app, result: Result<WorktreeChanges, String>| {
                    app.tabbar.asking = false;
                    if let Ok(c) = result {
                        app.tabbar.changes.insert(id, c);
                    }
                },
            );
        }
    }
    let left = app.tabbar.last_poll.map_or(CHANGES_EVERY, |t| CHANGES_EVERY.saturating_sub(t.elapsed()));
    app.ctx.request_repaint_after(left.max(Duration::from_millis(100)));

    for t in tabs {
        if app.tabbar.asked_mains.contains(&t.id) || (t.host.is_some() && active.as_ref() != Some(&t.id)) {
            continue;
        }
        app.tabbar.asked_mains.insert(t.id.clone());
        let id = t.id.clone();
        app.jobs.request(Request::Worktrees { id: id.clone() }, move |app, result: Result<WorktreeList, String>| {
            let Ok(list) = result else {
                app.tabbar.asked_mains.remove(&id);
                return;
            };
            if let Some(main) = list.worktrees.into_iter().find(|w| w.main) {
                app.tabbar.mains.insert(id, main.path);
            }
        });
    }
}

fn shown_of<'a>(g: &'a Group, active: Option<&str>, shown: &HashMap<String, String>) -> &'a Tab {
    if active == Some(g.head.id.as_str()) {
        return &g.head;
    }
    let last = shown.get(&g.head.id);
    g.members.iter().find(|t| Some(&t.id) == last).unwrap_or(&g.head)
}

fn worktree_menu(app: &mut App, g: &Group, active: Option<&str>, pos: Pos2) {
    let item = |t: &Tab, changes: &HashMap<String, WorktreeChanges>| {
        let id = t.id.clone();
        let mut item = MenuItem::new(t.name.clone(), move |app: &mut App| app.activate(&id))
            .checked(active == Some(t.id.as_str()));
        if let Some(c) = changes.get(&t.id).filter(|c| c.files > 0) {
            item = item.hint(changes_title(c));
        }
        item
    };
    let mut items = vec![item(&g.head, &app.tabbar.changes), MenuItem::separator()];
    items.extend(g.members.iter().map(|t| item(t, &app.tabbar.changes)));
    let ctx = app.ctx.clone();
    app.overlay.menu(&ctx, pos, items);
}

fn drop_tab(app: &mut App, groups: &[Group], tabs: &[Tab], dragging: &str, over: &str, after: bool) {
    let Some(moving) = groups.iter().find(|g| g.head.id == dragging) else { return };
    let mut heads: Vec<&Group> = groups.iter().filter(|g| g.head.id != dragging).collect();
    let Some(at) = heads.iter().position(|g| g.head.id == over) else { return };
    heads.insert(if after { at + 1 } else { at }, moving);
    let order: Vec<String> =
        heads.iter().flat_map(|g| std::iter::once(&g.head).chain(&g.members)).map(|t| t.id.clone()).collect();
    if order.iter().eq(tabs.iter().map(|t| &t.id)) {
        return;
    }
    let mut rest = std::mem::take(&mut app.session.tabs);
    let mut sorted: Vec<Tab> = Vec::with_capacity(rest.len());
    for id in &order {
        if let Some(i) = rest.iter().position(|t| &t.id == id) {
            sorted.push(rest.remove(i));
        }
    }
    sorted.append(&mut rest);
    app.session.tabs = sorted;
    app.jobs.request(Request::Reorder { order }, |app, result: Result<Session, String>| match result {
        Ok(session) => app.set_session(session),
        Err(e) => app.toasts.error(&e),
    });
}

fn led(remotes: &[RemoteState], host: &str, p: super::theme::Palette) -> (Color32, String) {
    match remotes.iter().find(|r| r.host == host).map(|r| r.state.as_str()) {
        Some("online") => (p.green, format!("{host} - connected")),
        Some("connecting") => (p.amber, format!("{host} - connecting")),
        _ => (p.red, format!("{host} - not connected; opening this tab will reconnect")),
    }
}

fn dirty_parts(ui: &Ui, c: &WorktreeChanges, p: super::theme::Palette) -> Vec<(Arc<Galley>, bool)> {
    if c.added == 0 && c.removed == 0 {
        return vec![(galley(ui, &compact(c.files), 10.0, p.amber, f32::INFINITY), true)];
    }
    let mut parts = Vec::new();
    if c.added > 0 {
        parts.push((galley(ui, &format!("+{}", compact(c.added)), 10.0, p.green, f32::INFINITY), false));
    }
    if c.removed > 0 {
        parts.push((galley(ui, &format!("-{}", compact(c.removed)), 10.0, p.red, f32::INFINITY), false));
    }
    parts
}

fn paint_icon(ui: &Ui, painter: &eframe::egui::Painter, rect: Rect, name: &str, color: Color32) {
    if painter.clip_rect().contains_rect(rect) {
        icons::paint(ui, rect, name, color);
    }
}

fn changes_title(c: &WorktreeChanges) -> String {
    let files = if c.files == 1 { "1 changed file".to_string() } else { format!("{} changed files", c.files) };
    format!("{files}, +{} -{} lines", c.added, c.removed)
}

fn compact(n: u64) -> String {
    if n < 1000 {
        return n.to_string();
    }
    if n < 10000 {
        return format!("{:.1}k", n as f64 / 1000.0);
    }
    format!("{}k", (n as f64 / 1000.0).round())
}

fn group_tabs(tabs: &[Tab], mains: &HashMap<String, String>) -> Vec<Group> {
    let head_of = |t: &Tab| -> Option<String> {
        let main = mains.get(&t.id)?;
        if same_path(&t.path, main) {
            return None;
        }
        tabs.iter().find(|h| h.id != t.id && h.host == t.host && same_path(&h.path, main)).map(|h| h.id.clone())
    };
    let heads: Vec<Option<String>> = tabs.iter().map(head_of).collect();
    let mut groups: Vec<Group> = Vec::new();
    for (t, head) in tabs.iter().zip(&heads) {
        if head.is_none() {
            groups.push(Group { head: t.clone(), members: Vec::new() });
        }
    }
    for (t, head) in tabs.iter().zip(&heads) {
        let Some(head) = head else { continue };
        match groups.iter_mut().find(|g| &g.head.id == head) {
            Some(g) => g.members.push(t.clone()),
            None => groups.push(Group { head: t.clone(), members: Vec::new() }),
        }
    }
    groups
}

fn follow_worktree(groups: &[Group], active: Option<&str>, shown: &mut HashMap<String, String>) {
    let Some(active) = active else { return };
    let Some(group) = groups.iter().find(|g| g.head.id == active || g.members.iter().any(|t| t.id == active)) else {
        return;
    };
    let now = group.members.iter().find(|t| t.id == active);
    let was = shown.get(&group.head.id).cloned();
    if was.as_deref() == now.map(|t| t.id.as_str()) {
        return;
    }
    let was_name = group.members.iter().find(|t| Some(&t.id) == was.as_ref()).map(|t| t.name.clone());
    match now {
        Some(t) => shown.insert(group.head.id.clone(), t.id.clone()),
        None => shown.remove(&group.head.id),
    };
    for g in groups.iter().filter(|g| g.head.id != group.head.id) {
        match now {
            Some(now) => {
                if let Some(same) = g.members.iter().find(|t| t.name == now.name) {
                    shown.insert(g.head.id.clone(), same.id.clone());
                }
            }
            None => {
                let current = g.members.iter().find(|t| shown.get(&g.head.id) == Some(&t.id)).map(|t| &t.name);
                if was_name.is_some() && current == was_name.as_ref() {
                    shown.remove(&g.head.id);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tab(id: &str, path: &str, host: Option<&str>) -> Tab {
        let name = path.rsplit('/').next().map(str::to_string).unwrap_or_default();
        Tab {
            id: id.into(),
            name,
            path: path.into(),
            host: host.map(str::to_string),
            workspaces: vec!["default".into()],
        }
    }

    fn shape(tabs: &[Tab], mains: &HashMap<String, String>) -> Vec<Vec<String>> {
        group_tabs(tabs, mains)
            .iter()
            .map(|g| std::iter::once(&g.head).chain(&g.members).map(|t| t.id.clone()).collect())
            .collect()
    }

    fn map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
    }

    #[test]
    fn paths() {
        assert!(same_path("C:\\Code\\repo\\agent", "C:/Code/repo/agent"));
        assert!(same_path("c:/code/Repo/agent", "C:/Code/repo/agent"));
        assert!(same_path("/code/agent/", "/code/agent"));
        assert!(!same_path("/code/Agent", "/code/agent"));
        assert!(!same_path("/code/agent", "/code/agent2"));
    }

    #[test]
    fn grouping() {
        let repo = tab("t1", "/code/repo", None);
        let agent = tab("t2", "/code/repo/worktrees/agent", None);
        let other = tab("t3", "/code/other", None);
        let remote_agent = tab("t4", "/code/repo/worktrees/agent", Some("box"));
        let mains = map(&[("t1", "/code/repo"), ("t2", "/code/repo"), ("t3", "/code/other"), ("t4", "/code/repo")]);
        let ids =
            |v: &[&[&str]]| v.iter().map(|g| g.iter().map(|s| s.to_string()).collect()).collect::<Vec<Vec<String>>>();
        assert_eq!(shape(&[repo.clone(), other.clone(), agent.clone()], &mains), ids(&[&["t1", "t2"], &["t3"]]));
        assert_eq!(shape(&[agent.clone(), repo.clone()], &mains), ids(&[&["t1", "t2"]]));
        assert_eq!(shape(&[agent.clone(), other], &mains), ids(&[&["t2"], &["t3"]]));
        assert_eq!(shape(&[repo.clone(), remote_agent], &mains), ids(&[&["t1"], &["t4"]]));
        assert_eq!(shape(&[repo, agent], &map(&[("t1", "/code/repo")])), ids(&[&["t1"], &["t2"]]));
    }

    #[test]
    fn following() {
        let tabs = [
            tab("a", "/code/frontend", None),
            tab("ax", "/code/frontend/worktrees/feature-x", None),
            tab("ay", "/code/frontend/worktrees/feature-y", None),
            tab("t", "/code/backend", None),
            tab("tx", "/code/backend/worktrees/feature-x", None),
            tab("o", "/code/other", None),
        ];
        let mains = map(&[
            ("a", "/code/frontend"),
            ("ax", "/code/frontend"),
            ("ay", "/code/frontend"),
            ("t", "/code/backend"),
            ("tx", "/code/backend"),
            ("o", "/code/other"),
        ]);
        let groups = group_tabs(&tabs, &mains);
        let mut shown = HashMap::new();
        follow_worktree(&groups, Some("ax"), &mut shown);
        assert_eq!(shown, map(&[("a", "ax"), ("t", "tx")]));
        follow_worktree(&groups, Some("ay"), &mut shown);
        assert_eq!(shown, map(&[("a", "ay"), ("t", "tx")]));
        follow_worktree(&groups, Some("ax"), &mut shown);
        follow_worktree(&groups, Some("a"), &mut shown);
        assert!(shown.is_empty());
        shown.insert("t".into(), "tx".into());
        follow_worktree(&groups, Some("o"), &mut shown);
        assert_eq!(shown, map(&[("t", "tx")]));
    }

    #[test]
    fn compacting() {
        assert_eq!(compact(999), "999");
        assert_eq!(compact(1234), "1.2k");
        assert_eq!(compact(12345), "12k");
    }
}
