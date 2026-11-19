use std::path::Path;

use super::git::{git, git_or_none};
use super::paths::need_in_repo;
use super::refs::git_dir;
use super::types::{ConflictFile, ConflictState, ConflictVersions, RebaseProgress, ResolvedFile};

/// Conflicted and already-resolved files, rebase progress and git's pending message.
/// `kind` is the pending operation; a conflict with none (a stash pop) reads as "unmerged".
pub fn read_conflict_state(repo: &str, kind: &str) -> Result<ConflictState, String> {
    let (raw, stash_list) = std::thread::scope(|s| {
        let stashes = s.spawn(|| git_or_none(repo, &["stash", "list"]));
        let raw = git(repo, &["status", "--porcelain=v1", "-z", "-uall"]);
        (raw, stashes.join().ok().flatten())
    });
    let raw = raw?;

    let mut conflicted = Vec::new();
    let mut resolved = Vec::new();
    let mut parts = raw.split('\0');
    while let Some(entry) = parts.next() {
        let (Some(code), Some(path)) = (entry.get(..2), entry.get(3..)) else {
            continue;
        };
        if path.is_empty() {
            continue;
        }
        if code.starts_with('R') || code.starts_with('C') {
            parts.next();
        }
        if let Some(kind) = conflict_kind(code) {
            let deletion = kind != "both-modified" && kind != "both-added";
            conflicted.push(ConflictFile { path: path.to_string(), kind: kind.to_string(), deletion });
        } else if !code.starts_with(' ') && !code.starts_with('?') {
            resolved.push(ResolvedFile { path: path.to_string(), status: code.get(..1).unwrap_or("").to_string() });
        }
    }

    let operation = if kind.is_empty() && !conflicted.is_empty() { "unmerged" } else { kind };
    let dir = git_dir(repo);
    let mut progress = if operation == "rebase" { rebase_progress(&dir) } else { None };
    if let Some(p) = progress.as_mut().filter(|p| !p.onto.is_empty()) {
        let named =
            git_or_none(repo, &["name-rev", "--name-only", "--refs=refs/heads/*", "--refs=refs/remotes/*", &p.onto])
                .unwrap_or_default();
        let named = named.trim();
        if !named.is_empty() && named != "undefined" {
            p.onto_name = named.to_string();
        }
    }

    let message = ["MERGE_MSG", "COMMIT_EDITMSG"]
        .iter()
        .find_map(|name| std::fs::read_to_string(dir.join(name)).ok())
        .map(|m| m.trim().to_string())
        .unwrap_or_default();
    let stashes = stash_list.map(|l| l.lines().filter(|l| !l.trim().is_empty()).count() as u64).unwrap_or(0);

    Ok(ConflictState { operation: operation.to_string(), conflicted, resolved, progress, message, stashes })
}

/// The base, ours and theirs stages of a conflicted file, plus the marked-up working copy.
pub fn read_conflict_versions(repo: &str, path: &str) -> Result<ConflictVersions, String> {
    let worktree = need_in_repo(repo, path)?;
    let stage = |n: u8| git_or_none(repo, &["show".to_string(), format!(":{n}:{path}")]);
    let (base, ours, theirs) = std::thread::scope(|s| {
        let base = s.spawn(|| stage(1));
        let theirs = s.spawn(|| stage(3));
        let ours = stage(2);
        (base.join().ok().flatten(), ours, theirs.join().ok().flatten())
    });
    let merged = std::fs::read(&worktree).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
    let has_nul = |s: &Option<String>| s.as_deref().is_some_and(|t| t.contains('\0'));
    Ok(ConflictVersions {
        path: path.to_string(),
        binary: has_nul(&ours) || has_nul(&theirs) || merged.contains('\0'),
        has_base: base.is_some(),
        has_ours: ours.is_some(),
        has_theirs: theirs.is_some(),
        base: base.unwrap_or_default(),
        ours: ours.unwrap_or_default(),
        theirs: theirs.unwrap_or_default(),
        merged,
    })
}

/// Writes the resolved content and stages it, which is what marks it resolved.
pub fn resolve_with_content(repo: &str, path: &str, content: &str) -> Result<(), String> {
    let full = need_in_repo(repo, path)?;
    std::fs::write(&full, content).map_err(|e| format!("cannot write {path}: {e}"))?;
    git(repo, &["add", "--", path]).map(drop)
}

/// Takes one side wholesale ("ours", "theirs"), or deletes the file ("delete").
pub fn resolve_with_side(repo: &str, path: &str, side: &str) -> Result<(), String> {
    need_in_repo(repo, path)?;
    if side == "delete" {
        return git(repo, &["rm", "-f", "--", path]).map(drop);
    }
    let flag = if side == "theirs" { "--theirs" } else { "--ours" };
    git(repo, &["checkout", flag, "--", path])?;
    git(repo, &["add", "--", path]).map(drop)
}

pub fn mark_all_resolved(repo: &str, paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    for path in paths {
        need_in_repo(repo, path)?;
    }
    let args: Vec<&str> = ["add", "--"].into_iter().chain(paths.iter().map(String::as_str)).collect();
    git(repo, &args).map(drop)
}

/// Puts a resolved file back into conflict.
pub fn unresolve(repo: &str, path: &str) -> Result<(), String> {
    need_in_repo(repo, path)?;
    git(repo, &["checkout", "-m", "--", path]).map(drop)
}

fn conflict_kind(code: &str) -> Option<&'static str> {
    Some(match code {
        "DD" => "both-deleted",
        "AU" => "added-by-us",
        "UD" => "deleted-by-them",
        "UA" => "added-by-them",
        "DU" => "deleted-by-us",
        "AA" => "both-added",
        "UU" => "both-modified",
        _ => return None,
    })
}

fn rebase_progress(dir: &Path) -> Option<RebaseProgress> {
    let (sub, current, total, subject) = if dir.join("rebase-merge").exists() {
        ("rebase-merge", "msgnum", "end", true)
    } else if dir.join("rebase-apply").exists() {
        ("rebase-apply", "next", "last", false)
    } else {
        return None;
    };
    let base = dir.join(sub);
    let read = |name: &str| std::fs::read_to_string(base.join(name)).map(|s| s.trim().to_string()).unwrap_or_default();
    let head_name = read("head-name");
    Some(RebaseProgress {
        current: read(current).parse().unwrap_or(0),
        total: read(total).parse().unwrap_or(0),
        subject: if subject { read("message").lines().next().unwrap_or("").to_string() } else { String::new() },
        branch: head_name.strip_prefix("refs/heads/").unwrap_or(&head_name).to_string(),
        onto: read("onto").chars().take(7).collect(),
        onto_name: String::new(),
    })
}
