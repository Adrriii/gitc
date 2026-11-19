use std::cmp::Ordering;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::install::installed_binary;
use super::semver::{compare, is_prerelease, pre_stream};
use super::types::{ReleaseNotes, UpdateInfo, UpdateProgress, UpdateResult};

const REPO: &str = "Adrriii/gitc";
const CHUNK: usize = 64 * 1024;

struct Channel {
    test: bool,
    stream: String,
}

#[derive(Deserialize)]
struct Release {
    #[serde(default)]
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
}

static CHANNEL: Mutex<Channel> = Mutex::new(Channel { test: false, stream: String::new() });
static PROGRESS: Mutex<UpdateProgress> =
    Mutex::new(UpdateProgress { phase: String::new(), received: 0, total: 0, message: String::new() });

/// "stable" or "test", and the prerelease stream to follow ("" for this build's own).
pub fn set_channel(channel: &str, stream: Option<&str>) {
    if let Ok(mut c) = CHANNEL.lock() {
        c.test = channel == "test";
        c.stream = stream.unwrap_or("").to_string();
    }
}

pub fn check() -> UpdateInfo {
    let (test, chosen) = CHANNEL.lock().map(|c| (c.test, c.stream.clone())).unwrap_or((false, String::new()));
    let mut info = UpdateInfo {
        current: crate::VERSION.to_string(),
        page: format!("https://github.com/{REPO}/releases/latest"),
        stream: if test { effective_stream(&chosen) } else { String::new() },
        ..Default::default()
    };
    let endpoint = match api_base() {
        Ok(base) if test => format!("{base}?per_page=20"),
        Ok(base) => format!("{base}/latest"),
        Err(e) => {
            info.error = e;
            return info;
        }
    };
    let Ok(body) = get_text(&endpoint) else {
        info.error = "no published release to compare against".into();
        return info;
    };
    let releases: Vec<Release> = match serde_json::from_str::<Vec<Release>>(&body) {
        Ok(list) => list,
        Err(_) => serde_json::from_str::<Release>(&body).map(|r| vec![r]).unwrap_or_default(),
    };
    let versions: Vec<String> = releases
        .into_iter()
        .map(|r| r.tag_name)
        .filter(|t| safe_tag(t))
        .map(|t| t.strip_prefix('v').unwrap_or(&t).to_string())
        .collect();
    if versions.is_empty() {
        info.error = "the release could not be read".into();
        return info;
    }
    info.streams = streams_in(&versions);
    info.latest = versions
        .iter()
        .filter(|v| pre_stream(v).is_none_or(|s| !info.stream.is_empty() && s == info.stream))
        .max_by(|a, b| compare(a, b))
        .cloned()
        .unwrap_or_default();

    let newer = compare(&info.latest, crate::VERSION) == Ordering::Greater;
    let leaving_test = !test && is_prerelease(crate::VERSION);
    info.switching = leaving_test && !newer && !info.latest.is_empty() && info.latest != crate::VERSION;
    info.available = newer || info.switching;
    info
}

/// Downloads, verifies and installs the offered version, then starts it. The caller then closes its window.
pub fn apply() -> UpdateResult {
    set_progress("checking", 0, 0, "Checking for the latest release");
    match install_update() {
        Ok(latest) => {
            set_progress("restarting", 0, 0, &format!("Restarting gitc {latest}"));
            UpdateResult { ok: true, message: format!("updated to {latest} - restarting"), restarting: true }
        }
        Err(message) => {
            set_progress("failed", 0, 0, &message);
            UpdateResult { ok: false, message, restarting: false }
        }
    }
}

pub fn progress() -> UpdateProgress {
    let p = PROGRESS.lock().map(|p| p.clone()).unwrap_or_default();
    if p.phase.is_empty() { UpdateProgress { phase: "idle".into(), ..p } } else { p }
}

/// The notes published with the running version.
pub fn release_notes() -> ReleaseNotes {
    let tag = format!("v{}", crate::VERSION);
    let mut out = ReleaseNotes {
        version: crate::VERSION.to_string(),
        page: format!("https://github.com/{REPO}/releases/tag/{tag}"),
        ..Default::default()
    };
    let base = match api_base() {
        Ok(b) => b,
        Err(e) => {
            out.error = e;
            return out;
        }
    };
    let Ok(body) = get_text(&format!("{base}/tags/{tag}")) else {
        out.error = format!("no release is published for {tag}");
        return out;
    };
    out.notes = serde_json::from_str::<Release>(&body).ok().and_then(|r| r.body).unwrap_or_default().trim().to_string();
    if out.notes.is_empty() {
        out.error = "that release was published without notes".into();
    }
    out
}

/// Removes the binary a previous update left aside. Called at startup.
pub fn cleanup_previous() {
    let binary = installed_binary();
    let (Some(dir), Some(name)) = (binary.parent(), binary.file_name()) else { return };
    let prefix = format!("{}.old", name.to_string_lossy());
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().starts_with(&prefix) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn install_update() -> Result<String, String> {
    let info = check();
    if !info.error.is_empty() {
        return Err(info.error);
    }
    if !info.available {
        return Err(format!("gitc {} is already the newest version on this stream", crate::VERSION));
    }
    let tag = format!("v{}", info.latest);
    if !safe_tag(&tag) {
        return Err(format!("the release tag {tag} is not a shape gitc will fetch"));
    }
    let base = download_base(&tag)?;
    let asset = if cfg!(windows) { "gitc.exe" } else { "gitc" };

    set_progress("downloading", 0, 0, &format!("Downloading gitc {}", info.latest));
    let bytes =
        download(&format!("{base}{asset}")).map_err(|e| format!("could not download {asset} for {tag}: {e}"))?;

    set_progress(
        "verifying",
        bytes.len() as u64,
        bytes.len() as u64,
        "Checking the download against its published checksum",
    );
    let sums = get_text(&format!("{base}SHA256SUMS"))
        .map_err(|_| format!("could not fetch the published checksums for {tag} - update cancelled"))?;
    let Some(expected) = expected_sum(&sums, asset) else {
        return Err(format!("the published checksums for {tag} do not list {asset}"));
    };
    let actual: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
    if !expected.eq_ignore_ascii_case(&actual) {
        return Err("the download did not match its published checksum - update cancelled".into());
    }

    set_progress("installing", bytes.len() as u64, bytes.len() as u64, "Putting the new version in place");
    let installed = installed_binary();
    let target = if installed.exists() {
        installed
    } else {
        std::env::current_exe().map_err(|e| format!("cannot tell where this binary is: {e}"))?
    };
    swap(&target, &bytes)?;

    Command::new(&target)
        .arg("--after-update")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("installed {}, but could not start it: {e}", info.latest))?;
    Ok(info.latest)
}

fn swap(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut aside = PathBuf::from(format!("{}.old", target.display()));
    if aside.exists() && std::fs::remove_file(&aside).is_err() {
        aside = PathBuf::from(format!("{}.old-{}", target.display(), super::git::now_ms()));
    }
    std::fs::rename(target, &aside).map_err(|_| "could not move the current binary aside".to_string())?;
    if let Err(e) = write_executable(target, bytes) {
        let _ = std::fs::rename(&aside, target);
        return Err(format!("could not write the new binary - the old one is unchanged: {e}"));
    }
    Ok(())
}

fn write_executable(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::write(target, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(target, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

fn download(url: &str) -> Result<Vec<u8>, String> {
    let mut response = agent(None).get(url).header("User-Agent", user_agent()).call().map_err(|e| e.to_string())?;
    if response.status().as_u16() >= 400 {
        return Err(format!("the server answered {}", response.status()));
    }
    let total = response.body().content_length().unwrap_or(0);
    set_progress("downloading", 0, total, &current_message());
    let mut reader = response.body_mut().as_reader();
    let mut bytes = Vec::with_capacity(total.min(256 << 20) as usize);
    let mut chunk = vec![0u8; CHUNK];
    loop {
        let n = reader.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(chunk.get(..n).unwrap_or_default());
        set_progress("downloading", bytes.len() as u64, total, &current_message());
    }
    if bytes.is_empty() {
        return Err("the download was empty".into());
    }
    Ok(bytes)
}

fn get_text(url: &str) -> Result<String, String> {
    let mut response = agent(Some(30))
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", user_agent())
        .call()
        .map_err(|e| e.to_string())?;
    if response.status().as_u16() >= 400 {
        return Err(format!("the server answered {}", response.status()));
    }
    response.body_mut().read_to_string().map_err(|e| e.to_string())
}

fn agent(seconds: Option<u64>) -> ureq::Agent {
    ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_connect(Some(Duration::from_secs(5)))
            .timeout_global(seconds.map(Duration::from_secs))
            .http_status_as_error(false)
            .build(),
    )
}

fn user_agent() -> String {
    format!("gitc/{}", crate::VERSION)
}

fn api_base() -> Result<String, String> {
    match std::env::var("GITC_UPDATE_API") {
        Ok(custom) if !custom.is_empty() => secure_url(&custom, "GITC_UPDATE_API"),
        _ => Ok(format!("https://api.github.com/repos/{REPO}/releases")),
    }
}

fn download_base(tag: &str) -> Result<String, String> {
    match std::env::var("GITC_UPDATE_BASE") {
        Ok(custom) if !custom.is_empty() => {
            let base = secure_url(&custom, "GITC_UPDATE_BASE")?;
            Ok(format!("{}/{tag}/", base.trim_end_matches('/')))
        }
        _ => Ok(format!("https://github.com/{REPO}/releases/download/{tag}/")),
    }
}

/// Refuses an update source that is not https, loopback excepted.
fn secure_url(value: &str, name: &str) -> Result<String, String> {
    let trimmed = value.trim();
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("https://") {
        return Ok(trimmed.to_string());
    }
    if let Some(rest) = lower.strip_prefix("http://") {
        let host = rest.split(['/', ':', '?', '#']).next().unwrap_or("");
        if host == "localhost" || is_loopback_v4(host) {
            return Ok(trimmed.to_string());
        }
    }
    Err(format!("{name} must be an https URL - refusing to update over {value}"))
}

fn is_loopback_v4(host: &str) -> bool {
    let parts: Vec<&str> = host.split('.').collect();
    parts.len() == 4
        && parts.first() == Some(&"127")
        && parts.iter().all(|p| !p.is_empty() && p.len() <= 3 && p.chars().all(|c| c.is_ascii_digit()))
}

fn safe_tag(tag: &str) -> bool {
    !tag.is_empty()
        && tag.len() <= 100
        && !tag.contains("..")
        && tag.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-'))
}

fn expected_sum(sums: &str, asset: &str) -> Option<String> {
    sums.lines().rev().find_map(|line| {
        let mut parts = line.split_whitespace();
        let (sum, name) = (parts.next()?, parts.next()?);
        (name.trim_start_matches('*') == asset).then(|| sum.to_string())
    })
}

fn streams_in(versions: &[String]) -> Vec<String> {
    let mut newest: HashMap<String, &str> = HashMap::new();
    for version in versions {
        let Some(stream) = pre_stream(version) else { continue };
        let held = newest.entry(stream).or_insert(version);
        if compare(version, held) == Ordering::Greater {
            *held = version;
        }
    }
    let mut names: Vec<(String, &str)> = newest.into_iter().collect();
    names.sort_by(|a, b| compare(b.1, a.1).then_with(|| a.0.cmp(&b.0)));
    names.into_iter().map(|(name, _)| name).collect()
}

fn effective_stream(chosen: &str) -> String {
    if !chosen.is_empty() {
        return chosen.to_string();
    }
    pre_stream(crate::VERSION).unwrap_or_default()
}

fn set_progress(phase: &str, received: u64, total: u64, message: &str) {
    if let Ok(mut p) = PROGRESS.lock() {
        *p = UpdateProgress { phase: phase.into(), received, total, message: message.into() };
    }
}

fn current_message() -> String {
    PROGRESS.lock().map(|p| p.message.clone()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sources_must_be_https() {
        assert!(secure_url("https://example.com/x", "X").is_ok());
        assert!(secure_url("http://127.0.0.1:8080/x", "X").is_ok());
        assert!(secure_url("http://localhost/x", "X").is_ok());
        assert!(secure_url("http://127.0.0.1.evil.example/", "X").is_err());
        assert!(secure_url("http://example.com/", "X").is_err());
    }

    #[test]
    fn tags() {
        assert!(safe_tag("v0.11.2"));
        assert!(safe_tag("v0.5.1-security.1"));
        assert!(!safe_tag("v1/../x"));
        assert!(!safe_tag("v1?x=1"));
        assert!(!safe_tag(""));
    }

    #[test]
    fn checksums() {
        let sums = "abc  gitc\ndef *gitc.exe\n";
        assert_eq!(expected_sum(sums, "gitc.exe").as_deref(), Some("def"));
        assert_eq!(expected_sum(sums, "gitc").as_deref(), Some("abc"));
        assert_eq!(expected_sum(sums, "other"), None);
    }

    #[test]
    fn streams_newest_first() {
        let versions: Vec<String> =
            ["0.5.0-rc.1", "0.6.0-conflicts.1", "0.5.1-security.2", "0.5.0"].iter().map(|s| s.to_string()).collect();
        assert_eq!(streams_in(&versions), vec!["conflicts", "security", "rc"]);
    }
}
