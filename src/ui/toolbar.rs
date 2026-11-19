use std::time::Duration;

use eframe::egui::{Color32, FontId, Id, Painter, Pos2, Rect, Response, Sense, Stroke, Ui, Vec2};

use super::preferences::version::{should_prompt, version_chip};
use super::tabbar::galley;
use super::theme::Palette;
use super::{App, actions, icons};
use crate::engine::git::now_ms;
use crate::engine::types::{AiConfig, AiProvider, OpArgs};

const TOOLBAR_H: f32 = 44.0;
const BANNER_H: f32 = 30.0;
const TICK_EVERY: Duration = Duration::from_secs(1);
const BUTTONS: [(&str, &str, &str); 6] = [
    ("Fetch", "fetch", "Fetch all remotes and prune"),
    ("Pull", "pull", "Pull (fast-forward only)"),
    ("Push", "push", "Push the current branch"),
    ("Branch", "branch", "Create a branch here"),
    ("Stash", "stash", "Stash changes, including untracked"),
    ("Pop", "pop", "Pop the latest stash"),
];

pub fn show(app: &mut App, ui: &mut Ui) {
    let Some(id) = app.active_id() else { return };
    let name = app.active_tab().map(|t| t.name.clone()).unwrap_or_default();
    let Some(repo) = app.repos.get(&id) else { return };
    let Some(data) = repo.data.as_ref() else { return };
    let branch = data.head.branch.clone().unwrap_or_else(|| "detached".into());
    let busy = repo.busy;
    let pending = data.pending.clone();
    let conflicts = if pending.conflicted {
        data.status
            .iter()
            .filter(|f| f.index == "U" || f.worktree == "U" || (f.index == "A" && f.worktree == "A"))
            .count()
    } else {
        0
    };
    let p = app.palette;
    ui.spacing_mut().item_spacing = Vec2::ZERO;

    let (bar, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), TOOLBAR_H), Sense::hover());
    let painter = ui.painter().clone();
    painter.rect_filled(bar, 0.0, p.bg_1);
    painter.hline(bar.x_range(), bar.bottom() - 0.5, Stroke::new(1.0, p.line));

    let group_w = BUTTONS.len() as f32 * 54.0 + (BUTTONS.len() as f32 - 1.0) * 2.0;
    let group_left = bar.center().x - group_w / 2.0;
    let mut x = bar.left() + 14.0;
    for (label, value) in [("repository", name.as_str()), ("branch", branch.as_str())] {
        let room = (group_left - 14.0 - x).min(220.0);
        if room < 30.0 {
            break;
        }
        let label = galley(ui, label, 10.0, p.fg_muted, room);
        let value = galley(ui, value, 15.0, p.fg_bright, room);
        let top = bar.center().y - (label.size().y + value.size().y) / 2.0;
        let width = label.size().x.max(value.size().x);
        painter.galley(Pos2::new(x, top), label.clone(), p.fg_muted);
        painter.galley(Pos2::new(x, top + label.size().y), value, p.fg_bright);
        x += width + 26.0;
    }

    let mut clicked = None;
    for (i, (label, icon, hint)) in BUTTONS.iter().enumerate() {
        let rect =
            Rect::from_min_size(Pos2::new(group_left + i as f32 * 56.0, bar.center().y - 18.0), Vec2::new(54.0, 36.0));
        let sense = if busy { Sense::hover() } else { Sense::click() };
        let resp = ui.interact(rect, Id::unique(("toolbar", *icon)), sense).on_hover_text(*hint);
        let lit = !busy && resp.hovered();
        if lit {
            let fill = if resp.is_pointer_button_down_on() { p.line_strong } else { p.bg_3 };
            painter.rect_filled(rect, 3.0, fill);
        }
        let color = if busy {
            p.fg_faint
        } else if lit {
            p.fg_bright
        } else {
            p.fg_dim
        };
        let text = galley(ui, label, 10.0, color, f32::INFINITY);
        painter.galley(Pos2::new(rect.center().x - text.size().x / 2.0, rect.top() + 4.0), text, color);
        icons::paint(
            ui,
            Rect::from_center_size(Pos2::new(rect.center().x, rect.bottom() - 3.0 - 8.5), Vec2::splat(17.0)),
            icon,
            color,
        );
        if resp.clicked() {
            clicked = Some(*icon);
        }
    }

    if !pending.kind.is_empty() {
        let (rect, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), BANNER_H), Sense::hover());
        let (bg, fg, edge) =
            if pending.conflicted { (p.red_bg, p.red_fg, p.red_line) } else { (p.amber_bg, p.amber_fg, p.amber_bg) };
        painter.rect_filled(rect, 0.0, bg);
        painter.hline(rect.x_range(), rect.bottom() - 0.5, Stroke::new(1.0, edge));
        let icon = if pending.conflicted { "warning" } else { "fetch" };
        icons::paint(
            ui,
            Rect::from_center_size(Pos2::new(rect.left() + 19.0, rect.center().y), Vec2::splat(14.0)),
            icon,
            fg,
        );
        let mut text = format!("{} in progress", capitalize(&pending.kind));
        if pending.conflicted && conflicts > 0 {
            let s = if conflicts == 1 { "" } else { "s" };
            text.push_str(&format!(" - {conflicts} conflicted file{s} to resolve"));
        }
        let can_skip = matches!(pending.kind.as_str(), "rebase" | "cherry-pick" | "revert");
        let mut right = rect.right() - 12.0;
        let abort_fill = p.red_line;
        if banner_button(ui, &painter, &mut right, rect, "Abort", "", !busy, abort_fill, abort_fill, fg) {
            clicked = Some("abort");
        }
        let soft = Color32::from_white_alpha(18);
        let line = Color32::from_white_alpha(60);
        if can_skip && banner_button(ui, &painter, &mut right, rect, "Skip", "Skip this commit", !busy, soft, line, fg)
        {
            clicked = Some("skip");
        }
        let tip = if pending.conflicted {
            "Resolve the conflicts and stage them first"
        } else {
            "Carry on with the operation"
        };
        if banner_button(ui, &painter, &mut right, rect, "Continue", tip, !busy && !pending.conflicted, soft, line, fg)
        {
            clicked = Some("continue");
        }
        let text = galley(ui, &text, 12.0, fg, (right - rect.left() - 40.0).max(0.0));
        painter.galley(Pos2::new(rect.left() + 33.0, rect.center().y - text.size().y / 2.0), text, fg);
    }

    match clicked {
        Some(op @ ("continue" | "skip" | "abort")) => {
            let args = OpArgs { op: op.to_string(), r#ref: pending.kind.clone(), ..Default::default() };
            actions::run_op(app, args);
        }
        Some(which) => actions::toolbar(app, which),
        None => {}
    }
}

pub fn status_bar(app: &mut App, ui: &mut Ui) {
    let Some(id) = app.active_id() else { return };
    let Some(tab) = app.active_tab().cloned() else { return };
    super::git_log::poll(app);
    let Some(repo) = app.repos.get(&id) else { return };
    let Some(data) = repo.data.as_ref() else { return };
    let p = app.palette;
    let viewing =
        if repo.loading { "Loading...".to_string() } else { format!("Viewing {} commits", data.commits.len()) };
    let local_age = repo.checked_at.map(|t| t.elapsed().as_millis() as u64);
    let remote_age = (repo.fetched_at > 0).then(|| now_ms().saturating_sub(repo.fetched_at.max(0) as u64));
    let has_remote = !data.remotes.is_empty();
    let stale_minutes = if app.settings.fetch_minutes > 0 { app.settings.fetch_minutes * 3 } else { 30 };

    let bar = ui.max_rect();
    let painter = ui.painter().clone();
    painter.hline(bar.x_range(), bar.top() + 0.5, Stroke::new(1.0, p.line_hard));
    let cy = bar.center().y;
    let mut right = bar.right() - 10.0;
    let mut action: Option<Box<dyn FnOnce(&mut App)>> = None;

    let (label, title) = version_chip(crate::VERSION, tab.host.as_deref(), &remote_version(app, tab.host.as_deref()));
    let version = galley(ui, &label, 11.0, p.fg_faint, f32::INFINITY);
    let r = Rect::from_min_size(Pos2::new(right - version.size().x, cy - 8.0), Vec2::new(version.size().x, 16.0));
    painter.galley(Pos2::new(r.left(), cy - version.size().y / 2.0), version, p.fg_faint);
    ui.interact(r, Id::unique("status-version"), Sense::hover()).on_hover_text(title);
    right = r.left() - 10.0;

    if let Some(config) = app.ai.as_ref().filter(|c| c.enabled && !c.features.is_empty()) {
        let label = match provider_for(config, tab.host.as_deref().unwrap_or(""), &tab.path) {
            Some((provider, true)) => provider.name.clone(),
            Some((provider, false)) => format!("{} (default)", provider.name),
            None => "No AI provider".to_string(),
        };
        let resp = pill(ui, &painter, &mut right, cy, Some("sparkle"), &label, p.fg_muted, p.bg_3, "ai")
            .on_hover_text("The AI provider this repository uses");
        if resp.clicked() {
            let pos = resp.interact_pointer_pos().unwrap_or(resp.rect.left_top());
            action = Some(Box::new(move |app| actions::ai_menu(app, pos)));
        }
    }

    if let Some(update) =
        app.update.as_ref().filter(|u| u.available && should_prompt(&u.current, &u.latest, &app.settings.update_level))
    {
        let label = if app.updating {
            "Updating...".to_string()
        } else if update.switching {
            format!("Switch to {}", update.latest)
        } else {
            format!("Update to {}", update.latest)
        };
        let tip = if update.switching {
            format!("Leave the test stream and go back to gitc {}", update.latest)
        } else {
            format!("gitc {} is available - you have {}", update.latest, update.current)
        };
        let text = galley(ui, &label, 11.0, p.accent_fg, f32::INFINITY);
        let r = Rect::from_min_size(
            Pos2::new(right - text.size().x - 16.0, cy - 8.0),
            Vec2::new(text.size().x + 16.0, 16.0),
        );
        let sense = if app.updating { Sense::hover() } else { Sense::click() };
        let resp = ui.interact(r, Id::unique("status-update"), sense).on_hover_text(tip);
        let fill = if resp.hovered() && !app.updating { p.accent_line } else { p.accent_bg };
        painter.rect(r, 8.0, fill, Stroke::new(1.0, p.accent_line), eframe::egui::StrokeKind::Inside);
        painter.galley(Pos2::new(r.left() + 8.0, cy - text.size().y / 2.0), text, p.accent_fg);
        if resp.clicked() {
            action = Some(Box::new(actions::run_update));
        }
        right = r.left() - 10.0;
    }

    let path_room = (bar.width() * 0.3).max(120.0);
    let path = galley(ui, &front_truncated(ui, &tab.path, path_room), 11.0, p.fg_muted, f32::INFINITY);
    let r = Rect::from_min_size(Pos2::new(right - path.size().x, cy - 8.0), path.size());
    painter.galley(Pos2::new(r.left(), cy - path.size().y / 2.0), path, p.fg_muted);
    ui.interact(r, Id::unique("status-path"), Sense::hover()).on_hover_text(&tab.path);
    right = r.left() - 10.0;

    if has_remote {
        let stale = remote_age.is_none_or(|age| age > stale_minutes * 60_000);
        let age = remote_age.map_or("never".to_string(), ago);
        let resp = freshness_pill(ui, &painter, &mut right, cy, "cloud", "remote", &age, stale, p, "remote");
        let tip = match remote_age {
            None => "This repository has never fetched - click to fetch now".to_string(),
            Some(age) => format!("Remote data last fetched {}. Click to fetch now.", since(age)),
        };
        if resp.on_hover_text(tip).clicked() {
            action = Some(Box::new(|app| actions::run_op(app, OpArgs { op: "fetch".into(), ..Default::default() })));
        }
    }
    let stale = local_age.is_none_or(|age| age > 4000);
    let age = local_age.map_or("-".to_string(), ago);
    let resp = freshness_pill(ui, &painter, &mut right, cy, "monitor", "local", &age, stale, p, "local");
    let tip = match local_age {
        None => "The view has not been checked against the working tree yet - click to read it now".to_string(),
        Some(age) => format!("The view matched the working tree {}. Click to re-read it now.", since(age)),
    };
    if resp.on_hover_text(tip).clicked() {
        let tab_id = id.clone();
        action = Some(Box::new(move |app| {
            if let Some(repo) = app.repos.get_mut(&tab_id) {
                repo.refresh();
            }
        }));
    }

    let viewing = galley(ui, &viewing, 11.0, p.fg_muted, f32::INFINITY);
    let left = bar.left() + 10.0;
    painter.galley(Pos2::new(left, cy - viewing.size().y / 2.0), viewing.clone(), p.fg_muted);

    let ticker = Rect::from_x_y_ranges(left + viewing.size().x + 10.0..=right - 10.0, cy - 8.0..=cy + 8.0);
    if ticker.width() > 30.0 {
        let resp = ui
            .interact(ticker, Id::unique("status-ticker"), Sense::click())
            .on_hover_text("Every git command gitc has run - click to see them all");
        let on = app.log_open;
        if on || resp.hovered() {
            painter.rect_filled(ticker, 3.0, p.bg_3);
        }
        let git = painter.layout_no_wrap("git".into(), FontId::monospace(11.0), p.accent);
        let gx = ticker.left() + 8.0;
        let args_x = gx + git.size().x + 5.0;
        painter.galley(Pos2::new(gx, cy - git.size().y / 2.0), git, p.accent);
        let last = app.git_log.last_visible(&app.settings.hidden_commands).unwrap_or("...");
        let color = if on { p.fg_dim } else { p.fg_muted };
        let mut job = eframe::egui::text::LayoutJob::single_section(
            last.to_string(),
            eframe::egui::TextFormat::simple(FontId::monospace(11.0), color),
        );
        job.wrap = eframe::egui::text::TextWrapping::truncate_at_width((ticker.right() - 8.0 - args_x).max(0.0));
        let args = painter.layout_job(job);
        painter.galley(Pos2::new(args_x, cy - args.size().y / 2.0), args, color);
        if resp.clicked() {
            app.log_open = !app.log_open;
        }
    }

    ui.ctx().request_repaint_after(TICK_EVERY);
    if let Some(action) = action {
        action(app);
    }
}

fn remote_version(app: &App, host: Option<&str>) -> String {
    let Some(host) = host else { return String::new() };
    app.remotes.iter().find(|r| r.host == host).map(|r| r.version.clone()).unwrap_or_default()
}

fn provider_for<'a>(config: &'a AiConfig, host: &str, path: &str) -> Option<(&'a AiProvider, bool)> {
    let pinned = config.repos.iter().find(|r| r.host == host && r.path == path);
    if let Some(chosen) = pinned.and_then(|r| config.providers.iter().find(|p| p.id == r.provider_id)) {
        return Some((chosen, true));
    }
    let fallback = config.providers.iter().find(|p| p.id == config.default_id).or(config.providers.first())?;
    Some((fallback, false))
}

#[allow(clippy::too_many_arguments)]
fn banner_button(
    ui: &Ui,
    painter: &Painter,
    right: &mut f32,
    bar: Rect,
    label: &str,
    tip: &str,
    enabled: bool,
    fill: Color32,
    line: Color32,
    fg: Color32,
) -> bool {
    let text = galley(ui, label, 11.0, fg, f32::INFINITY);
    let r = Rect::from_min_size(
        Pos2::new(*right - text.size().x - 20.0, bar.center().y - 10.0),
        Vec2::new(text.size().x + 20.0, 20.0),
    );
    *right = r.left() - 9.0;
    let resp = ui.interact(r, Id::unique(("banner", label)), if enabled { Sense::click() } else { Sense::hover() });
    let resp = if tip.is_empty() { resp } else { resp.on_hover_text(tip) };
    let alpha = if enabled { 1.0 } else { 0.45 };
    let fill = if enabled && resp.hovered() { fill.gamma_multiply(2.2) } else { fill };
    painter.rect(
        r,
        3.0,
        fill.gamma_multiply(alpha),
        Stroke::new(1.0, line.gamma_multiply(alpha)),
        eframe::egui::StrokeKind::Inside,
    );
    painter.galley(Pos2::new(r.left() + 10.0, r.center().y - text.size().y / 2.0), text, fg.gamma_multiply(alpha));
    enabled && resp.clicked()
}

#[allow(clippy::too_many_arguments)]
fn pill(
    ui: &Ui,
    painter: &Painter,
    right: &mut f32,
    cy: f32,
    icon: Option<&str>,
    label: &str,
    color: Color32,
    hover: Color32,
    id: &str,
) -> Response {
    let text = galley(ui, label, 11.0, color, f32::INFINITY);
    let icon_w = if icon.is_some() { 15.0 } else { 0.0 };
    let r = Rect::from_min_size(
        Pos2::new(*right - text.size().x - icon_w - 12.0, cy - 8.0),
        Vec2::new(text.size().x + icon_w + 12.0, 16.0),
    );
    *right = r.left() - 10.0;
    let resp = ui.interact(r, Id::unique(("status-pill", id)), Sense::click());
    if resp.hovered() {
        painter.rect_filled(r, 3.0, hover);
    }
    if let Some(icon) = icon {
        icons::paint(ui, Rect::from_center_size(Pos2::new(r.left() + 6.0 + 5.5, cy), Vec2::splat(11.0)), icon, color);
    }
    painter.galley(Pos2::new(r.left() + 6.0 + icon_w, cy - text.size().y / 2.0), text, color);
    resp
}

#[allow(clippy::too_many_arguments)]
fn freshness_pill(
    ui: &Ui,
    painter: &Painter,
    right: &mut f32,
    cy: f32,
    icon: &str,
    label: &str,
    age: &str,
    stale: bool,
    p: Palette,
    id: &str,
) -> Response {
    let age_g = galley(ui, age, 11.0, if stale { p.amber_fg } else { p.fg_dim }, f32::INFINITY);
    let label_g = galley(ui, label, 11.0, if stale { p.amber_fg } else { p.fg_faint }, f32::INFINITY);
    let width = 6.0 + 11.0 + 4.0 + label_g.size().x + 4.0 + age_g.size().x + 6.0;
    let r = Rect::from_min_size(Pos2::new(*right - width, cy - 7.5), Vec2::new(width, 15.0));
    *right = r.left() - 2.0;
    let resp = ui.interact(r, Id::unique(("status-fresh", id)), Sense::click());
    if resp.hovered() {
        painter.rect_filled(r, 3.0, p.bg_2);
    }
    let icon_color = if stale {
        p.amber_fg
    } else if resp.hovered() {
        p.fg_dim
    } else {
        p.fg_faint
    };
    icons::paint(ui, Rect::from_center_size(Pos2::new(r.left() + 11.5, cy), Vec2::splat(11.0)), icon, icon_color);
    let lx = r.left() + 21.0;
    painter.galley(Pos2::new(lx, cy - label_g.size().y / 2.0), label_g.clone(), p.fg_faint);
    painter.galley(Pos2::new(lx + label_g.size().x + 4.0, cy - age_g.size().y / 2.0), age_g, p.fg_dim);
    resp
}

/// The path cut at the front so its end (the repository's name) stays readable.
fn front_truncated(ui: &Ui, path: &str, max_width: f32) -> String {
    let font = FontId::proportional(11.0);
    let width = |s: &str| ui.painter().layout_no_wrap(s.to_string(), font.clone(), Color32::WHITE).size().x;
    if width(path) <= max_width {
        return path.to_string();
    }
    let chars: Vec<char> = path.chars().collect();
    let (mut lo, mut hi) = (0, chars.len());
    while lo < hi {
        let mid = (lo + hi) / 2;
        let tail: String = chars.get(mid..).map(|c| c.iter().collect()).unwrap_or_default();
        if width(&format!("...{tail}")) <= max_width { hi = mid } else { lo = mid + 1 }
    }
    let tail: String = chars.get(lo..).map(|c| c.iter().collect()).unwrap_or_default();
    format!("...{tail}")
}

fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    chars.next().map(|c| c.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

/// A duration at the coarsest unit that still says something.
fn ago(ms: u64) -> String {
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

fn since(ms: u64) -> String {
    if ms < 2000 { "a moment ago".into() } else { format!("{} ago", ago(ms)) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ages() {
        assert_eq!(ago(500), "now");
        assert_eq!(ago(5_000), "5s");
        assert_eq!(ago(120_000), "2m");
        assert_eq!(ago(3 * 3_600_000), "3h");
        assert_eq!(ago(3 * 86_400_000), "3d");
        assert_eq!(ago(800 * 86_400_000), "2y");
        assert_eq!(since(1000), "a moment ago");
        assert_eq!(since(5000), "5s ago");
        assert_eq!(capitalize("cherry-pick"), "Cherry-pick");
    }
}
