#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Bump {
    Patch,
    Minor,
    Major,
}

/// (setting value, label, hint), loosest threshold first.
pub const UPDATE_LEVELS: [(&str, &str, &str); 3] = [
    ("patch", "Any release", "Patch or newer"),
    ("minor", "Features", "Minor or newer"),
    ("major", "Major only", "Major releases"),
];

/// Should an update from `current` to `latest` interrupt someone whose threshold is `level`?
pub fn should_prompt(current: &str, latest: &str, level: &str) -> bool {
    if current.contains('-') || latest.contains('-') {
        return current != latest;
    }
    bump(current, latest).is_some_and(|size| size >= threshold(level))
}

/// How big a step `latest` is from `current`; None when it is not newer or either is not a version.
pub fn bump(current: &str, latest: &str) -> Option<Bump> {
    let a = parts(current)?;
    let b = parts(latest)?;
    for (i, (x, y)) in a.iter().zip(b.iter()).enumerate() {
        if y > x {
            return Some(match i {
                0 => Bump::Major,
                1 => Bump::Minor,
                _ => Bump::Patch,
            });
        }
        if y < x {
            return None;
        }
    }
    None
}

/// The status bar's version label and tooltip; `remote` is the version of the gitc serving a remote tab.
pub fn version_chip(local: &str, host: Option<&str>, remote: &str) -> (String, String) {
    let Some(host) = host.filter(|_| !remote.is_empty()) else {
        return (format!("v{local}"), format!("gitc {local}"));
    };
    if remote == local {
        return (format!("{host} v{remote}"), format!("gitc {local}, here and on {host}"));
    }
    (format!("v{local} - {host} v{remote}"), format!("gitc {local} here, gitc {remote} on {host}"))
}

fn threshold(level: &str) -> Bump {
    match level {
        "major" => Bump::Major,
        "minor" => Bump::Minor,
        _ => Bump::Patch,
    }
}

fn parts(v: &str) -> Option<[u64; 3]> {
    let trimmed = v.strip_prefix('v').unwrap_or(v);
    if trimmed.is_empty() {
        return None;
    }
    let mut out = [0u64; 3];
    for (i, piece) in trimmed.split('.').enumerate() {
        if piece.is_empty() || !piece.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let n = piece.parse::<u64>().ok()?;
        if let Some(slot) = out.get_mut(i) {
            *slot = n;
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bumps() {
        assert_eq!(bump("0.4.3", "0.4.4"), Some(Bump::Patch));
        assert_eq!(bump("0.4.3", "0.5.0"), Some(Bump::Minor));
        assert_eq!(bump("0.4.3", "1.0.0"), Some(Bump::Major));
        assert_eq!(bump("0.9.0", "0.10.0"), Some(Bump::Minor));
        assert_eq!(bump("0.4.9", "0.4.10"), Some(Bump::Patch));
        assert_eq!(bump("0.4.3", "0.4.3"), None);
        assert_eq!(bump("0.4.3", "0.4.2"), None);
        assert_eq!(bump("1.0.0", "0.9.9"), None);
        assert_eq!(bump("v0.4.3", "v0.5.0"), Some(Bump::Minor));
        assert_eq!(bump("1", "1.0.1"), Some(Bump::Patch));
        assert_eq!(bump("", "0.4.4"), None);
        assert_eq!(bump("0.4.3", "0.5.0-rc1"), None);
        assert_eq!(bump("0.4.3", "2.9.9"), Some(Bump::Major));
        assert_eq!(bump("0.4.3", "0.6.1"), Some(Bump::Minor));
    }

    #[test]
    fn thresholds() {
        assert!(Bump::Patch >= threshold("patch"));
        assert!(Bump::Patch < threshold("minor"));
        assert!(Bump::Minor >= threshold("minor"));
        assert!(Bump::Major >= threshold("minor"));
        assert!(Bump::Minor < threshold("major"));
        assert!(Bump::Major >= threshold("major"));
    }

    #[test]
    fn prompts() {
        assert!(should_prompt("0.4.3", "0.4.4", "patch"));
        assert!(!should_prompt("0.4.3", "0.4.4", "minor"));
        assert!(should_prompt("0.4.3", "0.5.0", "minor"));
        assert!(!should_prompt("0.4.3", "0.4.3", "patch"));
        assert!(should_prompt("0.5.0-rc.1", "0.5.0-rc.2", "major"));
        assert!(should_prompt("0.5.0-rc.2", "0.5.0", "major"));
        assert!(!should_prompt("0.5.0-rc.1", "0.5.0-rc.1", "patch"));
    }

    #[test]
    fn chips() {
        assert_eq!(version_chip("0.5.1", None, "").0, "v0.5.1");
        assert_eq!(version_chip("0.5.1", Some("server"), "0.5.1").0, "server v0.5.1");
        assert_eq!(version_chip("0.5.1", Some("server"), "0.5.1").1, "gitc 0.5.1, here and on server");
        assert_eq!(version_chip("0.5.1", Some("server"), "0.4.9").0, "v0.5.1 - server v0.4.9");
        assert_eq!(version_chip("0.5.1", Some("server"), "").0, "v0.5.1");
    }
}
