use std::hash::{BuildHasher, Hasher};
use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::Duration;

use super::paths::config_dir;

static PORT: AtomicU16 = AtomicU16::new(0);
static CLAIMED: Mutex<Option<Claim>> = Mutex::new(None);

struct Claim {
    listener: Option<TcpListener>,
    token: String,
}

/// Uses a fixed port and a separate instance file, so a test instance never meets the user's.
pub fn set_port(port: u16) {
    PORT.store(port, Ordering::Relaxed);
}

/// Asks a running gitc of this user to open `path` (or just come forward). True when it took it.
pub fn hand_off(path: Option<&str>) -> bool {
    let Ok(text) = std::fs::read_to_string(info_file()) else { return false };
    let mut parts = text.split_whitespace();
    let (Some(port), Some(token)) = (parts.next().and_then(|p| p.parse::<u16>().ok()), parts.next()) else {
        return false;
    };
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_secs(2)) else { return false };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let line = match path {
        Some(p) => format!("{token} open {p}\n"),
        None => format!("{token} focus\n"),
    };
    if stream.write_all(line.as_bytes()).is_err() {
        return false;
    }
    let mut reply = String::new();
    let _ = BufReader::new(stream).read_line(&mut reply);
    reply.trim() == "ok"
}

/// Becomes the running instance: binds the loopback listener and publishes how to reach it.
pub fn claim() -> bool {
    let listener = match TcpListener::bind((Ipv4Addr::LOCALHOST, PORT.load(Ordering::Relaxed))) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("gitc: cannot listen for other launches: {e}");
            return false;
        }
    };
    let Ok(addr) = listener.local_addr() else { return false };
    let token = random_token();
    if let Err(e) = write_private(&info_file(), &format!("{} {token}\n", addr.port())) {
        eprintln!("gitc: cannot publish this instance: {e}");
        return false;
    }
    if let Ok(mut claimed) = CLAIMED.lock() {
        *claimed = Some(Claim { listener: Some(listener), token });
    }
    true
}

/// Serves other launches on a background thread. `on_message` gets the path to open, or "" to only focus.
pub fn listen(on_message: impl Fn(String) + Send + 'static) {
    let Some((listener, token)) =
        CLAIMED.lock().ok().and_then(|mut c| c.as_mut().and_then(|c| Some((c.listener.take()?, c.token.clone()))))
    else {
        return;
    };
    let spawned = std::thread::Builder::new().name("instance".into()).spawn(move || {
        for stream in listener.incoming().flatten() {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let mut line = String::new();
            let Ok(mut writer) = stream.try_clone() else { continue };
            if BufReader::new(stream).read_line(&mut line).is_err() {
                continue;
            }
            let Some(message) = parse(&line, &token) else {
                let _ = writer.write_all(b"denied\n");
                continue;
            };
            let _ = writer.write_all(b"ok\n");
            on_message(message);
        }
    });
    if let Err(e) = spawned {
        eprintln!("gitc: cannot start the instance listener: {e}");
    }
}

/// Removes the instance file at exit, unless a newer instance has already replaced it.
pub fn release() {
    let Some(token) = CLAIMED.lock().ok().and_then(|c| c.as_ref().map(|c| c.token.clone())) else { return };
    let file = info_file();
    let ours = std::fs::read_to_string(&file).is_ok_and(|t| t.split_whitespace().nth(1) == Some(token.as_str()));
    if ours {
        let _ = std::fs::remove_file(file);
    }
}

fn parse(line: &str, token: &str) -> Option<String> {
    let line = line.trim_end_matches(['\r', '\n']);
    let (given, rest) = line.split_once(' ')?;
    if given != token {
        return None;
    }
    if rest == "focus" {
        return Some(String::new());
    }
    rest.strip_prefix("open ").filter(|p| !p.is_empty()).map(str::to_string)
}

fn info_file() -> PathBuf {
    match PORT.load(Ordering::Relaxed) {
        0 => config_dir().join("instance"),
        port => config_dir().join(format!("instance-{port}")),
    }
}

fn write_private(path: &PathBuf, text: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(text.as_bytes())
}

fn random_token() -> String {
    (0..4)
        .map(|i| {
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_u64(super::git::now_ms() ^ i);
            h.write_u32(std::process::id());
            format!("{:016x}", h.finish())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages() {
        assert_eq!(parse("abc open C:/x y\n", "abc").as_deref(), Some("C:/x y"));
        assert_eq!(parse("abc focus\r\n", "abc").as_deref(), Some(""));
        assert_eq!(parse("abd focus\n", "abc"), None);
        assert_eq!(parse("abc open \n", "abc"), None);
        assert_eq!(parse("GET / HTTP/1.1\r\n", "abc"), None);
    }

    #[test]
    fn tokens_differ() {
        assert_ne!(random_token(), random_token());
        assert_eq!(random_token().len(), 64);
    }
}
