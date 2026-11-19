use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use super::git::{is_repo, repo_root};
use super::paths::config_dir;
use super::types::{Session, Tab, Workspace};

pub const DEFAULT_WORKSPACE: &str = "default";
const MAX_RECENTS: usize = 30;

static SESSION: Mutex<Option<Session>> = Mutex::new(None);
static EPHEMERAL: AtomicBool = AtomicBool::new(false);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

pub fn snapshot() -> Session {
    locked(|s| s.clone())
}

/// Runs `f` on the live session and saves it afterwards.
pub fn with<T>(f: impl FnOnce(&mut Session) -> T) -> T {
    locked(|s| {
        let out = f(s);
        save(s);
        out
    })
}

pub fn find_tab(id: &str) -> Option<Tab> {
    locked(|s| s.tabs.iter().find(|t| t.id == id).cloned())
}

/// Opens the repository holding `path` as a tab, or brings forward the tab already showing it.
/// `want_id` is the id a caller (a remote client) has already chosen; it wins over any other.
pub fn open_repo(path: &str, want_id: Option<&str>) -> Option<Tab> {
    if !is_repo(path) {
        return None;
    }
    let resolved = repo_root(path).unwrap_or_else(|| path.to_string());
    let name = Path::new(&resolved).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let same = |t: &Tab| t.host.is_none() && t.path == resolved;
    Some(with(|s| {
        if let Some(existing) = s.tabs.iter().find(|t| same(t)).map(|t| t.id.clone()) {
            if let Some(want) = want_id.filter(|w| *w != existing) {
                s.tabs.retain(|o| same(o) || o.id != want);
                if let Some(t) = s.tabs.iter_mut().find(|t| same(t)) {
                    t.id = want.to_string();
                }
            }
            if let Some(t) = s.tabs.iter().find(|t| same(t)).cloned() {
                return bring_forward(s, t);
            }
        }
        let id = want_id.map(str::to_string).unwrap_or_else(|| fresh_id(s));
        s.tabs.retain(|t| t.id != id);
        let tab = Tab { id, name, path: resolved.clone(), host: None, workspaces: vec![s.workspace.clone()] };
        s.tabs.push(tab.clone());
        bring_forward(s, tab)
    }))
}

/// Adds a tab a remote engine opened, under the id both sides share, and brings it forward.
/// A tab already open for the same host and path is reused instead.
pub fn adopt_tab(tab: Tab) {
    with(|s| {
        let existing = s.tabs.iter().find(|t| t.host == tab.host && t.path == tab.path).cloned();
        let tab = match existing {
            Some(t) => t,
            None => {
                s.tabs.retain(|t| t.id != tab.id);
                let mut tab = tab;
                tab.workspaces.retain(|w| s.workspaces.iter().any(|x| x.id == *w));
                s.tabs.push(tab.clone());
                tab
            }
        };
        bring_forward(s, tab);
    });
}

/// Closes a tab in the current workspace; closed outright (and returned) when no other workspace holds it.
pub fn close_tab(s: &mut Session, id: &str, next: Option<&str>, everywhere: bool) -> Option<Tab> {
    let current = s.workspace.clone();
    let pos = s.tabs.iter().position(|t| t.id == id)?;
    let mut closed = None;
    if let Some(tab) = s.tabs.get_mut(pos) {
        let elsewhere: Vec<String> = tab.workspaces.iter().filter(|w| **w != current).cloned().collect();
        if !everywhere && !elsewhere.is_empty() {
            tab.workspaces = elsewhere;
        } else {
            closed = Some(s.tabs.remove(pos));
        }
    }
    if s.active_id.as_deref() == Some(id) {
        s.active_id = front_of(s, next);
    }
    closed
}

pub fn switch_workspace(s: &mut Session, id: &str) -> bool {
    let Some(target) = s.workspaces.iter().find(|w| w.id == id).map(|w| w.active_id.clone()) else { return false };
    let active = s.active_id.clone();
    let leaving = s.workspace.clone();
    if let Some(w) = s.workspaces.iter_mut().find(|w| w.id == leaving) {
        w.active_id = active;
    }
    s.workspace = id.to_string();
    s.active_id = front_of(s, target.as_deref());
    true
}

/// A new, empty workspace, which becomes the current one.
pub fn add_workspace(s: &mut Session, name: &str) {
    let mut n = s.workspaces.len() + 1;
    while s.workspaces.iter().any(|w| w.id == format!("w{n}")) {
        n += 1;
    }
    let id = format!("w{n}");
    s.workspaces.push(Workspace { id: id.clone(), name: name.to_string(), active_id: None });
    switch_workspace(s, &id);
}

pub fn rename_workspace(s: &mut Session, id: &str, name: &str) -> bool {
    let Some(w) = s.workspaces.iter_mut().find(|w| w.id == id) else { return false };
    w.name = name.to_string();
    true
}

/// Workspaces in the order given; any left out keep their place after it.
pub fn reorder_workspaces(s: &mut Session, order: &[String]) {
    s.workspaces = reordered(std::mem::take(&mut s.workspaces), order, |w| &w.id);
}

/// Deletes a workspace and returns the tabs only it held; None for an unknown or last workspace.
pub fn remove_workspace(s: &mut Session, id: &str) -> Option<Vec<Tab>> {
    if s.workspaces.len() <= 1 || !s.workspaces.iter().any(|w| w.id == id) {
        return None;
    }
    s.workspaces.retain(|w| w.id != id);
    let mut closed = Vec::new();
    for mut t in std::mem::take(&mut s.tabs) {
        t.workspaces.retain(|w| w != id);
        if t.workspaces.is_empty() {
            closed.push(t);
        } else {
            s.tabs.push(t);
        }
    }
    if s.workspace == id {
        if let Some(first) = s.workspaces.first().map(|w| w.id.clone()) {
            switch_workspace(s, &first);
        }
    } else {
        s.active_id = front_of(s, s.active_id.clone().as_deref());
    }
    Some(closed)
}

/// Chooses the workspaces a tab is in; unknown ids are dropped and at least one must remain.
pub fn set_tab_workspaces(s: &mut Session, id: &str, ids: &[String]) -> bool {
    let wanted: Vec<String> = ids.iter().filter(|i| s.workspaces.iter().any(|w| w.id == **i)).cloned().collect();
    if wanted.is_empty() {
        return false;
    }
    let Some(tab) = s.tabs.iter_mut().find(|t| t.id == id) else { return false };
    tab.workspaces = wanted;
    s.active_id = front_of(s, s.active_id.clone().as_deref());
    true
}

pub fn activate(s: &mut Session, id: &str) {
    s.active_id = Some(id.to_string());
    if let Some(tab) = s.tabs.iter().find(|t| t.id == id).cloned() {
        touch_recent(s, &tab);
    }
}

/// Tabs in the order given; any the order leaves out (opened meanwhile) follow.
pub fn reorder_tabs(s: &mut Session, order: &[String]) {
    s.tabs = reordered(std::mem::take(&mut s.tabs), order, |t| &t.id);
}

/// Keeps the session in memory only, for a `--stdio` engine serving another machine.
pub fn set_ephemeral() {
    EPHEMERAL.store(true, Ordering::Relaxed);
}

/// The tabs on the strip: the current workspace's, in session order.
pub fn shown_tabs(s: &Session) -> Vec<&Tab> {
    s.tabs.iter().filter(|t| t.workspaces.contains(&s.workspace)).collect()
}

/// Moves a repository to the front of the recent list, deduped by host and path.
pub fn touch_recent(s: &mut Session, tab: &Tab) {
    s.recents.retain(|r| r.path != tab.path || r.host != tab.host);
    s.recents.insert(0, tab.clone());
    s.recents.truncate(MAX_RECENTS);
}

/// Parses a saved session, repairing what older versions wrote; an empty session on any problem.
pub fn parse_session(text: &str) -> Session {
    let Ok(parsed) = serde_json::from_str::<Session>(text) else { return empty() };
    let workspaces = if parsed.workspaces.is_empty() { vec![default_workspace()] } else { parsed.workspaces };
    let known: HashSet<String> = workspaces.iter().map(|w| w.id.clone()).collect();
    let fallback = workspaces.first().map(|w| w.id.clone()).unwrap_or_else(|| DEFAULT_WORKSPACE.to_string());
    let current = if known.contains(&parsed.workspace) { parsed.workspace } else { fallback.clone() };
    let restore = |mut t: Tab| {
        t.workspaces.retain(|w| known.contains(w));
        if t.workspaces.is_empty() {
            t.workspaces.push(fallback.clone());
        }
        t
    };
    let tabs: Vec<Tab> = parsed.tabs.into_iter().map(restore).collect();
    let recents: Vec<Tab> = parsed.recents.into_iter().map(restore).collect();
    let mut session = Session {
        tabs: dedupe(tabs.into_iter().rev()).into_iter().rev().collect(),
        active_id: None,
        recents: dedupe(recents.into_iter()),
        workspaces,
        workspace: current,
    };
    session.active_id = front_of(&session, parsed.active_id.as_deref());
    session
}

fn locked<T>(f: impl FnOnce(&mut Session) -> T) -> T {
    let mut slot = SESSION.lock().unwrap_or_else(|e| e.into_inner());
    let session = slot.get_or_insert_with(load);
    f(session)
}

fn load() -> Session {
    let session = if EPHEMERAL.load(Ordering::Relaxed) {
        empty()
    } else {
        fs::read_to_string(state_path()).map(|t| parse_session(&t)).unwrap_or_else(|_| empty())
    };
    let highest = session.tabs.iter().filter_map(|t| t.id.strip_prefix('t')?.parse::<u64>().ok()).max();
    if let Some(n) = highest {
        NEXT_ID.fetch_max(n + 1, Ordering::Relaxed);
    }
    session
}

fn save(s: &Session) {
    if EPHEMERAL.load(Ordering::Relaxed) {
        return;
    }
    let path = state_path();
    let Ok(text) = serde_json::to_string(s) else { return };
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let tmp = path.with_extension("json.tmp");
    if let Err(e) = fs::write(&tmp, text).and_then(|()| fs::rename(&tmp, &path)) {
        eprintln!("gitc: cannot save the session: {e}");
    }
}

fn fresh_id(s: &Session) -> String {
    loop {
        let id = format!("t{}", NEXT_ID.fetch_add(1, Ordering::Relaxed));
        if !s.tabs.iter().any(|t| t.id == id) {
            return id;
        }
    }
}

fn state_path() -> PathBuf {
    config_dir().join("session.json")
}

fn bring_forward(s: &mut Session, mut tab: Tab) -> Tab {
    if !tab.workspaces.contains(&s.workspace) {
        tab.workspaces.push(s.workspace.clone());
    }
    if let Some(t) = s.tabs.iter_mut().find(|t| t.id == tab.id) {
        t.workspaces = tab.workspaces.clone();
    }
    s.active_id = Some(tab.id.clone());
    touch_recent(s, &tab);
    tab
}

fn front_of(s: &Session, wanted: Option<&str>) -> Option<String> {
    let shown = shown_tabs(s);
    let found = shown.iter().find(|t| Some(t.id.as_str()) == wanted).or(shown.first());
    found.map(|t| t.id.clone())
}

fn dedupe(tabs: impl Iterator<Item = Tab>) -> Vec<Tab> {
    let mut seen = HashSet::new();
    tabs.filter(|t| seen.insert(t.id.clone())).collect()
}

fn reordered<T>(items: Vec<T>, order: &[String], id: impl Fn(&T) -> &String) -> Vec<T> {
    let mut rest: Vec<Option<T>> = items.into_iter().map(Some).collect();
    let mut out = Vec::with_capacity(rest.len());
    for want in order {
        if let Some(slot) = rest.iter_mut().find(|x| x.as_ref().is_some_and(|x| id(x) == want)) {
            out.extend(slot.take());
        }
    }
    out.extend(rest.into_iter().flatten());
    out
}

fn default_workspace() -> Workspace {
    Workspace { id: DEFAULT_WORKSPACE.to_string(), name: "Default".to_string(), active_id: None }
}

fn empty() -> Session {
    Session {
        tabs: Vec::new(),
        active_id: None,
        recents: Vec::new(),
        workspaces: vec![default_workspace()],
        workspace: DEFAULT_WORKSPACE.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(tabs: Vec<&Tab>) -> Vec<String> {
        tabs.into_iter().map(|t| t.id.clone()).collect()
    }

    #[test]
    fn repairs_and_workspaces() {
        let text = r#"{
            "tabs": [
                { "id": "t4", "name": "dex", "path": "/main/dex", "host": null },
                { "id": "t7", "name": "old", "path": "/home/adri/deleted", "host": null },
                { "id": "t7", "name": "collector", "path": "/main/osu/farm/collector", "host": null }
            ],
            "activeId": "t7",
            "recents": [
                { "id": "t7", "name": "collector", "path": "/main/osu/farm/collector", "host": null },
                { "id": "t7", "name": "old", "path": "/home/adri/deleted", "host": null },
                { "id": "t4", "name": "dex", "path": "/main/dex", "host": null }
            ]
        }"#;
        let mut s = parse_session(text);
        assert_eq!(s.tabs.len(), 2);
        assert_eq!(s.tabs.iter().find(|t| t.id == "t7").map(|t| t.path.as_str()), Some("/main/osu/farm/collector"));
        assert_eq!(s.tabs.first().map(|t| t.path.as_str()), Some("/main/dex"));
        assert_eq!(s.recents.iter().find(|t| t.id == "t7").map(|t| t.path.as_str()), Some("/main/osu/farm/collector"));
        assert_eq!(s.recents.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["t7", "t4"]);
        assert_eq!(s.workspaces.iter().map(|w| w.id.as_str()).collect::<Vec<_>>(), ["default"]);
        assert_eq!(s.workspace, "default");
        assert!(s.tabs.iter().all(|t| t.workspaces == ["default"]));

        add_workspace(&mut s, "Work");
        let work = s.workspace.clone();
        assert_ne!(work, "default");
        assert!(shown_tabs(&s).is_empty());
        assert_eq!(s.active_id, None);

        assert!(set_tab_workspaces(&mut s, "t4", &["default".into(), work.clone()]));
        assert_eq!(ids(shown_tabs(&s)), ["t4"]);
        assert!(!set_tab_workspaces(&mut s, "t4", &["nowhere".into()]));

        switch_workspace(&mut s, "default");
        s.active_id = Some("t7".into());
        switch_workspace(&mut s, &work);
        assert_eq!(s.active_id.as_deref(), Some("t4"));

        reorder_workspaces(&mut s, &[work.clone(), "nowhere".into(), work.clone()]);
        assert_eq!(s.workspaces.iter().map(|w| w.id.clone()).collect::<Vec<_>>(), [work.clone(), "default".into()]);
        reorder_workspaces(&mut s, &["default".into(), work.clone()]);
        switch_workspace(&mut s, "default");
        assert_eq!(s.active_id.as_deref(), Some("t7"));

        assert_eq!(close_tab(&mut s, "t4", None, false), None);
        assert_eq!(s.tabs.iter().find(|t| t.id == "t4").map(|t| t.workspaces.clone()), Some(vec![work.clone()]));
        assert_eq!(ids(shown_tabs(&s)), ["t7"]);

        let closed = remove_workspace(&mut s, &work).unwrap_or_default();
        assert_eq!(closed.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["t4"]);
        assert_eq!(s.tabs.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["t7"]);
        assert_eq!(remove_workspace(&mut s, "default"), None);

        assert_eq!(close_tab(&mut s, "t7", None, false).map(|t| t.id), Some("t7".into()));
        assert_eq!(s.active_id, None);
    }

    #[test]
    fn deleted_workspace_falls_back() {
        let s = parse_session(
            r#"{"tabs":[{"id":"t1","name":"a","path":"/a","host":null,"workspaces":["gone"]}],"activeId":"t1",
               "recents":[],"workspaces":[{"id":"w2","name":"Mine","activeId":null}],"workspace":"w2"}"#,
        );
        assert_eq!(s.tabs.first().map(|t| t.workspaces.clone()), Some(vec!["w2".to_string()]));
        assert_eq!(s.active_id.as_deref(), Some("t1"));
        assert_eq!(parse_session("not json"), empty());
    }

    #[test]
    fn reorder_keeps_unmentioned() {
        let mut s = empty();
        for id in ["t1", "t2", "t3"] {
            s.tabs.push(Tab { id: id.into(), workspaces: vec![DEFAULT_WORKSPACE.into()], ..Tab::default() });
        }
        reorder_tabs(&mut s, &["t3".into(), "zz".into(), "t1".into()]);
        assert_eq!(s.tabs.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["t3", "t1", "t2"]);
    }
}
