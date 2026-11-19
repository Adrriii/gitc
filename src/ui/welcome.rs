use eframe::egui::{self, Align, Id, Layout, Margin, Pos2, Rect, RichText, Sense, Stroke, Ui, Vec2};

use super::dialogs::Confirm;
use super::repo_picker::{self, Picker};
use super::tabbar::galley;
use super::{App, icons};
use crate::engine::api::Request;
use crate::engine::types::{Opened, RemotePlan, SshHost};

const ROW_H: f32 = 24.0;
const ASIDE_W: f32 = 300.0;

#[derive(Default)]
pub struct State {
    search: String,
    hosts: Vec<SshHost>,
    last_pass: Option<u64>,
    /// The machine being browsed, or None while the choice is this one.
    host: Option<SshHost>,
    connecting: bool,
    /// The recent being opened, keyed by host and path.
    opening: Option<String>,
    /// The machine whose install plan is being asked for.
    checking: Option<String>,
    error: Option<String>,
    local: Picker,
    remote: Picker,
}

#[derive(serde::Deserialize, Default)]
#[serde(default)]
struct HostList {
    hosts: Vec<SshHost>,
}

pub fn show(app: &mut App, ui: &mut Ui) {
    let pass = ui.ctx().cumulative_pass_nr();
    if app.welcome.last_pass.is_none_or(|last| pass > last + 1) {
        app.jobs.request(Request::Hosts, |app, result: Result<HostList, String>| {
            app.welcome.hosts = result.map(|h| h.hosts).unwrap_or_default();
        });
    }
    app.welcome.last_pass = Some(pass);

    egui::ScrollArea::vertical().auto_shrink(false).show(ui, |ui| {
        egui::Frame::new().inner_margin(Margin::symmetric(46, 34)).show(ui, |ui| {
            let total = ui.available_width();
            let aside = !app.welcome.hosts.is_empty();
            let main_w = if aside { (total - ASIDE_W - 40.0).min(1000.0) } else { total.min(1000.0) }.max(200.0);
            ui.horizontal_top(|ui| {
                let height = ui.available_height();
                ui.allocate_ui_with_layout(Vec2::new(main_w, height), Layout::top_down(Align::Min), |ui| {
                    ui.set_width(main_w);
                    main_column(app, ui);
                });
                if aside {
                    ui.add_space(40.0);
                    ui.allocate_ui_with_layout(Vec2::new(ASIDE_W, height), Layout::top_down(Align::Min), |ui| {
                        ui.set_width(ASIDE_W);
                        ui.add_space(47.0);
                        aside_column(app, ui);
                    });
                }
            });
        });
    });
}

fn main_column(app: &mut App, ui: &mut Ui) {
    let p = app.palette;
    ui.spacing_mut().item_spacing = Vec2::ZERO;
    ui.label(RichText::new("Repositories").size(21.0).color(p.fg_bright));
    ui.add_space(20.0);

    if let Some(path) = repo_picker::show(app, ui, local, "") {
        open(app, path, String::new());
    }
    ui.add_space(14.0);
    if let Some(error) = &app.welcome.error {
        ui.label(RichText::new(error).size(12.0).color(p.red_fg));
        ui.add_space(14.0);
    }

    egui::Frame::new()
        .fill(p.bg_inset)
        .stroke(Stroke::new(1.0, p.accent))
        .corner_radius(3.0)
        .inner_margin(Margin::symmetric(10, 7))
        .show(ui, |ui| {
            ui.add(
                egui::TextEdit::singleline(&mut app.welcome.search)
                    .hint_text(RichText::new("Search repositories").color(p.fg_faint))
                    .frame(egui::Frame::NONE)
                    .margin(Margin::ZERO)
                    .text_color(p.fg)
                    .desired_width(f32::INFINITY),
            );
        });
    ui.add_space(20.0);
    ui.label(RichText::new("Recent").size(13.0).color(p.fg_dim));
    ui.add_space(8.0);

    let filter = app.welcome.search.trim().to_lowercase();
    let recents: Vec<(String, String, Option<String>)> = app
        .session
        .recents
        .iter()
        .filter(|r| {
            filter.is_empty()
                || r.name.to_lowercase().contains(&filter)
                || r.path.to_lowercase().contains(&filter)
                || r.host.as_deref().is_some_and(|h| where_is(&app.welcome.hosts, h).to_lowercase().contains(&filter))
        })
        .map(|r| (r.name.clone(), r.path.clone(), r.host.clone()))
        .collect();
    if recents.is_empty() {
        ui.label(RichText::new("No repositories yet.").size(12.0).color(p.fg_faint));
    }
    let busy = app.welcome.opening.is_some();
    for (name, path, host) in recents {
        let key = format!("{}{}", host.as_deref().unwrap_or(""), path);
        let (rect, resp) = ui.allocate_exact_size(Vec2::new(ui.available_width(), ROW_H), Sense::click());
        let fade = if busy && !resp.hovered() { 0.5 } else { 1.0 };
        if resp.hovered() && !busy {
            ui.painter().rect_filled(rect, 3.0, p.bg_3);
        }
        let cy = rect.center().y;
        let mut x = rect.left() + 5.0;
        let name_g = galley(ui, &name, 13.0, p.accent.gamma_multiply(fade), rect.width() * 0.5);
        ui.painter().galley(Pos2::new(x, cy - name_g.size().y / 2.0), name_g.clone(), p.accent);
        x += name_g.size().x + 12.0;
        if let Some(h) = &host {
            let where_ = where_is(&app.welcome.hosts, h);
            let text = galley(ui, &where_, 11.0, p.fg_dim.gamma_multiply(fade), f32::INFINITY);
            let chip = Rect::from_min_size(Pos2::new(x, cy - 8.0), Vec2::new(text.size().x + 14.0 + 15.0, 16.0));
            ui.painter().rect_filled(chip, 3.0, p.bg_2.gamma_multiply(fade));
            icons::paint(
                ui,
                Rect::from_center_size(Pos2::new(chip.left() + 7.0 + 5.5, cy), Vec2::splat(11.0)),
                "repo",
                p.fg_dim.gamma_multiply(fade),
            );
            ui.painter().galley(Pos2::new(chip.left() + 22.0, cy - text.size().y / 2.0), text, p.fg_dim);
            ui.interact(chip, Id::unique(("recent-host", &key)), Sense::hover()).on_hover_text(format!("On {where_}"));
            x = chip.right() + 12.0;
        }
        let mut right = rect.right() - 5.0;
        if app.welcome.opening.as_deref() == Some(key.as_str()) {
            let text = galley(ui, "Opening...", 11.0, p.accent, f32::INFINITY);
            right -= text.size().x;
            ui.painter().galley(Pos2::new(right, cy - text.size().y / 2.0), text, p.accent);
            right -= 12.0;
        }
        let path_g = galley(ui, &path, 12.0, p.fg_muted.gamma_multiply(fade), (right - x).max(0.0));
        ui.painter().galley(Pos2::new(x, cy - path_g.size().y / 2.0), path_g, p.fg_muted);

        if !resp.clicked() || busy {
            continue;
        }
        app.welcome.opening = Some(key);
        match host {
            None => open(app, path, String::new()),
            Some(host) => {
                let target = host.clone();
                before_installing(app, &host, Box::new(move |app| open(app, path, target)));
            }
        }
    }
}

fn aside_column(app: &mut App, ui: &mut Ui) {
    let p = app.palette;
    ui.spacing_mut().item_spacing = Vec2::ZERO;
    ui.label(RichText::new("On another machine").size(12.0).color(p.fg_dim));
    ui.add_space(10.0);

    let Some(host) = app.welcome.host.clone() else {
        let checking = app.welcome.checking.clone();
        for h in app.welcome.hosts.clone() {
            let (rect, resp) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 28.0), Sense::click());
            let lit = resp.hovered() && checking.is_none();
            if lit {
                ui.painter().rect_filled(rect, 3.0, p.bg_3);
            }
            let cy = rect.center().y;
            let fade = if checking.is_some() { 0.6 } else { 1.0 };
            icons::paint(
                ui,
                Rect::from_center_size(Pos2::new(rect.left() + 10.0 + 6.5, cy), Vec2::splat(13.0)),
                "repo",
                p.fg_dim.gamma_multiply(fade),
            );
            let alias = galley(ui, &h.alias, 13.0, p.fg.gamma_multiply(fade), f32::INFINITY);
            let ax = rect.left() + 31.0;
            ui.painter().galley(Pos2::new(ax, cy - alias.size().y / 2.0), alias.clone(), p.fg);
            let wx = ax + alias.size().x + 8.0;
            let dest =
                galley(ui, &destination(&h), 11.0, p.fg_muted.gamma_multiply(fade), (rect.right() - 8.0 - wx).max(0.0));
            ui.painter().galley(Pos2::new(wx, cy - dest.size().y / 2.0), dest, p.fg_muted);
            if resp.clicked() && checking.is_none() {
                app.welcome.checking = Some(h.alias.clone());
                let alias = h.alias.clone();
                before_installing(
                    app,
                    &alias,
                    Box::new(move |app| {
                        app.welcome.checking = None;
                        app.welcome.host = Some(h);
                    }),
                );
            }
            ui.add_space(2.0);
        }
        if let Some(alias) = checking {
            ui.add_space(4.0);
            ui.label(RichText::new(format!("Checking {alias}...")).size(11.0).color(p.fg_muted));
        }
        return;
    };

    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 8.0;
        icons::show(ui, "repo", 13.0, p.fg_dim);
        ui.label(RichText::new(&host.alias).size(13.0).color(p.fg));
        let change = egui::Button::new(RichText::new("Change").size(11.0).color(p.fg_dim))
            .fill(p.bg_2)
            .stroke(Stroke::new(1.0, p.line_strong))
            .corner_radius(3.0);
        if ui.add_enabled(!app.welcome.connecting, change).clicked() {
            app.welcome.host = None;
        }
    });
    ui.add_space(8.0);
    if let Some(path) = repo_picker::show(app, ui, remote, &host.alias) {
        app.welcome.connecting = true;
        open(app, path, host.alias.clone());
    }
    if app.welcome.connecting {
        ui.add_space(8.0);
        ui.label(RichText::new(format!("Opening {}...", host.alias)).size(11.0).color(p.fg_muted));
    }
}

fn local(app: &mut App) -> &mut Picker {
    &mut app.welcome.local
}

fn remote(app: &mut App) -> &mut Picker {
    &mut app.welcome.remote
}

fn open(app: &mut App, path: String, host: String) {
    app.welcome.error = None;
    let req = Request::Open { path, host, want_id: None };
    app.jobs.request(req, |app, result: Result<Opened, String>| {
        app.welcome.opening = None;
        app.welcome.connecting = false;
        match result {
            Ok(opened) => {
                let id = opened.tab.id.clone();
                app.set_session(opened.session);
                app.activate(&id);
            }
            Err(e) => app.welcome.error = Some(e),
        }
    });
}

/// Runs `go`, first asking about installing gitc on `host` when that is what reaching it would do.
fn before_installing(app: &mut App, host: &str, go: Box<dyn FnOnce(&mut App)>) {
    app.jobs.request(Request::RemotePlan { host: host.to_string() }, move |app, result: Result<RemotePlan, String>| {
        match result {
            Ok(plan) if !plan.approved && (plan.action == "install" || plan.action == "replace") => {
                app.welcome.checking = None;
                app.welcome.opening = None;
                ask(app, plan, go);
            }
            _ => go(app),
        }
    });
}

fn ask(app: &mut App, plan: RemotePlan, go: Box<dyn FnOnce(&mut App)>) {
    let install = plan.action == "install";
    let title = format!("{} gitc on {}?", if install { "Install" } else { "Replace" }, plan.host);
    let lead =
        "A repository on another machine is opened by a gitc running on that machine, and gitc puts it there itself.";
    let detail = if install {
        format!(
            "gitc {} will be written to {} on {} - downloaded there from the release page, or sent from here if that \
             machine has no route to the internet. Nothing else on it is touched, and none of it needs root.",
            plan.want, plan.path, plan.host
        )
    } else {
        format!(
            "{} has gitc {} and this one is {}. The two halves of gitc talk to each other across the connection, so \
             they have to be the same version - {} will be replaced.",
            plan.host,
            plan.have.as_deref().unwrap_or("of another version"),
            plan.want,
            plan.path
        )
    };
    let body = format!("{lead}\n\n{detail}\n\ngitc will not ask again for this machine.");
    let label = if install { "Install gitc" } else { "Replace it" };
    let host = plan.host.clone();
    app.overlay.confirm(Confirm::new(title, body, label, move |app| {
        app.jobs.request(Request::ApproveRemote { host }, move |app, _: Result<serde_json::Value, String>| go(app));
    }));
}

/// How a remote recent is labelled: the resolved destination when the alias is still known.
fn where_is(hosts: &[SshHost], host: &str) -> String {
    let Some(known) = hosts.iter().find(|h| h.alias == host) else { return host.to_string() };
    let user = known.user.as_deref().map(|u| format!("{u}@")).unwrap_or_default();
    format!("{user}{}", known.host_name.as_deref().unwrap_or(&known.alias))
}

fn destination(h: &SshHost) -> String {
    let user = h.user.as_deref().map(|u| format!("{u}@")).unwrap_or_default();
    let port = h.port.map(|p| format!(":{p}")).unwrap_or_default();
    format!("{user}{}{port}", h.host_name.as_deref().unwrap_or(&h.alias))
}
