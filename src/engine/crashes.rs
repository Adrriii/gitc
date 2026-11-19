use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::paths::config_dir;
use super::types::CrashReport;

const KEEP: usize = 50;

static WRITTEN: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// Writes one report, once per distinct report per process. Never fails loudly.
pub fn record_crash(source: &str, message: &str, detail: &str) {
    let key = format!("{source}|{message}|{detail}");
    if let Ok(mut written) = WRITTEN.lock() {
        if !written.get_or_insert_with(HashSet::new).insert(key) {
            return;
        }
    }
    if let Err(e) = write_report(source, message, detail) {
        eprintln!("gitc: could not write a crash report: {e}");
    }
}

/// Every report, newest first.
pub fn list_crashes() -> Vec<CrashReport> {
    let dir = dir();
    report_ids(&dir)
        .into_iter()
        .rev()
        .filter_map(|id| {
            let text = std::fs::read_to_string(dir.join(format!("{id}.json"))).ok()?;
            let report: CrashReport = serde_json::from_str(&text).ok()?;
            Some(CrashReport { id, ..report })
        })
        .collect()
}

/// Deletes one report, or all of them when `id` is empty.
pub fn clear_crashes(id: &str) {
    let dir = dir();
    for known in report_ids(&dir) {
        if id.is_empty() || known == id {
            let _ = std::fs::remove_file(dir.join(format!("{known}.json")));
        }
    }
}

pub fn crash_dir() -> String {
    dir().to_string_lossy().into_owned()
}

/// Records every panic as an "engine" report, on top of the default message.
pub fn install_panic_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panic".to_string());
        let place = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        let thread = std::thread::current().name().unwrap_or("unnamed").to_string();
        let backtrace = std::backtrace::Backtrace::force_capture();
        let detail = format!("Panicked at {place} on thread {thread}.\n\n{backtrace}");
        record_crash("engine", &message, &detail);
        default(info);
    }));
}

fn dir() -> PathBuf {
    config_dir().join("crashes")
}

fn write_report(source: &str, message: &str, detail: &str) -> std::io::Result<()> {
    let dir = dir();
    std::fs::create_dir_all(&dir)?;
    let time = iso_now();
    let stamp = time.replace([':', '.'], "-");
    let mut id = format!("{stamp}-{source}");
    let mut n = 1;
    while dir.join(format!("{id}.json")).exists() {
        n += 1;
        id = format!("{stamp}-{source}-{n}");
    }
    let report = CrashReport {
        id: id.clone(),
        time,
        version: crate::VERSION.to_string(),
        platform: format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        source: source.to_string(),
        message: message.to_string(),
        detail: detail.to_string(),
    };
    let json = serde_json::to_string(&report).map_err(std::io::Error::other)?;
    std::fs::write(dir.join(format!("{id}.json")), json)?;
    let ids = report_ids(&dir);
    for old in ids.iter().take(ids.len().saturating_sub(KEEP)) {
        let _ = std::fs::remove_file(dir.join(format!("{old}.json")));
    }
    Ok(())
}

fn report_ids(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut ids: Vec<String> = entries
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter_map(|name| name.strip_suffix(".json").map(str::to_string))
        .filter(|id| is_report_id(id))
        .collect();
    ids.sort();
    ids
}

fn is_report_id(id: &str) -> bool {
    let mut parts = id.rsplitn(2, '-');
    let (Some(tail), Some(head)) = (parts.next(), parts.next()) else { return false };
    let (stamp, source) = if tail.chars().all(|c| c.is_ascii_digit()) && !tail.is_empty() {
        let Some((stamp, source)) = head.rsplit_once('-') else { return false };
        (stamp, source)
    } else {
        (head, tail)
    };
    !stamp.is_empty()
        && stamp.chars().all(|c| c.is_ascii_digit() || c == 'T' || c == 'Z' || c == '-')
        && !source.is_empty()
        && source.chars().all(|c| c.is_ascii_lowercase())
}

/// The current UTC time as ISO 8601 with milliseconds, like JavaScript's toISOString.
pub fn iso_now() -> String {
    let ms = super::git::now_ms();
    let secs = ms / 1000;
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3600, rem % 3600 / 60, rem % 60, ms % 1000)
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_ids_are_recognised() {
        assert!(is_report_id("2026-11-18T10-20-30-123Z-engine"));
        assert!(is_report_id("2026-11-18T10-20-30-123Z-window-2"));
        assert!(!is_report_id("running-1234"));
        assert!(!is_report_id("../evil"));
        assert!(!is_report_id("2026-11-18T10-20-30-123Z-Engine"));
    }

    #[test]
    fn dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_775), (2026, 11, 18));
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
    }
}
