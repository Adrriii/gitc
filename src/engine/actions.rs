use super::git::{git, git_or_none, git_with};
use super::paths::safe_argument;
use super::types::{CommitDone, Message};

pub fn stage_paths(repo: &str, paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    git(repo, &with_paths(&["add", "--"], paths)).map(drop)
}

pub fn stage_all(repo: &str) -> Result<(), String> {
    git(repo, &["add", "-A"]).map(drop)
}

/// Unstages paths, falling back to `rm --cached` on a repository with no commits yet.
pub fn unstage_paths(repo: &str, paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let args = if has_head(repo) {
        with_paths(&["reset", "-q", "HEAD", "--"], paths)
    } else {
        with_paths(&["rm", "--cached", "-r", "--"], paths)
    };
    git(repo, &args).map(drop)
}

pub fn unstage_all(repo: &str) -> Result<(), String> {
    let args: &[&str] = if has_head(repo) { &["reset", "-q", "HEAD"] } else { &["rm", "--cached", "-r", "."] };
    git(repo, args).map(drop)
}

/// Restores tracked files from HEAD and deletes untracked ones; the caller says which is which.
pub fn discard_paths(repo: &str, tracked: &[String], untracked: &[String]) -> Result<(), String> {
    if !tracked.is_empty() {
        git(repo, &with_paths(&["checkout", "HEAD", "--"], tracked))?;
    }
    if !untracked.is_empty() {
        git(repo, &with_paths(&["clean", "-fdq", "--"], untracked))?;
    }
    Ok(())
}

/// Commits the index with the message on stdin; an amend also moves the author date to now.
pub fn commit(repo: &str, summary: &str, description: &str, amend: bool) -> Result<CommitDone, String> {
    let mut args = vec!["commit", "-F", "-"];
    if amend {
        args.extend(["--amend", "--date=now"]);
    }
    let summary = summary.trim();
    let description = description.trim();
    let message = if description.is_empty() { format!("{summary}\n") } else { format!("{summary}\n\n{description}\n") };
    git_with(repo, &args, &[], Some(&message))?;
    let hash = git(repo, &["rev-parse", "HEAD"])?.trim().to_string();
    Ok(CommitDone { hash, summary: summary.to_string() })
}

pub fn head_message(repo: &str) -> Option<Message> {
    commit_message(repo, "HEAD")
}

/// A commit's message exactly as stored, trailers included.
pub fn commit_message(repo: &str, sha: &str) -> Option<Message> {
    let rev = safe_argument(sha, "commit").ok()?;
    let raw = git_or_none(repo, &["log", "-1", "--format=%B", rev, "--"])?.replace('\r', "");
    let (summary, rest) = raw.split_once('\n').unwrap_or((&raw, ""));
    Some(Message { summary: summary.to_string(), description: rest.trim().to_string() })
}

fn has_head(repo: &str) -> bool {
    git_or_none(repo, &["rev-parse", "--verify", "HEAD"]).is_some()
}

fn with_paths(head: &[&str], paths: &[String]) -> Vec<String> {
    head.iter().map(|s| s.to_string()).chain(paths.iter().cloned()).collect()
}
