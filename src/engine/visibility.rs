use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::paths::config_dir;

#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct RepoVisibility {
    path: String,
    hidden: Vec<String>,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct VisibilityFile {
    repos: Vec<RepoVisibility>,
}

static WRITE: Mutex<()> = Mutex::new(());

/// The ref display names ("topic", "origin/topic", "v1.0") hidden from this repository's graph.
pub fn load_hidden(repo: &str) -> Vec<String> {
    load_all().repos.into_iter().find(|r| r.path == repo).map(|r| r.hidden).unwrap_or_default()
}

pub fn save_hidden(repo: &str, hidden: &[String]) {
    let _guard = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let mut all = load_all();
    all.repos.retain(|r| r.path != repo);
    if !hidden.is_empty() {
        all.repos.push(RepoVisibility { path: repo.to_string(), hidden: hidden.to_vec() });
    }
    let Ok(text) = serde_json::to_string(&all) else { return };
    let path = file_path();
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let tmp = path.with_extension("json.tmp");
    if let Err(e) = fs::write(&tmp, text).and_then(|()| fs::rename(&tmp, &path)) {
        eprintln!("gitc: cannot save hidden refs: {e}");
    }
}

fn load_all() -> VisibilityFile {
    fs::read_to_string(file_path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn file_path() -> PathBuf {
    config_dir().join("hidden.json")
}
