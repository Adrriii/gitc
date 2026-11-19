use std::time::{Duration, Instant};

use eframe::egui::{self, Align, Id, Layout, Margin, RichText, Sense, Stroke, Ui, Vec2};

use super::theme::Palette;
use super::{App, actions, icons};
use crate::engine::api::Request;
use crate::engine::types::{OpArgs, UpdateProgress};

#[derive(Default)]
pub struct State {
    /// An AI explanation to show: (title, text).
    pub explain: Option<(String, String)>,
    polled: Option<Instant>,
    polling: bool,
    closing: bool,
}

enum Refused {
    Force,
    Pull(&'static str),
    Cancel,
}

#[derive(Clone, Copy)]
enum Tone {
    Primary,
    Secondary,
    Danger,
}

const POLL: Duration = Duration::from_millis(300);

/// Overlays: update progress, push refused, AI explanations.
pub fn show(app: &mut App, ctx: &egui::Context) {
    poll(app, ctx);
    if app.push_refusal.is_some() {
        push_refused(app, ctx);
    }
    if app.updates.explain.is_some() {
        explain(app, ctx);
    }
    if app.updating || app.update_progress.as_ref().is_some_and(|p| p.phase == "failed") {
        progress(app, ctx);
    }
}

fn poll(app: &mut App, ctx: &egui::Context) {
    if !app.updating {
        app.updates.polled = None;
        return;
    }
    if app.update_progress.as_ref().is_some_and(|p| p.phase == "restarting") && !app.updates.closing {
        app.updates.closing = true;
        ctx.send_viewport_cmd(egui::ViewportCommand::Close);
    }
    ctx.request_repaint_after(POLL);
    if app.updates.polling || app.updates.polled.is_some_and(|t| t.elapsed() < POLL) {
        return;
    }
    app.updates.polling = true;
    app.updates.polled = Some(Instant::now());
    app.jobs.request(Request::UpdateProgress, |app, result: Result<UpdateProgress, String>| {
        app.updates.polling = false;
        let Ok(progress) = result else { return };
        if !app.updating {
            return;
        }
        if progress.phase == "failed" {
            app.updating = false;
        }
        app.update_progress = Some(progress);
    });
}

fn progress(app: &mut App, ctx: &egui::Context) {
    let p = app.palette;
    let progress = app.update_progress.clone().unwrap_or_default();
    let phase = progress.phase.as_str();
    let failed = phase == "failed";
    let mut dismiss = false;
    egui::Modal::new(Id::unique("gitc-updating")).frame(frame(p)).show(ctx, |ui| {
        ui.set_width(400.0);
        ui.label(RichText::new(title(phase)).size(15.0).strong().color(p.fg_bright));
        ui.add_space(4.0);
        let message = if failed {
            "Nothing was changed - the version you have is still installed."
        } else if progress.message.is_empty() {
            "Starting"
        } else {
            &progress.message
        };
        ui.add(egui::Label::new(RichText::new(message).color(p.fg_dim)).wrap());
        ui.add_space(10.0);
        if failed {
            ui.add(egui::Label::new(RichText::new(&progress.message).color(p.red_fg)).wrap());
            ui.add_space(10.0);
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| dismiss = ui.button("Close").clicked());
            return;
        }
        let fraction = (phase == "downloading" && progress.total > 0)
            .then(|| (progress.received as f32 / progress.total as f32).clamp(0.0, 1.0));
        track(ui, p, fraction);
        if let Some(f) = fraction {
            ui.horizontal(|ui| {
                let figures = format!("{} of {}", mb(progress.received), mb(progress.total));
                ui.label(RichText::new(figures).size(11.0).color(p.fg_muted));
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    ui.label(RichText::new(format!("{}%", (f * 100.0).round())).size(11.0).color(p.fg_muted));
                });
            });
        }
        if phase == "restarting" {
            ui.label(RichText::new("This window closes and a new one opens.").size(11.0).color(p.fg_muted));
        }
    });
    if dismiss {
        app.update_progress = None;
        app.updating = false;
    }
}

fn track(ui: &mut Ui, p: Palette, fraction: Option<f32>) {
    let (rect, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 6.0), Sense::hover());
    ui.painter().rect_filled(rect, 3.0, p.bg_inset);
    let fill = match fraction {
        Some(f) => egui::Rect::from_min_size(rect.min, Vec2::new(rect.width() * f, rect.height())),
        None => {
            let t = (ui.input(|i| i.time) * 0.8).fract() as f32;
            let width = rect.width() * 0.3;
            let left = rect.left() - width + t * (rect.width() + width);
            ui.ctx().request_repaint();
            egui::Rect::from_min_max(
                egui::pos2(left.max(rect.left()), rect.top()),
                egui::pos2((left + width).min(rect.right()), rect.bottom()),
            )
        }
    };
    ui.painter().rect_filled(fill, 3.0, p.accent);
}

fn push_refused(app: &mut App, ctx: &egui::Context) {
    let p = app.palette;
    let Some((refusal, _)) = app.push_refusal.as_ref() else { return };
    let behind = refusal.kind == "behind";
    let rewrite = refusal.kind == "rewrite";
    let up = refusal.upstream.as_str();
    let mut act: Option<Refused> = None;
    let modal = egui::Modal::new(Id::unique("gitc-push-refused")).frame(frame(p)).show(ctx, |ui| {
        ui.set_width(460.0);
        let heading = if behind {
            "This branch is behind the remote"
        } else if rewrite {
            "This branch was rewritten"
        } else {
            "The remote has work you do not"
        };
        ui.label(RichText::new(heading).size(15.0).strong().color(p.fg_bright));
        ui.add_space(6.0);
        let them = |n: u64| if n == 1 { "it" } else { "them" };
        let body = if behind {
            format!(
                "{up} has {} that this branch does not, and this branch has nothing of its own to publish. Pulling brings you level - there is nothing to reconcile. Unless you removed {} on purpose - a reset or a dropped commit - and the remote should lose {} too.",
                plural(refusal.behind, "commit"),
                them(refusal.behind),
                them(refusal.behind)
            )
        } else if rewrite {
            format!(
                "{up} still holds the older version of {} you have since rebased, amended or squashed. Nothing there is missing from this branch.",
                plural(refusal.behind, "commit")
            )
        } else {
            format!(
                "{up} has {} that this branch does not. Pushing over it would delete {}.",
                plural(refusal.theirs, "commit"),
                them(refusal.theirs)
            )
        };
        ui.add(egui::Label::new(RichText::new(body).color(p.fg)).wrap());
        ui.add_space(8.0);
        ui.horizontal(|ui| {
            ui.label(RichText::new(refusal.ahead.to_string()).strong().color(p.fg_bright));
            ui.label(RichText::new("here, not on the remote").color(p.fg_dim));
            ui.label(RichText::new("-").color(p.fg_faint));
            ui.label(RichText::new(refusal.behind.to_string()).strong().color(p.fg_bright));
            ui.label(RichText::new("on the remote, not here").color(p.fg_dim));
        });
        if !rewrite && !refusal.their_commits.is_empty() {
            ui.add_space(6.0);
            let color = if behind { p.fg } else { p.red_fg };
            let fill = if behind { p.bg_inset } else { p.red_bg };
            egui::Frame::new().fill(fill).corner_radius(4.0).inner_margin(Margin::symmetric(10, 6)).show(ui, |ui| {
                ui.set_width(ui.available_width());
                for line in &refusal.their_commits {
                    ui.label(RichText::new(line).size(12.0).monospace().color(color));
                }
                let more = refusal.theirs.saturating_sub(refusal.their_commits.len() as u64);
                if more > 0 {
                    ui.label(RichText::new(format!("and {more} more")).size(12.0).color(p.fg_muted));
                }
            });
        }
        ui.add_space(12.0);
        let mut option = |ui: &mut Ui, tone: Tone, label: &str, hint: String, then: Refused| {
            if choice(ui, p, tone, label, &hint) {
                act = Some(then);
            }
        };
        if behind {
            option(ui, Tone::Primary, "Pull", format!("git pull --ff-only. Moves this branch up to {up}; nothing here is changed or merged."), Refused::Pull("ff"));
            option(ui, Tone::Danger, "Force push", format!("Deletes {} from {up}, for commits you removed on purpose.", plural(refusal.behind, "commit")), Refused::Force);
        } else if rewrite {
            option(ui, Tone::Primary, "Force push", format!("Replaces {up} with this branch. Refused automatically if the remote has moved since gitc last looked."), Refused::Force);
            option(ui, Tone::Secondary, "Pull first", "Brings the superseded commits back and merges them, undoing the tidying. Rarely what you want here.".into(), Refused::Pull("merge"));
        } else {
            option(ui, Tone::Primary, "Pull, then replay mine on top", "git pull --rebase. Keeps history linear; may raise conflicts to resolve.".into(), Refused::Pull("rebase"));
            option(ui, Tone::Secondary, "Pull and merge", "git pull --no-rebase. Keeps both histories and adds a merge commit.".into(), Refused::Pull("merge"));
            option(ui, Tone::Danger, "Force push anyway", format!("Deletes {} from {up}. Only if you know that work is not wanted.", plural(refusal.theirs, "commit")), Refused::Force);
        }
        ui.add_space(4.0);
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            if ui.button("Cancel").clicked() {
                act = Some(Refused::Cancel);
            }
        });
    });
    if modal.should_close() && act.is_none() {
        act = Some(Refused::Cancel);
    }
    let Some(act) = act else { return };
    let Some((_, args)) = app.push_refusal.take() else { return };
    match act {
        Refused::Force => actions::run_op(app, OpArgs { force: true, ..args }),
        Refused::Pull(mode) => {
            let mode = if mode == "ff" { "" } else { mode };
            actions::run_op(app, OpArgs { op: "pull".into(), mode: mode.into(), ..Default::default() });
        }
        Refused::Cancel => {}
    }
}

fn choice(ui: &mut Ui, p: Palette, tone: Tone, label: &str, hint: &str) -> bool {
    let (fill, stroke, text) = match tone {
        Tone::Primary => (p.accent_bg, p.accent_line, p.accent_fg),
        Tone::Secondary => (p.bg_3, p.line_strong, p.fg_bright),
        Tone::Danger => (p.red_bg, p.red_line, p.red_fg),
    };
    let response = egui::Frame::new()
        .fill(fill)
        .stroke(Stroke::new(1.0, stroke))
        .corner_radius(4.0)
        .inner_margin(Margin::symmetric(12, 8))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.label(RichText::new(label).size(13.0).strong().color(text));
            ui.add(egui::Label::new(RichText::new(hint).size(11.0).color(p.fg_dim)).wrap());
        })
        .response
        .interact(Sense::click());
    if response.hovered() {
        ui.painter().rect_stroke(response.rect, 4.0, Stroke::new(1.0, text), egui::StrokeKind::Inside);
    }
    ui.add_space(6.0);
    response.clicked()
}

fn explain(app: &mut App, ctx: &egui::Context) {
    let p = app.palette;
    let Some((title, text)) = app.updates.explain.as_ref() else { return };
    let mut close = false;
    let modal = egui::Modal::new(Id::unique("gitc-explain")).frame(frame(p)).show(ctx, |ui| {
        ui.set_width(540.0);
        ui.horizontal(|ui| {
            icons::show(ui, "sparkle", 13.0, p.purple);
            ui.label(RichText::new(title).size(15.0).strong().color(p.fg_bright));
        });
        ui.add_space(8.0);
        egui::ScrollArea::vertical().max_height(ctx.content_rect().height() * 0.6).show(ui, |ui| {
            ui.add(egui::Label::new(RichText::new(text).size(13.0).color(p.fg)).selectable(true).wrap());
        });
        ui.add_space(12.0);
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            close = ui.button("Close").clicked();
            if ui.button("Copy").clicked() {
                ui.ctx().copy_text(text.clone());
            }
        });
    });
    if close || modal.should_close() {
        app.updates.explain = None;
    }
}

fn frame(p: Palette) -> egui::Frame {
    egui::Frame::new().fill(p.bg_2).stroke(Stroke::new(1.0, p.line_strong)).inner_margin(16.0).corner_radius(6.0)
}

fn title(phase: &str) -> &'static str {
    match phase {
        "checking" => "Checking for the newest version",
        "downloading" => "Downloading gitc",
        "verifying" => "Verifying the download",
        "installing" => "Installing",
        "restarting" => "Restarting",
        "failed" => "The update did not finish",
        _ => "Updating gitc",
    }
}

fn plural(n: u64, word: &str) -> String {
    format!("{n} {word}{}", if n == 1 { "" } else { "s" })
}

fn mb(bytes: u64) -> String {
    format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
}
