use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::paths::config_dir;

#[derive(Serialize, Deserialize, Default)]
struct ApprovalFile {
    hosts: Vec<String>,
}

static WRITING: Mutex<()> = Mutex::new(());

/// The machines gitc may install itself on, in the order they were approved.
pub fn approved_remotes() -> Vec<String> {
    load(&file_path())
}

/// Matched exactly: two spellings of one machine are two decisions.
pub fn is_approved_remote(host: &str) -> bool {
    approved_remotes().iter().any(|h| h == host)
}

pub fn approve_remote(host: &str) {
    let _guard = WRITING.lock().unwrap_or_else(|e| e.into_inner());
    approve_in(&file_path(), host);
}

/// Takes the approval back. The binary already over there is left alone.
pub fn revoke_remote(host: &str) {
    let _guard = WRITING.lock().unwrap_or_else(|e| e.into_inner());
    revoke_in(&file_path(), host);
}

fn approve_in(path: &Path, host: &str) {
    let mut hosts = load(path);
    if host.is_empty() || hosts.iter().any(|h| h == host) {
        return;
    }
    hosts.push(host.to_string());
    save(path, hosts);
}

fn revoke_in(path: &Path, host: &str) {
    let hosts: Vec<String> = load(path).into_iter().filter(|h| h != host).collect();
    save(path, hosts);
}

fn load(path: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(path) else { return Vec::new() };
    serde_json::from_str::<ApprovalFile>(&text).map(|f| f.hosts).unwrap_or_default()
}

fn save(path: &Path, hosts: Vec<String>) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let Ok(text) = serde_json::to_string(&ApprovalFile { hosts }) else { return };
    if let Err(e) = std::fs::write(path, text) {
        eprintln!("[approvals] could not save {}: {e}", path.display());
    }
}

fn file_path() -> PathBuf {
    config_dir().join("remotes.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approvals_round_trip() {
        let dir = std::env::temp_dir().join(format!("gitc-approvals-test-{}", std::process::id()));
        let path = dir.join("remotes.json");
        let _ = std::fs::remove_dir_all(&dir);

        assert!(load(&path).is_empty());
        approve_in(&path, "server");
        assert_eq!(load(&path), ["server"]);
        approve_in(&path, "server");
        assert_eq!(load(&path), ["server"]);
        approve_in(&path, "adri@server");
        assert_eq!(load(&path), ["server", "adri@server"]);
        revoke_in(&path, "server");
        assert_eq!(load(&path), ["adri@server"]);
        revoke_in(&path, "never-approved");
        assert_eq!(load(&path), ["adri@server"]);
        approve_in(&path, "");
        assert_eq!(load(&path), ["adri@server"]);

        std::fs::write(&path, "{ this is not json").ok();
        assert!(load(&path).is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
