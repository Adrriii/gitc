use std::collections::HashSet;

use eframe::egui::{self, Align, Align2, Color32, FontId, Layout, Margin, Response, RichText, Sense, Stroke, Ui, Vec2};
use serde::Deserialize;

use super::settings::{FETCH_INTERVALS, REMOTE_HOLDS, TAB_SIZES, UPDATE_CHECKS};
use super::theme::{self, GROUPS, PRESETS, Palette, Preset, TOKENS};
use super::{App, actions, icons};
use crate::engine::api::Request;
use crate::engine::types::{CrashList, CrashReport, ReleaseNotes};

#[path = "preferences_ai.rs"]
mod ai;
#[path = "preferences_changelog.rs"]
pub mod changelog;
#[path = "preferences_version.rs"]
pub mod version;

#[derive(Default)]
pub struct State {
    shown_pass: u64,
    crashes: Option<Result<CrashList, String>>,
    crashes_for: Option<String>,
    open_crashes: HashSet<String>,
    remotes: Option<Vec<String>>,
    notes: Option<Result<(ReleaseNotes, Vec<changelog::Line>), String>>,
    notes_asked: bool,
    theme_dirty: bool,
    ai: ai::State,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Hosts {
    hosts: Vec<String>,
}

/// (id, label, icon); `app.prefs_section` holds the id.
pub const SECTIONS: [(&str, &str, &str); 7] = [
    ("theme", "Theme", "eye"),
    ("editor", "General", "edit"),
    ("repository", "Repository", "fetch"),
    ("ai", "AI", "sparkle"),
    ("commands", "Command log", "branch"),
    ("crashes", "Crash reports", "warning"),
    ("about", "About", "repo"),
];

const CHANNELS: [(&str, &str, &str); 2] = [
    ("stable", "Stable", "Published releases"),
    ("test", "Test builds", "Release candidates, before they are everyone's"),
];

const LABEL_WIDTH: f32 = 190.0;

pub fn show(app: &mut App, ui: &mut Ui) {
    let pass = ui.ctx().cumulative_pass_nr();
    if pass > app.prefs.shown_pass + 1 {
        app.prefs.crashes_for = None;
        app.prefs.remotes = None;
    }
    app.prefs.shown_pass = pass;
    if !SECTIONS.iter().any(|s| s.0 == app.prefs_section) {
        app.prefs_section = "theme".into();
    }
    load(app);

    let p = app.palette;
    egui::Panel::left("prefs-nav")
        .exact_size(240.0)
        .resizable(false)
        .frame(egui::Frame::new().fill(p.bg_1).inner_margin(Margin::symmetric(0, 10)))
        .show(ui, |ui| nav(app, ui));
    egui::CentralPanel::default().frame(egui::Frame::new().fill(p.bg_0)).show(ui, |ui| {
        egui::ScrollArea::vertical().id_salt(("prefs-pane", app.prefs_section.as_str())).auto_shrink(false).show(
            ui,
            |ui| {
                egui::Frame::new().inner_margin(Margin { left: 32, right: 32, top: 26, bottom: 40 }).show(ui, |ui| {
                    ui.spacing_mut().item_spacing.y = 6.0;
                    match app.prefs_section.as_str() {
                        "editor" => general(app, ui),
                        "repository" => repository(app, ui),
                        "ai" => ai::show(app, ui),
                        "commands" => commands(app, ui),
                        "crashes" => crashes(app, ui),
                        "about" => about(app, ui),
                        _ => theme_section(app, ui),
                    }
                });
            },
        );
    });
}

fn load(app: &mut App) {
    let section = app.prefs_section.clone();
    if app.prefs.crashes_for.as_deref() != Some(section.as_str()) {
        app.prefs.crashes_for = Some(section.clone());
        app.jobs.request(Request::Crashes, |app, result: Result<CrashList, String>| app.prefs.crashes = Some(result));
    }
    if app.prefs.remotes.is_none() {
        app.prefs.remotes = Some(Vec::new());
        app.jobs.request(Request::ApprovedRemotes, |app, result: Result<Hosts, String>| {
            app.prefs.remotes = Some(result.unwrap_or_default().hosts);
        });
    }
    if section == "about" && !app.prefs.notes_asked {
        app.prefs.notes_asked = true;
        app.jobs.request(Request::Changelog, |app, result: Result<ReleaseNotes, String>| {
            app.prefs.notes = Some(result.map(|notes| {
                let lines = changelog::parse_notes(&changelog::changelog_only(&notes.notes));
                (notes, lines)
            }));
        });
    }
}

fn nav(app: &mut App, ui: &mut Ui) {
    let p = app.palette;
    ui.spacing_mut().item_spacing.y = 0.0;
    if nav_item(ui, p, "chevronRight", "Exit Preferences", false, 0).clicked() {
        app.prefs_open = false;
        app.prefs_section = "theme".into();
    }
    ui.add_space(16.0);
    ui.horizontal(|ui| {
        ui.add_space(16.0);
        ui.label(RichText::new("PREFERENCES").size(11.0).color(p.fg_muted));
    });
    ui.add_space(6.0);
    let crash_count = match &app.prefs.crashes {
        Some(Ok(list)) => list.reports.len(),
        _ => 0,
    };
    for (id, label, icon) in SECTIONS {
        let count = if id == "crashes" { crash_count } else { 0 };
        if nav_item(ui, p, icon, label, app.prefs_section == id, count).clicked() {
            app.prefs_section = id.into();
        }
    }
}

fn nav_item(ui: &mut Ui, p: Palette, icon: &str, label: &str, on: bool, count: usize) -> Response {
    let (rect, response) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 32.0), Sense::click());
    if on {
        ui.painter().rect_filled(rect, 0.0, p.bg_3);
        ui.painter().rect_filled(egui::Rect::from_min_size(rect.min, Vec2::new(2.0, rect.height())), 0.0, p.accent);
    } else if response.hovered() {
        ui.painter().rect_filled(rect, 0.0, p.bg_2);
    }
    let color = if on { p.fg_bright } else { p.fg_dim };
    let icon_rect = egui::Rect::from_center_size(egui::pos2(rect.left() + 23.0, rect.center().y), Vec2::splat(14.0));
    icons::paint(ui, icon_rect, icon, color);
    ui.painter().text(
        egui::pos2(rect.left() + 40.0, rect.center().y),
        Align2::LEFT_CENTER,
        label,
        FontId::proportional(13.0),
        color,
    );
    if count > 0 {
        let text = count.to_string();
        let galley = ui.painter().layout_no_wrap(text, FontId::proportional(10.0), p.red_fg);
        let size = Vec2::new(galley.size().x + 12.0, 15.0);
        let badge = egui::Rect::from_min_size(egui::pos2(rect.right() - 16.0 - size.x, rect.center().y - 7.5), size);
        ui.painter().rect_filled(badge, 7.5, p.red_bg);
        ui.painter().galley(badge.center() - galley.size() / 2.0, galley, p.red_fg);
    }
    response
}

fn theme_section(app: &mut App, ui: &mut Ui) {
    let p = app.palette;
    heading(ui, p, "Theme");
    let current = theme::preset(&app.settings.theme_preset);
    let mut chosen: Option<&str> = None;
    row(ui, p, "Preset", "A starting point. Any colour below can be changed on top of it.", |ui| {
        ui.horizontal_wrapped(|ui| {
            ui.spacing_mut().item_spacing = Vec2::splat(10.0);
            for preset in PRESETS {
                if preset_card(ui, p, preset, preset.id == current.id).clicked() {
                    chosen = Some(preset.id);
                }
            }
        });
    });
    if let Some(id) = chosen {
        app.settings.theme_preset = id.into();
        app.save_settings();
    }

    let overridden = app.settings.theme_overrides.len();
    if overridden > 0 {
        let mut reset = false;
        row(ui, p, "Customised", "Colours you changed on top of the preset.", |ui| {
            reset = small_button(ui, p, &format!("Reset {overridden} to {}", current.name)).clicked();
        });
        if reset {
            app.settings.theme_overrides.clear();
            app.save_settings();
        }
    }

    let mut changed: Option<(&str, Color32)> = None;
    let mut reverted: Option<&str> = None;
    for (title, blurb) in GROUPS {
        ui.add_space(10.0);
        ui.label(RichText::new(*title).size(13.0).strong().color(p.fg_bright));
        ui.label(RichText::new(*blurb).size(11.0).color(p.fg_muted));
        ui.add_space(4.0);
        ui.horizontal_wrapped(|ui| {
            ui.set_max_width(680.0);
            ui.spacing_mut().item_spacing = Vec2::splat(6.0);
            for (name, label, _) in TOKENS.iter().filter(|t| t.2 == *title) {
                let custom = app.settings.theme_overrides.contains_key(*name);
                let mut color = app.palette.get(name).unwrap_or_default();
                let cell = egui::Frame::new()
                    .fill(p.bg_1)
                    .stroke(Stroke::new(1.0, p.line))
                    .corner_radius(4.0)
                    .inner_margin(Margin::symmetric(8, 5));
                cell.show(ui, |ui| {
                    ui.set_width(196.0);
                    ui.horizontal(|ui| {
                        let picked = egui::widgets::color_picker::color_edit_button_srgba(
                            ui,
                            &mut color,
                            egui::widgets::color_picker::Alpha::Opaque,
                        );
                        if picked.changed() {
                            changed = Some((name, color));
                        }
                        ui.vertical(|ui| {
                            ui.spacing_mut().item_spacing.y = 0.0;
                            ui.label(RichText::new(*label).size(12.0).color(p.fg));
                            ui.label(RichText::new(theme::to_hex(color)).size(10.0).monospace().color(p.fg_muted));
                        });
                        if custom {
                            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                if icons::button(ui, "undo", 11.0, &format!("Back to {}", current.name)).clicked() {
                                    reverted = Some(name);
                                }
                            });
                        }
                    });
                });
            }
        });
    }
    if let Some((name, color)) = changed {
        app.settings.theme_overrides.insert(name.to_string(), theme::to_hex(color));
        app.palette = theme::Palette::from_settings(&app.settings).0;
        app.prefs.theme_dirty = true;
    }
    if let Some(name) = reverted {
        app.settings.theme_overrides.remove(name);
        app.save_settings();
    }
    if app.prefs.theme_dirty && !ui.ctx().egui_is_using_pointer() {
        app.prefs.theme_dirty = false;
        app.save_settings();
    }
}

fn preset_card(ui: &mut Ui, p: Palette, preset: &Preset, on: bool) -> Response {
    let (rect, response) = ui.allocate_exact_size(Vec2::new(150.0, 76.0), Sense::click());
    let painter = ui.painter();
    let border = if on {
        p.accent
    } else if response.hovered() {
        p.line_strong
    } else {
        p.line
    };
    painter.rect(rect, 5.0, if on { p.accent_bg } else { p.bg_1 }, Stroke::new(1.0, border), egui::StrokeKind::Inside);
    let c = preset.colors;
    let swatch = egui::Rect::from_min_size(rect.min + Vec2::new(9.0, 8.0), Vec2::new(132.0, 44.0));
    painter.rect(swatch, 3.0, c.bg_0, Stroke::new(1.0, c.line), egui::StrokeKind::Inside);
    let inner = swatch.shrink(6.0);
    let colors = [c.bg_2, c.accent, c.lane_1, c.lane_2, c.lane_3];
    let width = (inner.width() - 3.0 * 4.0) / 5.0;
    for (i, color) in colors.iter().enumerate() {
        let x = inner.left() + i as f32 * (width + 3.0);
        painter.rect_filled(
            egui::Rect::from_min_size(egui::pos2(x, inner.top()), Vec2::new(width, inner.height())),
            2.0,
            *color,
        );
    }
    painter.text(
        egui::pos2(rect.left() + 10.0, rect.bottom() - 13.0),
        Align2::LEFT_CENTER,
        preset.name,
        FontId::proportional(12.0),
        if on { p.fg_bright } else { p.fg },
    );
    response.on_hover_text(preset.blurb)
}

fn general(app: &mut App, ui: &mut Ui) {
    let p = app.palette;
    heading(ui, p, "General");
    let mut s = app.settings.clone();
    row(
        ui,
        p,
        "Tab width",
        "How far a tab indents, in characters. Applies to diffs, the file view and the conflict editor.",
        |ui| {
            if let Some(n) = choices(ui, p, TAB_SIZES.map(|n| (n, n.to_string(), "")), &s.tab_size) {
                s.tab_size = n;
            }
        },
    );
    row(ui, p, "Long lines", "Wrapping keeps everything on screen; scrolling keeps the shape of the code.", |ui| {
        if let Some(v) = choices(ui, p, [(true, "Wrap".into(), ""), (false, "Scroll".into(), "")], &s.diff_wrap) {
            s.diff_wrap = v;
        }
    });
    row(
        ui,
        p,
        "Branch folders",
        "Nest branch names into folders in the sidebar, or list them flat with the most recent first.",
        |ui| {
            if let Some(v) =
                choices(ui, p, [(true, "Folders".into(), ""), (false, "Flat".into(), "")], &s.branch_folders)
            {
                s.branch_folders = v;
            }
        },
    );
    row(ui, p, "Avatars", "Author pictures beside commits.", |ui| {
        if let Some(v) = on_off(ui, p, s.avatars) {
            s.avatars = v;
        }
    });
    commit_settings(app, s);
}

fn repository(app: &mut App, ui: &mut Ui) {
    let p = app.palette;
    heading(ui, p, "Repository");
    let mut s = app.settings.clone();
    row(
        ui,
        p,
        "Fetch automatically",
        "Only the repository you are looking at, and only while the window has focus. The command shows in the ticker like any other.",
        |ui| {
            let options = FETCH_INTERVALS.map(|n| (n, if n == 0 { "Off".to_string() } else { format!("{n} min") }, ""));
            if let Some(n) = choices(ui, p, options, &s.fetch_minutes) {
                s.fetch_minutes = n;
            }
        },
    );
    row(
        ui,
        p,
        "Hold remote connections",
        "A repository on another machine is served by a gitc running over there, reached through an SSH tunnel. This is how long that is kept after you leave its tab - the tab you are looking at is never dropped, and tabbing back reconnects.",
        |ui| {
            if let Some(n) = choices(ui, p, REMOTE_HOLDS.map(|(n, l)| (n, l.to_string(), "")), &s.remote_hold_minutes) {
                s.remote_hold_minutes = n;
            }
        },
    );
    if s.remote_hold_minutes != app.settings.remote_hold_minutes {
        app.jobs.send(Request::SetRemoteHold { minutes: s.remote_hold_minutes });
    }

    let remotes = app.prefs.remotes.clone().unwrap_or_default();
    let hint = if remotes.is_empty() {
        "A repository on another machine is served by a gitc running over there, which gitc installs itself the first time you open that machine - and asks before it does. Nothing has been agreed to yet."
    } else {
        "gitc may keep a copy of itself on these, and updates it when versions no longer match. Removing one means being asked again next time; the copy already over there is left alone."
    };
    let mut revoke: Option<String> = None;
    row(ui, p, "Machines gitc may install on", hint, |ui| {
        if remotes.is_empty() {
            value(ui, p, "None");
            return;
        }
        ui.horizontal_wrapped(|ui| {
            for host in &remotes {
                if chip(ui, p, host).on_hover_text(format!("Ask again before installing gitc on {host}")).clicked() {
                    revoke = Some(host.clone());
                }
            }
        });
    });
    if let Some(host) = revoke {
        app.jobs.request(Request::RevokeRemote { host }, |app, result: Result<Hosts, String>| match result {
            Ok(h) => app.prefs.remotes = Some(h.hosts),
            Err(e) => app.toasts.error(&e),
        });
    }

    row(
        ui,
        p,
        "Fetch on focus",
        "Fetch when you come back to the window, or switch to this repository's tab, rather than waiting for the interval. Works with the interval Off. Repeats within a few seconds are skipped, so flipping between tabs does not fetch every time.",
        |ui| {
            if let Some(v) = on_off(ui, p, s.fetch_on_focus) {
                s.fetch_on_focus = v;
            }
        },
    );
    commit_settings(app, s);
}

fn commands(app: &mut App, ui: &mut Ui) {
    let p = app.palette;
    heading(ui, p, "Command log");
    let hidden = app.settings.hidden_commands.clone();
    let hint = if hidden.is_empty() {
        "Nothing is hidden. The eye on a row in the command log hides every command of that kind - the polls gitc runs constantly are the usual reason."
    } else {
        "These no longer appear in the command log or the ticker. They are still run, and still recorded: showing one again brings its history back."
    };
    let mut show_again: Option<String> = None;
    let mut show_all = false;
    row(ui, p, "Hidden commands", hint, |ui| {
        if hidden.is_empty() {
            value(ui, p, "None");
            return;
        }
        ui.horizontal_wrapped(|ui| {
            for name in &hidden {
                if chip(ui, p, &format!("git {name}"))
                    .on_hover_text(format!("Show \"git {name}\" in the log again"))
                    .clicked()
                {
                    show_again = Some(name.clone());
                }
            }
            show_all = small_button(ui, p, "Show all").clicked();
        });
    });
    if show_all {
        app.settings.hidden_commands.clear();
        app.save_settings();
    } else if let Some(name) = show_again {
        app.settings.hidden_commands.retain(|n| *n != name);
        app.save_settings();
    }
}

fn crashes(app: &mut App, ui: &mut Ui) {
    let p = app.palette;
    heading(ui, p, "Crash reports");
    let mut delete: Option<String> = None;
    let state = &mut app.prefs;
    row(
        ui,
        p,
        "Reports",
        "Kept when something in gitc fails in a way nothing planned for: a request the engine could not answer, or a panic in the window. The newest 50 are kept, on this machine only - nothing is sent anywhere. Copy one into an issue to report it.",
        |ui| {
            let list = match &state.crashes {
                None => return hint(ui, p, "reading..."),
                Some(Err(e)) => return hint(ui, p, e),
                Some(Ok(list)) => list,
            };
            if list.reports.is_empty() {
                return value(ui, p, "None");
            }
            ui.set_max_width(680.0);
            for report in &list.reports {
                let open = state.open_crashes.contains(&report.id);
                if crash_head(ui, p, report, open).clicked() && !state.open_crashes.remove(&report.id) {
                    state.open_crashes.insert(report.id.clone());
                }
                if open {
                    let text = report_text(report);
                    egui::Frame::new().fill(p.bg_inset).corner_radius(3.0).inner_margin(Margin::symmetric(10, 8)).show(
                        ui,
                        |ui| {
                            egui::ScrollArea::vertical().id_salt(("crash", &report.id)).max_height(280.0).show(
                                ui,
                                |ui| {
                                    ui.add(
                                        egui::Label::new(RichText::new(&text).size(11.0).monospace().color(p.fg))
                                            .selectable(true)
                                            .wrap(),
                                    );
                                },
                            );
                        },
                    );
                    ui.horizontal(|ui| {
                        if small_button(ui, p, "Copy report").clicked() {
                            ui.ctx().copy_text(text.clone());
                        }
                        if small_button(ui, p, "Delete").clicked() {
                            delete = Some(report.id.clone());
                        }
                    });
                    ui.add_space(4.0);
                }
            }
            ui.add_space(4.0);
            if small_button(ui, p, "Delete all").clicked() {
                delete = Some(String::new());
            }
        },
    );
    if let Some(Ok(list)) = &state.crashes {
        let dir = list.dir.clone();
        row(ui, p, "Folder", "One JSON file per report, named by the time it happened.", |ui| value(ui, p, &dir));
    }
    if let Some(id) = delete {
        app.jobs.request(Request::ClearCrashes { id }, |app, result: Result<CrashList, String>| {
            app.prefs.crashes = Some(result)
        });
    }
}

fn crash_head(ui: &mut Ui, p: Palette, report: &CrashReport, open: bool) -> Response {
    let (rect, response) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 28.0), Sense::click());
    let fill = if response.hovered() { p.bg_2 } else { p.bg_1 };
    ui.painter().rect(rect, 4.0, fill, Stroke::new(1.0, p.line), egui::StrokeKind::Inside);
    let y = rect.center().y;
    let chevron = egui::Rect::from_center_size(egui::pos2(rect.left() + 16.0, y), Vec2::splat(11.0));
    icons::paint(ui, chevron, if open { "chevronDown" } else { "chevronRight" }, p.fg_muted);
    let source = source_label(&report.source);
    let tone = if report.source == "stopped" { p.amber_fg } else { p.fg_dim };
    let galley = ui.painter().layout_no_wrap(source.to_string(), FontId::proportional(10.0), tone);
    let chip =
        egui::Rect::from_min_size(egui::pos2(rect.left() + 28.0, y - 8.0), Vec2::new(galley.size().x + 12.0, 16.0));
    ui.painter().rect_filled(chip, 3.0, p.bg_3);
    ui.painter().galley(chip.center() - galley.size() / 2.0, galley, tone);
    let when = when(&report.time);
    let when_galley = ui.painter().layout_no_wrap(when, FontId::proportional(11.0), p.fg_muted);
    let when_x = rect.right() - 10.0 - when_galley.size().x;
    let message_left = chip.right() + 8.0;
    let message = ui.painter().layout(
        report.message.lines().next().unwrap_or("").to_string(),
        FontId::monospace(11.0),
        p.fg,
        (when_x - message_left - 10.0).max(10.0),
    );
    let clip = egui::Rect::from_min_max(egui::pos2(message_left, rect.top()), egui::pos2(when_x - 8.0, rect.bottom()));
    ui.painter().with_clip_rect(clip).galley(egui::pos2(message_left, y - 7.0), message, p.fg);
    ui.painter().galley(egui::pos2(when_x, y - when_galley.size().y / 2.0), when_galley, p.fg_muted);
    response
}

fn about(app: &mut App, ui: &mut Ui) {
    let p = app.palette;
    heading(ui, p, "About");
    let update = app.update.clone();
    let version_hint = match &update {
        None => String::new(),
        Some(u) if u.available => format!("gitc {} is available. Updating replaces this copy and restarts.", u.latest),
        Some(u) if !u.error.is_empty() => u.error.clone(),
        Some(_) => "This is the newest version.".into(),
    };
    let mut run_update = false;
    let mut check = false;
    let updating = app.updating;
    row(ui, p, "Version", &version_hint, |ui| {
        ui.horizontal(|ui| {
            value(ui, p, &format!("gitc {}", crate::VERSION));
            ui.add_space(12.0);
            match &update {
                Some(u) if u.available => {
                    let label = if updating { "Updating...".to_string() } else { format!("Update to {}", u.latest) };
                    let button =
                        egui::Button::new(RichText::new(label).size(12.0).color(p.accent_fg)).fill(p.accent_line);
                    run_update = ui.add_enabled(!updating, button).clicked();
                }
                _ => check = small_button(ui, p, "Check for updates").clicked(),
            }
        });
    });
    if run_update {
        actions::run_update(app);
    }
    if check {
        actions::check_update(app, true);
    }

    let mut s = app.settings.clone();
    row(
        ui,
        p,
        "Release stream",
        "Test builds are release candidates - published to be tried and reported on, not relied upon. Switching here installs through the updater, which can replace a running gitc. Going back to Stable offers the newest published release, even though its number is lower.",
        |ui| {
            if let Some(c) =
                choices(ui, p, CHANNELS.map(|(c, l, h)| (c.to_string(), l.to_string(), h)), &s.update_channel)
            {
                s.update_channel = c;
            }
        },
    );
    if s.update_channel == "test" {
        let streams = update.as_ref().map(|u| u.streams.clone()).unwrap_or_default();
        row(
            ui,
            p,
            "Which test builds",
            "More than one branch can have candidates published at once. Following one means the others are not offered to you, however high their version numbers go - and an ordinary release is always offered, which is how you leave a stream when its work ships.",
            |ui| {
                if streams.is_empty() {
                    return hint(ui, p, "no test builds are published");
                }
                if let Some(name) = choices(ui, p, streams.iter().map(|n| (n.clone(), n.clone(), "")), &s.update_stream)
                {
                    s.update_stream = name;
                }
            },
        );
    }
    row(
        ui,
        p,
        "Check for updates",
        "An interval checks at launch as well. The check is one request to the releases page and reports nothing unless there is something newer.",
        |ui| {
            if let Some(n) = choices(ui, p, UPDATE_CHECKS.map(|(n, l)| (n, l.to_string(), "")), &s.update_check_minutes)
            {
                s.update_check_minutes = n;
            }
        },
    );
    row(
        ui,
        p,
        "Tell me about",
        "How big a new version has to be before gitc mentions it. This page always reports what is actually available.",
        |ui| {
            if let Some(level) = choices(
                ui,
                p,
                version::UPDATE_LEVELS.map(|(v, l, h)| (v.to_string(), l.to_string(), h)),
                &s.update_level,
            ) {
                s.update_level = level;
            }
        },
    );
    if s.update_channel != app.settings.update_channel || s.update_stream != app.settings.update_stream {
        let stream = Some(s.update_stream.clone()).filter(|v| !v.is_empty());
        let req = Request::SetUpdateChannel { channel: s.update_channel.clone(), stream };
        app.jobs.request(req, |app, result: Result<serde_json::Value, String>| match result {
            Ok(_) => actions::check_update(app, false),
            Err(e) => app.toasts.error(&e),
        });
    }
    commit_settings(app, s);

    row(ui, p, "Licence", "Free software. The source is the whole program.", |ui| {
        value(ui, p, "GNU Affero General Public License v3.0");
    });
    let dir = crate::engine::paths::config_dir().display().to_string();
    row(ui, p, "Settings", "Open repositories, hidden branches and the preferences on this screen live here.", |ui| {
        value(ui, p, &dir)
    });

    let label = format!("What changed in {}", crate::VERSION);
    let notes = &app.prefs.notes;
    row(ui, p, &label, "From the release page for this version.", |ui| match notes {
        None => hint(ui, p, "reading the release notes..."),
        Some(Err(e)) => hint(ui, p, e),
        Some(Ok((notes, lines))) if lines.is_empty() => {
            hint(ui, p, if notes.error.is_empty() { "No release notes for this version." } else { &notes.error });
        }
        Some(Ok((notes, lines))) => {
            ui.set_max_width(620.0);
            egui::Frame::new().fill(p.bg_inset).corner_radius(4.0).inner_margin(Margin::symmetric(12, 10)).show(
                ui,
                |ui| {
                    egui::ScrollArea::vertical()
                        .id_salt("release-notes")
                        .max_height(320.0)
                        .auto_shrink([false, true])
                        .show(ui, |ui| {
                            release_notes(ui, p, lines);
                        });
                },
            );
            if notes.page.starts_with("https://") {
                ui.hyperlink_to(RichText::new("the release page").size(11.0).color(p.accent), &notes.page);
            }
        }
    });
}

fn release_notes(ui: &mut Ui, p: Palette, lines: &[changelog::Line]) {
    use changelog::Kind;
    ui.spacing_mut().item_spacing.y = 2.0;
    for line in lines {
        match line.kind {
            Kind::Blank => ui.add_space(5.0),
            Kind::Heading => {
                ui.add_space(4.0);
                ui.horizontal_wrapped(|ui| pieces(ui, p, &line.pieces, p.fg_bright, true));
            }
            Kind::Bullet => {
                ui.horizontal_wrapped(|ui| {
                    ui.add_space(line.depth as f32 * 14.0);
                    ui.label(RichText::new("-").size(12.0).color(p.fg_muted));
                    ui.add_space(4.0);
                    pieces(ui, p, &line.pieces, p.fg, false);
                });
            }
            Kind::Text => {
                ui.horizontal_wrapped(|ui| pieces(ui, p, &line.pieces, p.fg, false));
            }
        }
    }
}

fn pieces(ui: &mut Ui, p: Palette, pieces: &[changelog::Piece], color: Color32, strong: bool) {
    ui.spacing_mut().item_spacing.x = 0.0;
    for piece in pieces {
        let mut text = RichText::new(&piece.text).size(12.0).color(color);
        if strong || piece.bold {
            text = text.strong().color(p.fg_bright);
        }
        if piece.code {
            text = text.monospace().size(11.0).background_color(p.bg_3);
        }
        match &piece.href {
            Some(href) => {
                ui.hyperlink_to(text.color(p.accent), href);
            }
            None => {
                ui.label(text);
            }
        }
    }
}

fn commit_settings(app: &mut App, s: super::settings::Settings) {
    if s != app.settings {
        app.settings = s;
        app.save_settings();
    }
}

fn heading(ui: &mut Ui, p: Palette, text: &str) {
    ui.label(RichText::new(text).size(19.0).color(p.fg_bright));
    ui.add_space(18.0);
}

/// One labelled control; the label column is right-aligned, as in the reference.
fn row(ui: &mut Ui, p: Palette, label: &str, hint_text: &str, contents: impl FnOnce(&mut Ui)) {
    ui.horizontal_top(|ui| {
        ui.allocate_ui_with_layout(Vec2::new(LABEL_WIDTH, 24.0), Layout::right_to_left(Align::Center), |ui| {
            ui.set_min_width(LABEL_WIDTH);
            ui.add(egui::Label::new(RichText::new(label).size(13.0).color(p.fg_dim)).wrap());
        });
        ui.add_space(20.0);
        ui.vertical(|ui| {
            ui.set_max_width(ui.available_width().min(680.0));
            contents(ui);
            if !hint_text.is_empty() {
                ui.set_max_width(ui.available_width().min(520.0));
                hint(ui, p, hint_text);
            }
        });
    });
    ui.add_space(16.0);
}

fn hint(ui: &mut Ui, p: Palette, text: &str) {
    ui.add(egui::Label::new(RichText::new(text).size(11.0).color(p.fg_muted)).wrap());
}

fn value(ui: &mut Ui, p: Palette, text: &str) {
    ui.add(egui::Label::new(RichText::new(text).size(13.0).color(p.fg)).selectable(true));
}

/// A segmented control; returns the option clicked when it is not the current one.
fn choices<'a, T: PartialEq>(
    ui: &mut Ui,
    p: Palette,
    options: impl IntoIterator<Item = (T, String, &'a str)>,
    current: &T,
) -> Option<T> {
    let mut picked = None;
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 0.0;
        for (value, label, tip) in options {
            let on = value == *current;
            let text = RichText::new(label).size(12.0).color(if on { p.accent_fg } else { p.fg_dim });
            let button = egui::Button::new(text)
                .fill(if on { p.accent_bg } else { p.bg_2 })
                .stroke(Stroke::new(1.0, if on { p.accent_line } else { p.line_strong }))
                .corner_radius(0.0)
                .min_size(Vec2::new(46.0, 24.0));
            let mut response = ui.add(button);
            if !tip.is_empty() {
                response = response.on_hover_text(tip);
            }
            if response.clicked() && !on {
                picked = Some(value);
            }
        }
    });
    picked
}

fn on_off(ui: &mut Ui, p: Palette, current: bool) -> Option<bool> {
    choices(ui, p, [(true, "On".to_string(), ""), (false, "Off".to_string(), "")], &current)
}

fn small_button(ui: &mut Ui, p: Palette, text: &str) -> Response {
    ui.add(
        egui::Button::new(RichText::new(text).size(12.0).color(p.fg))
            .fill(p.bg_2)
            .stroke(Stroke::new(1.0, p.line_strong))
            .min_size(Vec2::new(0.0, 24.0)),
    )
}

fn chip(ui: &mut Ui, p: Palette, text: &str) -> Response {
    let button =
        egui::Button::new((RichText::new(text).size(12.0).color(p.fg), icons::image("close", 10.0, p.fg_muted)))
            .fill(p.bg_2)
            .stroke(Stroke::new(1.0, p.line_strong))
            .corner_radius(12.0);
    ui.add(button)
}

fn source_label(source: &str) -> &str {
    match source {
        "engine" => "Engine",
        "window" => "Window",
        "stopped" => "Stopped",
        other => other,
    }
}

fn report_text(r: &CrashReport) -> String {
    format!(
        "gitc {} on {}\n{} - {}\n\n{}\n\n{}",
        r.version,
        r.platform,
        r.time,
        source_label(&r.source),
        r.message,
        r.detail
    )
}

fn when(iso: &str) -> String {
    let short = iso.split('.').next().unwrap_or(iso).replace('T', " ");
    format!("{} UTC", short.trim_end_matches('Z'))
}
