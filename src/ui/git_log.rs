use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::time::{Duration, Instant};

use eframe::egui::text::{LayoutJob, TextFormat, TextWrapping};
use eframe::egui::{self, Align, FontId, Key, Layout, Pos2, Rect, RichText, Sense, Stroke, Ui, pos2, vec2};

use super::theme::Palette;
use super::{App, icons};
use crate::engine::api::Request;
use crate::engine::types::GitCall;

const LIMIT: usize = 2000;
const INTERVAL: Duration = Duration::from_millis(350);
const ROW_H: f32 = 18.0;
const MONO: f32 = 11.5;

/// Every git command gitc has run, tailed from the engine.
#[derive(Default)]
pub struct State {
    pub calls: Vec<GitCall>,
    seen: u64,
    host: Option<String>,
    polling: bool,
    last_poll: Option<Instant>,
    open: HashSet<u64>,
}

#[derive(serde::Deserialize, Default)]
#[serde(default)]
struct CallList {
    calls: Vec<GitCall>,
}

enum Act {
    Hide(String),
    Toggle(u64),
    Clear,
    Close,
    Copy,
}

impl State {
    /// The newest command whose type is not in `hidden`, for the status bar ticker.
    pub fn last_visible(&self, hidden: &[String]) -> Option<&str> {
        self.calls.iter().rev().find(|c| !is_hidden(c, hidden)).map(|c| c.args.as_str())
    }
}

/// Fetches what the engine ran since the last poll; call it every frame, it rate-limits itself.
pub fn poll(app: &mut App) {
    if app.log_open {
        app.ctx.request_repaint_after(INTERVAL);
    }
    let state = &app.git_log;
    if state.polling || state.last_poll.is_some_and(|t| t.elapsed() < INTERVAL) {
        return;
    }
    let id = app.active_id().unwrap_or_default();
    let host = app.active_tab().and_then(|t| t.host.clone());
    let state = &mut app.git_log;
    if state.host != host {
        state.host = host.clone();
        state.seen = 0;
        state.calls.clear();
        state.open.clear();
    }
    state.polling = true;
    state.last_poll = Some(Instant::now());
    let req = Request::GitLog { id, after: state.seen };
    app.jobs.request(req, move |app, result: Result<CallList, String>| {
        let state = &mut app.git_log;
        state.polling = false;
        let Ok(list) = result else { return };
        if state.host != host {
            return;
        }
        merge(&mut state.calls, &mut state.seen, list.calls);
    });
}

pub fn show(app: &mut App, ui: &mut Ui) {
    poll(app);
    if !app.overlay.is_open() && ui.input(|i| i.key_pressed(Key::Escape)) {
        app.log_open = false;
        return;
    }
    let p = app.palette;
    let hidden = &app.settings.hidden_commands;
    let state = &app.git_log;
    let shown = state.calls.iter().filter(|c| !is_hidden(c, hidden)).count();
    let hidden_count = state.calls.len() - shown;

    ui.spacing_mut().item_spacing = vec2(10.0, 0.0);
    let mut act = head(ui, &p, shown, hidden_count);
    let rect = ui.available_rect_before_wrap();
    ui.painter().hline(rect.x_range(), rect.top() + 0.5, Stroke::new(1.0, p.line));
    if let Some(a) = body(ui, &p, state, hidden, shown, hidden_count) {
        act = Some(a);
    }
    let Some(act) = act else { return };
    match act {
        Act::Hide(name) => {
            if name.is_empty() || app.settings.hidden_commands.contains(&name) {
                return;
            }
            app.settings.hidden_commands.push(name);
            app.settings.hidden_commands.sort();
            app.save_settings();
        }
        Act::Toggle(key) => {
            if !app.git_log.open.remove(&key) {
                app.git_log.open.insert(key);
            }
        }
        Act::Clear => {
            app.git_log.calls.clear();
            app.git_log.open.clear();
        }
        Act::Close => app.log_open = false,
        Act::Copy => {
            let hidden = &app.settings.hidden_commands;
            let text: Vec<String> =
                app.git_log.calls.iter().filter(|c| !is_hidden(c, hidden)).map(|c| format!("git {}", c.args)).collect();
            app.ctx.copy_text(text.join("\n"));
        }
    }
}

/// The git subcommand of a recorded call: its first argument that is not a flag.
pub fn command_type(args: &str) -> &str {
    args.split(' ').find(|part| !part.is_empty() && !part.starts_with('-')).unwrap_or(args)
}

fn head(ui: &mut Ui, p: &Palette, shown: usize, hidden_count: usize) -> Option<Act> {
    let mut act = None;
    egui::Frame::new().inner_margin(egui::Margin::symmetric(10, 6)).show(ui, |ui| {
        ui.horizontal(|ui| {
            ui.label(RichText::new("git commands").monospace().size(11.0).color(p.fg_bright));
            let noun = if shown == 1 { "command" } else { "commands" };
            ui.label(RichText::new(format!("{shown} {noun}")).size(11.0).color(p.fg_muted));
            let blurb = if hidden_count > 0 {
                "oldest first - hidden types are listed in Preferences"
            } else {
                "everything gitc has run, oldest first"
            };
            ui.label(RichText::new(blurb).size(11.0).color(p.fg_faint));
            if hidden_count > 0 {
                egui::Frame::new().fill(p.bg_3).corner_radius(255).inner_margin(egui::Margin::symmetric(7, 1)).show(
                    ui,
                    |ui| {
                        ui.label(RichText::new(format!("{hidden_count} hidden")).size(10.0).color(p.fg_muted));
                    },
                );
            }
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                ui.spacing_mut().item_spacing.x = 6.0;
                if icons::button(ui, "close", 12.0, "Close (Esc)").clicked() {
                    act = Some(Act::Close);
                }
                let button = |text: &str| {
                    egui::Button::new(RichText::new(text).size(11.0).color(p.fg_dim))
                        .fill(p.bg_2)
                        .stroke(Stroke::new(1.0, p.line_strong))
                };
                if ui.add(button("Clear")).on_hover_text("Clear this view").clicked() {
                    act = Some(Act::Clear);
                }
                if ui.add(button("Copy all")).on_hover_text("Copy every command as text").clicked() {
                    act = Some(Act::Copy);
                }
            });
        });
    });
    act
}

fn body(ui: &mut Ui, p: &Palette, state: &State, hidden: &[String], shown: usize, hidden_count: usize) -> Option<Act> {
    if shown == 0 {
        let text = if hidden_count > 0 {
            let s = if hidden_count == 1 { "" } else { "s" };
            format!(
                "Everything run so far is of a kind you have hidden ({hidden_count} command{s}). Preferences > Command log brings them back."
            )
        } else {
            "Nothing yet. Any action here runs git, and shows up below.".to_string()
        };
        egui::Frame::new().inner_margin(14.0).show(ui, |ui| ui.label(RichText::new(text).size(12.0).color(p.fg_muted)));
        return None;
    }
    let mut act = None;
    egui::ScrollArea::vertical().auto_shrink([false, false]).stick_to_bottom(true).show_viewport(ui, |ui, viewport| {
        let origin = ui.max_rect().min;
        let width = ui.available_width();
        let mut y = 4.0;
        for call in state.calls.iter().filter(|c| !is_hidden(c, hidden)) {
            let key = key(call);
            let expanded = state.open.contains(&key);
            let cmd_w = (width - 190.0).max(40.0);
            let galley = expanded.then(|| ui.painter().layout_job(command(p, call, cmd_w, true)));
            let h = galley.as_ref().map_or(ROW_H, |g| g.size().y + 4.0).max(ROW_H);
            if y + h >= viewport.min.y && y <= viewport.max.y {
                let rect = Rect::from_min_size(origin + vec2(0.0, y), vec2(width, h));
                if let Some(a) = row(ui, p, call, rect, key, galley, cmd_w) {
                    act = Some(a);
                }
            }
            y += h;
        }
        ui.set_min_size(vec2(width, y + 4.0));
    });
    act
}

fn row(
    ui: &mut Ui,
    p: &Palette,
    call: &GitCall,
    rect: Rect,
    key: u64,
    galley: Option<std::sync::Arc<egui::Galley>>,
    cmd_w: f32,
) -> Option<Act> {
    let resp = ui.interact(rect, ui.scope_id().with(("gitlog", call.id)), Sense::click());
    let hover = resp.contains_pointer();
    let expanded = galley.is_some();
    let painter = ui.painter();
    if !call.ok {
        painter.rect_filled(rect, 0.0, p.red_bg);
    } else if expanded || hover {
        painter.rect_filled(rect, 0.0, p.bg_2);
    }
    let top = rect.top() + 2.0;
    let mono = FontId::monospace(MONO);
    let line_cy = top + (ROW_H - 4.0) / 2.0;
    painter.text(
        pos2(rect.left() + 10.0, line_cy),
        egui::Align2::LEFT_CENTER,
        clock(call.at),
        mono.clone(),
        p.fg_faint,
    );

    let cmd_x = rect.left() + 80.0;
    let galley = galley.unwrap_or_else(|| painter.layout_job(command(p, call, cmd_w, false)));
    let cmd_y = if expanded { top } else { line_cy - galley.size().y / 2.0 };
    painter.galley(Pos2::new(cmd_x, cmd_y), galley, p.fg);

    let right = rect.right() - 10.0;
    let (ms, ms_color) = if call.running {
        let t = ui.input(|i| i.time);
        ("running".to_string(), p.accent.gamma_multiply(0.72 + 0.28 * (t * 5.7).cos() as f32))
    } else {
        (format!("{}ms", call.ms), p.fg_faint)
    };
    let ms_rect = painter.text(pos2(right, line_cy), egui::Align2::RIGHT_CENTER, ms, mono, ms_color);
    if call.running {
        ui.ctx().request_repaint();
    }

    let mut act = None;
    let eye = Rect::from_center_size(pos2(ms_rect.left() - 18.0, line_cy), vec2(16.0, 16.0));
    let eye_resp = ui.interact(eye, resp.id.with("hide"), Sense::click());
    if hover {
        let color = if eye_resp.contains_pointer() { p.fg } else { p.fg_muted };
        icons::paint(ui, Rect::from_center_size(eye.center(), vec2(12.0, 12.0)), "eyeOff", color);
        let kind = command_type(&call.args);
        if eye_resp.on_hover_text(format!("Hide every \"git {kind}\" from this log")).clicked() {
            act = Some(Act::Hide(kind.to_string()));
        }
    }
    if act.is_some() {
        return act;
    }
    let tip = if expanded { "Click to collapse" } else { "Click to see the whole command" };
    resp.on_hover_text(tip).clicked().then_some(Act::Toggle(key))
}

fn command(p: &Palette, call: &GitCall, width: f32, wrap: bool) -> LayoutJob {
    let mono = FontId::monospace(MONO);
    let color = if call.ok { p.fg } else { p.red_fg };
    let mut job = LayoutJob::default();
    job.append("git", 0.0, TextFormat::simple(mono.clone(), p.accent));
    job.append(&format!(" {}", call.args), 0.0, TextFormat::simple(mono, color));
    if call.count > 1 {
        let format = TextFormat { background: p.bg_4, ..TextFormat::simple(FontId::monospace(10.0), p.fg_muted) };
        job.append(&format!(" x{} ", call.count), 7.0, format);
    }
    job.wrap = if wrap {
        TextWrapping { max_width: width, break_anywhere: true, ..Default::default() }
    } else {
        TextWrapping::truncate_at_width(width)
    };
    job
}

fn merge(calls: &mut Vec<GitCall>, seen: &mut u64, fresh: Vec<GitCall>) {
    for call in fresh {
        *seen = (*seen).max(call.seq);
        match calls.iter().rposition(|c| c.id == call.id).and_then(|i| calls.get_mut(i)) {
            Some(slot) => *slot = call,
            None => calls.push(call),
        }
    }
    if calls.len() > LIMIT {
        calls.drain(..calls.len() - LIMIT);
    }
}

fn key(call: &GitCall) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    (&call.repo, &call.args).hash(&mut hasher);
    hasher.finish()
}

fn is_hidden(call: &GitCall, hidden: &[String]) -> bool {
    !hidden.is_empty() && hidden.iter().any(|h| h == command_type(&call.args))
}

fn clock(at_ms: u64) -> String {
    use chrono::TimeZone;
    chrono::Local
        .timestamp_millis_opt(at_ms as i64)
        .single()
        .map(|t| t.format("%H:%M:%S").to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_types() {
        assert_eq!(command_type("status"), "status");
        assert_eq!(command_type("log --branches --tags HEAD"), "log");
        assert_eq!(command_type("--exclude=topic --branches"), "--exclude=topic --branches");
        assert_eq!(command_type("-C /repo status"), "/repo");
        assert_eq!(command_type("stash list"), "stash");
        assert_eq!(command_type("name-rev --name-only HEAD"), "name-rev");
        assert_eq!(command_type(""), "");
        assert_eq!(command_type("log --exclude=topic --branches --tags --remotes HEAD --topo-order"), "log");
        assert_eq!(command_type("fetch --all --prune"), "fetch");
        assert_eq!(command_type("show --name-status -m --first-parent abc123"), "show");
    }

    #[test]
    fn merging_by_id() {
        let call = |id: u64, seq: u64, running: bool| GitCall {
            id,
            seq,
            running,
            args: "status".into(),
            ..Default::default()
        };
        let mut calls = Vec::new();
        let mut seen = 0;
        merge(&mut calls, &mut seen, vec![call(1, 1, true), call(2, 2, true)]);
        merge(&mut calls, &mut seen, vec![call(2, 4, false), call(1, 3, false)]);
        assert_eq!(seen, 4);
        assert_eq!(calls.iter().map(|c| (c.id, c.running)).collect::<Vec<_>>(), [(1, false), (2, false)]);
        let state = State { calls, ..Default::default() };
        assert_eq!(state.last_visible(&[]), Some("status"));
        assert_eq!(state.last_visible(&["status".into()]), None);
    }
}
