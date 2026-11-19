use std::time::{Duration, Instant};

use crate::engine::api::{DEFAULT_LIMIT, Request};
use crate::engine::types::{ConflictState, DiffTarget, GraphPayload, Submodule, Watch};

use super::{App, conflict_panel, diff_view, graph, merge_editor, panel, sidebar};

pub const DEEP_LIMIT: usize = 50_000;
const WATCH_EVERY: Duration = Duration::from_millis(1000);

pub struct OpenFile {
    pub path: String,
    pub target: DiffTarget,
    pub label: String,
}

/// Everything the window holds about one open repository tab.
pub struct Repo {
    pub data: Option<GraphPayload>,
    /// The data on screen is from before the last change and a reload is on its way.
    pub stale: bool,
    pub loading: bool,
    pub error: Option<String>,
    pub selected: Vec<String>,
    pub anchor: Option<String>,
    pub open_file: Option<OpenFile>,
    pub conflicts: Option<ConflictState>,
    pub merge_file: Option<String>,
    pub submodules: Option<Vec<Submodule>>,
    pub limit: usize,
    /// An operation is running; buttons that start another stay disabled.
    pub busy: bool,
    /// A commit the graph should scroll to and select, once.
    pub reveal: Option<String>,
    /// Bumped on every reload, so views holding derived data know to recompute.
    pub version: u64,
    /// Fingerprint the engine last reported, and when the last fetch landed (ms since epoch).
    pub watch_version: String,
    pub fetched_at: i64,
    pub checked_at: Option<Instant>,
    pub last_fetch_attempt: Option<Instant>,
    pub graph: graph::State,
    pub sidebar: sidebar::State,
    pub panel: panel::State,
    pub diff: diff_view::State,
    pub merge: merge_editor::State,
    pub conflict: conflict_panel::State,
    reload_wanted: bool,
    watching: bool,
    last_watch: Option<Instant>,
    last_head: Option<String>,
    last_selected: Vec<String>,
}

impl Repo {
    pub fn new() -> Repo {
        Repo {
            data: None,
            stale: false,
            loading: false,
            error: None,
            selected: Vec::new(),
            anchor: None,
            open_file: None,
            conflicts: None,
            merge_file: None,
            submodules: None,
            limit: DEFAULT_LIMIT,
            busy: false,
            reveal: None,
            version: 0,
            watch_version: String::new(),
            fetched_at: 0,
            checked_at: None,
            last_fetch_attempt: None,
            graph: graph::State::default(),
            sidebar: sidebar::State::default(),
            panel: panel::State::default(),
            diff: diff_view::State::default(),
            merge: merge_editor::State::default(),
            conflict: conflict_panel::State::default(),
            reload_wanted: true,
            watching: false,
            last_watch: None,
            last_head: None,
            last_selected: Vec::new(),
        }
    }

    /// Asks for the graph to be read again on the next frame.
    pub fn refresh(&mut self) {
        self.reload_wanted = true;
        if self.data.is_some() {
            self.stale = true;
        }
    }

    pub fn resolving(&self) -> bool {
        self.conflicts.as_ref().is_some_and(|c| !c.operation.is_empty())
    }

    /// Selects and scrolls to a commit, reading further back when it is not loaded yet.
    pub fn reveal_commit(&mut self, hash: &str) {
        if hash.is_empty() {
            return;
        }
        self.selected = vec![hash.to_string()];
        self.anchor = Some(hash.to_string());
        self.reveal = Some(hash.to_string());
        let loaded = self.data.as_ref().is_some_and(|d| d.commits.iter().any(|c| c.hash == hash));
        if !loaded && self.limit < DEEP_LIMIT {
            self.limit = DEEP_LIMIT;
            self.refresh();
        }
    }
}

/// Per-frame upkeep for the tab in front: reloads, the change watch, follow-up reads.
pub fn tick(app: &mut App, id: &str) {
    let Some(repo) = app.repos.get_mut(id) else { return };
    if repo.selected != repo.last_selected {
        repo.last_selected = repo.selected.clone();
        repo.open_file = None;
    }
    if repo.reload_wanted && !repo.loading {
        repo.reload_wanted = false;
        repo.loading = true;
        let req = Request::Graph { id: id.to_string(), limit: repo.limit };
        let tab = id.to_string();
        app.jobs.request(req, move |app, result: Result<GraphPayload, String>| loaded(app, &tab, result));
    }
    let due = repo.last_watch.is_none_or(|t| t.elapsed() >= WATCH_EVERY);
    if due && !repo.watching && repo.data.is_some() {
        repo.watching = true;
        repo.last_watch = Some(Instant::now());
        let tab = id.to_string();
        app.jobs.request(Request::Watch { id: id.to_string() }, move |app, result: Result<Watch, String>| {
            let Some(repo) = app.repos.get_mut(&tab) else { return };
            repo.watching = false;
            let Ok(watch) = result else { return };
            repo.checked_at = Some(Instant::now());
            repo.fetched_at = watch.fetched;
            if !repo.watch_version.is_empty() && repo.watch_version != watch.version {
                repo.refresh();
            }
            repo.watch_version = watch.version;
        });
    }
    if let Some(left) = repo.last_watch.map(|t| WATCH_EVERY.saturating_sub(t.elapsed())) {
        app.ctx.request_repaint_after(left.max(Duration::from_millis(50)));
    }
}

fn loaded(app: &mut App, id: &str, result: Result<GraphPayload, String>) {
    let Some(repo) = app.repos.get_mut(id) else { return };
    repo.loading = false;
    repo.stale = false;
    let data = match result {
        Ok(data) => data,
        Err(e) => {
            repo.error = Some(e.clone());
            app.toasts.error(&e);
            return;
        }
    };
    repo.error = None;
    repo.version += 1;
    let has_wip = !data.status.is_empty();
    let kept: Vec<String> =
        repo.selected.iter().filter(|h| *h == "WIP" || data.commits.iter().any(|c| &c.hash == *h)).cloned().collect();
    repo.selected = if repo.selected.iter().any(|h| h == "WIP") && has_wip {
        vec!["WIP".to_string()]
    } else if !kept.is_empty() {
        kept
    } else if has_wip {
        vec!["WIP".to_string()]
    } else {
        data.commits.first().map(|c| vec![c.hash.clone()]).unwrap_or_default()
    };
    let head = data.head.hash.clone();
    if let (Some(before), Some(now)) = (repo.last_head.as_ref(), head.as_ref()) {
        if before != now {
            repo.selected = vec![now.clone()];
            repo.anchor = Some(now.clone());
            repo.reveal = Some(now.clone());
        }
    }
    repo.last_head = head;
    let pending = data.pending.kind.clone();
    let declared = data.submodules.len();
    repo.data = Some(data);
    let tab = id.to_string();
    if pending.is_empty() {
        repo.conflicts = None;
        repo.merge_file = None;
    } else {
        app.jobs.request(Request::Conflicts { id: tab.clone() }, move |app, result: Result<ConflictState, String>| {
            let Some(repo) = app.repos.get_mut(&tab) else { return };
            repo.conflicts = result.ok();
        });
    }
    if declared > 0 {
        let tab = id.to_string();
        app.jobs.request(Request::Submodules { id: tab.clone() }, move |app, result: Result<SubmoduleList, String>| {
            let Some(repo) = app.repos.get_mut(&tab) else { return };
            repo.submodules = result.ok().map(|r| r.submodules);
        });
    }
}

#[derive(serde::Deserialize, Default)]
#[serde(default)]
struct SubmoduleList {
    submodules: Vec<Submodule>,
}
