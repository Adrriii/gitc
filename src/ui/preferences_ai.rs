use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::time::{Duration, Instant};

use eframe::egui::{self, Align, Id, Key, Layout, Margin, RichText, Stroke, Ui};
use serde::Deserialize;

use super::{choices, heading, hint, on_off, row, small_button};
use crate::engine::api::Request;
use crate::engine::types::{AiConfig, AiModel, AiProvider, ClaudeStatus};
use crate::ui::theme::Palette;
use crate::ui::{App, icons};

#[derive(Default)]
pub struct State {
    asked: bool,
    open: bool,
    tests: HashMap<String, String>,
    editing: Option<Editing>,
}

struct Editing {
    provider: AiProvider,
    known: bool,
    models: Vec<AiModel>,
    models_note: String,
    models_due: Option<Instant>,
    status: Option<ClaudeStatus>,
    status_due: Option<Instant>,
    error: String,
    waiting: bool,
    login_url: String,
    seq: u64,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Models {
    models: Vec<AiModel>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Login {
    url: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Took {
    ms: u64,
}

/// (kind, label, hint)
pub const KINDS: [(&str, &str, &str); 3] = [
    ("openai", "OpenAI-compatible", "OpenRouter, OpenAI, Ollama, LM Studio, or any server speaking the same API"),
    ("anthropic", "Anthropic", "The Anthropic API, with your own key"),
    ("claude-code", "Claude Code", "The claude on this machine, signed in to your Claude account"),
];

/// (id, label, hint)
pub const FEATURES: [(&str, &str, &str); 5] = [
    (
        "commitMessage",
        "Commit message",
        "A button inside the commit summary writes the summary and description from the staged changes, in the style of this repository's recent commits. Anything already typed in either box is taken as a hint.",
    ),
    (
        "explainCommit",
        "Explain commits",
        "A button in the commit panel explains the selected commit, or commits, in a few plain paragraphs.",
    ),
    (
        "branchName",
        "Branch name",
        "A button in the new branch box names the branch after your uncommitted changes, in the style of this repository's branches.",
    ),
    (
        "squashMessage",
        "Squash message",
        "Squashing writes one message for the result from the commits' messages and their combined change, instead of joining the messages together.",
    ),
    (
        "conflictAssist",
        "Conflict picks",
        "The merge editor can suggest which lines to keep from each side. It only ever picks lines, and says so when a conflict needs more than that.",
    ),
];

const MODELS_DELAY: Duration = Duration::from_millis(500);
const STATUS_POLL: Duration = Duration::from_secs(2);

pub fn show(app: &mut App, ui: &mut Ui) {
    let p = app.palette;
    heading(ui, p, "AI");
    if app.ai.is_none() && !app.prefs.ai.asked {
        app.prefs.ai.asked = true;
        app.jobs.request(Request::Ai, |app, result: Result<AiConfig, String>| match result {
            Ok(config) => app.ai = Some(config),
            Err(e) => app.toasts.error(&format!("Could not read the AI settings\n{e}")),
        });
    }
    let Some(config) = app.ai.clone() else {
        return hint(ui, p, "reading the AI settings...");
    };

    let mut next = config.clone();
    row(
        ui,
        p,
        "AI features",
        "Off by default. While off, none of what follows exists anywhere in gitc. Requests go straight from this machine to the provider you choose, and API keys are kept in ai.json in the settings folder.",
        |ui| {
            if let Some(on) = on_off(ui, p, config.enabled) {
                next.enabled = on;
            }
        },
    );
    if config.enabled {
        providers(app, ui, &config, &mut next);
        for (id, label, tip) in FEATURES {
            let on = config.features.iter().any(|f| f == id);
            row(ui, p, label, tip, |ui| {
                if let Some(want) = on_off(ui, p, on) {
                    next.features.retain(|f| f != id);
                    if want {
                        next.features.push(id.to_string());
                    }
                }
            });
        }
    }
    if next != config {
        save(app, next);
    }
    editor(app, ui.ctx());
}

fn providers(app: &mut App, ui: &mut Ui, config: &AiConfig, next: &mut AiConfig) {
    let p = app.palette;
    let state = &mut app.prefs.ai;
    let empty = config.providers.is_empty();
    let expanded = state.open || empty;
    let default = config.providers.iter().find(|q| q.id == config.default_id).or(config.providers.first());
    let mut edit: Option<AiProvider> = None;
    let mut test: Option<String> = None;
    row(
        ui,
        p,
        "Providers",
        "Every repository uses the default unless you pick another for it, from the provider shown in the status bar.",
        |ui| {
            let title = if empty {
                "No provider yet".to_string()
            } else {
                let n = config.providers.len();
                format!(
                    "{n} provider{}, default {}",
                    if n == 1 { "" } else { "s" },
                    default.map_or("", |d| d.name.as_str())
                )
            };
            let icon = icons::image(if expanded { "chevronDown" } else { "chevronRight" }, 11.0, p.fg_muted);
            let head = egui::Button::new((icon, RichText::new(title).size(12.0).color(p.fg)))
                .fill(p.bg_1)
                .stroke(Stroke::new(1.0, p.line));
            if ui.add_enabled(!empty, head).clicked() {
                state.open = !expanded;
            }
            if !expanded {
                return;
            }
            egui::Frame::new()
                .fill(p.bg_1)
                .stroke(Stroke::new(1.0, p.line))
                .corner_radius(4.0)
                .inner_margin(Margin::same(8))
                .show(ui, |ui| {
                    for provider in &config.providers {
                        ui.horizontal(|ui| {
                            let is_default = default.is_some_and(|d| d.id == provider.id);
                            if ui
                                .radio(is_default, RichText::new("Default").size(12.0))
                                .on_hover_text("Used by every repository that has not picked another")
                                .clicked()
                            {
                                next.default_id = provider.id.clone();
                            }
                            ui.label(RichText::new(&provider.name).size(12.0).color(p.fg_bright));
                            ui.label(
                                RichText::new(kind_label(&provider.kind))
                                    .size(10.0)
                                    .color(p.fg_dim)
                                    .background_color(p.bg_3),
                            );
                            ui.label(
                                RichText::new(state.tests.get(&provider.id).map_or("", |s| s.as_str()))
                                    .size(11.0)
                                    .color(p.fg_muted),
                            );
                            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                if small_button(ui, p, "Remove").clicked() {
                                    next.providers.retain(|q| q.id != provider.id);
                                }
                                if small_button(ui, p, "Edit").clicked() {
                                    edit = Some(provider.clone());
                                }
                                if small_button(ui, p, "Test").clicked() {
                                    test = Some(provider.id.clone());
                                }
                            });
                        });
                    }
                    ui.horizontal_wrapped(|ui| {
                        for (kind, label, tip) in KINDS {
                            if small_button(ui, p, &format!("Add {label}")).on_hover_text(tip).clicked() {
                                edit = Some(new_provider(kind, &config.providers));
                            }
                        }
                    });
                });
        },
    );
    if let Some(provider) = edit {
        let known = config.providers.iter().any(|q| q.id == provider.id);
        start_editing(app, provider, known);
    }
    if let Some(id) = test {
        app.prefs.ai.tests.insert(id.clone(), "testing...".into());
        let req = Request::TestAi { provider_id: id.clone() };
        app.jobs.request(req, move |app, result: Result<Took, String>| {
            let note = match result {
                Ok(t) => format!("ok, {} ms", t.ms),
                Err(e) => e,
            };
            app.prefs.ai.tests.insert(id, note);
        });
    }
}

fn start_editing(app: &mut App, provider: AiProvider, known: bool) {
    let now = Instant::now();
    let seq = app.prefs.ai.editing.as_ref().map_or(0, |e| e.seq) + 1;
    let status_due = (provider.kind == "claude-code").then_some(now);
    app.prefs.ai.editing = Some(Editing {
        provider,
        known,
        models: Vec::new(),
        models_note: String::new(),
        models_due: Some(now + MODELS_DELAY),
        status: None,
        status_due,
        error: String::new(),
        waiting: false,
        login_url: String::new(),
        seq,
    });
}

fn editor(app: &mut App, ctx: &egui::Context) {
    poll(app, ctx);
    let p = app.palette;
    let Some(editing) = app.prefs.ai.editing.as_mut() else { return };
    let kind = editing.provider.kind.clone();
    let claude = kind == "claude-code";
    let before = (editing.provider.base_url.clone(), editing.provider.key.clone(), editing.provider.account.clone());
    let mut save_it = false;
    let mut cancel = false;
    let mut log_in = false;
    let frame =
        egui::Frame::new().fill(p.bg_2).stroke(Stroke::new(1.0, p.line_strong)).inner_margin(16.0).corner_radius(6.0);
    let modal = egui::Modal::new(Id::unique("gitc-ai-provider")).frame(frame).show(ctx, |ui| {
        ui.set_width(440.0);
        let verb = if editing.known { "Edit" } else { "Add" };
        ui.label(RichText::new(format!("{verb} {}", kind_label(&kind))).size(15.0).strong().color(p.fg_bright));
        ui.add_space(6.0);
        let body = if claude {
            "Uses the Claude Code on this machine, signed in to the account below. It runs with no tools, so it only sees what gitc sends: the staged diff and recent commit messages."
        } else {
            "The key stays on this machine. Write $NAME instead to read it from that environment variable."
        };
        ui.add(egui::Label::new(RichText::new(body).color(p.fg_dim)).wrap());
        ui.add_space(8.0);
        let d = &mut editing.provider;
        field(ui, p, "Name", |ui| ui.add(egui::TextEdit::singleline(&mut d.name).desired_width(f32::INFINITY)));
        if kind == "openai" {
            field(ui, p, "Base URL", |ui| ui.add(egui::TextEdit::singleline(&mut d.base_url).desired_width(f32::INFINITY)));
            if !d.base_url.trim().is_empty() && !url_ok(&d.base_url) {
                ui.label(RichText::new("Starts with http:// or https://").color(p.amber_fg));
            }
        }
        if !claude {
            let placeholder = if kind == "openai" { "none needed for a local server" } else { "sk-ant-..." };
            field(ui, p, "API key", |ui| ui.add(egui::TextEdit::singleline(&mut d.key).password(true).hint_text(placeholder).desired_width(f32::INFINITY)));
        }
        let placeholder = match kind.as_str() {
            "anthropic" => "claude-opus-5-5",
            "openai" => "provider/model-name",
            _ => "the default",
        };
        let models = &editing.models;
        field(ui, p, "Model", |ui| {
            if models.is_empty() {
                return ui.add(egui::TextEdit::singleline(&mut d.model).hint_text(placeholder).desired_width(f32::INFINITY));
            }
            let shown = models.iter().find(|m| m.id == d.model).map_or(d.model.clone(), |m| m.label.clone());
            egui::ComboBox::from_id_salt("ai-model")
                .selected_text(shown)
                .width(ui.available_width())
                .show_ui(ui, |ui| {
                    for m in models {
                        ui.selectable_value(&mut d.model, m.id.clone(), &m.label);
                    }
                })
                .response
        });
        if !claude && !editing.models_note.is_empty() {
            hint(ui, p, &editing.models_note);
        }
        if claude {
            ui.add_space(4.0);
            let account = d.account.clone();
            let options = [
                (String::new(), "This machine's sign-in".to_string(), "The account the claude on this machine is already signed in to"),
                ("own".to_string(), "A separate account".to_string(), "Another Claude account, signed in for gitc only"),
            ];
            let current = if account == "own" { "own".to_string() } else { String::new() };
            if let Some(picked) = choices(ui, p, options, &current) {
                d.account = picked;
            }
            ui.add_space(4.0);
            log_in = sign_in(ui, p, editing);
        }
        ui.add_space(12.0);
        let valid = valid(&editing.provider) && (!claude || ready(editing));
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            let button = egui::Button::new(RichText::new("Save").color(p.accent_fg)).fill(p.accent_line);
            save_it = ui.add_enabled(valid, button).clicked() || (valid && ui.input(|i| i.key_pressed(Key::Enter)));
            cancel = ui.button("Cancel").clicked();
        });
    });
    if modal.should_close() {
        cancel = true;
    }

    let after = (editing.provider.base_url.clone(), editing.provider.key.clone(), editing.provider.account.clone());
    if after.0 != before.0 || after.1 != before.1 {
        editing.models.clear();
        editing.models_note.clear();
        editing.models_due = Some(Instant::now() + MODELS_DELAY);
    }
    if claude && after.2 != before.2 {
        editing.seq += 1;
        editing.status = None;
        editing.waiting = false;
        editing.login_url.clear();
        editing.error.clear();
        editing.status_due = Some(Instant::now());
    }
    if log_in {
        claude_login(app);
        return;
    }
    if save_it {
        let Some(editing) = app.prefs.ai.editing.take() else { return };
        store(app, trimmed(editing.provider));
        return;
    }
    if cancel {
        let Some(editing) = app.prefs.ai.editing.take() else { return };
        if claude && editing.provider.account == "own" {
            app.jobs.request(
                Request::ClaudeForget { provider_id: editing.provider.id },
                |_, _: Result<serde_json::Value, String>| {},
            );
        }
    }
}

fn sign_in(ui: &mut Ui, p: Palette, editing: &Editing) -> bool {
    let mut log_in = false;
    match &editing.status {
        None => hint(ui, p, "Looking for Claude Code..."),
        Some(s) if !s.installed => {
            ui.horizontal_wrapped(|ui| {
                hint(ui, p, "Claude Code is not installed on this machine.");
                ui.hyperlink_to(RichText::new("How to install it").size(11.0), "https://code.claude.com/docs");
            });
        }
        Some(s) if s.logged_in => {
            ui.horizontal(|ui| {
                icons::show(ui, "check", 12.0, p.green);
                let who = if s.email.is_empty() { " to Claude".to_string() } else { format!(" as {}", s.email) };
                let plan = if s.plan.is_empty() { String::new() } else { format!(" ({})", s.plan) };
                ui.label(RichText::new(format!("Signed in{who}{plan}")).size(12.0).color(p.green_fg));
            });
        }
        Some(_) => {
            let label = if editing.waiting { "Waiting for the browser..." } else { "Log in to Claude Code" };
            let button = egui::Button::new(RichText::new(label).size(12.0).color(p.accent_fg)).fill(p.accent_line);
            log_in = ui.add_enabled(!editing.waiting, button).clicked();
            if editing.waiting {
                ui.horizontal_wrapped(|ui| {
                    hint(ui, p, "Finish signing in in your browser.");
                    if editing.login_url.starts_with("https://") {
                        ui.hyperlink_to(RichText::new("Open the sign-in page").size(11.0), &editing.login_url);
                    }
                });
            }
        }
    }
    if !editing.error.is_empty() {
        ui.add(egui::Label::new(RichText::new(&editing.error).size(11.0).color(p.red_fg)).wrap());
    }
    log_in
}

fn poll(app: &mut App, ctx: &egui::Context) {
    let Some(editing) = app.prefs.ai.editing.as_mut() else { return };
    let now = Instant::now();
    let seq = editing.seq;
    for due in [editing.models_due, editing.status_due].into_iter().flatten() {
        ctx.request_repaint_after(due.saturating_duration_since(now));
    }
    if editing.models_due.is_some_and(|d| d <= now) {
        editing.models_due = None;
        let asked = (editing.provider.base_url.clone(), editing.provider.key.clone());
        app.jobs.request(
            Request::AiModels { provider: editing.provider.clone() },
            move |app, result: Result<Models, String>| {
                let Some(e) = app.prefs.ai.editing.as_mut() else { return };
                if e.seq != seq || (e.provider.base_url.clone(), e.provider.key.clone()) != asked {
                    return;
                }
                match result {
                    Ok(m) if !m.models.is_empty() => e.models = m.models,
                    Ok(_) => e.models_note = "No model list from the provider".into(),
                    Err(err) => e.models_note = format!("No model list from the provider: {err}"),
                }
            },
        );
    }
    let Some(editing) = app.prefs.ai.editing.as_mut() else { return };
    if editing.provider.kind != "claude-code" || !editing.status_due.is_some_and(|d| d <= now) {
        return;
    }
    editing.status_due = None;
    let req =
        Request::ClaudeStatus { provider_id: editing.provider.id.clone(), account: editing.provider.account.clone() };
    app.jobs.request(req, move |app, result: Result<ClaudeStatus, String>| {
        let Some(e) = app.prefs.ai.editing.as_mut() else { return };
        if e.seq != seq {
            return;
        }
        match result {
            Ok(status) => {
                if status.logged_in {
                    e.waiting = false;
                }
                e.status = Some(status);
            }
            Err(err) => e.error = err,
        }
        if e.waiting {
            e.status_due = Some(Instant::now() + STATUS_POLL);
        }
    });
}

fn claude_login(app: &mut App) {
    let Some(editing) = app.prefs.ai.editing.as_mut() else { return };
    editing.error.clear();
    let seq = editing.seq;
    let req =
        Request::ClaudeLogin { provider_id: editing.provider.id.clone(), account: editing.provider.account.clone() };
    app.jobs.request(req, move |app, result: Result<Login, String>| {
        let Some(e) = app.prefs.ai.editing.as_mut() else { return };
        if e.seq != seq {
            return;
        }
        match result {
            Ok(login) => {
                e.login_url = login.url;
                e.waiting = true;
                e.status_due = Some(Instant::now() + STATUS_POLL);
            }
            Err(err) => e.error = err,
        }
    });
}

fn store(app: &mut App, provider: AiProvider) {
    let Some(mut config) = app.ai.clone() else { return };
    match config.providers.iter_mut().find(|q| q.id == provider.id) {
        Some(slot) => *slot = provider.clone(),
        None => config.providers.push(provider.clone()),
    }
    if config.default_id.is_empty() {
        config.default_id = provider.id;
    }
    save(app, config);
}

fn save(app: &mut App, next: AiConfig) {
    app.ai = Some(next.clone());
    app.jobs.request(Request::SaveAi { config: next }, |app, result: Result<AiConfig, String>| match result {
        Ok(saved) => app.ai = Some(saved),
        Err(e) => {
            app.toasts.error(&format!("Saving the AI settings failed\n{e}"));
            app.ai = None;
            app.prefs.ai.asked = false;
        }
    });
}

fn field(ui: &mut Ui, p: Palette, label: &str, add: impl FnOnce(&mut Ui) -> egui::Response) {
    ui.label(RichText::new(label).size(12.0).color(p.fg_dim));
    add(ui);
    ui.add_space(4.0);
}

fn ready(editing: &Editing) -> bool {
    editing.status.as_ref().is_some_and(|s| s.installed && s.logged_in)
}

fn valid(p: &AiProvider) -> bool {
    if p.name.trim().is_empty() {
        return false;
    }
    match p.kind.as_str() {
        "openai" => url_ok(&p.base_url) && !p.model.trim().is_empty(),
        "anthropic" => !p.key.trim().is_empty() && !p.model.trim().is_empty(),
        _ => true,
    }
}

fn trimmed(p: AiProvider) -> AiProvider {
    AiProvider {
        name: p.name.trim().to_string(),
        base_url: p.base_url.trim().to_string(),
        key: p.key.trim().to_string(),
        model: p.model.trim().to_string(),
        ..p
    }
}

fn url_ok(url: &str) -> bool {
    let url = url.trim();
    url.starts_with("http://") || url.starts_with("https://")
}

pub fn kind_label(kind: &str) -> &str {
    KINDS.iter().find(|k| k.0 == kind).map_or(kind, |k| k.1)
}

fn new_provider(kind: &str, existing: &[AiProvider]) -> AiProvider {
    let same = existing.iter().filter(|p| p.kind == kind).count();
    let base = match kind {
        "openai" => "OpenRouter",
        other => kind_label(other),
    };
    let machine_taken = existing.iter().any(|p| p.kind == "claude-code" && p.account != "own");
    AiProvider {
        id: new_id(),
        name: if same == 0 { base.to_string() } else { format!("{base} {}", same + 1) },
        kind: kind.to_string(),
        base_url: if kind == "openai" { "https://openrouter.ai/api/v1".into() } else { String::new() },
        key: String::new(),
        model: if kind == "anthropic" { "claude-opus-5-5".into() } else { String::new() },
        account: if kind == "claude-code" && machine_taken { "own".into() } else { String::new() },
    }
}

fn new_id() -> String {
    let random = std::collections::hash_map::RandomState::new().build_hasher().finish();
    let mut id = base36(crate::engine::git::now_ms());
    id.extend(base36(random).chars().take(6));
    id
}

fn base36(mut n: u64) -> String {
    let mut out = Vec::new();
    loop {
        out.push(char::from_digit((n % 36) as u32, 36).unwrap_or('0'));
        n /= 36;
        if n == 0 {
            break;
        }
    }
    out.iter().rev().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_usable_as_claude_homes() {
        let id = new_id();
        assert!(id.len() > 6);
        assert!(id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()));
        assert_eq!(base36(0), "0");
        assert_eq!(base36(35), "z");
        assert_eq!(base36(36), "10");
    }

    #[test]
    fn provider_names_count_up() {
        let first = new_provider("openai", &[]);
        assert_eq!(first.name, "OpenRouter");
        assert_eq!(new_provider("openai", &[first.clone()]).name, "OpenRouter 2");
        let mine = new_provider("claude-code", &[]);
        assert_eq!(mine.account, "");
        assert_eq!(new_provider("claude-code", &[mine]).account, "own");
    }
}
