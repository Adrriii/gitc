use std::collections::HashMap;
use std::thread::ScopedJoinHandle;

use super::git::{RawStash, RefFilter, now_ms, peeled_tags, read_commits, read_stashes, read_status};
use super::graph::{LANE_COLORS, STASH_LANE, build_graph, splice_stashes};
use super::refs::{common_dir, read_head, read_pending, read_refs, read_remotes};
use super::submodules::list_submodules;
use super::types::{Commit, GraphPayload, RawCommit, Ref, StashRef, Tab, WorkingFile};
use super::visibility::load_hidden;
use super::worktrees::{list_worktrees, other_statuses};

pub const WIP_HASH: &str = "WIP";

/// Everything the graph view draws for a tab. The git reads (status, the walk, peeled tags,
/// stashes, other worktrees' statuses) run concurrently; the rest is read from .git directly.
pub fn graph_payload(tab: &Tab, limit: usize) -> Result<GraphPayload, String> {
    let repo = tab.path.as_str();
    let head = read_head(repo);
    let mut refs = read_refs(repo);
    let hidden = load_hidden(repo);

    let mut hide = RefFilter::default();
    for r in refs.iter().filter(|r| hidden.contains(&r.short)) {
        match r.kind.as_str() {
            "local" => hide.branches.push(r.short.clone()),
            "remote" => hide.remotes.push(r.short.clone()),
            _ => hide.tags.push(r.short.clone()),
        }
    }
    let mut worktrees = list_worktrees(repo);
    let other_heads: Vec<String> =
        worktrees.iter().filter(|w| !w.current && !w.prunable).filter_map(|w| w.hash.clone()).collect();
    let has_tags = refs.iter().any(|r| r.kind == "tag");
    let has_stash = common_dir(repo).join("logs").join("refs").join("stash").exists();

    let (status, history, peeled, stashes, others) = std::thread::scope(|scope| {
        let history = scope.spawn(|| read_commits(repo, limit, &hide, &other_heads));
        let peeled = has_tags.then(|| scope.spawn(|| peeled_tags(repo)));
        let stashes = has_stash.then(|| scope.spawn(|| read_stashes(repo)));
        let others = scope.spawn(|| other_statuses(&worktrees));
        let status = read_status(repo);
        (status, joined(history), peeled.map(joined), stashes.map(joined), joined(others))
    });
    let status = status?;
    let history = history.ok_or("the commit walk did not finish")??;
    let peeled = peeled.flatten().unwrap_or_default();
    let stashes: Vec<RawStash> = stashes.flatten().unwrap_or_default();
    let others = others.unwrap_or_default();

    for r in refs.iter_mut().filter(|r| r.kind == "tag") {
        if let Some(commit) = peeled.get(&r.name).filter(|c| !c.is_empty()) {
            r.hash = commit.clone();
        }
    }

    let now = (now_ms() / 1000) as i64;
    let wip = |hash: String, parent: &str| RawCommit {
        hash,
        parents: vec![parent.to_string()],
        date: now,
        ..RawCommit::default()
    };
    let mut walked = Vec::with_capacity(history.len() + 1 + worktrees.len());
    if let (false, Some(hash)) = (status.is_empty(), head.hash.as_deref()) {
        walked.push(wip(WIP_HASH.to_string(), hash));
    }
    let mut other_status: HashMap<String, Vec<WorkingFile>> = HashMap::new();
    for w in &worktrees {
        let (Some(files), Some(hash)) = (others.get(&w.name), w.hash.as_deref()) else { continue };
        if files.is_empty() {
            continue;
        }
        other_status.insert(w.name.clone(), files.clone());
        walked.push(wip(format!("{WIP_HASH}:{}", w.name), hash));
    }
    walked.extend(history);

    let rows = build_graph(&walked, &trunk_tip(&refs));
    let stash_commits: Vec<RawCommit> = stashes.iter().map(|s| s.commit.clone()).collect();
    let (commits, rows) = splice_stashes(walked, rows, &stash_commits);

    let mut chips: HashMap<String, Vec<String>> = HashMap::new();
    for r in refs.iter().filter(|r| !hidden.contains(&r.short)) {
        chips.entry(r.hash.clone()).or_default().push(format!("{}:{}", r.kind, r.short));
    }
    for s in &stashes {
        chips.insert(s.commit.hash.clone(), vec![format!("stash:{}", s.selector)]);
    }
    for w in &worktrees {
        if w.current || w.prunable || !w.detached || other_status.contains_key(&w.name) {
            continue;
        }
        let Some(hash) = &w.hash else { continue };
        chips.entry(hash.clone()).or_default().push(format!("worktree:{}", w.name));
    }

    let commits: Vec<Commit> = commits
        .into_iter()
        .zip(&rows)
        .map(|(c, r)| Commit {
            refs: chips.get(&c.hash).cloned().unwrap_or_default(),
            hash: c.hash,
            parents: c.parents,
            subject: c.subject,
            body: c.body,
            author: c.author,
            email: c.email,
            date: c.date,
            lane: r.lane,
            color: r.color,
            co_authors: c.co_authors,
        })
        .collect();

    let mut pending = read_pending(repo);
    pending.conflicted = status.iter().any(|f| {
        let (i, w) = (f.index.as_str(), f.worktree.as_str());
        i == "U" || w == "U" || (i == "A" && w == "A") || (i == "D" && w == "D")
    });
    if pending.conflicted && pending.kind.is_empty() {
        pending.kind = "unmerged".into();
    }

    for w in &mut worktrees {
        w.status = if w.current { status.clone() } else { other_status.remove(&w.name).unwrap_or_default() };
    }
    let remote_info = read_remotes(repo);
    let upstream = head.branch.as_ref().and_then(|b| remote_info.upstreams.get(b)).cloned();
    let mut colors: Vec<String> = LANE_COLORS.iter().map(|c| c.to_string()).collect();
    colors.push(STASH_LANE.to_string());

    Ok(GraphPayload {
        head,
        remotes: remote_info.remotes,
        remote_detail: remote_info.detail,
        upstream,
        upstreams: remote_info.upstreams,
        refs,
        commits,
        rows,
        status,
        pending,
        hidden,
        submodules: list_submodules(repo),
        stashes: stashes
            .iter()
            .map(|s| StashRef { selector: s.selector.clone(), subject: s.commit.subject.clone() })
            .collect(),
        worktrees,
        colors,
    })
}

/// The commit master (else main) points at, local first then remote; "" for neither.
pub fn trunk_tip(refs: &[Ref]) -> String {
    for kind in ["local", "remote"] {
        for name in ["master", "main"] {
            let found = refs.iter().filter(|r| r.kind == kind).find(|r| {
                let short =
                    if kind == "local" { r.short.as_str() } else { r.short.split_once('/').map_or("", |(_, b)| b) };
                short == name
            });
            if let Some(r) = found {
                return r.hash.clone();
            }
        }
    }
    String::new()
}

fn joined<T>(handle: ScopedJoinHandle<'_, T>) -> Option<T> {
    handle.join().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(kind: &str, short: &str, hash: &str) -> Ref {
        Ref { kind: kind.into(), short: short.into(), hash: hash.into(), ..Ref::default() }
    }

    #[test]
    fn trunk_prefers_local_then_master() {
        assert_eq!(trunk_tip(&[r("remote", "origin/master", "a"), r("local", "main", "b")]), "b");
        assert_eq!(trunk_tip(&[r("local", "main", "b"), r("local", "master", "c")]), "c");
        assert_eq!(trunk_tip(&[r("remote", "origin/main", "d"), r("local", "topic", "e")]), "d");
        assert_eq!(trunk_tip(&[r("remote", "origin/feat/main", "f")]), "");
    }
}
