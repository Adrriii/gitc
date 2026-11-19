use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use super::types::{Head, Pending, Ref, Remote};

#[derive(Debug, Clone, Default)]
pub struct RemoteInfo {
    pub remotes: Vec<String>,
    pub detail: Vec<Remote>,
    /// Upstream of each local branch, as "remote/branch".
    pub upstreams: BTreeMap<String, String>,
}

/// The directory of ONE working tree: HEAD, index, in-progress markers. Follows a `.git` file.
pub fn git_dir(repo: &str) -> PathBuf {
    let dot = Path::new(repo).join(".git");
    if dot.is_dir() {
        return dot;
    }
    let Ok(content) = fs::read_to_string(&dot) else { return dot };
    match content.trim().strip_prefix("gitdir:") {
        Some(target) => absolute(&Path::new(repo).join(target.trim())),
        None => dot,
    }
}

/// The directory every worktree of the repository shares: branches, tags, packed-refs, config.
pub fn common_dir(repo: &str) -> PathBuf {
    common_dir_of(&git_dir(repo))
}

pub fn common_dir_of(dir: &Path) -> PathBuf {
    let Ok(target) = fs::read_to_string(dir.join("commondir")) else { return dir.to_path_buf() };
    let target = target.trim();
    if target.is_empty() {
        return dir.to_path_buf();
    }
    absolute(&dir.join(target))
}

pub fn read_head(repo: &str) -> Head {
    read_head_of(&git_dir(repo))
}

/// `read_head` from a git directory, which is how another worktree's HEAD is read.
pub fn read_head_of(dir: &Path) -> Head {
    let Ok(raw) = fs::read_to_string(dir.join("HEAD")) else { return Head::default() };
    let raw = raw.trim();
    let Some(name) = raw.strip_prefix("ref: ") else {
        return Head { branch: None, hash: Some(raw.to_string()), detached: true };
    };
    let name = name.trim();
    let branch = name.strip_prefix("refs/heads/").unwrap_or(name).to_string();
    Head { branch: Some(branch), hash: resolve_ref(dir, name), detached: false }
}

/// The hash a full ref name points at, loose first, then packed.
pub fn resolve_ref(dir: &Path, name: &str) -> Option<String> {
    let common = common_dir_of(dir);
    if let Ok(loose) = fs::read_to_string(ref_home(dir, &common, name).join(name)) {
        return Some(loose.trim().to_string());
    }
    read_packed(&common).into_iter().find(|r| r.name == name).map(|r| r.hash)
}

/// Branches, remote branches and tags, loose shadowing packed, remote HEAD pointers left out.
pub fn read_refs(repo: &str) -> Vec<Ref> {
    let dir = common_dir(repo);
    let mut out = Vec::new();
    for family in ["heads", "remotes", "tags"] {
        walk_loose(&dir.join("refs").join(family), &format!("refs/{family}"), &mut out);
    }
    let seen: HashSet<String> = out.iter().map(|r| r.name.clone()).collect();
    out.extend(read_packed(&dir).into_iter().filter(|r| !seen.contains(&r.name)));
    out.retain(|r| !r.short.ends_with("/HEAD"));
    out
}

pub fn read_pending(repo: &str) -> Pending {
    read_pending_of(&git_dir(repo))
}

/// `read_pending` from a git directory; markers are per worktree.
pub fn read_pending_of(dir: &Path) -> Pending {
    let has = |name: &str| dir.join(name).exists();
    let kind = if has("rebase-merge") || has("rebase-apply") {
        "rebase"
    } else if has("CHERRY_PICK_HEAD") {
        "cherry-pick"
    } else if has("REVERT_HEAD") {
        "revert"
    } else if has("MERGE_HEAD") {
        "merge"
    } else if has("BISECT_LOG") {
        "bisect"
    } else {
        ""
    };
    Pending { kind: kind.to_string(), conflicted: false }
}

/// Remotes and branch upstreams, from the shared config.
pub fn read_remotes(repo: &str) -> RemoteInfo {
    let mut out = RemoteInfo::default();
    let Ok(text) = fs::read_to_string(common_dir(repo).join("config")) else { return out };
    parse_config(&text, &mut out);
    out
}

fn parse_config(text: &str, out: &mut RemoteInfo) {
    let mut section = String::new();
    let mut name = String::new();
    let mut branch_remote = String::new();
    let mut branch_merge = String::new();

    for raw in text.lines() {
        let line = raw.trim();
        if let Some(header) = line.strip_prefix('[') {
            flush_branch(out, &section, &name, &mut branch_remote, &mut branch_merge);
            let header = header.split(']').next().unwrap_or(header);
            match (header.find('"'), header.rfind('"')) {
                (Some(open), Some(close)) => {
                    section = header.get(..open).unwrap_or("").trim().to_string();
                    name = if close > open {
                        header.get(open + 1..close).unwrap_or("").to_string()
                    } else {
                        String::new()
                    };
                }
                _ => {
                    section = header.trim().to_string();
                    name.clear();
                }
            }
            if section == "remote" && !name.is_empty() && !out.remotes.contains(&name) {
                out.remotes.push(name.clone());
                out.detail.push(Remote { name: name.clone(), ..Remote::default() });
            }
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        let (key, value) = (key.trim(), value.trim());
        if section == "branch" {
            match key {
                "remote" => branch_remote = value.to_string(),
                "merge" => branch_merge = value.to_string(),
                _ => {}
            }
        }
        if section == "remote" && !name.is_empty() {
            for r in out.detail.iter_mut().filter(|r| r.name == name) {
                match key {
                    "url" => r.url = value.to_string(),
                    "pushurl" => r.push_url = value.to_string(),
                    _ => {}
                }
            }
        }
    }
    flush_branch(out, &section, &name, &mut branch_remote, &mut branch_merge);
}

fn flush_branch(out: &mut RemoteInfo, section: &str, name: &str, remote: &mut String, merge: &mut String) {
    if section == "branch" && !name.is_empty() && !remote.is_empty() {
        let short = merge.strip_prefix("refs/heads/").unwrap_or(merge);
        if !short.is_empty() {
            out.upstreams.insert(name.to_string(), format!("{remote}/{short}"));
        }
    }
    remote.clear();
    merge.clear();
}

fn ref_home(dir: &Path, common: &Path, name: &str) -> PathBuf {
    let own = ["refs/bisect/", "refs/worktree/", "refs/rewritten/"].iter().any(|p| name.starts_with(p));
    if own { dir.to_path_buf() } else { common.to_path_buf() }
}

fn classify(name: &str, hash: &str) -> Option<Ref> {
    let make = |short: &str, kind: &str, remote: Option<String>| Ref {
        name: name.to_string(),
        short: short.to_string(),
        hash: hash.to_string(),
        kind: kind.to_string(),
        remote,
    };
    if let Some(short) = name.strip_prefix("refs/heads/") {
        return Some(make(short, "local", None));
    }
    if let Some(rest) = name.strip_prefix("refs/remotes/") {
        let (remote, _) = rest.split_once('/')?;
        return Some(make(rest, "remote", Some(remote.to_string())));
    }
    let short = name.strip_prefix("refs/tags/")?;
    Some(make(short, "tag", None))
}

fn read_packed(common: &Path) -> Vec<Ref> {
    let Ok(text) = fs::read_to_string(common.join("packed-refs")) else { return Vec::new() };
    let mut out: Vec<Ref> = Vec::new();
    for line in text.lines() {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(peeled) = line.strip_prefix('^') {
            if let Some(prev) = out.last_mut().filter(|r| r.kind == "tag") {
                prev.hash = peeled.trim().to_string();
            }
            continue;
        }
        let Some((hash, name)) = line.split_once(' ') else { continue };
        out.extend(classify(name.trim(), hash));
    }
    out
}

fn walk_loose(dir: &Path, prefix: &str, out: &mut Vec<Ref>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let file = entry.file_name();
        let name = format!("{prefix}/{}", file.to_string_lossy());
        let path = entry.path();
        if path.is_dir() {
            walk_loose(&path, &name, out);
            continue;
        }
        let Ok(hash) = fs::read_to_string(&path) else { continue };
        out.extend(classify(&name, hash.trim()));
    }
}

/// Absolute and lexically normalized, like Node's `path.resolve`.
pub fn absolute(path: &Path) -> PathBuf {
    let full = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let mut out = PathBuf::new();
    for part in full.components() {
        match part {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upstreams_and_remotes() {
        let text = "[core]\n\tbare = false\n[remote \"origin\"]\n\turl = git@h:a/b.git\n\tpushurl = x\n\
                    [branch \"main\"]\n\tremote = origin\n\tmerge = refs/heads/main\n\
                    [branch \"feat/x\"]\n\tremote = origin\n\tmerge = refs/heads/feat/y\n[branch \"lonely\"]\n";
        let mut info = RemoteInfo::default();
        parse_config(text, &mut info);
        assert_eq!(info.remotes, ["origin"]);
        assert_eq!(info.detail.first().map(|r| (r.url.as_str(), r.push_url.as_str())), Some(("git@h:a/b.git", "x")));
        assert_eq!(info.upstreams.get("main").map(String::as_str), Some("origin/main"));
        assert_eq!(info.upstreams.get("feat/x").map(String::as_str), Some("origin/feat/y"));
        assert!(!info.upstreams.contains_key("lonely"));
    }

    #[test]
    fn classifies_refs() {
        assert_eq!(classify("refs/remotes/origin/a/b", "h").and_then(|r| r.remote), Some("origin".into()));
        assert!(classify("refs/remotes/orphan", "h").is_none());
        assert_eq!(classify("refs/tags/v1", "h").map(|r| r.kind), Some("tag".into()));
        assert_eq!(absolute(Path::new("/a/b/../c/./d")), absolute(Path::new("/a/c/d")));
    }
}
