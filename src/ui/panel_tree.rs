use std::collections::{HashMap, HashSet};

/// One path segment; `item` is the index of the entry living exactly here.
#[derive(Debug, Clone, PartialEq)]
pub struct Node {
    pub name: String,
    pub path: String,
    pub item: Option<usize>,
    pub children: Vec<Node>,
}

/// One line of the tree as drawn, after collapsing and folding.
#[derive(Debug, Clone, PartialEq)]
pub enum Row {
    Folder { label: String, path: String, count: usize, depth: usize, open: bool },
    File { item: usize, depth: usize },
}

/// Nests slash-separated paths; folders first, then entries, each alphabetical.
pub fn build_tree<'a>(paths: impl IntoIterator<Item = &'a str>) -> Vec<Node> {
    let mut arena: Vec<(Node, Vec<usize>)> = Vec::new();
    let mut by_path: HashMap<String, usize> = HashMap::new();
    let mut roots: Vec<usize> = Vec::new();
    for (item, full) in paths.into_iter().enumerate() {
        let segments: Vec<&str> = full.split('/').filter(|s| !s.is_empty()).collect();
        let mut prefix = String::new();
        let mut parent: Option<usize> = None;
        for (i, segment) in segments.iter().enumerate() {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(segment);
            let at = match by_path.get(&prefix) {
                Some(&at) => at,
                None => {
                    let at = arena.len();
                    let node =
                        Node { name: segment.to_string(), path: prefix.clone(), item: None, children: Vec::new() };
                    arena.push((node, Vec::new()));
                    by_path.insert(prefix.clone(), at);
                    match parent.and_then(|p| arena.get_mut(p)) {
                        Some((_, kids)) => kids.push(at),
                        None => roots.push(at),
                    }
                    at
                }
            };
            if i + 1 == segments.len() {
                if let Some((node, _)) = arena.get_mut(at) {
                    node.item = Some(item);
                }
            }
            parent = Some(at);
        }
    }
    let mut out = assemble(&mut arena, &roots);
    sort(&mut out);
    out
}

/// How many entries sit at or below these nodes.
pub fn count_items(nodes: &[Node]) -> usize {
    nodes.iter().map(|n| usize::from(n.item.is_some()) + count_items(&n.children)).sum()
}

/// The visible rows: a chain of single-child folders is one row, collapsed folders hide their content.
pub fn flatten(nodes: &[Node], collapsed: &HashSet<String>, depth: usize, out: &mut Vec<Row>) {
    for node in nodes {
        if node.children.is_empty() {
            if let Some(item) = node.item {
                out.push(Row::File { item, depth });
            }
            continue;
        }
        let mut label = node.name.clone();
        let mut folder = node;
        while folder.item.is_none() && folder.children.len() == 1 {
            let Some(only) = folder.children.first().filter(|c| !c.children.is_empty()) else { break };
            folder = only;
            label.push('/');
            label.push_str(&folder.name);
        }
        let open = !collapsed.contains(&folder.path);
        let count = count_items(&folder.children);
        out.push(Row::Folder { label, path: folder.path.clone(), count, depth, open });
        if open {
            flatten(&folder.children, collapsed, depth + 1, out);
        }
    }
}

fn assemble(arena: &mut Vec<(Node, Vec<usize>)>, ids: &[usize]) -> Vec<Node> {
    let mut out = Vec::with_capacity(ids.len());
    for &id in ids {
        let Some((node, kids)) = arena.get_mut(id) else { continue };
        let kids = std::mem::take(kids);
        let mut node = node.clone();
        node.children = assemble(arena, &kids);
        out.push(node);
    }
    out
}

fn sort(nodes: &mut [Node]) {
    nodes.sort_by(|a, b| {
        let (fa, fb) = (!a.children.is_empty(), !b.children.is_empty());
        fb.cmp(&fa).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())).then_with(|| a.name.cmp(&b.name))
    });
    for node in nodes {
        sort(&mut node.children);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shape(nodes: &[Node]) -> String {
        let parts: Vec<String> = nodes
            .iter()
            .map(|n| {
                let label = if n.item.is_some() { format!("{}*", n.name) } else { n.name.clone() };
                if n.children.is_empty() { label } else { format!("{label}[{}]", shape(&n.children)) }
            })
            .collect();
        parts.join(",")
    }

    fn tree(paths: &[&str]) -> String {
        shape(&build_tree(paths.iter().copied()))
    }

    #[test]
    fn builds_trees() {
        assert_eq!(tree(&["main"]), "main*");
        assert_eq!(tree(&["adri/feature1/login"]), "adri[feature1[login*]]");
        assert_eq!(tree(&["adri/one", "adri/two"]), "adri[one*,two*]");
        assert_eq!(tree(&["feature", "feature/login"]), "feature*[login*]");
        assert_eq!(tree(&["feature/login", "feature"]), "feature*[login*]");
        assert_eq!(tree(&["zeta", "alpha", "beta/x", "aardvark/y"]), "aardvark[y*],beta[x*],alpha*,zeta*");
        assert_eq!(tree(&[]), "");
        assert_eq!(count_items(&build_tree(["a/b/c", "a/d", "e"])), 3);
    }

    #[test]
    fn folds_single_child_folders() {
        let nodes = build_tree(["src/ui/components/a.rs", "src/ui/components/b.rs", "README"]);
        let mut rows = Vec::new();
        flatten(&nodes, &HashSet::new(), 0, &mut rows);
        assert_eq!(
            rows,
            vec![
                Row::Folder {
                    label: "src/ui/components".into(),
                    path: "src/ui/components".into(),
                    count: 2,
                    depth: 0,
                    open: true
                },
                Row::File { item: 0, depth: 1 },
                Row::File { item: 1, depth: 1 },
                Row::File { item: 2, depth: 0 },
            ]
        );
        let mut closed = Vec::new();
        flatten(&nodes, &HashSet::from(["src/ui/components".to_string()]), 0, &mut closed);
        assert_eq!(closed.len(), 2);
    }
}
