use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use super::git::{now_ms, read_status_with};
use super::refs::{absolute, common_dir, git_dir, read_head_of, read_pending_of};
use super::types::{WorkingFile, Worktree};

const OTHER_STATUS_MS: u64 = 4000;

struct Located {
    name: String,
    admin: PathBuf,
    path: PathBuf,
    main: bool,
}

static STATUS_CACHE: Mutex<Option<HashMap<String, (u64, Vec<WorkingFile>)>>> = Mutex::new(None);

/// Every worktree of the repository `repo` belongs to, main first, the rest by name. Reads .git only.
pub fn list_worktrees(repo: &str) -> Vec<Worktree> {
    let own = git_dir(repo);
    let now = now_ms() as i64;
    locate(repo)
        .into_iter()
        .map(|w| {
            let head = read_head_of(&w.admin);
            let lock_file = w.admin.join("locked");
            let locked = !w.main && lock_file.exists();
            let touched = mtime_ms(&w.admin.join("HEAD")).max(mtime_ms(&w.admin.join("index")));
            Worktree {
                name: w.name,
                path: w.path.to_string_lossy().into_owned(),
                main: w.main,
                current: same(&w.admin, &own),
                branch: head.branch,
                hash: head.hash,
                detached: head.detached,
                locked,
                lock_reason: if locked { read_trimmed(&lock_file) } else { String::new() },
                prunable: !w.main && !w.path.exists(),
                pending: read_pending_of(&w.admin).kind,
                idle_ms: if touched == 0 { -1 } else { (now - touched).max(0) },
                status: Vec::new(),
            }
        })
        .collect()
}

/// A live worktree by the name `list_worktrees` gave it; never joins the name onto a path.
pub fn find_worktree(repo: &str, name: &str) -> Option<Worktree> {
    list_worktrees(repo).into_iter().find(|w| w.name == name && !w.prunable)
}

/// Two spellings of one directory (case-insensitive on Windows, slashes either way).
/// Another worktree's files, read without taking its index lock, cached for a few seconds.
pub fn worktree_status(path: &str) -> Result<Vec<WorkingFile>, String> {
    let now = now_ms();
    if let Ok(cache) = STATUS_CACHE.lock() {
        if let Some((at, files)) = cache.as_ref().and_then(|c| c.get(path)) {
            if now.saturating_sub(*at) < OTHER_STATUS_MS {
                return Ok(files.clone());
            }
        }
    }
    let files = read_status_with(path, true)?;
    if let Ok(mut cache) = STATUS_CACHE.lock() {
        cache.get_or_insert_with(HashMap::new).insert(path.to_string(), (now, files.clone()));
    }
    Ok(files)
}

/// Statuses of every other live worktree by name, read concurrently; failures are left out.
pub fn other_statuses(worktrees: &[Worktree]) -> HashMap<String, Vec<WorkingFile>> {
    std::thread::scope(|scope| {
        let jobs: Vec<_> = worktrees
            .iter()
            .filter(|w| !w.current && !w.prunable)
            .map(|w| (w.name.clone(), scope.spawn(|| worktree_status(&w.path))))
            .collect();
        jobs.into_iter().filter_map(|(name, job)| Some((name, job.join().ok()?.ok()?))).collect()
    })
}

/// Runs `act` with git's record of worktree `name` pointing where it really is on this machine,
/// putting the old record back if `act` fails.
pub fn as_registered_here<T, E>(repo: &str, name: &str, act: impl FnOnce() -> Result<T, E>) -> Result<T, E> {
    let Some(w) = locate(repo).into_iter().find(|x| x.name == name && !x.main) else { return act() };
    let record = w.admin.join("gitdir");
    let before = read_trimmed(&record);
    let recorded = parent(&absolute(&w.admin.join(&before)));
    if same(&recorded, &w.path) || !points_back(&w.path, &w.admin) {
        return act();
    }
    let real = w.path.join(".git").to_string_lossy().replace('\\', "/");
    if let Err(e) = fs::write(&record, format!("{real}\n")) {
        eprintln!("gitc: cannot rewrite {}: {e}", record.display());
        return act();
    }
    let result = act();
    if result.is_err() && w.admin.exists() {
        let _ = fs::write(&record, format!("{before}\n"));
    }
    result
}

fn locate(repo: &str) -> Vec<Located> {
    let common = common_dir(repo);
    let mut out = Vec::new();
    if common.file_name().is_some_and(|n| n == ".git") {
        out.push(Located { name: String::new(), admin: common.clone(), path: parent(&common), main: true });
    }
    let Ok(entries) = fs::read_dir(common.join("worktrees")) else { return out };
    let mut names: Vec<String> = entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    for name in names {
        let admin = common.join("worktrees").join(&name);
        let pointer = read_trimmed(&admin.join("gitdir"));
        if pointer.is_empty() {
            continue;
        }
        let recorded = parent(&absolute(&admin.join(&pointer)));
        let path = relocate(&recorded, &admin, &common);
        out.push(Located { name, admin, path, main: false });
    }
    out
}

/// A worktree registered from another machine: try the recorded path's tails under the common dir
/// and its ancestors, accepting one only when its .git leads back to this admin directory.
fn relocate(recorded: &Path, admin: &Path, common: &Path) -> PathBuf {
    if recorded.exists() {
        return recorded.to_path_buf();
    }
    let text = recorded.to_string_lossy();
    let parts: Vec<&str> = text.split(['\\', '/']).filter(|p| !p.is_empty()).collect();
    for cut in 1..parts.len() {
        let tail = parts.get(cut..).unwrap_or_default().join("/");
        for base in common.ancestors() {
            let candidate = base.join(&tail);
            if points_back(&candidate, admin) {
                return candidate;
            }
        }
    }
    recorded.to_path_buf()
}

fn points_back(tree: &Path, admin: &Path) -> bool {
    let line = read_trimmed(&tree.join(".git"));
    let Some(target) = line.strip_prefix("gitdir:") else { return false };
    same(&absolute(&tree.join(target.trim())), admin)
}

fn same(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| {
        let s = absolute(p).to_string_lossy().replace('\\', "/");
        let s = s.trim_end_matches('/').to_string();
        if cfg!(windows) { s.to_lowercase() } else { s }
    };
    norm(a) == norm(b)
}

fn parent(path: &Path) -> PathBuf {
    path.parent().map(Path::to_path_buf).unwrap_or_else(|| path.to_path_buf())
}

fn read_trimmed(path: &Path) -> String {
    fs::read_to_string(path).map(|s| s.trim().to_string()).unwrap_or_default()
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
    use crate::engine::refs::{read_head, read_refs, read_remotes};
    use std::process::Command;

    fn run(cwd: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output();
        out.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default()
    }

    fn rewrite(path: &Path, text: &str) {
        let _ = fs::remove_file(path);
        let _ = fs::write(path, text);
    }

    #[test]
    fn real_linked_worktrees() {
        let root = std::env::temp_dir().join(format!("gitc-worktrees-test-{}", now_ms()));
        let _ = fs::create_dir_all(&root);
        let root = fs::canonicalize(&root)
            .map(|p| PathBuf::from(p.to_string_lossy().trim_start_matches(r"\\?\")))
            .unwrap_or(root);
        let main = root.join("main");
        let s = |p: &Path| p.to_string_lossy().into_owned();
        run(&root, &["init", "-q", "-b", "master", "main"]);
        run(&main, &["commit", "-q", "--allow-empty", "-m", "first"]);
        run(&main, &["branch", "topic"]);
        run(&main, &["remote", "add", "origin", "https://example.invalid/r.git"]);
        run(&main, &["pack-refs", "--all"]);
        run(&main, &["worktree", "add", "-q", &s(&root.join("agent")), "topic"]);
        run(&main, &["worktree", "add", "-q", "--detach", &s(&root.join("loose")), "master"]);
        run(&main, &["worktree", "add", "-q", "-b", "gone", &s(&root.join("gone"))]);
        run(&main, &["worktree", "lock", "--reason", "agent at work", &s(&root.join("loose"))]);
        let tip = run(&main, &["rev-parse", "HEAD"]);
        let agent = root.join("agent");
        let (main_s, agent_s) = (s(&main), s(&agent));

        assert!(same(&git_dir(&agent_s), &main.join(".git").join("worktrees").join("agent")));
        assert!(same(&common_dir(&agent_s), &main.join(".git")));
        assert!(same(&common_dir(&main_s), &main.join(".git")));
        let shorts = |r: &str| {
            let mut v: Vec<String> = read_refs(r).into_iter().map(|r| r.short).collect();
            v.sort();
            v
        };
        assert_eq!(shorts(&agent_s), shorts(&main_s));
        let head = read_head(&agent_s);
        assert_eq!((head.branch.as_deref(), head.hash.as_deref()), (Some("topic"), Some(tip.as_str())));
        assert_eq!(read_remotes(&agent_s).remotes, ["origin"]);

        let dot_git = agent.join(".git");
        let pointer = read_trimmed(&dot_git);
        let absolute_ptr = pointer.trim_start_matches("gitdir:").trim().to_string();
        rewrite(&dot_git, "gitdir: ../main/.git/worktrees/agent\n");
        assert_eq!(read_head(&agent_s).hash.as_deref(), Some(tip.as_str()));

        let _ = fs::remove_dir_all(root.join("gone"));
        let seen: Vec<(String, bool, bool, Option<String>, bool, bool, String, bool)> = list_worktrees(&agent_s)
            .into_iter()
            .map(|w| (w.name, w.main, w.current, w.branch, w.detached, w.locked, w.lock_reason, w.prunable))
            .collect();
        assert_eq!(
            seen,
            vec![
                ("".into(), true, false, Some("master".into()), false, false, "".into(), false),
                ("agent".into(), false, true, Some("topic".into()), false, false, "".into(), false),
                ("gone".into(), false, false, Some("gone".into()), false, false, "".into(), true),
                ("loose".into(), false, false, None, true, true, "agent at work".into(), false),
            ]
        );

        let admin_gitdir = main.join(".git").join("worktrees").join("agent").join("gitdir");
        let recorded = fs::read_to_string(&admin_gitdir).unwrap_or_default();
        rewrite(&admin_gitdir, "/elsewhere/mount/agent/.git\n");
        let moved = find_worktree(&main_s, "agent");
        assert!(moved.is_some_and(|w| same(Path::new(&w.path), Path::new(&agent_s))));
        rewrite(&dot_git, "gitdir: /elsewhere/mount/main/.git/worktrees/agent\n");
        assert!(find_worktree(&main_s, "agent").is_none());
        rewrite(&dot_git, &format!("gitdir: {absolute_ptr}\n"));
        rewrite(&admin_gitdir, &recorded);

        let current: Vec<bool> = list_worktrees(&main_s).into_iter().map(|w| w.current).collect();
        assert_eq!(current, [true, false, false, false]);
        assert!(find_worktree(&main_s, "agent").is_some());
        assert_eq!(find_worktree(&agent_s, "").map(|w| w.main), Some(true));
        assert!(find_worktree(&main_s, "../agent").is_none());
        assert!(find_worktree(&main_s, &agent_s).is_none());
        assert!(find_worktree(&main_s, "gone").is_none());

        let _ = fs::write(agent.join("note.txt"), "x");
        let files: Vec<String> = worktree_status(&agent_s).unwrap_or_default().into_iter().map(|f| f.path).collect();
        assert_eq!(files, ["note.txt"]);
        let _ = fs::remove_dir_all(&root);
    }
}
