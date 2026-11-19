use std::fs;
use std::path::{Path, PathBuf};

use super::types::{DirEntry, Listing};

const LIMIT: usize = 500;

/// Lists a directory's subdirectories, repositories first. A path that is not a directory
/// lists its parent, with the last segment as the completion `prefix`.
pub fn list_dir(input: &str) -> Listing {
    let home = home();
    let typed = input.trim();
    let start = if typed.is_empty() { home.clone() } else { typed.to_string() };
    let sep = std::path::MAIN_SEPARATOR.to_string();

    let (dir, prefix) = if Path::new(&start).is_dir() {
        (PathBuf::from(&start), String::new())
    } else {
        let parent = Path::new(&start).parent().map(Path::to_path_buf).unwrap_or_default();
        let parent = if parent.as_os_str().is_empty() { PathBuf::from(".") } else { parent };
        let prefix = start.rsplit(['/', '\\']).next().unwrap_or("").to_string();
        if !parent.is_dir() {
            return Listing { path: start, prefix, sep, home, ..Listing::default() };
        }
        (parent, prefix)
    };

    let mut entries = Vec::new();
    let mut truncated = false;
    if let Ok(read) = fs::read_dir(&dir) {
        for entry in read.flatten() {
            if entries.len() >= LIMIT {
                truncated = true;
                break;
            }
            let full = entry.path();
            if !fs::metadata(&full).is_ok_and(|m| m.is_dir()) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            entries.push(DirEntry { name, dir: true, repo: is_repo(&full) });
        }
    }
    entries.sort_by(|a, b| b.repo.cmp(&a.repo).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));

    Listing {
        path: dir.to_string_lossy().into_owned(),
        repo: is_repo(&dir),
        parent: dir.parent().filter(|p| !p.as_os_str().is_empty()).map(|p| p.to_string_lossy().into_owned()),
        prefix,
        entries,
        truncated,
        sep,
        home,
    }
}

pub fn home() -> String {
    ["USERPROFILE", "HOME"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .find(|v| !v.is_empty())
        .unwrap_or_else(|| "/".to_string())
}

fn is_repo(path: &Path) -> bool {
    path.join(".git").exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completes_a_partial_name() {
        let root = std::env::temp_dir().join(format!("gitc-browse-test-{}", super::super::git::now_ms()));
        let _ = fs::create_dir_all(root.join("Zeta"));
        let _ = fs::create_dir_all(root.join("alpha").join(".git"));
        let _ = fs::create_dir_all(root.join("beta"));
        let _ = fs::write(root.join("file.txt"), "x");
        let listing = list_dir(&root.to_string_lossy());
        let names: Vec<(&str, bool)> = listing.entries.iter().map(|e| (e.name.as_str(), e.repo)).collect();
        assert_eq!(names, [("alpha", true), ("beta", false), ("Zeta", false)]);
        let partial = list_dir(&root.join("be").to_string_lossy());
        assert_eq!(partial.prefix, "be");
        assert_eq!(partial.path, root.to_string_lossy());
        let missing = list_dir(&root.join("nope").join("x").to_string_lossy());
        assert!(missing.entries.is_empty() && missing.parent.is_none());
        let _ = fs::remove_dir_all(&root);
    }
}
