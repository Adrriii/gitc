use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use rusty_leveldb::{DB, LdbIterator, Options};

use super::settings::Settings;
use crate::engine::paths::{config_dir, temp_file};

const PROFILES: [&str; 2] = ["gitc-window", "gitc-dialog"];
const ORIGIN: &str = "http://127.0.0.1:7893";

/// Carries over what 0.11 kept in its browser window, closes that window, and retires its browser profiles.
pub fn adopt() {
    let dir = config_dir();
    let profiles: Vec<PathBuf> = PROFILES.iter().map(|p| dir.join(p)).filter(|p| p.is_dir()).collect();
    if profiles.is_empty() {
        return;
    }
    close_windows(&profiles);
    if !Settings::exists() {
        let store = dir.join("gitc-window").join("Default").join("Local Storage").join("leveldb");
        let Some(stored) = read_store(&store) else {
            eprintln!("gitc: could not read the 0.11 settings in {}, trying again next start", store.display());
            return;
        };
        let mut settings = Settings::default();
        apply(&mut settings, &stored);
        settings.save();
    }
    for profile in profiles {
        let _ = std::fs::remove_dir_all(profile);
    }
}

fn apply(s: &mut Settings, stored: &BTreeMap<String, String>) {
    let get = |key: &str| stored.get(&format!("gitc.{key}")).map(|v| v.trim());
    let num = |key: &str| get(key).and_then(|v| v.parse::<f64>().ok()).filter(|n| n.is_finite());
    let flag = |key: &str| match get(key) {
        Some("1") => Some(true),
        Some("0") => Some(false),
        _ => None,
    };
    if let Some(n) = num("tabSize").map(|n| n as usize).filter(|n| super::settings::TAB_SIZES.contains(n)) {
        s.tab_size = n;
    }
    if let Some(n) = num("fetchMinutes").filter(|n| *n >= 0.0) {
        s.fetch_minutes = n as u64;
    }
    if let Some(n) = num("updateCheckMinutes") {
        s.update_check_minutes = n as i64;
    }
    if let Some(n) = num("remoteHoldMinutes").filter(|n| *n >= 0.0) {
        s.remote_hold_minutes = n as u64;
    }
    s.diff_wrap = flag("diffWrap").unwrap_or(s.diff_wrap);
    s.fetch_on_focus = flag("fetchOnFocus").unwrap_or(s.fetch_on_focus);
    s.branch_folders = flag("branchFolders").unwrap_or(s.branch_folders);
    s.avatars = get("avatars") != Some("0");
    if let Some(list) = get("hiddenCommands") {
        s.hidden_commands = list.split(',').map(str::trim).filter(|n| !n.is_empty()).map(String::from).collect();
    }
    for (key, slot) in [
        ("updateChannel", &mut s.update_channel),
        ("updateStream", &mut s.update_stream),
        ("updateLevel", &mut s.update_level),
    ] {
        if let Some(v) = get(key).filter(|v| !v.is_empty()) {
            *slot = v.to_string();
        }
    }
    if let Some(v) = get("themePreset").filter(|v| !v.is_empty()) {
        s.theme_preset = v.to_string();
    }
    if let Some(map) = get("themeOverrides").and_then(|v| serde_json::from_str::<BTreeMap<String, String>>(v).ok()) {
        s.theme_overrides = map;
    }
    for (key, slot) in
        [("sidebarWidth", &mut s.sidebar_width), ("panelWidth", &mut s.panel_width), ("chipsWidth", &mut s.chips_width)]
    {
        if let Some(n) = num(key).filter(|n| *n > 0.0) {
            *slot = n as f32;
        }
    }
    s.graph_width = num("graphWidth").filter(|n| *n > 0.0).map(|n| n as f32);
}

/// The `gitc.*` localStorage entries of 0.11's window, read from a copy so the original stays untouched.
fn read_store(store: &Path) -> Option<BTreeMap<String, String>> {
    if !store.is_dir() {
        return Some(BTreeMap::new());
    }
    let copy = temp_file("legacy-store").ok()?;
    std::fs::create_dir_all(&copy).ok()?;
    for entry in std::fs::read_dir(store).ok()?.flatten() {
        if entry.file_name() != "LOCK" {
            std::fs::copy(entry.path(), copy.join(entry.file_name())).ok()?;
        }
    }
    let read = std::panic::catch_unwind(|| entries(&copy)).ok().flatten();
    let _ = std::fs::remove_dir_all(&copy);
    let mut by_origin: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    for (key, value) in read? {
        let Some((origin, name)) = split_key(&key) else { continue };
        let (Some(name), Some(value)) = (decode(name), decode(&value)) else { continue };
        if name.starts_with("gitc.") {
            by_origin.entry(origin).or_default().insert(name, value);
        }
    }
    let preferred = by_origin.remove(ORIGIN);
    Some(preferred.or_else(|| by_origin.into_values().max_by_key(BTreeMap::len)).unwrap_or_default())
}

fn entries(dir: &Path) -> Option<Vec<(Vec<u8>, Vec<u8>)>> {
    let options = Options { create_if_missing: false, ..Options::default() };
    let mut db = DB::open(dir, options).ok()?;
    let mut iter = db.new_iter().ok()?;
    let mut out = Vec::new();
    while let Some(pair) = iter.next() {
        out.push(pair);
    }
    Some(out)
}

fn close_windows(profiles: &[PathBuf]) {
    #[cfg(windows)]
    {
        let names: Vec<String> =
            profiles.iter().map(|p| format!("'{}'", p.display().to_string().replace('\'', "''"))).collect();
        let script = format!(
            "$want = @({}); $found = @(Get-CimInstance Win32_Process | Where-Object {{ $c = $_.CommandLine; \
             $c -and ($want | Where-Object {{ $c.IndexOf($_, [StringComparison]::OrdinalIgnoreCase) -ge 0 }}) }}); \
             if ($found.Count -eq 0) {{ exit }}; \
             $main = @($found | ForEach-Object {{ Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }} | \
             Where-Object {{ $_.MainWindowHandle -ne 0 }}); \
             foreach ($g in $main) {{ [void]$g.CloseMainWindow() }}; \
             foreach ($g in $main) {{ [void]$g.WaitForExit(5000) }}; \
             foreach ($p in $found) {{ Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }}",
            names.join(",")
        );
        crate::engine::install::powershell(&script);
    }
    #[cfg(not(windows))]
    {
        let Ok(procs) = std::fs::read_dir("/proc") else { return };
        let wanted: Vec<String> = profiles.iter().map(|p| p.display().to_string()).collect();
        let pids: Vec<String> = procs
            .flatten()
            .filter_map(|e| {
                let pid = e.file_name().to_string_lossy().into_owned();
                let cmdline = std::fs::read(e.path().join("cmdline")).ok()?;
                let text = String::from_utf8_lossy(&cmdline);
                wanted.iter().any(|w| text.contains(w.as_str())).then_some(pid)
            })
            .collect();
        if pids.is_empty() {
            return;
        }
        let _ = std::process::Command::new("kill").args(&pids).status();
        for _ in 0..30 {
            if pids.iter().all(|pid| !Path::new("/proc").join(pid).exists()) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        let _ = std::process::Command::new("kill").arg("-9").args(&pids).status();
    }
}

/// Chromium's localStorage key: `_` + origin + NUL + the encoded script key.
fn split_key(key: &[u8]) -> Option<(String, &[u8])> {
    let rest = key.strip_prefix(b"_")?;
    let nul = rest.iter().position(|b| *b == 0)?;
    let origin = String::from_utf8_lossy(rest.get(..nul)?).into_owned();
    Some((origin, rest.get(nul + 1..)?))
}

/// Chromium's string encoding: a 1 byte then Latin-1, or a 0 byte then UTF-16LE.
fn decode(bytes: &[u8]) -> Option<String> {
    match bytes.split_first()? {
        (1, rest) => Some(rest.iter().map(|b| char::from(*b)).collect()),
        (0, rest) => {
            let units: Vec<u16> =
                rest.chunks_exact(2).filter_map(|c| <[u8; 2]>::try_from(c).ok()).map(u16::from_le_bytes).collect();
            String::from_utf16(&units).ok()
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_chromium_local_storage_entries() {
        let (origin, name) = split_key(b"_http://127.0.0.1:7893\x00\x01gitc.tabSize").expect("split");
        assert_eq!(origin, ORIGIN);
        assert_eq!(decode(name).as_deref(), Some("gitc.tabSize"));
        let utf16: Vec<u8> = std::iter::once(0).chain("é1".encode_utf16().flat_map(u16::to_le_bytes)).collect();
        assert_eq!(decode(&utf16).as_deref(), Some("é1"));
        assert_eq!(decode(b"\x02x"), None);
        assert_eq!(split_key(b"META:http://127.0.0.1:7893"), None);
    }

    #[test]
    fn maps_0_11_settings() {
        let stored: BTreeMap<String, String> = [
            ("gitc.tabSize", "8"),
            ("gitc.diffWrap", "0"),
            ("gitc.fetchMinutes", "15"),
            ("gitc.hiddenCommands", "push, stash"),
            ("gitc.themePreset", "ember"),
            ("gitc.themeOverrides", "{\"bg-0\":\"#101010\"}"),
            ("gitc.avatars", "0"),
            ("gitc.panelWidth", "512.5"),
            ("gitc.updateCheckMinutes", "-1"),
            ("gitc.tabSize.bogus", "x"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        let mut s = Settings::default();
        apply(&mut s, &stored);
        assert_eq!(s.tab_size, 8);
        assert!(!s.diff_wrap);
        assert_eq!(s.fetch_minutes, 15);
        assert_eq!(s.hidden_commands, vec!["push".to_string(), "stash".to_string()]);
        assert_eq!(s.theme_preset, "ember");
        assert_eq!(s.theme_overrides.get("bg-0").map(String::as_str), Some("#101010"));
        assert!(!s.avatars);
        assert_eq!(s.panel_width, 512.5);
        assert_eq!(s.update_check_minutes, -1);
        assert!(s.fetch_on_focus);
        assert_eq!(s.graph_width, None);
    }
}
