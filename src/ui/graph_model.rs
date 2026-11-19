use std::cmp::Ordering;
use std::collections::HashMap;

use crate::engine::types::{Commit, Worktree};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum GroupKind {
    Branch,
    Worktree,
    Tag,
}

/// The refs of one name on one commit: `main` and `origin/main` are one chip.
#[derive(Clone, Debug, PartialEq)]
pub struct RefGroup {
    pub name: String,
    pub kind: GroupKind,
    pub local: bool,
    pub remotes: Vec<String>,
    pub is_head: bool,
    /// "local" | "remote" | "tag" | "worktree": what a click on the chip acts on.
    pub action_kind: &'static str,
    pub action_name: String,
    /// Label of the other worktree holding this branch, or the worktree a worktree chip stands for.
    pub elsewhere: String,
    /// Name of that worktree, for opening it.
    pub holder: String,
}

/// Other worktrees as the chips name them: by the branch they hold, and by name.
#[derive(Default)]
pub struct WorktreeLabels {
    by_branch: HashMap<String, (String, String)>,
    by_name: HashMap<String, String>,
}

pub fn worktree_labels(worktrees: &[Worktree]) -> WorktreeLabels {
    let mut out = WorktreeLabels::default();
    for w in worktrees {
        let label = worktree_label(w);
        if let (false, false, false, Some(branch)) = (w.current, w.prunable, w.detached, w.branch.as_ref()) {
            out.by_branch.insert(branch.clone(), (label.clone(), w.name.clone()));
        }
        out.by_name.insert(w.name.clone(), label);
    }
    out
}

/// A worktree's directory name, which is also what its tab is called.
pub fn worktree_label(w: &Worktree) -> String {
    let trimmed = w.path.trim_end_matches(['/', '\\']);
    let leaf = trimmed.rsplit(['/', '\\']).next().unwrap_or("");
    if leaf.is_empty() { w.name.clone() } else { leaf.to_string() }
}

/// Groups a commit's `kind:name` labels: HEAD first, then branches, worktrees, tags. Stashes are not chips.
pub fn group_refs(labels: &[String], head_branch: Option<&str>, worktrees: &WorktreeLabels) -> Vec<RefGroup> {
    let mut groups: Vec<RefGroup> = Vec::new();
    for label in labels {
        let Some((kind, short)) = label.split_once(':') else { continue };
        match kind {
            "stash" => continue,
            "worktree" => {
                let name = worktrees.by_name.get(short).cloned().unwrap_or_else(|| short.to_string());
                groups.push(RefGroup {
                    name: name.clone(),
                    kind: GroupKind::Worktree,
                    local: false,
                    remotes: Vec::new(),
                    is_head: false,
                    action_kind: "worktree",
                    action_name: short.to_string(),
                    elsewhere: name,
                    holder: short.to_string(),
                });
                continue;
            }
            "tag" => {
                groups.push(RefGroup {
                    name: short.to_string(),
                    kind: GroupKind::Tag,
                    local: false,
                    remotes: Vec::new(),
                    is_head: false,
                    action_kind: "tag",
                    action_name: short.to_string(),
                    elsewhere: String::new(),
                    holder: String::new(),
                });
                continue;
            }
            _ => {}
        }
        let local = kind == "local";
        let (remote, name) = match short.split_once('/') {
            Some((remote, name)) if !local => (Some(remote), name),
            _ => (None, short),
        };
        let held = if local { worktrees.by_branch.get(name).cloned() } else { None };
        let (elsewhere, holder) = held.unwrap_or_default();
        let existing = groups.iter_mut().find(|g| g.kind == GroupKind::Branch && g.name == name);
        let Some(group) = existing else {
            groups.push(RefGroup {
                name: name.to_string(),
                kind: GroupKind::Branch,
                local,
                remotes: remote.map(|r| vec![r.to_string()]).unwrap_or_default(),
                is_head: local && Some(name) == head_branch,
                action_kind: if local { "local" } else { "remote" },
                action_name: if local { name.to_string() } else { short.to_string() },
                elsewhere,
                holder,
            });
            continue;
        };
        if local {
            group.local = true;
            group.is_head |= Some(name) == head_branch;
            group.action_kind = "local";
            group.action_name = name.to_string();
            group.elsewhere = elsewhere;
            group.holder = holder;
        } else if let Some(remote) = remote.filter(|r| !group.remotes.iter().any(|x| x == r)) {
            group.remotes.push(remote.to_string());
        }
    }
    groups.sort_by(|a, b| {
        b.is_head
            .cmp(&a.is_head)
            .then(a.kind.cmp(&b.kind))
            .then(b.local.cmp(&a.local))
            .then_with(|| natural(&a.name, &b.name))
    });
    groups
}

/// Shift-click: the first-parent chain between anchor and target, else just the target.
pub fn range_select(commits: &[Commit], anchor: &str, target: &str) -> Vec<String> {
    let order = index_of(commits);
    range_in(commits, &order, anchor, target)
}

/// Ctrl-click: grows or shrinks the run by one at either end; anything else replaces it.
pub fn toggle_select(commits: &[Commit], selected: &[String], hash: &str) -> Vec<String> {
    let only = || vec![hash.to_string()];
    if selected.is_empty() {
        return only();
    }
    let order = index_of(commits);
    let Some(&idx) = order.get(hash) else { return only() };
    let mut positions: Vec<usize> = selected.iter().filter_map(|h| order.get(h.as_str()).copied()).collect();
    positions.sort_unstable();
    let (Some(&top), Some(&bottom)) = (positions.first(), positions.last()) else { return only() };

    if selected.iter().any(|h| h == hash) {
        if idx == top || idx == bottom {
            return selected.iter().filter(|h| *h != hash).cloned().collect();
        }
        return only();
    }

    let grown = |from: &str, to: &str| -> Option<Vec<String>> {
        let run = range_in(commits, &order, from, to);
        let fits = run.len() == selected.len() + 1 && selected.iter().all(|h| run.contains(h));
        fits.then_some(run)
    };
    let (Some(newest), Some(oldest)) = (commits.get(top), commits.get(bottom)) else { return only() };
    grown(&newest.hash, hash).or_else(|| grown(hash, &oldest.hash)).unwrap_or_else(only)
}

/// Which rows start a new relative-time bucket, only ever moving further into the past.
pub fn markers(commits: &[Commit], now: i64) -> HashMap<usize, String> {
    let mut out = HashMap::new();
    let mut deepest = -1;
    let mut last = String::new();
    for (i, c) in commits.iter().enumerate() {
        if is_wip(&c.hash) {
            continue;
        }
        let age = now - c.date;
        if age <= deepest {
            continue;
        }
        deepest = age;
        let b = bucket(c.date, now);
        if b != last {
            last = b.clone();
            out.insert(i, b);
        }
    }
    out
}

/// Coarse buckets for the graph's time markers.
pub fn bucket(date: i64, now: i64) -> String {
    let hours = (now - date).div_euclid(3600);
    if hours < 1 {
        return "just now".into();
    }
    if hours < 24 {
        return if hours == 1 { "1 hour ago".into() } else { format!("{hours} hours ago") };
    }
    let days = hours / 24;
    if days == 1 {
        return "yesterday".into();
    }
    if days < 7 {
        return format!("{days} days ago");
    }
    let weeks = days / 7;
    if weeks < 5 {
        return if weeks == 1 { "a week ago".into() } else { format!("{weeks} weeks ago") };
    }
    let months = days / 30;
    if months < 12 {
        return if months == 1 { "a month ago".into() } else { format!("{months} months ago") };
    }
    let years = days / 365;
    if years == 1 { "a year ago".into() } else { format!("{years} years ago") }
}

pub fn is_wip(hash: &str) -> bool {
    hash == "WIP" || hash.starts_with("WIP:")
}

fn index_of(commits: &[Commit]) -> HashMap<&str, usize> {
    commits.iter().enumerate().map(|(i, c)| (c.hash.as_str(), i)).collect()
}

fn range_in(commits: &[Commit], order: &HashMap<&str, usize>, anchor: &str, target: &str) -> Vec<String> {
    let (Some(&a), Some(&b)) = (order.get(anchor), order.get(target)) else { return vec![target.to_string()] };
    let (newer, older) = if a < b { (anchor, target) } else { (target, anchor) };
    chain_between(commits, order, newer, older).unwrap_or_else(|| vec![target.to_string()])
}

fn chain_between(commits: &[Commit], order: &HashMap<&str, usize>, newer: &str, older: &str) -> Option<Vec<String>> {
    let mut chain = Vec::new();
    let mut cursor = newer;
    for _ in 0..=commits.len() {
        chain.push(cursor.to_string());
        if cursor == older {
            return Some(chain);
        }
        let commit = commits.get(*order.get(cursor)?)?;
        cursor = commit.parents.first()?;
    }
    None
}

fn natural(a: &str, b: &str) -> Ordering {
    let fold = |s: &str| s.chars().flat_map(char::to_lowercase).collect::<String>();
    fold(a).cmp(&fold(b)).then_with(|| a.cmp(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk(hash: &str, parents: &[&str]) -> Commit {
        Commit { hash: hash.into(), parents: parents.iter().map(|p| p.to_string()).collect(), ..Commit::default() }
    }

    fn graph() -> Vec<Commit> {
        vec![
            mk("A", &["B"]),
            mk("B", &["C", "F"]),
            mk("F", &["G"]),
            mk("G", &["C"]),
            mk("C", &["D"]),
            mk("D", &["E"]),
            mk("E", &[]),
        ]
    }

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn range_follows_first_parents() {
        let c = graph();
        assert_eq!(range_select(&c, "A", "D"), v(&["A", "B", "C", "D"]));
        assert_eq!(range_select(&c, "D", "A"), v(&["A", "B", "C", "D"]));
        assert_eq!(range_select(&c, "C", "C"), v(&["C"]));
        assert_eq!(range_select(&c, "A", "G"), v(&["G"]));
        assert_eq!(range_select(&c, "F", "E"), v(&["F", "G", "C", "D", "E"]));
        assert_eq!(range_select(&c, "A", "C"), v(&["A", "B", "C"]));
        assert_eq!(range_select(&c, "A", "E"), v(&["A", "B", "C", "D", "E"]));
    }

    #[test]
    fn toggle_keeps_the_run_contiguous() {
        let c = graph();
        assert_eq!(toggle_select(&c, &v(&["A", "B"]), "C"), v(&["A", "B", "C"]));
        assert_eq!(toggle_select(&c, &v(&["B", "C"]), "A"), v(&["A", "B", "C"]));
        assert_eq!(toggle_select(&c, &v(&["A", "B", "C"]), "C"), v(&["A", "B"]));
        assert_eq!(toggle_select(&c, &v(&["A", "B", "C"]), "B"), v(&["B"]));
        assert_eq!(toggle_select(&c, &v(&["A", "B"]), "E"), v(&["E"]));
    }

    #[test]
    fn refs_group_by_name() {
        let labels =
            v(&["remote:origin/main", "tag:v1", "local:main", "remote:up/main", "local:topic", "stash:stash@{0}"]);
        let groups = group_refs(&labels, Some("main"), &WorktreeLabels::default());
        let names: Vec<&str> = groups.iter().map(|g| g.name.as_str()).collect();
        assert_eq!(names, ["main", "topic", "v1"]);
        let main = &groups[0];
        assert!(main.is_head && main.local);
        assert_eq!(main.remotes, v(&["origin", "up"]));
        assert_eq!((main.action_kind, main.action_name.as_str()), ("local", "main"));
        let remote_only = group_refs(&v(&["remote:origin/feature/x"]), None, &WorktreeLabels::default());
        assert_eq!(remote_only[0].name, "feature/x");
        assert_eq!((remote_only[0].action_kind, remote_only[0].action_name.as_str()), ("remote", "origin/feature/x"));
    }

    #[test]
    fn branches_held_elsewhere_name_their_worktree() {
        let w = Worktree {
            name: "agent".into(),
            path: "C:/work/agent-1/".into(),
            branch: Some("topic".into()),
            ..Worktree::default()
        };
        let labels = worktree_labels(&[w]);
        let groups = group_refs(&v(&["local:topic", "worktree:agent"]), None, &labels);
        assert_eq!(groups[0].elsewhere, "agent-1");
        assert_eq!(groups[0].holder, "agent");
        assert_eq!(groups[1].kind, GroupKind::Worktree);
        assert_eq!(groups[1].name, "agent-1");
    }

    #[test]
    fn markers_only_move_back_in_time() {
        let now = 1_000_000;
        let mut a = mk("a", &[]);
        a.date = now - 7200;
        let mut b = mk("b", &[]);
        b.date = now - 90_000;
        let mut c = mk("c", &[]);
        c.date = now - 60;
        let mut d = mk("d", &[]);
        d.date = now - 100_000;
        let m = markers(&[mk("WIP", &[]), a, b, c, d], now);
        assert_eq!(m.get(&1).map(String::as_str), Some("2 hours ago"));
        assert_eq!(m.get(&2).map(String::as_str), Some("yesterday"));
        assert_eq!(m.len(), 2);
    }

    #[test]
    fn buckets() {
        assert_eq!(bucket(0, 30), "just now");
        assert_eq!(bucket(0, 8 * 86_400), "a week ago");
    }
}
