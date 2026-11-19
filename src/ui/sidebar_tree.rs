use std::cmp::Ordering;
use std::collections::HashMap;

use crate::engine::types::Worktree;

pub struct Node {
    pub name: String,
    pub path: String,
    pub item: Option<usize>,
    pub children: Vec<usize>,
}

/// Slash-separated names nested into folders, stored flat: nodes refer to each other by index.
#[derive(Default)]
pub struct Tree {
    pub nodes: Vec<Node>,
    pub roots: Vec<usize>,
}

impl Tree {
    /// Folders first and alphabetical; the items inside newest first by `dates[item]`, then by name.
    pub fn build(items: &[(usize, &str)], dates: &[i64]) -> Tree {
        let mut tree = Tree::default();
        let mut index: HashMap<String, usize> = HashMap::new();
        for &(item, full) in items {
            let segments: Vec<&str> = full.split('/').filter(|s| !s.is_empty()).collect();
            let mut prefix = String::new();
            let mut parent: Option<usize> = None;
            for (i, segment) in segments.iter().enumerate() {
                if !prefix.is_empty() {
                    prefix.push('/');
                }
                prefix.push_str(segment);
                let node = match index.get(&prefix) {
                    Some(&n) => n,
                    None => {
                        let n = tree.nodes.len();
                        tree.nodes.push(Node {
                            name: segment.to_string(),
                            path: prefix.clone(),
                            item: None,
                            children: Vec::new(),
                        });
                        index.insert(prefix.clone(), n);
                        match parent.and_then(|p| tree.nodes.get_mut(p)) {
                            Some(p) => p.children.push(n),
                            None => tree.roots.push(n),
                        }
                        n
                    }
                };
                if i + 1 == segments.len() {
                    if let Some(node) = tree.nodes.get_mut(node) {
                        node.item = Some(item);
                    }
                }
                parent = Some(node);
            }
        }
        tree.sort(dates);
        tree
    }

    /// Every item on one level, named by its full path, newest first.
    pub fn flat(items: &[(usize, &str)], dates: &[i64]) -> Tree {
        let mut tree = Tree::default();
        for &(item, full) in items {
            if full.is_empty() {
                continue;
            }
            tree.roots.push(tree.nodes.len());
            tree.nodes.push(Node {
                name: full.to_string(),
                path: full.to_string(),
                item: Some(item),
                children: Vec::new(),
            });
        }
        tree.sort(dates);
        tree
    }

    pub fn node(&self, n: usize) -> Option<&Node> {
        self.nodes.get(n)
    }

    /// Every item strictly below node `n`, depth first.
    pub fn items_under(&self, n: usize, out: &mut Vec<usize>) {
        let Some(node) = self.nodes.get(n) else { return };
        for &child in &node.children {
            if let Some(item) = self.nodes.get(child).and_then(|c| c.item) {
                out.push(item);
            }
            self.items_under(child, out);
        }
    }

    /// Every item in the tree, depth first.
    pub fn all_items(&self) -> Vec<usize> {
        let mut out = Vec::new();
        for &root in &self.roots {
            if let Some(item) = self.nodes.get(root).and_then(|r| r.item) {
                out.push(item);
            }
            self.items_under(root, &mut out);
        }
        out
    }

    fn sort(&mut self, dates: &[i64]) {
        let mut roots = std::mem::take(&mut self.roots);
        self.sort_level(&mut roots, dates);
        self.roots = roots;
        for n in 0..self.nodes.len() {
            let Some(node) = self.nodes.get_mut(n) else { continue };
            let mut children = std::mem::take(&mut node.children);
            self.sort_level(&mut children, dates);
            if let Some(node) = self.nodes.get_mut(n) {
                node.children = children;
            }
        }
    }

    fn sort_level(&self, list: &mut [usize], dates: &[i64]) {
        list.sort_by(|&a, &b| {
            let (Some(a), Some(b)) = (self.nodes.get(a), self.nodes.get(b)) else { return Ordering::Equal };
            let (a_folder, b_folder) = (!a.children.is_empty(), !b.children.is_empty());
            if a_folder != b_folder {
                return if a_folder { Ordering::Less } else { Ordering::Greater };
            }
            if !a_folder {
                let date = |item: Option<usize>| item.and_then(|i| dates.get(i).copied()).unwrap_or(0);
                let newer = date(b.item).cmp(&date(a.item));
                if newer != Ordering::Equal {
                    return newer;
                }
            }
            alphabetical(&a.name, &b.name)
        });
    }
}

/// What to call a stash: its message without git's "WIP on main: " / "On main: " prefix.
pub fn stash_name(subject: &str) -> &str {
    let text = subject.trim();
    let rest = text.strip_prefix("WIP ").unwrap_or(text);
    let Some(rest) = rest.strip_prefix("On ").or_else(|| rest.strip_prefix("on ")) else { return text };
    let Some(colon) = rest.find(':') else { return text };
    let Some(after) = rest.get(colon + 1..).and_then(|r| r.strip_prefix(' ')) else { return text };
    if colon == 0 {
        return text;
    }
    let stripped = after.trim();
    if stripped.is_empty() { text } else { stripped }
}

/// A worktree's directory name, which is also what its tab is called.
pub fn worktree_label(w: &Worktree) -> &str {
    let trimmed = w.path.trim_end_matches(['/', '\\']);
    let leaf = trimmed.rsplit(['/', '\\']).next().unwrap_or(trimmed);
    if leaf.is_empty() { &w.name } else { leaf }
}

/// Moved within the last half-minute, so something (usually an agent) is working in it.
pub fn worktree_active(w: &Worktree) -> bool {
    !w.current && w.idle_ms >= 0 && w.idle_ms < 30_000
}

/// "gone" / "conflicts" / the pending operation / "3 changed" / "locked", with a tone: 2 bad, 1 warn, 0 dim.
pub fn worktree_badge(w: &Worktree) -> Option<(String, u8)> {
    if w.prunable {
        return Some(("gone".into(), 0));
    }
    if !w.pending.is_empty() {
        let conflicted = w.status.iter().any(|f| f.index == "U" || f.worktree == "U");
        return Some(if conflicted { ("conflicts".into(), 2) } else { (w.pending.clone(), 1) });
    }
    if !w.status.is_empty() {
        return Some((format!("{} changed", w.status.len()), 1));
    }
    if w.locked {
        return Some(("locked".into(), 0));
    }
    None
}

fn alphabetical(a: &str, b: &str) -> Ordering {
    a.chars().flat_map(char::to_lowercase).cmp(b.chars().flat_map(char::to_lowercase)).then_with(|| a.cmp(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shape(tree: &Tree, level: &[usize]) -> String {
        let parts: Vec<String> = level
            .iter()
            .filter_map(|&n| tree.node(n))
            .map(|n| {
                let label = if n.item.is_some() { format!("{}*", n.name) } else { n.name.clone() };
                if n.children.is_empty() { label } else { format!("{label}[{}]", shape(tree, &n.children)) }
            })
            .collect();
        parts.join(",")
    }

    fn tree_of(names: &[&str]) -> Tree {
        let items: Vec<(usize, &str)> = names.iter().copied().enumerate().collect();
        Tree::build(&items, &[])
    }

    fn of(names: &[&str]) -> String {
        let tree = tree_of(names);
        shape(&tree, &tree.roots)
    }

    #[test]
    fn nesting() {
        assert_eq!(of(&["main"]), "main*");
        assert_eq!(of(&["adri/feature1/login"]), "adri[feature1[login*]]");
        assert_eq!(of(&["adri/one", "adri/two"]), "adri[one*,two*]");
        assert_eq!(of(&["feature", "feature/login"]), "feature*[login*]");
        assert_eq!(of(&["feature/login", "feature"]), "feature*[login*]");
        assert_eq!(of(&["zeta", "alpha", "beta/x", "aardvark/y"]), "aardvark[y*],beta[x*],alpha*,zeta*");
        assert_eq!(of(&[]), "");
    }

    #[test]
    fn newest_first_inside_a_level() {
        let items = [(0, "old"), (1, "new"), (2, "dir/x")];
        let tree = Tree::build(&items, &[10, 20, 0]);
        assert_eq!(shape(&tree, &tree.roots), "dir[x*],new*,old*");
        let flat = Tree::flat(&items, &[10, 20, 0]);
        assert_eq!(shape(&flat, &flat.roots), "new*,old*,dir/x*");
    }

    #[test]
    fn collecting() {
        let names = ["a/b/c", "a/d", "e"];
        let tree = tree_of(&names);
        let got: Vec<&str> = tree.all_items().iter().filter_map(|&i| names.get(i).copied()).collect();
        assert_eq!(got, ["a/b/c", "a/d", "e"]);
        let mut under = Vec::new();
        tree.items_under(tree.roots.first().copied().unwrap_or(usize::MAX), &mut under);
        assert_eq!(under.len(), 2);
    }

    #[test]
    fn stash_names() {
        assert_eq!(stash_name("On main: half the parser"), "half the parser");
        assert_eq!(stash_name("WIP on main: 1a2b3c subject"), "1a2b3c subject");
        assert_eq!(stash_name("On main: "), "On main:");
        assert_eq!(stash_name("plain"), "plain");
    }

    #[test]
    fn worktrees() {
        let tree = |path: &str, name: &str| Worktree { path: path.into(), name: name.into(), ..Default::default() };
        assert_eq!(worktree_label(&tree("/code/agent-7", "x")), "agent-7");
        assert_eq!(worktree_label(&tree("C:\\Code\\gitc", "")), "gitc");
        assert_eq!(worktree_label(&tree("/code/agent/", "x")), "agent");
        let idle = |ms: i64, current: bool| Worktree { idle_ms: ms, current, ..Default::default() };
        assert!(worktree_active(&idle(3000, false)));
        assert!(!worktree_active(&idle(600_000, false)));
        assert!(!worktree_active(&idle(-1, false)));
        assert!(!worktree_active(&idle(0, true)));
    }
}
