use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use eframe::egui::{self, Key, Modifiers, Ui};
use serde::Deserialize;
use serde_json::Value;

use super::App;
use super::dialogs::{Choice, Choose, Confirm, Field, Form, Prompt, Suggest, Validate};
use crate::engine::api::{self, DEFAULT_LIMIT, Request};
use crate::engine::git::now_ms;
use crate::engine::types::{
    AiConfig, AiProvider, Commit, CommitDone, GraphPayload, OpArgs, OpResult, Ping, Session, Submodule, Tab,
    UpdateInfo, UpdateProgress, UpdateResult, Worktree,
};

#[path = "actions_menus.rs"]
mod menus;

pub use menus::{
    ai_menu, chip_menu, commit_menu, folder_menu, ref_menu, remote_menu, stash_menu, submodule_menu, tab_menu,
    workspace_menu, worktree_menu,
};

const ARRIVE_COOLDOWN: Duration = Duration::from_secs(15);
const PING_EVERY: Duration = Duration::from_secs(2);
const ACTIVE_MS: i64 = 30_000;
const OWN_WIP: &str = "WIP";

#[derive(Default)]
pub struct State {
    /// A manual update check is running.
    pub checking_update: bool,
    started: bool,
    focused: bool,
    front: Option<String>,
    fetching: HashSet<String>,
    arrived: HashMap<String, Instant>,
    channel: Option<(String, String)>,
    update_minutes: Option<i64>,
    update_checked: Option<Instant>,
    hold: Option<u64>,
    pinging: bool,
    pinged: Option<Instant>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Named {
    name: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct WorktreeList {
    worktrees: Vec<Worktree>,
}

/// Per-frame app logic: keybinds, auto-fetch, fetch on focus, update checks, remote status polling.
pub fn frame(app: &mut App, ui: &mut Ui) {
    let ctx = ui.ctx().clone();
    if !app.actions.started {
        app.actions.started = true;
        app.jobs.request(Request::Ai, |app, result: Result<AiConfig, String>| match result {
            Ok(config) => app.ai = Some(config),
            Err(e) => eprintln!("gitc: reading the AI settings failed: {e}"),
        });
    }
    keybinds(app, &ctx);
    auto_fetch(app, &ctx);
    update_checks(app);
    remote_upkeep(app);
    ctx.request_repaint_after(PING_EVERY);
}

/// Runs an operation on the tab in front, reporting the result and refreshing.
pub fn run_op(app: &mut App, args: OpArgs) {
    let Some(id) = app.active_id() else { return };
    run_on(app, &id, args);
}

/// Double-click on a branch or chip: kind is "local" | "remote" | "tag".
pub fn checkout_ref(app: &mut App, kind: &str, short: &str) {
    let Some(worktrees) = app.repo().and_then(|r| r.data.as_ref()).map(|d| d.worktrees.clone()) else { return };
    if kind == "worktree" {
        if worktrees.iter().any(|w| w.name == short) {
            edit_worktree(app, short);
        }
        return;
    }
    if kind == "local" {
        if let Some(w) = holder(&worktrees, short) {
            edit_worktree(app, &w.name);
            return;
        }
    }
    run_op(app, OpArgs { r#ref: short.to_string(), ..op("checkout") });
}

/// A toolbar button: "undo" | "fetch" | "pull" | "push" | "branch" | "stash" | "pop".
pub fn toolbar(app: &mut App, which: &str) {
    let name = match which {
        "fetch" => "fetch",
        "pull" => "pull",
        "push" => "push",
        "stash" => "stash",
        "pop" => "stashPop",
        "branch" => return new_branch(app),
        _ => return,
    };
    run_op(app, op(name));
}

pub fn new_branch(app: &mut App) {
    let Some(id) = app.active_id() else { return };
    let ai = ai_feature(app, "branchName");
    let Some(data) = app.repos.get(&id).and_then(|r| r.data.as_ref()) else { return };
    let from = data.head.branch.clone().unwrap_or_else(|| "HEAD".into());
    let dirty = !data.status.is_empty();
    let tab = id.clone();
    let mut prompt = Prompt::new("Create branch", "Create & checkout", move |app, name| {
        run_on(app, &tab, OpArgs { name, checkout: true, ..op("createBranch") })
    });
    prompt.label = format!("Branch from {from}");
    prompt.placeholder = "feature/my-work".into();
    prompt.validate = Some(Box::new(validate_ref_name));
    if ai && dirty {
        let run: Suggest =
            Arc::new(move || api::call::<Named>(Request::SuggestBranchName { id: id.clone() }).map(|r| r.name));
        prompt.suggest = Some(("Name the branch after your uncommitted changes".into(), run));
    }
    app.overlay.prompt(prompt);
}

pub fn add_remote(app: &mut App) {
    let Some(id) = app.active_id() else { return };
    app.overlay.form(Form {
        title: "Add remote".into(),
        body: "The remote is fetched as soon as it is added, so its branches appear right away.".into(),
        fields: vec![
            Field {
                key: "name".into(),
                label: "Name".into(),
                placeholder: "origin".into(),
                initial: "origin".into(),
                validate: Some(Box::new(validate_remote_name)),
                ..Default::default()
            },
            Field {
                key: "url".into(),
                label: "URL".into(),
                placeholder: "https://github.com/you/repo.git".into(),
                validate: Some(Box::new(validate_remote_url)),
                ..Default::default()
            },
        ],
        confirm_label: "Add remote".into(),
        on_confirm: Box::new(move |app, v| {
            let name = v.get("name").cloned().unwrap_or_default();
            let message = v.get("url").cloned().unwrap_or_default();
            run_on(app, &id, OpArgs { name, message, ..op("addRemote") });
        }),
    });
}

pub fn set_hidden(app: &mut App, refs: Vec<String>, hide: bool) {
    let Some(id) = app.active_id() else { return };
    if refs.is_empty() {
        return;
    }
    let Some(data) = app.repos.get(&id).and_then(|r| r.data.as_ref()) else { return };
    let mut hidden = data.hidden.clone();
    hidden.retain(|h| !refs.contains(h));
    if hide {
        hidden.extend(refs);
    }
    app.overlay.menu = None;
    let tab = id.clone();
    app.jobs.request(Request::SetHidden { id, hidden }, move |app, result: Result<GraphPayload, String>| {
        let data = match result {
            Ok(data) => data,
            Err(e) => return app.toasts.error(&e),
        };
        let Some(repo) = app.repos.get_mut(&tab) else { return };
        repo.data = Some(data);
        repo.version += 1;
        if repo.limit > DEFAULT_LIMIT {
            repo.refresh();
        }
    });
}

pub fn open_submodule(app: &mut App, sub: &Submodule) {
    if sub.state == "uninitialized" {
        app.toasts.error(&format!("{} is not checked out yet - update it first", sub.path));
        return;
    }
    let host = app.active_tab().and_then(|t| t.host.clone()).unwrap_or_default();
    app.open(&sub.absolute, &host);
}

/// Shows another worktree's uncommitted changes in the panel.
pub fn view_worktree(app: &mut App, name: &str) {
    let Some(repo) = app.repo() else { return };
    let Some(w) = repo.data.as_ref().and_then(|d| d.worktrees.iter().find(|w| w.name == name)) else { return };
    if w.current {
        return;
    }
    if w.prunable {
        let message = format!("{} is gone from disk - nothing left to look at", worktree_label(w));
        app.toasts.error(&message);
        return;
    }
    let target = if !w.status.is_empty() { Some(wip_hash(&w.name)) } else { w.hash.clone() };
    if let Some(hash) = target {
        repo.reveal_commit(&hash);
    }
}

/// Opens another worktree as a tab of its own.
pub fn edit_worktree(app: &mut App, name: &str) {
    let Some(tab) = app.active_tab().cloned() else { return };
    let Some(w) =
        app.repo().and_then(|r| r.data.as_ref()).and_then(|d| d.worktrees.iter().find(|w| w.name == name)).cloned()
    else {
        return;
    };
    if w.current {
        return;
    }
    if w.prunable {
        app.toasts.error(&format!("{} is gone from disk - it can only be pruned", worktree_label(&w)));
        return;
    }
    app.jobs.request(Request::Worktrees { id: tab.id.clone() }, move |app, result: Result<WorktreeList, String>| {
        let fresh = result.ok().and_then(|l| l.worktrees.into_iter().find(|x| x.name == w.name)).unwrap_or_else(|| w.clone());
        let active = is_active(&fresh);
        if !active && !fresh.locked {
            open_with_namesakes(app, w, tab);
            return;
        }
        let label = worktree_label(&w);
        let mut body = Vec::new();
        if active {
            body.push(format!(
                "Something changed in {label} {} seconds ago. If an agent is working there, changing things underneath it will confuse it.",
                (fresh.idle_ms + 500) / 1000
            ));
        }
        if fresh.locked {
            body.push(locked_line(&fresh));
        }
        body.push("Looking at its changes from this tab is always safe.".into());
        let mut confirm = Confirm::new(format!("Open {label} for editing?"), body.join("\n\n"), "Open anyway", move |app| {
            open_with_namesakes(app, w, tab)
        });
        confirm.tab_id = app.active_id();
        app.overlay.confirm(confirm);
    });
}

/// The one-line commit box on the graph's WIP row.
pub fn quick_commit(app: &mut App, summary: String) {
    let Some(id) = app.active_id() else { return };
    let req = Request::Commit { id: id.clone(), summary, description: String::new(), amend: false };
    app.jobs.request(req, move |app, result: Result<CommitDone, String>| {
        match result {
            Ok(done) => app.toasts.ok(&format!("committed {}", short(&done.hash))),
            Err(e) => app.toasts.error(&e),
        }
        if let Some(repo) = app.repos.get_mut(&id) {
            repo.refresh();
        }
    });
}

/// Squashes commits of the tab in front, with an AI-written message when that feature is on.
pub fn squash(app: &mut App, shas: Vec<String>) {
    let Some(id) = app.active_id() else { return };
    if !ai_feature(app, "squashMessage") {
        run_on(app, &id, OpArgs { shas, ..op("squash") });
        return;
    }
    app.toasts.ok("Writing the squash message...");
    let req = Request::WriteSquashMessage { id: id.clone(), shas: shas.clone() };
    app.jobs.request(req, move |app, result: Result<crate::engine::types::Message, String>| match result {
        Ok(m) => {
            let message =
                if m.description.is_empty() { m.summary } else { format!("{}\n\n{}", m.summary, m.description) };
            run_on(app, &id, OpArgs { shas, message, ..op("squash") });
        }
        Err(e) => {
            app.toasts.warn(&format!("Squashed with the usual message - {e}"));
            run_on(app, &id, OpArgs { shas, ..op("squash") });
        }
    });
}

pub fn check_update(app: &mut App, manual: bool) {
    if manual {
        app.actions.checking_update = true;
    }
    app.jobs.request(Request::CheckUpdate, move |app, result: Result<UpdateInfo, String>| {
        if manual {
            app.actions.checking_update = false;
        }
        match result {
            Ok(info) => app.update = Some(info),
            Err(error) if manual => {
                app.update = Some(UpdateInfo { current: crate::VERSION.to_string(), error, ..Default::default() })
            }
            Err(_) => {}
        }
    });
}

/// Asks, then downloads and installs the available update.
pub fn run_update(app: &mut App) {
    let Some(latest) = app.update.as_ref().filter(|u| u.available).map(|u| u.latest.clone()) else { return };
    let body = format!(
        "gitc will download {latest}, replace itself and restart. This window closes and a new one opens - nothing else is affected, and your repositories are untouched."
    );
    let confirm = Confirm::new(format!("Update to gitc {latest}?"), body, format!("Update to {latest}"), |app| {
        app.updating = true;
        app.update_progress = Some(progress("checking", "Starting the update"));
        app.jobs.request(Request::ApplyUpdate, |app, result: Result<UpdateResult, String>| match result {
            Ok(r) if r.ok => app.toasts.ok(&r.message),
            Ok(r) => failed(app, r.message),
            Err(e) => failed(app, e),
        });
    });
    app.overlay.confirm(confirm);
}

pub fn close_tab(app: &mut App, id: &str) {
    let back = match (app.active_tab(), app.repos.get(id).and_then(|r| r.data.as_ref())) {
        (Some(front), Some(data)) if front.id == id => main_tab_of(&app.session.tabs, front, &data.worktrees),
        _ => None,
    };
    let req = Request::Close { id: id.to_string(), next: back, everywhere: false };
    app.jobs.request(req, set_session);
}

/// Whether an opt-in AI feature is on.
pub fn ai_feature(app: &App, name: &str) -> bool {
    app.ai.as_ref().is_some_and(|c| c.enabled && c.features.iter().any(|f| f == name))
}

/// The provider a repository uses, and whether it was picked for it rather than being the default.
pub fn provider_for<'a>(config: &'a AiConfig, host: &str, path: &str) -> Option<(&'a AiProvider, bool)> {
    let pinned = config.repos.iter().find(|r| r.host == host && r.path == path);
    if let Some(p) = pinned.and_then(|r| config.providers.iter().find(|p| p.id == r.provider_id)) {
        return Some((p, true));
    }
    let fallback = config.providers.iter().find(|p| p.id == config.default_id).or(config.providers.first())?;
    Some((fallback, false))
}

pub fn kind_label(kind: &str) -> &str {
    match kind {
        "openai" => "OpenAI-compatible",
        "anthropic" => "Anthropic",
        "claude-code" => "Claude Code",
        other => other,
    }
}

/// The graph row holding another worktree's uncommitted work.
pub fn wip_hash(name: &str) -> String {
    format!("{OWN_WIP}:{name}")
}

/// Any WIP row, this tab's or another worktree's.
pub fn is_wip(hash: &str) -> bool {
    hash == OWN_WIP || wip_worktree(hash).is_some()
}

/// Which worktree a WIP row belongs to; None for this tab's own and for commits.
pub fn wip_worktree(hash: &str) -> Option<&str> {
    hash.strip_prefix(OWN_WIP)?.strip_prefix(':')
}

/// A worktree's directory name, the same name its tab gets.
pub fn worktree_label(w: &Worktree) -> String {
    let leaf = w.path.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or("");
    if leaf.is_empty() { w.name.clone() } else { leaf.to_string() }
}

/// Somebody, probably an agent, moved its HEAD or index within the last 30 seconds.
pub fn is_active(w: &Worktree) -> bool {
    !w.current && w.idle_ms >= 0 && w.idle_ms < ACTIVE_MS
}

/// The other worktree that has `branch` checked out, if any.
pub fn holder<'a>(worktrees: &'a [Worktree], branch: &str) -> Option<&'a Worktree> {
    worktrees.iter().find(|w| !w.current && !w.prunable && !w.detached && w.branch.as_deref() == Some(branch))
}

/// Whether two paths name the same directory: slashes either way, drive letters in any case.
pub fn same_path(a: &str, b: &str) -> bool {
    norm_path(a) == norm_path(b)
}

pub fn validate_ref_name(value: &str) -> Option<String> {
    let v = value.trim();
    if v.is_empty() {
        return None;
    }
    if v.starts_with('-') || v.starts_with('/') || v.ends_with('/') {
        return Some("Cannot start with - or /".into());
    }
    if v.ends_with(".lock") {
        return Some("Cannot end with .lock".into());
    }
    if v.contains("..") || v.contains("//") {
        return Some("Cannot contain .. or //".into());
    }
    if v.chars().any(|c| c.is_whitespace() || "~^:?*[\\".contains(c)) {
        return Some("Cannot contain spaces or ~ ^ : ? * [ \\".into());
    }
    None
}

pub fn validate_remote_name(value: &str) -> Option<String> {
    if value.trim().contains('/') {
        return Some("A remote name cannot contain /".into());
    }
    validate_ref_name(value)
}

pub fn validate_remote_url(value: &str) -> Option<String> {
    value.trim().chars().any(char::is_whitespace).then(|| "A URL cannot contain spaces".into())
}

fn keybinds(app: &mut App, ctx: &egui::Context) {
    let (prev, next, close, escape) = ctx.input_mut(|i| {
        let prev = i.consume_key(Modifiers::COMMAND | Modifiers::SHIFT, Key::Tab);
        let next = i.consume_key(Modifiers::COMMAND, Key::Tab);
        let close = !i.modifiers.shift && !i.modifiers.alt && i.consume_key(Modifiers::COMMAND, Key::W);
        (prev, next, close, i.key_pressed(Key::Escape))
    });
    if prev {
        step_repo(app, -1);
    }
    if next {
        step_repo(app, 1);
    }
    if close {
        if let Some(id) = app.active_id() {
            close_tab(app, &id);
        }
    }
    if escape && !app.overlay.is_open() && !app.prefs_open {
        if let Some(repo) = app.repo() {
            if repo.merge_file.is_some() {
                repo.merge_file = None;
            } else {
                repo.open_file = None;
            }
        }
    }
}

fn step_repo(app: &mut App, delta: isize) {
    let session = &app.session;
    let tabs: Vec<&Tab> = session.tabs.iter().filter(|t| t.workspaces.contains(&session.workspace)).collect();
    let len = tabs.len() as isize;
    if len < 2 {
        return;
    }
    let Some(at) = tabs.iter().position(|t| Some(&t.id) == session.active_id.as_ref()) else { return };
    let Some(next) = tabs.get((at as isize + delta).rem_euclid(len) as usize).map(|t| t.id.clone()) else { return };
    app.activate(&next);
}

fn auto_fetch(app: &mut App, ctx: &egui::Context) {
    let focused = ctx.input(|i| i.focused);
    let regained = focused && !app.actions.focused;
    app.actions.focused = focused;
    let Some(id) = app.active_id() else {
        app.actions.front = None;
        return;
    };
    let arrived = app.actions.front.as_deref() != Some(id.as_str());
    if arrived {
        app.actions.front = Some(id.clone());
    }
    if !focused || app.actions.fetching.contains(&id) {
        return;
    }
    let Some(repo) = app.repos.get(&id) else { return };
    let since_fetch = (repo.fetched_at != 0).then(|| (now_ms() as i64 - repo.fetched_at).max(0) as u64);
    if (arrived || regained) && app.settings.fetch_on_focus {
        let recent = app.actions.arrived.get(&id).is_some_and(|t| t.elapsed() < ARRIVE_COOLDOWN);
        let fresh = since_fetch.is_some_and(|ms| ms < ARRIVE_COOLDOWN.as_millis() as u64);
        if !recent && !fresh {
            app.actions.arrived.insert(id.clone(), Instant::now());
            fetch_quietly(app, &id);
        }
        return;
    }
    let minutes = app.settings.fetch_minutes;
    if minutes == 0 || repo.checked_at.is_none() {
        return;
    }
    let due = Duration::from_secs(minutes * 60);
    if repo.last_fetch_attempt.is_some_and(|t| t.elapsed() < due) {
        return;
    }
    if since_fetch.is_some_and(|ms| ms < due.as_millis() as u64) {
        return;
    }
    fetch_quietly(app, &id);
}

fn fetch_quietly(app: &mut App, id: &str) {
    app.actions.fetching.insert(id.to_string());
    if let Some(repo) = app.repos.get_mut(id) {
        repo.last_fetch_attempt = Some(Instant::now());
    }
    let tab = id.to_string();
    let req = Request::Op { id: tab.clone(), args: op("fetch") };
    app.jobs.request(req, move |app, result: Result<OpResult, String>| {
        app.actions.fetching.remove(&tab);
        if result.is_err() {
            return;
        }
        if let Some(repo) = app.repos.get_mut(&tab) {
            repo.refresh();
        }
    });
}

fn update_checks(app: &mut App) {
    let settings = &app.settings;
    let state = &mut app.actions;
    let minutes = settings.update_check_minutes;
    let moved =
        state.channel.as_ref().is_none_or(|(c, s)| c != &settings.update_channel || s != &settings.update_stream);
    if moved {
        let (channel, stream) = (settings.update_channel.clone(), settings.update_stream.clone());
        state.channel = Some((channel.clone(), stream.clone()));
        state.update_minutes = Some(minutes);
        state.update_checked = Some(Instant::now());
        let req = Request::SetUpdateChannel { channel, stream: Some(stream) };
        app.jobs.request(req, move |app, result: Result<Value, String>| {
            if result.is_ok() && minutes >= 0 {
                check_update(app, false);
            }
        });
        return;
    }
    let changed = state.update_minutes != Some(minutes);
    state.update_minutes = Some(minutes);
    let every = Duration::from_secs(minutes.max(0) as u64 * 60);
    let due = minutes > 0 && state.update_checked.is_none_or(|t| t.elapsed() >= every);
    if minutes < 0 || !(changed || due) {
        return;
    }
    state.update_checked = Some(Instant::now());
    check_update(app, false);
}

fn remote_upkeep(app: &mut App) {
    let hold = app.settings.remote_hold_minutes;
    if app.actions.hold != Some(hold) {
        app.actions.hold = Some(hold);
        app.jobs.request(Request::SetRemoteHold { minutes: hold }, |_, _: Result<Value, String>| {});
    }
    let hosts = app.session.tabs.iter().any(|t| t.host.as_deref().is_some_and(|h| !h.is_empty()));
    let state = &mut app.actions;
    if !hosts || state.pinging || state.pinged.is_some_and(|t| t.elapsed() < PING_EVERY) {
        return;
    }
    state.pinging = true;
    state.pinged = Some(Instant::now());
    app.jobs.request(Request::Ping, |app, result: Result<Ping, String>| {
        app.actions.pinging = false;
        if let Ok(ping) = result {
            app.remotes = ping.remotes;
        }
    });
}

/// Runs one operation on a given tab, so a question answered later still acts on the tab it was asked about.
fn run_on(app: &mut App, id: &str, args: OpArgs) {
    run_chain(app, id, vec![args]);
}

/// Runs operations one after another, stopping at the first that does not simply succeed.
fn run_chain(app: &mut App, id: &str, mut chain: Vec<OpArgs>) {
    if chain.is_empty() {
        return;
    }
    let args = chain.remove(0);
    if let Some(repo) = app.repos.get_mut(id) {
        repo.busy = true;
    }
    app.overlay.menu = None;
    let tab = id.to_string();
    let req = Request::Op { id: tab.clone(), args: args.clone() };
    app.jobs.request(req, move |app, result: Result<OpResult, String>| op_done(app, &tab, args, chain, result));
}

fn op_done(app: &mut App, id: &str, args: OpArgs, rest: Vec<OpArgs>, result: Result<OpResult, String>) {
    if let Some(repo) = app.repos.get_mut(id) {
        repo.busy = false;
        repo.refresh();
    }
    let r = match result {
        Ok(r) => r,
        Err(e) => return app.toasts.error(&e),
    };
    let here = app.active_id().as_deref() == Some(id);
    let asks = !matches!(r.refusal.kind.as_str(), "" | "none")
        || r.push_to.as_deref().is_some_and(|p| !p.is_empty())
        || !r.confirm.is_empty();
    if asks && !here {
        let title = if r.confirm.is_empty() { "The push needs a decision" } else { r.confirm.as_str() };
        app.toasts.warn(&format!("{title}\n{}", r.note));
        return;
    }
    if !matches!(r.refusal.kind.as_str(), "" | "none") {
        app.push_refusal = Some((r.refusal, args));
        return;
    }
    if let Some(dest) = r.push_to.clone().filter(|p| !p.is_empty()) {
        ask_push_to(app, id, args, &r.note, dest);
        return;
    }
    if !r.confirm.is_empty() && args.op == "checkout" {
        ask_diverged(app, id, args, r);
        return;
    }
    if !r.confirm.is_empty() {
        let forced = OpArgs { force: true, ..args };
        confirm_op(app, id, r.confirm, r.note, "Delete anyway", true, forced);
        return;
    }
    if r.ok && args.op == "removeWorktree" {
        close_worktree_tabs(app, id, &args.name);
    }
    if !r.ok {
        if r.pending.is_empty() {
            app.toasts.error(&r.note)
        } else {
            app.toasts.warn(&r.note)
        }
        return;
    }
    if !r.note.is_empty() {
        if r.warn { app.toasts.warn(&r.note) } else { app.toasts.ok(&r.note) }
    }
    run_chain(app, id, rest);
}

fn ask_push_to(app: &mut App, id: &str, args: OpArgs, note: &str, dest: String) {
    let remotes = remotes_of(app, id);
    let checked = remotes.clone();
    let tab = id.to_string();
    let force = args.force;
    let mut prompt = Prompt::new("Push to", if force { "Force push" } else { "Push" }, move |app, value| {
        let Some((remote, name)) = split_remote_branch(&value, &remotes) else { return };
        run_on(app, &tab, OpArgs { remote, name, ..args });
    });
    prompt.label = format!("{note} Push it to:");
    prompt.initial = dest;
    prompt.validate = Some(remote_branch_check(checked));
    app.overlay.prompt(prompt);
}

fn ask_diverged(app: &mut App, id: &str, args: OpArgs, r: OpResult) {
    let target = if args.r#ref.is_empty() { "the remote".to_string() } else { args.r#ref.clone() };
    let tab = id.to_string();
    app.overlay.choose(Choose {
        title: r.confirm,
        body: r.note,
        options: vec![
            Choice {
                value: "rebase".into(),
                label: format!("Rebase my commits onto {target}"),
                hint: "like git pull --rebase".into(),
            },
            Choice {
                value: "reset".into(),
                label: format!("Overwrite my branch with {target}"),
                hint: "my local commits are dropped".into(),
            },
        ],
        on_pick: Box::new(move |app, mode| run_on(app, &tab, OpArgs { mode, ..args })),
    });
}

fn close_worktree_tabs(app: &mut App, id: &str, name: &str) {
    let host = app.session.tabs.iter().find(|t| t.id == id).map(|t| t.host.clone());
    let gone =
        app.repos.get(id).and_then(|r| r.data.as_ref()).and_then(|d| d.worktrees.iter().find(|w| w.name == name));
    let (Some(host), Some(gone)) = (host, gone) else { return };
    let doomed: Vec<String> = app
        .session
        .tabs
        .iter()
        .filter(|t| t.host == host && same_path(&t.path, &gone.path))
        .map(|t| t.id.clone())
        .collect();
    for tab in doomed {
        app.jobs.request(Request::Close { id: tab, next: None, everywhere: true }, set_session);
    }
}

/// Opens a worktree, and the worktree of the same name in each other repository of the
/// workspace on that machine, so their tabs can follow it. The one asked for opens last.
fn open_with_namesakes(app: &mut App, w: Worktree, from: Tab) {
    let label = worktree_label(&w);
    let workspace = app.session.workspace.clone();
    let others: Vec<String> = app
        .session
        .tabs
        .iter()
        .filter(|t| t.id != from.id && t.host == from.host && t.workspaces.contains(&workspace))
        .map(|t| t.id.clone())
        .collect();
    let mut known: Vec<String> =
        app.session.tabs.iter().filter(|t| t.host == from.host).map(|t| t.path.clone()).collect();
    let host = from.host.clone().unwrap_or_default();
    let remote = host.clone();
    let work = move || {
        let lists: Vec<Vec<Worktree>> = std::thread::scope(|s| {
            let handles: Vec<_> = others
                .iter()
                .map(|id| s.spawn(move || api::call::<WorktreeList>(Request::Worktrees { id: id.clone() })))
                .collect();
            handles.into_iter().filter_map(|h| h.join().ok()?.ok()).map(|l| l.worktrees).collect()
        });
        for x in lists.into_iter().flatten() {
            if x.main || x.prunable || worktree_label(&x) != label || same_path(&x.path, &w.path) {
                continue;
            }
            if known.iter().any(|p| same_path(p, &x.path)) {
                continue;
            }
            known.push(x.path.clone());
            let req = Request::Open { path: x.path, host: remote.clone(), want_id: None };
            if let Err(e) = api::call::<Value>(req) {
                eprintln!("gitc: could not open a namesake worktree: {e}");
            }
        }
        w.path
    };
    app.jobs.run(work, move |app, path: String| app.open(&path, &host));
}

/// A confirmation that runs one operation on the tab it was asked about.
fn confirm_op(
    app: &mut App,
    id: &str,
    title: impl Into<String>,
    body: impl Into<String>,
    label: impl Into<String>,
    destructive: bool,
    args: OpArgs,
) {
    let tab = id.to_string();
    let mut confirm = Confirm::new(title, body, label, move |app| run_on(app, &tab, args));
    confirm.destructive = destructive;
    confirm.tab_id = Some(id.to_string());
    app.overlay.confirm(confirm);
}

/// A one-field prompt whose answer becomes one operation on the tab it was asked about.
fn prompt_op(
    id: &str,
    title: &str,
    confirm_label: &str,
    validate: Validate,
    make: impl FnOnce(String) -> Option<OpArgs> + 'static,
) -> Prompt {
    let tab = id.to_string();
    let mut prompt = Prompt::new(title, confirm_label, move |app, value| {
        if let Some(args) = make(value) {
            run_on(app, &tab, args);
        }
    });
    prompt.validate = Some(validate);
    prompt
}

fn remote_branch_check(remotes: Vec<String>) -> Validate {
    Box::new(move |value| match split_remote_branch(value, &remotes) {
        Some((_, name)) => validate_ref_name(&name),
        None => {
            let starts: Vec<String> = remotes.iter().map(|r| format!("{r}/")).collect();
            Some(format!("Start with a remote: {}", starts.join(", ")))
        }
    })
}

/// "origin/topic" as its remote and branch, when a known remote starts it.
fn split_remote_branch(value: &str, remotes: &[String]) -> Option<(String, String)> {
    let v = value.trim();
    remotes.iter().find_map(|r| Some((r.clone(), v.strip_prefix(r.as_str())?.strip_prefix('/')?.to_string())))
}

fn remotes_of(app: &App, id: &str) -> Vec<String> {
    app.repos.get(id).and_then(|r| r.data.as_ref()).map(|d| d.remotes.clone()).unwrap_or_default()
}

fn save_ai(app: &mut App, config: AiConfig) {
    app.ai = Some(config.clone());
    app.jobs.request(Request::SaveAi { config }, |app, result: Result<AiConfig, String>| match result {
        Ok(config) => app.ai = Some(config),
        Err(e) => {
            eprintln!("gitc: saving the AI settings failed: {e}");
            app.jobs.request(Request::Ai, |app, result: Result<AiConfig, String>| app.ai = result.ok());
        }
    });
}

fn set_session(app: &mut App, result: Result<Session, String>) {
    match result {
        Ok(session) => app.set_session(session),
        Err(e) => app.toasts.error(&e),
    }
}

/// Where closing a worktree's tab should land: its repository's main working tree, open on the same machine.
fn main_tab_of(tabs: &[Tab], from: &Tab, worktrees: &[Worktree]) -> Option<String> {
    let main = worktrees.iter().find(|w| w.main).filter(|w| !w.current)?;
    tabs.iter().find(|t| t.id != from.id && t.host == from.host && same_path(&t.path, &main.path)).map(|t| t.id.clone())
}

/// The first-parent walk from `newer` down to `older`, both included; None when `older` is not on it.
fn chain_between<'a>(by_hash: &HashMap<&'a str, &'a Commit>, newer: &'a str, older: &str) -> Option<Vec<&'a str>> {
    let mut chain = Vec::new();
    let mut cursor = newer;
    for _ in 0..=by_hash.len() {
        chain.push(cursor);
        if cursor == older {
            return Some(chain);
        }
        cursor = by_hash.get(cursor)?.parents.first()?.as_str();
    }
    None
}

fn locked_line(w: &Worktree) -> String {
    if w.lock_reason.is_empty() { "It is locked.".into() } else { format!("It is locked: {}.", w.lock_reason) }
}

fn failed(app: &mut App, message: String) {
    app.update_progress = Some(progress("failed", &message));
    app.updating = false;
}

fn progress(phase: &str, message: &str) -> UpdateProgress {
    UpdateProgress { phase: phase.into(), received: 0, total: 0, message: message.into() }
}

fn op(name: &str) -> OpArgs {
    OpArgs { op: name.to_string(), ..Default::default() }
}

fn short(hash: &str) -> &str {
    hash.get(..7).unwrap_or(hash)
}

fn norm_path(p: &str) -> String {
    let s = p.replace('\\', "/");
    let s = s.trim_end_matches('/');
    let drive = s.as_bytes().get(1) == Some(&b':') && s.as_bytes().first().is_some_and(u8::is_ascii_alphabetic);
    if drive { s.to_lowercase() } else { s.to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ref_names() {
        assert_eq!(validate_ref_name(""), None);
        assert_eq!(validate_ref_name("feature/login"), None);
        assert!(validate_ref_name("-x").is_some());
        assert!(validate_ref_name("a/").is_some());
        assert!(validate_ref_name("x.lock").is_some());
        assert!(validate_ref_name("a..b").is_some());
        assert!(validate_ref_name("a b").is_some());
        assert!(validate_ref_name("a\\b").is_some());
        assert!(validate_remote_name("a/b").is_some());
        assert!(validate_remote_url("http://x y").is_some());
        assert_eq!(validate_remote_url("git@host:me/repo.git"), None);
    }

    #[test]
    fn remote_branches() {
        let remotes = vec!["origin".to_string(), "up".to_string()];
        assert_eq!(split_remote_branch(" origin/main ", &remotes), Some(("origin".into(), "main".into())));
        assert_eq!(split_remote_branch("upstream/main", &remotes), None);
        assert!(remote_branch_check(remotes.clone())("main").is_some());
        assert!(remote_branch_check(remotes)("up/a b").is_some());
    }

    #[test]
    fn worktree_helpers() {
        assert_eq!(wip_worktree("WIP:agent"), Some("agent"));
        assert_eq!(wip_worktree("WIP"), None);
        assert!(is_wip("WIP") && is_wip("WIP:x") && !is_wip("abc"));
        assert!(same_path("C:\\Code\\x\\", "c:/code/x"));
        assert!(!same_path("/home/A", "/home/a"));
        let w = Worktree { name: "n".into(), path: "C:\\Code\\agent-7\\".into(), ..Default::default() };
        assert_eq!(worktree_label(&w), "agent-7");
    }

    #[test]
    fn chains() {
        let c = |h: &str, p: &str| Commit { hash: h.into(), parents: vec![p.into()], ..Default::default() };
        let commits = [c("c", "b"), c("b", "a"), c("a", "")];
        let by_hash: HashMap<&str, &Commit> = commits.iter().map(|c| (c.hash.as_str(), c)).collect();
        assert_eq!(chain_between(&by_hash, "c", "a"), Some(vec!["c", "b", "a"]));
        assert_eq!(chain_between(&by_hash, "b", "c"), None);
    }
}
