use std::cmp::Ordering;

pub fn is_prerelease(version: &str) -> bool {
    version.contains('-')
}

/// Semver ordering: numbers first, then a prerelease is older than its release.
pub fn compare(a: &str, b: &str) -> Ordering {
    let (an, ap) = split_version(a);
    let (bn, bp) = split_version(b);
    for i in 0..3 {
        let l = an.get(i).copied().unwrap_or(0);
        let r = bn.get(i).copied().unwrap_or(0);
        if l != r {
            return l.cmp(&r);
        }
    }
    match (ap.is_empty(), bp.is_empty()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (false, false) => compare_pre(&ap, &bp),
    }
}

/// The prerelease stream name ("security" in 0.5.1-security.1), if any.
pub fn pre_stream(version: &str) -> Option<String> {
    let (_, tail) = version.split_once('-')?;
    tail.split('.').find(|p| !p.is_empty() && numeric(p).is_none()).map(str::to_string)
}

fn split_version(v: &str) -> (Vec<u64>, Vec<&str>) {
    let (head, tail) = v.split_once('-').unwrap_or((v, ""));
    let nums = head.split('.').map(leading_number).collect();
    let pre = if tail.is_empty() { Vec::new() } else { tail.split('.').collect() };
    (nums, pre)
}

fn compare_pre(a: &[&str], b: &[&str]) -> Ordering {
    for i in 0..a.len().max(b.len()) {
        let (Some(l), Some(r)) = (a.get(i), b.get(i)) else {
            return a.len().cmp(&b.len());
        };
        let order = match (numeric(l), numeric(r)) {
            (Some(x), Some(y)) => x.cmp(&y),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => l.cmp(r),
        };
        if order != Ordering::Equal {
            return order;
        }
    }
    Ordering::Equal
}

fn numeric(piece: &str) -> Option<u64> {
    let n: u64 = piece.parse().ok()?;
    (n.to_string() == piece).then_some(n)
}

fn leading_number(piece: &str) -> u64 {
    let digits: String = piece.trim_start().chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering::*;

    #[test]
    fn ordering() {
        assert_eq!(compare("0.4.5", "0.4.4"), Greater);
        assert_eq!(compare("0.4.4", "0.4.5"), Less);
        assert_eq!(compare("0.4.4", "0.4.4"), Equal);
        assert_eq!(compare("0.10.0", "0.9.0"), Greater);
        assert_eq!(compare("0.4.10", "0.4.9"), Greater);
        assert_eq!(compare("0.5.0-rc.1", "0.5.0"), Less);
        assert_eq!(compare("0.5.0", "0.5.0-rc.1"), Greater);
        assert_eq!(compare("0.5.0-rc.2", "0.5.0-rc.1"), Greater);
        assert_eq!(compare("0.5.0-rc.10", "0.5.0-rc.9"), Greater);
        assert_eq!(compare("0.5.0-rc.1", "0.5.0-rc.1"), Equal);
        assert_eq!(compare("0.4.5-rc.1", "0.4.4"), Greater);
        assert_eq!(compare("0.4.5-rc.1", "0.4.5"), Less);
        assert_eq!(compare("0.5.0-rc", "0.5.0-rc.1"), Less);
        assert_eq!(compare("0.5.1-security.1", "0.4.5-rc.9"), Greater);
        assert_eq!(compare("0.5.1-security.2", "0.5.1-security.1"), Greater);
        assert_eq!(compare("0.5.1", "0.5.1-security.9"), Greater);
        assert_eq!(compare("1.0.0", "0.11.2"), Greater);
        assert!(!is_prerelease("0.4.4"));
        assert!(is_prerelease("0.5.0-rc.1"));
    }

    #[test]
    fn streams() {
        assert_eq!(pre_stream("0.5.1-security.1").as_deref(), Some("security"));
        assert_eq!(pre_stream("0.6.0-conflicts.2").as_deref(), Some("conflicts"));
        assert_eq!(pre_stream("0.4.5-rc.1").as_deref(), Some("rc"));
        assert_eq!(pre_stream("0.5.0"), None);
        assert_eq!(pre_stream("0.5.1-security").as_deref(), Some("security"));
        assert_eq!(pre_stream("0.5.1-remote-ssh.1").as_deref(), Some("remote-ssh"));
        assert_eq!(pre_stream("0.5.1-1.2"), None);
        assert_eq!(pre_stream("0.5.1-"), None);
    }
}
