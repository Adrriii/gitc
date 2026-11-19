use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use super::git::git_or_none;
use super::types::Submodule;

struct Live {
    state: &'static str,
    sha: String,
    label: String,
}

/// Declared submodules with their live state (`git submodule status`, plus a dirty check inside them).
pub fn read_submodules(repo: &str) -> Vec<Submodule> {
    let mut list = list_submodules(repo);
    if list.is_empty() {
        return list;
    }
    let (live, dirty) = std::thread::scope(|scope| {
        let dirty = scope.spawn(|| dirty_paths(repo));
        (live_state(repo), dirty.join().unwrap_or_default())
    });
    for sub in &mut list {
        let Some(l) = live.get(&sub.path) else {
            sub.state = "uninitialized".into();
            continue;
        };
        let dirty_inside = l.state == "current" && dirty.contains(&sub.path);
        sub.state = if dirty_inside { "dirty" } else { l.state }.to_string();
        sub.sha = l.sha.clone();
        sub.label = l.label.clone();
    }
    list
}

/// The submodules .gitmodules declares, state "pending": one file read, no git.
pub fn list_submodules(repo: &str) -> Vec<Submodule> {
    let Ok(text) = fs::read_to_string(Path::new(repo).join(".gitmodules")) else { return Vec::new() };
    let mut out: Vec<Submodule> = declared(&text)
        .into_iter()
        .map(|(name, path, url)| Submodule {
            absolute: Path::new(repo).join(&path).to_string_lossy().into_owned(),
            name,
            path,
            url,
            state: "pending".into(),
            sha: String::new(),
            label: String::new(),
        })
        .collect();
    out.sort_by_key(|s| s.path.to_lowercase());
    out
}

fn declared(text: &str) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    let (mut name, mut path, mut url) = (String::new(), String::new(), String::new());
    let mut flush = |name: &mut String, path: &mut String, url: &mut String| {
        if !name.is_empty() && !path.is_empty() {
            out.push((std::mem::take(name), std::mem::take(path), std::mem::take(url)));
        }
        name.clear();
        path.clear();
        url.clear();
    };
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with("[submodule ") {
            flush(&mut name, &mut path, &mut url);
            if let (Some(open), Some(close)) = (line.find('"'), line.rfind('"')) {
                if close > open {
                    name = line.get(open + 1..close).unwrap_or("").to_string();
                }
            }
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        match key.trim().to_lowercase().as_str() {
            "path" => path = value.trim().to_string(),
            "url" => url = value.trim().to_string(),
            _ => {}
        }
    }
    flush(&mut name, &mut path, &mut url);
    out
}

fn live_state(repo: &str) -> HashMap<String, Live> {
    let Some(raw) = git_or_none(repo, &["submodule", "status"]) else { return HashMap::new() };
    parse_live(&raw)
}

fn parse_live(raw: &str) -> HashMap<String, Live> {
    let mut out = HashMap::new();
    for line in raw.lines().filter(|l| !l.trim().is_empty()) {
        let mut chars = line.chars();
        let state = match chars.next() {
            Some('-') => "uninitialized",
            Some('+') => "moved",
            Some('U') => "conflicted",
            _ => "current",
        };
        let rest = chars.as_str().trim();
        let Some((sha, tail)) = rest.split_once(' ') else { continue };
        let mut tail = tail.trim();
        let mut label = "";
        if let Some(open) = tail.rfind(" (").filter(|_| tail.ends_with(')')) {
            label = tail.get(open + 2..tail.len() - 1).unwrap_or("");
            tail = tail.get(..open).unwrap_or("").trim();
        }
        out.insert(tail.to_string(), Live { state, sha: sha.to_string(), label: label.to_string() });
    }
    out
}

fn dirty_paths(repo: &str) -> HashSet<String> {
    let args = ["--no-optional-locks", "status", "--porcelain=v1", "-z", "-uno", "--ignore-submodules=none"];
    let Some(raw) = git_or_none(repo, &args) else { return HashSet::new() };
    let mut out = HashSet::new();
    let mut parts = raw.split('\0');
    while let Some(entry) = parts.next() {
        let Some(path) = entry.get(3..).filter(|p| !p.is_empty()) else { continue };
        if entry.starts_with('R') || entry.starts_with('C') {
            parts.next();
        }
        out.insert(path.to_string());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_declared_and_live() {
        let d =
            declared("[submodule \"lib a\"]\n\tpath = vendor/a\n\tURL = https://x/a\n[submodule \"b\"]\n\turl = u\n");
        assert_eq!(d, vec![("lib a".to_string(), "vendor/a".to_string(), "https://x/a".to_string())]);
        let live = parse_live("-abc vendor/a\n+def vendor/b (v1.0-2-gdef)\n 123 c d (heads/main)\n");
        assert_eq!(live.get("vendor/a").map(|l| l.state), Some("uninitialized"));
        assert_eq!(live.get("vendor/b").map(|l| (l.state, l.label.as_str())), Some(("moved", "v1.0-2-gdef")));
        assert_eq!(live.get("c d").map(|l| (l.state, l.sha.as_str())), Some(("current", "123")));
    }
}
