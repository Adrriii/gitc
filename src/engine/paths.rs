use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

const ALLOWED_SCHEMES: [&str; 5] = ["https://", "http://", "ssh://", "git://", "file://"];

static TEMP_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);
static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Where gitc keeps everything that belongs to this user.
pub fn config_dir() -> PathBuf {
    if let Some(app) = std::env::var_os("APPDATA").filter(|v| !v.is_empty()) {
        return PathBuf::from(app).join("gitc");
    }
    if let Some(home) = std::env::var_os("HOME").filter(|v| !v.is_empty()) {
        return PathBuf::from(home).join(".config").join("gitc");
    }
    PathBuf::from(".gitc")
}

/// A repository-relative path made absolute, or None when it is empty, absolute,
/// or leaves the repository, textually or through a symlink.
pub fn in_repo(repo: &str, path: &str) -> Option<PathBuf> {
    if path.is_empty() || path.contains('\0') {
        return None;
    }
    let rel = Path::new(path);
    if rel.is_absolute() || rel.has_root() || has_drive(path) {
        return None;
    }
    let root = normalize(&std::path::absolute(repo).ok()?);
    let full = normalize(&root.join(rel));
    if !within(&root, &full) {
        return None;
    }
    let real = real_ancestor(&full)?;
    let real_root = real_ancestor(&root)?;
    if real != real_root && !within(&real_root, &real) {
        return None;
    }
    Some(full)
}

pub fn need_in_repo(repo: &str, path: &str) -> Result<PathBuf, String> {
    in_repo(repo, path).ok_or_else(|| format!("{path} is outside the repository"))
}

/// Refuses a value git would read as an option rather than as a name.
pub fn safe_argument<'a>(value: &'a str, what: &str) -> Result<&'a str, String> {
    if value.contains('\0') {
        return Err(format!("that {what} contains a NUL byte"));
    }
    if value.starts_with('-') {
        return Err(format!("a {what} cannot start with \"-\", git would read it as an option"));
    }
    Ok(value)
}

/// A remote URL gitc will hand to git: an allowed scheme, scp-like ssh, or a local path.
pub fn safe_remote_url(url: &str) -> Result<String, String> {
    let value = url.trim();
    if value.is_empty() {
        return Err("the remote needs a URL".into());
    }
    safe_argument(value, "URL")?;
    let lower = value.to_ascii_lowercase();
    if ALLOWED_SCHEMES.iter().any(|s| lower.starts_with(s)) {
        return Ok(value.to_string());
    }
    if value.contains("::") {
        return Err(
            "gitc will not add a remote using a git transport helper; use an https, ssh, git or file URL".into()
        );
    }
    if has_scheme(value) {
        return Err("gitc will not add a remote using that transport; use an https, ssh, git or file URL".into());
    }
    let b = value.as_bytes();
    if b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'/' || b[2] == b'\\') {
        return Ok(value.to_string());
    }
    if is_scp_like(value) {
        return Ok(value.to_string());
    }
    if value.starts_with('/') || value.starts_with('.') || value.starts_with('~') || !value.contains(':') {
        return Ok(value.to_string());
    }
    Err("that does not look like a URL gitc can use for a remote".into())
}

/// A fresh path inside this process's private temp directory.
pub fn temp_file(name: &str) -> Result<PathBuf, String> {
    let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    Ok(temp_dir()?.join(format!("{seq}-{name}")))
}

/// This process's private temp directory, made on first use with an unguessable name.
pub fn temp_dir() -> Result<PathBuf, String> {
    let mut slot = TEMP_DIR.lock().map_err(|_| "temp directory lock poisoned".to_string())?;
    if let Some(dir) = slot.as_ref().filter(|d| d.is_dir()) {
        return Ok(dir.clone());
    }
    let mut last = String::new();
    for _ in 0..8 {
        let dir = std::env::temp_dir().join(format!("gitc-{}-{:016x}", std::process::id(), random()));
        match make_private_dir(&dir) {
            Ok(()) => {
                *slot = Some(dir.clone());
                return Ok(dir);
            }
            Err(e) => last = e.to_string(),
        }
    }
    Err(format!("cannot create a temp directory: {last}"))
}

/// Removes this process's temp directory, if it made one.
pub fn clean_temp_dir() {
    let Ok(mut slot) = TEMP_DIR.lock() else {
        return;
    };
    if let Some(dir) = slot.take() {
        let _ = std::fs::remove_dir_all(dir);
    }
}

fn make_private_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().mode(0o700).create(dir)
    }
    #[cfg(not(unix))]
    std::fs::create_dir(dir)
}

fn random() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    h.finish()
}

fn has_drive(path: &str) -> bool {
    let b = path.as_bytes();
    b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

fn has_scheme(value: &str) -> bool {
    let Some(end) = value.find("://") else {
        return false;
    };
    let scheme = &value[..end];
    let mut chars = scheme.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_alphabetic() && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
}

fn is_scp_like(value: &str) -> bool {
    let Some(colon) = value.find(':') else {
        return false;
    };
    let prefix = &value[..colon];
    let user_char = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '~' | '-');
    let ok = |s: &str, f: &dyn Fn(char) -> bool| !s.is_empty() && s.chars().all(f);
    match prefix.split_once('@') {
        Some((user, host)) => ok(user, &user_char) && ok(host, &|c| user_char(c) || c == '[' || c == ']'),
        None => ok(prefix, &user_char),
    }
}

fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(out.components().next_back(), Some(Component::Normal(_))) {
                    out.pop();
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn within(root: &Path, full: &Path) -> bool {
    full.strip_prefix(root).is_ok_and(|rest| rest.components().next().is_some())
}

fn real_ancestor(full: &Path) -> Option<PathBuf> {
    let mut head = full.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    for _ in 0..64 {
        if std::fs::symlink_metadata(&head).is_ok() {
            let mut real = std::fs::canonicalize(&head).ok()?;
            for name in tail.iter().rev() {
                real.push(name);
            }
            return Some(real);
        }
        tail.push(head.file_name()?.to_os_string());
        if !head.pop() {
            return None;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn abs(p: &str) -> PathBuf {
        normalize(&std::path::absolute(p).unwrap_or_default())
    }

    #[test]
    fn containment() {
        let repo = "/tmp/repo";
        let root = abs(repo);
        assert_eq!(in_repo(repo, "src/main.ts"), Some(root.join("src").join("main.ts")));
        assert_eq!(in_repo(repo, "./src/../a.txt"), Some(root.join("a.txt")));
        assert_eq!(in_repo(repo, "../secret.txt"), None);
        assert_eq!(in_repo(repo, "../../../../etc/passwd"), None);
        assert_eq!(in_repo(repo, "../repo/a.txt"), Some(root.join("a.txt")));
        if cfg!(windows) {
            assert_eq!(in_repo(repo, "..\\secret.txt"), None);
        } else {
            assert_eq!(in_repo(repo, "..\\secret.txt"), Some(root.join("..\\secret.txt")));
        }
        assert_eq!(in_repo(repo, "/etc/passwd"), None);
        assert_eq!(in_repo(repo, "C:/Windows/win.ini"), None);
        assert_eq!(in_repo(repo, "C:secret.txt"), None);
        assert_eq!(in_repo(repo, ""), None);
        assert_eq!(in_repo(repo, "."), None);
        assert_eq!(in_repo(repo, "a\0.txt"), None);
    }

    #[test]
    fn arguments() {
        assert_eq!(safe_argument("feature/login", "branch"), Ok("feature/login"));
        assert_eq!(safe_argument("my-branch", "branch"), Ok("my-branch"));
        assert!(safe_argument("--upload-pack=sh", "ref").is_err());
        assert!(safe_argument("-", "ref").is_err());
        assert!(safe_argument("-x", "ref").is_err());
        assert!(safe_argument("a\0b", "ref").is_err());
    }

    #[test]
    fn remote_urls() {
        for (given, want) in [
            ("https://github.com/a/b.git", "https://github.com/a/b.git"),
            ("ssh://git@host/a/b.git", "ssh://git@host/a/b.git"),
            ("git@github.com:a/b.git", "git@github.com:a/b.git"),
            ("host:a/b.git", "host:a/b.git"),
            ("/srv/git/b.git", "/srv/git/b.git"),
            ("../other", "../other"),
            ("C:/src/other", "C:/src/other"),
            ("  https://x/y  ", "https://x/y"),
            ("http://h/x", "http://h/x"),
            ("git://h/x", "git://h/x"),
            ("file:///srv/x", "file:///srv/x"),
        ] {
            assert_eq!(safe_remote_url(given), Ok(want.to_string()), "{given}");
        }
        for bad in [
            "ext::sh -c whoami",
            "sftp://evil.example/x",
            "gcrypt://h/x",
            "hg://h/x",
            "fd://x",
            "helper://a",
            "ext::sh -c touch% /tmp/x",
            "weird::whatever",
            "--upload-pack=sh",
            "   ",
        ] {
            assert!(safe_remote_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn links() {
        let Ok(sandbox) = temp_file("paths-test") else {
            return;
        };
        let repo = sandbox.join("repo");
        let outside = sandbox.join("outside");
        let _ = std::fs::create_dir_all(repo.join("real"));
        let _ = std::fs::create_dir_all(&outside);
        let _ = std::fs::write(outside.join("secret.txt"), "not yours");
        let _ = std::fs::write(repo.join("real").join("a.txt"), "mine");
        let r = repo.to_string_lossy().to_string();

        assert_eq!(in_repo(&r, "real/a.txt"), Some(repo.join("real").join("a.txt")));
        assert_eq!(in_repo(&r, "real/new.txt"), Some(repo.join("real").join("new.txt")));
        assert_eq!(in_repo(&r, "brand/new/deep.txt"), Some(repo.join("brand").join("new").join("deep.txt")));

        if dir_link(&outside, &repo.join("escape")) && repo.join("escape").join("secret.txt").exists() {
            assert_eq!(in_repo(&r, "escape/secret.txt"), None);
            assert_eq!(in_repo(&r, "escape/planted.txt"), None);
        }
        let _ = std::fs::remove_dir_all(&sandbox);
    }

    #[cfg(windows)]
    fn dir_link(target: &Path, link: &Path) -> bool {
        std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .is_ok_and(|o| o.status.success())
    }

    #[cfg(unix)]
    fn dir_link(target: &Path, link: &Path) -> bool {
        std::os::unix::fs::symlink(target, link).is_ok()
    }
}
