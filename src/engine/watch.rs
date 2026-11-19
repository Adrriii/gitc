use std::collections::HashMap;
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Component, Path};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use notify::event::{AccessKind, AccessMode};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use super::git::{git, now_ms};
use super::refs::{common_dir, git_dir};
use super::worktrees::{list_worktrees, other_statuses};

const CACHE_MS: u64 = 900;
const RECHECK_MS: u64 = 30_000;
const IDLE_DROP_MS: u64 = 300_000;
const MARKERS: [&str; 5] = ["index", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge"];

struct Tree {
    watcher: Option<RecommendedWatcher>,
    dirty: Arc<AtomicBool>,
    used: u64,
    key: String,
    text: String,
    at: u64,
}

#[derive(Default)]
struct State {
    trees: HashMap<String, Tree>,
    cache: HashMap<String, (u64, String)>,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

/// A value that moves whenever the repository does: HEAD, index, refs, in-progress markers,
/// working-tree edits and other worktrees. Cheap enough to poll every second per tab:
/// .git is stat'ed, and `git status` only reruns when a file-system event says the tree changed.
pub fn fingerprint(repo: &str) -> Result<String, String> {
    let now = now_ms();
    if let Some(value) =
        with_state(|s| s.cache.get(repo).filter(|(at, _)| now.saturating_sub(*at) < CACHE_MS).map(|(_, v)| v.clone()))
            .flatten()
    {
        return Ok(value);
    }

    let dir = git_dir(repo);
    let common = common_dir(repo);
    let mut text = fs::read_to_string(dir.join("HEAD")).map(|h| h.trim().to_string()).unwrap_or_default();
    text.push('|');
    for name in MARKERS {
        text.push_str(&format!("{name}={};", mtime_ms(&dir.join(name))));
    }
    text.push_str(&format!("packed-refs={};", mtime_ms(&common.join("packed-refs"))));
    refs_fingerprint(&common.join("refs"), 0, &mut text);

    let worktrees = list_worktrees(repo);
    let others = std::thread::scope(|scope| {
        let others = scope.spawn(|| other_statuses(&worktrees));
        text.push_str(&tree_text(repo, &text.clone()));
        others.join().unwrap_or_default()
    });
    for w in worktrees.iter().filter(|w| !w.current) {
        text.push_str(&format!("wt:{}={:?},{:?},{},{},{};", w.name, w.hash, w.branch, w.pending, w.locked, w.prunable));
        for f in others.get(&w.name).into_iter().flatten() {
            let at = mtime_ms(&Path::new(&w.path).join(&f.path));
            text.push_str(&format!("{}:{}{}{}@{at};", w.name, f.index, f.worktree, f.path));
        }
    }

    let mut h = DefaultHasher::new();
    text.hash(&mut h);
    let value = format!("{:016x}", h.finish());
    with_state(|s| s.cache.insert(repo.to_string(), (now, value.clone())));
    Ok(value)
}

/// When this repository last fetched (FETCH_HEAD's mtime, per worktree or shared), in ms; 0 if never.
pub fn last_fetch(repo: &str) -> i64 {
    mtime_ms(&git_dir(repo).join("FETCH_HEAD")).max(mtime_ms(&common_dir(repo).join("FETCH_HEAD")))
}

/// The working tree's part: `git status` plus the mtimes of the files it names,
/// recomputed only when the watcher saw an edit, `key` (the .git part) moved, or a while has passed.
fn tree_text(repo: &str, key: &str) -> String {
    let now = now_ms();
    let fresh = with_state(|s| {
        s.trees.retain(|path, t| path == repo || now.saturating_sub(t.used) < IDLE_DROP_MS);
        let tree = s.trees.entry(repo.to_string()).or_insert_with(|| watch(repo));
        tree.used = now;
        let edited = tree.dirty.swap(false, Ordering::AcqRel);
        let stale = tree.watcher.is_none() || edited || tree.key != key || now.saturating_sub(tree.at) > RECHECK_MS;
        (!stale).then(|| tree.text.clone())
    })
    .flatten();
    if let Some(text) = fresh {
        return text;
    }

    let status = git(repo, &["--no-optional-locks", "status", "--porcelain=v1", "-z", "-uall"])
        .unwrap_or_else(|_| "status-failed".to_string());
    let mut text = status.clone();
    for entry in status.split('\0') {
        let Some(file) = entry.get(3..).filter(|f| !f.is_empty()) else { continue };
        text.push_str(&format!("{file}@{};", mtime_ms(&Path::new(repo).join(file))));
    }
    with_state(|s| {
        if let Some(tree) = s.trees.get_mut(repo) {
            tree.key = key.to_string();
            tree.text = text.clone();
            tree.at = now;
        }
    });
    text
}

fn watch(repo: &str) -> Tree {
    let dirty = Arc::new(AtomicBool::new(true));
    let flag = dirty.clone();
    let handler = move |res: notify::Result<Event>| match res {
        Ok(ev) if !matters(&ev) => {}
        _ => flag.store(true, Ordering::Release),
    };
    let watcher = notify::recommended_watcher(handler).ok().and_then(|mut w| {
        match w.watch(Path::new(repo), RecursiveMode::Recursive) {
            Ok(()) => Some(w),
            Err(e) => {
                eprintln!("gitc: cannot watch {repo}, polling git status instead: {e}");
                None
            }
        }
    });
    Tree { watcher, dirty, used: 0, key: String::new(), text: String::new(), at: 0 }
}

fn matters(ev: &Event) -> bool {
    match ev.kind {
        EventKind::Access(AccessKind::Close(AccessMode::Write)) => {}
        EventKind::Access(_) => return false,
        _ => {}
    }
    ev.paths.is_empty() || ev.paths.iter().any(|p| !p.components().any(|c| c == Component::Normal(".git".as_ref())))
}

fn refs_fingerprint(dir: &Path, depth: usize, out: &mut String) {
    if depth > 4 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_type().is_ok_and(|t| t.is_dir()) {
            refs_fingerprint(&path, depth + 1, out);
            continue;
        }
        out.push_str(&format!("{}:{};", path.display(), mtime_ms(&path)));
    }
}

fn with_state<T>(f: impl FnOnce(&mut State) -> T) -> Option<T> {
    let mut slot = STATE.lock().ok()?;
    Some(f(slot.get_or_insert_with(State::default)))
}

fn mtime_ms(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::time::Duration;

    #[test]
    fn edits_move_the_fingerprint() {
        let root = std::env::temp_dir().join(format!("gitc-watch-test-{}", now_ms()));
        let _ = fs::create_dir_all(&root);
        let repo = root.to_string_lossy().into_owned();
        let git = |args: &[&str]| {
            let _ = Command::new("git")
                .args(args)
                .current_dir(&root)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output();
        };
        let settle = || std::thread::sleep(Duration::from_millis(CACHE_MS + 300));
        git(&["init", "-q", "-b", "master"]);
        let _ = fs::write(root.join("a.txt"), "1");
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "first"]);

        let base = fingerprint(&repo).unwrap_or_default();
        settle();
        assert_eq!(fingerprint(&repo).unwrap_or_default(), base, "stable when nothing changes");

        let _ = fs::write(root.join("a.txt"), "2");
        settle();
        let edited = fingerprint(&repo).unwrap_or_default();
        assert_ne!(edited, base, "a working-tree edit");

        let _ = fs::write(root.join("a.txt"), "3 and longer");
        settle();
        let again = fingerprint(&repo).unwrap_or_default();
        assert_ne!(again, edited, "a second edit to a modified file");

        git(&["add", "a.txt"]);
        settle();
        let staged = fingerprint(&repo).unwrap_or_default();
        assert_ne!(staged, again, "staging");

        git(&["branch", "topic"]);
        settle();
        assert_ne!(fingerprint(&repo).unwrap_or_default(), staged, "a new ref");

        assert_eq!(last_fetch(&repo), 0);
        let _ = fs::remove_dir_all(&root);
    }
}
