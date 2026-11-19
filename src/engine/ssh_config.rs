use std::path::{Path, PathBuf};

use super::types::SshHost;

struct SshConfig {
    hosts: Vec<SshHost>,
    includes: Vec<String>,
}

/// Every literal host the user's ssh config offers, following `Include`.
pub fn read_ssh_hosts() -> Vec<SshHost> {
    let ssh_dir = home().join(".ssh");
    let mut out: Vec<SshHost> = Vec::new();
    let mut seen: Vec<PathBuf> = Vec::new();
    let mut queue = std::collections::VecDeque::from([ssh_dir.join("config")]);
    let mut guard = 0;

    while let Some(path) = queue.pop_front() {
        guard += 1;
        if guard > 64 {
            break;
        }
        if seen.contains(&path) {
            continue;
        }
        seen.push(path.clone());
        let Ok(text) = std::fs::read_to_string(&path) else { continue };

        let parsed = parse_ssh_config(&text);
        for host in parsed.hosts {
            if !out.iter().any(|h| h.alias == host.alias) {
                out.push(host);
            }
        }
        for inc in parsed.includes {
            let tilde = match inc.strip_prefix("~/") {
                Some(rest) => home().join(rest),
                None => PathBuf::from(&inc),
            };
            let full = if tilde.is_absolute() { tilde } else { ssh_dir.join(tilde) };
            queue.extend(expand(&full));
        }
    }
    out
}

fn parse_ssh_config(text: &str) -> SshConfig {
    let mut hosts: Vec<SshHost> = Vec::new();
    let mut includes = Vec::new();
    let mut current: Vec<usize> = Vec::new();

    for raw in text.split('\n') {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, rest)) = split(line) else { continue };

        match key.as_str() {
            "host" => {
                current.clear();
                for pattern in rest.split_whitespace() {
                    let alias = unquote(pattern);
                    if !is_literal(alias) {
                        continue;
                    }
                    if let Some(i) = hosts.iter().position(|h| h.alias == alias) {
                        current.push(i);
                        continue;
                    }
                    hosts.push(SshHost { alias: alias.to_string(), ..Default::default() });
                    current.push(hosts.len() - 1);
                }
            }
            "match" => current.clear(),
            "include" => includes.extend(rest.split_whitespace().map(|p| unquote(p).to_string())),
            _ => {
                let value = unquote(rest);
                for &i in &current {
                    let Some(host) = hosts.get_mut(i) else { continue };
                    match key.as_str() {
                        "hostname" if host.host_name.is_none() => host.host_name = Some(value.to_string()),
                        "user" if host.user.is_none() => host.user = Some(value.to_string()),
                        "port" if host.port.is_none() => host.port = value.parse::<u16>().ok().filter(|&n| n > 0),
                        _ => {}
                    }
                }
            }
        }
    }
    SshConfig { hosts, includes }
}

fn split(line: &str) -> Option<(String, &str)> {
    let cut = line.find(|c: char| c == '=' || c.is_whitespace())?;
    let key = line.get(..cut)?.to_lowercase();
    let mut rest = line.get(cut + 1..)?.trim();
    if let Some(after) = rest.strip_prefix('=') {
        rest = after.trim();
    }
    if key.is_empty() || rest.is_empty() {
        return None;
    }
    Some((key, rest))
}

fn expand(pattern: &Path) -> Vec<PathBuf> {
    let Some(name) = pattern.file_name().and_then(|n| n.to_str()) else { return vec![pattern.to_path_buf()] };
    if !name.contains(['*', '?']) {
        return vec![pattern.to_path_buf()];
    }
    let Some(dir) = pattern.parent() else { return Vec::new() };
    if dir.to_string_lossy().contains(['*', '?']) {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| e.file_name().to_str().is_some_and(|entry| matches(entry, name)))
        .map(|e| e.path())
        .collect();
    out.sort();
    out
}

fn matches(name: &str, pattern: &str) -> bool {
    if name.starts_with('.') && !pattern.starts_with('.') {
        return false;
    }
    let name: Vec<char> = name.chars().collect();
    let pattern: Vec<char> = pattern.chars().collect();
    glob(&name, &pattern)
}

fn glob(name: &[char], pattern: &[char]) -> bool {
    let Some((&p, pattern_rest)) = pattern.split_first() else { return name.is_empty() };
    let first = name.split_first();
    match p {
        '*' => glob(name, pattern_rest) || first.is_some_and(|(&c, rest)| c != '/' && glob(rest, pattern)),
        '?' => first.is_some_and(|(&c, rest)| c != '/' && glob(rest, pattern_rest)),
        _ => first.is_some_and(|(&c, rest)| c == p && glob(rest, pattern_rest)),
    }
}

fn is_literal(pattern: &str) -> bool {
    !pattern.is_empty() && !pattern.contains(['*', '?']) && !pattern.starts_with('!')
}

fn unquote(v: &str) -> &str {
    v.strip_prefix('"').and_then(|s| s.strip_suffix('"')).unwrap_or(v)
}

fn home() -> PathBuf {
    ["USERPROFILE", "HOME"]
        .iter()
        .find_map(|k| std::env::var_os(k).filter(|v| !v.is_empty()))
        .map(PathBuf::from)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    type Row = (String, Option<String>, Option<String>, Option<u16>);

    fn hosts(text: &str) -> Vec<Row> {
        parse_ssh_config(text).hosts.into_iter().map(|h| (h.alias, h.host_name, h.user, h.port)).collect()
    }

    fn aliases(text: &str) -> Vec<String> {
        parse_ssh_config(text).hosts.into_iter().map(|h| h.alias).collect()
    }

    fn one(alias: &str, host_name: Option<&str>, user: Option<&str>, port: Option<u16>) -> Vec<Row> {
        vec![(alias.to_string(), host_name.map(String::from), user.map(String::from), port)]
    }

    #[test]
    fn parses_hosts() {
        assert_eq!(
            hosts("Host build\n  HostName 10.0.0.4\n  User adri\n  Port 2222\n"),
            one("build", Some("10.0.0.4"), Some("adri"), Some(2222))
        );
        assert_eq!(hosts("HOST build\n  hostname h\n"), one("build", Some("h"), None, None));
        assert_eq!(hosts("Host=build\nHostName=h\n"), one("build", Some("h"), None, None));
        assert_eq!(hosts("Host = build\n  HostName = h\n"), one("build", Some("h"), None, None));
        assert_eq!(hosts("Host \"build\"\n  User \"a d\"\n"), one("build", None, Some("a d"), None));
        assert_eq!(hosts("Host build\r\n  User adri\r\n"), one("build", None, Some("adri"), None));
    }

    #[test]
    fn first_value_wins() {
        assert_eq!(hosts("Host build\n  HostName first\n  HostName second\n"), one("build", Some("first"), None, None));
        assert_eq!(
            hosts("Host build\n  HostName first\nHost build\n  HostName second\n"),
            one("build", Some("first"), None, None)
        );
    }

    #[test]
    fn patterns_are_not_hosts() {
        assert!(aliases("Host *\n  User adri\n").is_empty());
        assert!(aliases("Host *.internal\n").is_empty());
        assert!(aliases("Host build?\n").is_empty());
        assert!(aliases("Host !build\n").is_empty());
        assert_eq!(aliases("Host build * deploy\n"), ["build", "deploy"]);
    }

    #[test]
    fn several_hosts_per_line() {
        assert_eq!(aliases("Host build deploy\n"), ["build", "deploy"]);
        let users: Vec<Option<String>> =
            parse_ssh_config("Host build deploy\n  User adri\n").hosts.into_iter().map(|h| h.user).collect();
        assert_eq!(users, [Some("adri".to_string()), Some("adri".to_string())]);
    }

    #[test]
    fn odd_lines() {
        assert_eq!(aliases("# a comment\n\nHost build\n   # another\n"), ["build"]);
        assert_eq!(
            hosts("Host build\n  User adri\nMatch host other\n  User wrong\n"),
            one("build", None, Some("adri"), None)
        );
        assert_eq!(aliases("User adri\nHost build\n"), ["build"]);
        assert_eq!(hosts("Host b\n  Port nope\n"), one("b", None, None, None));
        assert_eq!(hosts("Host b\n  Port -1\n"), one("b", None, None, None));
        assert_eq!(
            hosts("Host b\n  ProxyCommand ssh -W %h:%p jump\n  User adri\n"),
            one("b", None, Some("adri"), None)
        );
        assert!(aliases("").is_empty());
        assert_eq!(aliases("Host\nHost build\n"), ["build"]);
    }

    #[test]
    fn includes() {
        assert_eq!(parse_ssh_config("Include conf.d/*\nHost b\n").includes, ["conf.d/*"]);
        assert_eq!(parse_ssh_config("Include a b\n").includes, ["a", "b"]);
    }

    #[test]
    fn globs() {
        assert!(matches("work", "*"));
        assert!(matches("config-work", "config-*"));
        assert!(!matches("a/b", "a*"));
        assert!(matches("cfg1", "cfg?"));
        assert!(!matches("cfg12", "cfg?"));
        assert!(!matches("configXd", "config.d"));
        assert!(matches("config.d", "config.d"));
        assert!(!matches("myconfig", "config"));
        assert!(!matches(".config.swp", "*"));
        assert!(!matches(".bak", "conf*"));
        assert!(matches(".keep", ".*"));
    }
}
