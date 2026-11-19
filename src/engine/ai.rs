use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};

use super::git::{git, git_with, hide_console, now_ms};
use super::paths::config_dir;
use super::types::{AiConfig, AiModel, AiProvider, AiRepoProvider, ClaudeStatus, CommitContext, Message};

pub const DIFF_CAP: usize = 60000;

pub const SYSTEM: &str = "You write git commit messages. Answer with the message only: the subject on the first line, \
then a blank line, then the body. No code fences, no quotes around it, no commentary before \
or after. Match the style of the recent commits you are shown: their tense, capitalisation, \
prefixes, subject length, and whether and how long they write a body. Say what the change \
does and, where the diff shows it, why. Do not list every file. Never use tools.";

const ALL_FEATURES: [&str; 5] = ["commitMessage", "explainCommit", "branchName", "squashMessage", "conflictAssist"];
const KINDS: [&str; 3] = ["openai", "anthropic", "claude-code"];
const TIMEOUT: Duration = Duration::from_secs(120);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);
const LOGIN_WAIT: Duration = Duration::from_secs(5);
const LOCK_FILES: [&str; 14] = [
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lockb",
    "bun.lock",
    "Cargo.lock",
    "Gemfile.lock",
    "poetry.lock",
    "Pipfile.lock",
    "uv.lock",
    "composer.lock",
    "go.sum",
    "flake.lock",
];
const CLAUDE_MODELS: [(&str, &str); 4] =
    [("", "Claude Code's default"), ("opus", "Opus"), ("sonnet", "Sonnet"), ("haiku", "Haiku")];

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct StoredConfig {
    enabled: Option<bool>,
    features: Option<Vec<String>>,
    providers: Option<Vec<AiProvider>>,
    default_id: Option<String>,
    repos: Option<Vec<AiRepoProvider>>,
}

struct Launch {
    program: PathBuf,
    prefix: Vec<String>,
}

struct Ran {
    code: i32,
    out: String,
    err: String,
}

pub fn load_ai() -> AiConfig {
    match std::fs::read_to_string(file_path()) {
        Ok(text) => parse_config(&text),
        Err(_) => default_config(),
    }
}

/// Saves the config; a key sent back masked keeps the stored key. Returns what was saved.
pub fn save_ai(config: AiConfig) -> AiConfig {
    let stored = load_ai();
    let providers: Vec<AiProvider> = config
        .providers
        .into_iter()
        .map(|p| match stored.providers.iter().find(|o| o.id == p.id) {
            Some(old) if mask_key(&old.key) == p.key => AiProvider { key: old.key.clone(), ..p },
            _ => p,
        })
        .collect();
    let has = |id: &str| providers.iter().any(|p| p.id == id);
    let default_id = if has(&config.default_id) {
        config.default_id.clone()
    } else {
        providers.first().map(|p| p.id.clone()).unwrap_or_default()
    };
    let repos = config.repos.into_iter().filter(|r| has(&r.provider_id)).collect();
    let saved = AiConfig { enabled: config.enabled, features: config.features, providers, default_id, repos };

    let path = file_path();
    let written = std::fs::create_dir_all(config_dir())
        .and_then(|_| std::fs::write(&path, serde_json::to_string(&saved).unwrap_or_default()));
    if let Err(e) = written {
        eprintln!("gitc: could not save {}: {e}", path.display());
    }

    let kept: Vec<&str> = saved.providers.iter().filter(|p| p.account == "own").map(|p| p.id.as_str()).collect();
    if let Ok(entries) = std::fs::read_dir(config_dir().join("claude")) {
        for entry in entries.flatten() {
            if !kept.contains(&entry.file_name().to_string_lossy().as_ref()) {
                forget_claude(entry.path());
            }
        }
    }
    saved
}

pub fn masked(config: AiConfig) -> AiConfig {
    AiConfig {
        providers: config.providers.into_iter().map(|p| AiProvider { key: mask_key(&p.key), ..p }).collect(),
        ..config
    }
}

/// Signs out and removes the account folder of a provider that was never saved.
pub fn forget_unsaved(id: &str) {
    if load_ai().providers.iter().any(|p| p.id == id) {
        return;
    }
    if let Some(home) = claude_home(id, "own") {
        let home = PathBuf::from(home);
        if home.exists() {
            forget_claude(home);
        }
    }
}

/// The CLAUDE_CONFIG_DIR for a provider: "" for this machine's own sign-in, None for an unusable id.
pub fn claude_home(id: &str, account: &str) -> Option<String> {
    if account != "own" {
        return Some(String::new());
    }
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()) {
        return None;
    }
    Some(config_dir().join("claude").join(id).to_string_lossy().into_owned())
}

pub fn claude_status(home: &str) -> ClaudeStatus {
    let Some(launch) = find_command("claude") else { return ClaudeStatus::default() };
    let Ok(ran) = exec(&launch, &["auth", "status", "--json"], "", &claude_env(home)) else {
        return ClaudeStatus::default();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&ran.out) else {
        return ClaudeStatus { installed: true, ..Default::default() };
    };
    let text = |k: &str| parsed.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    ClaudeStatus {
        installed: true,
        logged_in: parsed.get("loggedIn").and_then(Value::as_bool).unwrap_or(false),
        plan: text("subscriptionType"),
        email: text("email"),
    }
}

/// Starts a login and returns the URL to open.
pub fn start_claude_login(home: &str) -> Result<String, String> {
    let launch = find_command("claude").ok_or("Claude Code is not installed")?;
    if !home.is_empty() {
        let _ = std::fs::create_dir_all(home);
    }
    let mut cmd = command(&launch, &["auth", "login"], &claude_env(home));
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let (tx, rx) = mpsc::channel::<Option<String>>();
    for pipe in [child.stdout.take().map(boxed), child.stderr.take().map(boxed)].into_iter().flatten() {
        let tx = tx.clone();
        std::thread::spawn(move || pump(pipe, |text| tx.send(Some(text)).is_ok()));
    }
    let (done_tx, done_rx) = mpsc::channel::<i32>();
    std::thread::spawn(move || {
        let started = Instant::now();
        let code = loop {
            if let Ok(Some(status)) = child.try_wait() {
                break status.code().unwrap_or(1);
            }
            if started.elapsed() > LOGIN_TIMEOUT {
                let _ = child.kill();
                let _ = child.wait();
                break 1;
            }
            std::thread::sleep(Duration::from_millis(200));
        };
        let _ = done_tx.send(code);
    });
    drop(tx);

    let deadline = Instant::now() + LOGIN_WAIT;
    let mut said = String::new();
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        if let Ok(code) = done_rx.try_recv() {
            while let Ok(Some(text)) = rx.recv_timeout(Duration::from_millis(100)) {
                said.push_str(&text);
            }
            if let Some(url) = login_url(&said) {
                return Ok(url);
            }
            if code == 0 {
                return Ok(String::new());
            }
            let said = said.trim();
            return Err(if said.is_empty() {
                format!("claude auth login exited with {code}")
            } else {
                said.to_string()
            });
        }
        match rx.recv_timeout(left.min(Duration::from_millis(100))) {
            Ok(Some(text)) => {
                said.push_str(&text);
                if let Some(url) = login_url(&said) {
                    return Ok(url);
                }
            }
            Ok(None) | Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => std::thread::sleep(Duration::from_millis(100)),
        }
    }
    Ok(String::new())
}

pub fn list_models(provider: &AiProvider) -> Result<Vec<AiModel>, String> {
    if provider.kind == "claude-code" {
        return Ok(CLAUDE_MODELS
            .iter()
            .map(|(id, label)| AiModel { id: id.to_string(), label: label.to_string() })
            .collect());
    }
    let key = resolve_key(&provider.key);
    let anthropic = provider.kind == "anthropic";
    if anthropic && key.is_empty() {
        return Err("no API key set".into());
    }
    let url = if anthropic {
        "https://api.anthropic.com/v1/models?limit=1000".to_string()
    } else {
        format!("{}/models", trim_slash(&provider.base_url))
    };
    let (status, text) = request(&url, &auth_headers(provider, &key), None).map_err(|e| scrub(&e, &key))?;
    if status >= 400 {
        return Err(scrub(&format!("{status} {}", clip(&text, 300)), &key));
    }
    let parsed: Value =
        serde_json::from_str(&text).map_err(|_| "the provider's model list could not be read".to_string())?;
    let models = parsed
        .get("data")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|m| {
                    let id = m.get("id").and_then(Value::as_str).filter(|s| !s.is_empty())?;
                    let label = ["display_name", "name"]
                        .iter()
                        .find_map(|k| m.get(*k).and_then(Value::as_str).filter(|s| !s.is_empty()))
                        .unwrap_or(id);
                    Some(AiModel { id: id.to_string(), label: label.to_string() })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(models)
}

/// Swaps a masked key sent back by the window for the stored one.
pub fn with_stored_key(provider: AiProvider) -> AiProvider {
    match load_ai().providers.into_iter().find(|p| p.id == provider.id) {
        Some(stored) if provider.key == mask_key(&stored.key) => AiProvider { key: stored.key, ..provider },
        _ => provider,
    }
}

/// Round trip time in milliseconds.
pub fn test_provider(provider: &AiProvider) -> Result<u64, String> {
    let started = now_ms();
    complete(provider, "Answer with the single word OK.", "Say OK.")?;
    Ok(now_ms().saturating_sub(started))
}

pub fn provider_for(config: &AiConfig, host: &str, path: &str) -> Option<AiProvider> {
    let find = |id: &str| config.providers.iter().find(|p| p.id == id);
    config
        .repos
        .iter()
        .find(|r| r.host == host && r.path == path)
        .and_then(|r| find(&r.provider_id))
        .or_else(|| find(&config.default_id))
        .or_else(|| config.providers.first())
        .cloned()
}

pub fn commit_context(repo: &str, amend: bool) -> Result<CommitContext, String> {
    let mut range = vec!["--cached".to_string()];
    if amend {
        range.push(amend_base(repo));
    }
    let diff_args: Vec<&str> =
        ["diff", "--no-color", "--no-ext-diff"].into_iter().chain(range.iter().map(String::as_str)).collect();
    let stat_args: Vec<&str> = ["diff", "--numstat"].into_iter().chain(range.iter().map(String::as_str)).collect();
    let (diff, numstat, recent) = std::thread::scope(|s| {
        let diff = s.spawn(|| git(repo, &diff_args));
        let numstat = s.spawn(|| git(repo, &stat_args));
        let recent = recent_messages(repo);
        (joined(diff.join()), joined(numstat.join()), recent)
    });
    Ok(CommitContext { diff: diff?, numstat: numstat?, recent })
}

pub fn write_commit_message(provider: &AiProvider, context: &CommitContext, hint: &str) -> Result<Message, String> {
    if context.diff.trim().is_empty() {
        return Err("Nothing staged to describe".into());
    }
    let text =
        complete(provider, SYSTEM, &build_prompt(context, hint)).map_err(|e| format!("{}: {e}", provider.name))?;
    let message = parse_reply(&text);
    if message.summary.is_empty() {
        return Err(format!("{} returned no message", provider.name));
    }
    Ok(message)
}

/// One system + user exchange with the provider; the reply text.
pub fn complete(provider: &AiProvider, system: &str, user: &str) -> Result<String, String> {
    if provider.kind == "claude-code" {
        return claude_code(provider, system, user);
    }
    if provider.model.trim().is_empty() {
        return Err("no model set".into());
    }
    let key = resolve_key(&provider.key);
    let anthropic = provider.kind == "anthropic";
    if anthropic && key.is_empty() {
        return Err("no API key set".into());
    }
    let model = provider.model.trim();
    let (url, body) = if anthropic {
        let body = json!({
            "model": model,
            "max_tokens": 16000,
            "system": system,
            "messages": [{ "role": "user", "content": user }],
        });
        ("https://api.anthropic.com/v1/messages".to_string(), body)
    } else {
        let body = json!({
            "model": model,
            "messages": [{ "role": "system", "content": system }, { "role": "user", "content": user }],
        });
        (format!("{}/chat/completions", trim_slash(&provider.base_url)), body)
    };
    let mut headers = auth_headers(provider, &key);
    headers.push(("content-type", "application/json".into()));
    if url.contains("openrouter.ai") {
        headers.push(("http-referer", "https://github.com/Adrriii/gitc".into()));
        headers.push(("x-title", "gitc".into()));
    }
    let (status, text) = request(&url, &headers, Some(&body.to_string())).map_err(|e| scrub(&e, &key))?;
    let Ok(parsed) = serde_json::from_str::<Value>(&text) else {
        return Err(scrub(&format!("{status} {}", clip(&text, 300)), &key));
    };
    let failure = parsed.pointer("/error/message").and_then(Value::as_str).unwrap_or("");
    if status >= 400 || !failure.is_empty() {
        return Err(scrub(&format!("{status} {}", if failure.is_empty() { &text } else { failure }), &key));
    }
    if !anthropic {
        return Ok(parsed.pointer("/choices/0/message/content").and_then(Value::as_str).unwrap_or("").to_string());
    }
    if parsed.get("stop_reason").and_then(Value::as_str) == Some("refusal") {
        return Err("the model declined to answer".into());
    }
    let blocks = parsed.get("content").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    Ok(blocks
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect())
}

pub fn build_prompt(context: &CommitContext, hint: &str) -> String {
    let mut parts = Vec::new();
    let examples: Vec<&str> = context.recent.iter().map(|m| m.trim()).filter(|m| !m.is_empty()).collect();
    if !examples.is_empty() {
        parts.push(format!(
            "Recent commit messages in this repository, newest first, as style examples:\n\n{}",
            examples.join("\n\n-----\n\n")
        ));
    }
    if !hint.trim().is_empty() {
        parts.push(format!(
            "The author's own note about this change. Take it as the intent and improve the wording:\n\n{}",
            hint.trim()
        ));
    }
    parts.push(format!("The staged changes:\n\n{}", trim_diff(&context.diff, &context.numstat, DIFF_CAP)));
    parts.join("\n\n=====\n\n")
}

/// The diff within `cap` bytes: lock files and binaries summarised, files past the cap listed.
pub fn trim_diff(diff: &str, numstat: &str, cap: usize) -> String {
    let counts: HashMap<String, String> = numstat
        .lines()
        .filter_map(|line| {
            let mut cells = line.splitn(3, '\t');
            let (added, removed, name) = (cells.next()?, cells.next()?, cells.next()?);
            let count = if added == "-" { "binary".to_string() } else { format!("+{added} -{removed}") };
            Some((name.to_string(), count))
        })
        .collect();

    let mut kept = String::new();
    let mut summarised = Vec::new();
    let mut omitted = Vec::new();
    for section in sections(diff) {
        let name = section_path(section);
        let count = counts.get(name).map(String::as_str).unwrap_or("");
        if is_binary(section) {
            summarised.push(format!("{name} (binary)"));
        } else if is_lock_file(name) {
            summarised.push(format!("{})", with_count(&format!("{name} (lock file"), count, ", ")));
        } else if kept.len() + section.len() > cap {
            omitted.push(with_count(name, count, " "));
        } else {
            kept.push_str(section);
        }
    }

    let loose = diff.find("diff --git ").map_or(diff, |first| diff.get(..first).unwrap_or(""));
    let mut text = clip_bytes(loose, cap).to_string() + &kept;
    if !summarised.is_empty() {
        text += &format!("\nAlso changed, contents not shown:\n{}\n", summarised.join("\n"));
    }
    if !omitted.is_empty() {
        text += &format!("\nAlso changed, left out for length:\n{}\n", omitted.join("\n"));
    }
    text
}

/// A model's reply as a commit message, tolerating fences and quotes.
pub fn parse_reply(reply: &str) -> Message {
    let mut text = reply.replace("\r\n", "\n").trim().to_string();
    if text.starts_with("```") {
        text = text.split_once('\n').map(|(_, rest)| rest.to_string()).unwrap_or_default();
        if let Some(inner) = text.trim_end().strip_suffix("```") {
            text = inner.to_string();
        }
        text = text.trim().to_string();
    }
    let text = unwrap(unwrap(unwrap(&text, '"'), '\''), '`');
    let mut lines = text.split('\n').skip_while(|l| l.trim().is_empty());
    let Some(summary) = lines.next() else { return Message::default() };
    Message {
        summary: summary.trim().to_string(),
        description: lines.collect::<Vec<_>>().join("\n").trim().to_string(),
    }
}

pub fn mask_key(key: &str) -> String {
    if key.is_empty() || key.starts_with('$') {
        return key.to_string();
    }
    let chars: Vec<char> = key.chars().collect();
    if chars.len() <= 12 {
        return "...".into();
    }
    let head: String = chars.iter().take(6).collect();
    let tail: String = chars.iter().skip(chars.len() - 4).collect();
    format!("{head}...{tail}")
}

fn parse_config(text: &str) -> AiConfig {
    let Ok(raw) = serde_json::from_str::<StoredConfig>(text) else { return default_config() };
    AiConfig {
        enabled: raw.enabled.unwrap_or(false),
        features: raw.features.unwrap_or_else(all_features),
        providers: raw
            .providers
            .unwrap_or_default()
            .into_iter()
            .filter(|p| !p.id.is_empty() && KINDS.contains(&p.kind.as_str()))
            .collect(),
        default_id: raw.default_id.unwrap_or_default(),
        repos: raw.repos.unwrap_or_default(),
    }
}

fn default_config() -> AiConfig {
    AiConfig { features: all_features(), ..Default::default() }
}

fn all_features() -> Vec<String> {
    ALL_FEATURES.iter().map(|f| f.to_string()).collect()
}

fn file_path() -> PathBuf {
    config_dir().join("ai.json")
}

fn forget_claude(home: PathBuf) {
    std::thread::spawn(move || {
        if let Some(launch) = find_command("claude") {
            let _ = exec(&launch, &["auth", "logout"], "", &claude_env(&home.to_string_lossy()));
        }
        if let Err(e) = std::fs::remove_dir_all(&home) {
            eprintln!("gitc: could not remove {}: {e}", home.display());
        }
    });
}

fn claude_code(provider: &AiProvider, system: &str, user: &str) -> Result<String, String> {
    let missing = "claude not found - is Claude Code installed and on PATH?";
    let launch = find_command("claude").ok_or(missing)?;
    let home = claude_home(&provider.id, &provider.account).ok_or("this provider's sign-in folder is unusable")?;
    let mut args =
        vec!["-p", "--tools", "", "--no-session-persistence", "--setting-sources", "", "--system-prompt", system];
    let model = provider.model.trim();
    if !model.is_empty() {
        args.extend(["--model", model]);
    }
    let ran = exec(&launch, &args, user, &claude_env(&home))
        .map_err(|e| if e.contains("not found") { missing.to_string() } else { e })?;
    if ran.code != 0 {
        let said = if ran.err.trim().is_empty() { ran.out.trim() } else { ran.err.trim() };
        return Err(if said.is_empty() { format!("claude exited with {}", ran.code) } else { clip(said, 500) });
    }
    Ok(ran.out)
}

fn auth_headers(provider: &AiProvider, key: &str) -> Vec<(&'static str, String)> {
    if provider.kind == "anthropic" {
        return vec![("x-api-key", key.to_string()), ("anthropic-version", "2023-06-01".into())];
    }
    if key.is_empty() {
        return Vec::new();
    }
    vec![("authorization", format!("Bearer {key}"))]
}

fn request(url: &str, headers: &[(&str, String)], body: Option<&str>) -> Result<(u16, String), String> {
    let agent = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_connect(Some(Duration::from_secs(10)))
            .timeout_global(Some(TIMEOUT))
            .http_status_as_error(false)
            .build(),
    );
    let sent = match body {
        Some(body) => {
            let mut req = agent.post(url);
            for (k, v) in headers {
                req = req.header(*k, v.as_str());
            }
            req.send(body)
        }
        None => {
            let mut req = agent.get(url);
            for (k, v) in headers {
                req = req.header(*k, v.as_str());
            }
            req.call()
        }
    };
    let mut response = sent.map_err(|e| match e {
        ureq::Error::Timeout(_) => format!("no answer after {} s", TIMEOUT.as_secs()),
        other => other.to_string(),
    })?;
    let status = response.status().as_u16();
    let text = response.body_mut().read_to_string().map_err(|e| e.to_string())?;
    Ok((status, text))
}

fn exec(launch: &Launch, args: &[&str], input: &str, env: &[(&str, String)]) -> Result<Ran, String> {
    let mut child = command(launch, args, env).spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("{} not found", launch.program.display())
        } else {
            e.to_string()
        }
    })?;
    let mut stdin = child.stdin.take();
    let input = input.to_string();
    std::thread::spawn(move || {
        if let Some(pipe) = stdin.as_mut() {
            let _ = pipe.write_all(input.as_bytes());
        }
    });
    let read = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut out = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut out);
            }
            String::from_utf8_lossy(&out).into_owned()
        })
    };
    let out = read(child.stdout.take().map(boxed));
    let err = read(child.stderr.take().map(boxed));
    let started = Instant::now();
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code().unwrap_or(1),
            Ok(None) if started.elapsed() > TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("no answer after {} s", TIMEOUT.as_secs()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(e.to_string()),
        }
    };
    Ok(Ran { code, out: out.join().unwrap_or_default(), err: err.join().unwrap_or_default() })
}

fn command(launch: &Launch, args: &[&str], env: &[(&str, String)]) -> Command {
    let mut cmd = Command::new(&launch.program);
    cmd.args(&launch.prefix).args(args).current_dir(std::env::temp_dir());
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for (k, v) in env {
        cmd.env(k, v);
    }
    hide_console(&mut cmd);
    cmd
}

fn boxed<R: Read + Send + 'static>(pipe: R) -> Box<dyn Read + Send> {
    Box::new(pipe)
}

fn pump(mut pipe: Box<dyn Read + Send>, mut send: impl FnMut(String) -> bool) {
    let mut buf = [0u8; 4096];
    while let Ok(n) = pipe.read(&mut buf) {
        if n == 0 || !send(String::from_utf8_lossy(buf.get(..n).unwrap_or_default()).into_owned()) {
            break;
        }
    }
}

fn find_command(name: &str) -> Option<Launch> {
    if !cfg!(windows) {
        return Some(Launch { program: PathBuf::from(name), prefix: Vec::new() });
    }
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let exe = dir.join(format!("{name}.exe"));
        if exe.is_file() {
            return Some(Launch { program: exe, prefix: Vec::new() });
        }
        let cli = dir.join("node_modules").join("@anthropic-ai").join("claude-code").join("cli.js");
        if dir.join(format!("{name}.cmd")).is_file() && cli.is_file() {
            let node = dir.join("node.exe");
            let program = if node.is_file() { node } else { PathBuf::from("node") };
            return Some(Launch { program, prefix: vec![cli.to_string_lossy().into_owned()] });
        }
    }
    None
}

fn claude_env(home: &str) -> Vec<(&'static str, String)> {
    let mut env =
        vec![("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1".to_string()), ("DISABLE_AUTOUPDATER", "1".to_string())];
    if !home.is_empty() {
        env.push(("CLAUDE_CONFIG_DIR", home.to_string()));
    }
    env
}

fn amend_base(repo: &str) -> String {
    if let Ok(parent) = git(repo, &["rev-parse", "--verify", "-q", "HEAD^"]) {
        return parent.trim().to_string();
    }
    git_with(repo, &["hash-object", "-t", "tree", "--stdin"], &[], Some("")).unwrap_or_default().trim().to_string()
}

fn recent_messages(repo: &str) -> Vec<String> {
    git(repo, &["log", "-20", "--format=%B%x00", "HEAD"])
        .map(|log| log.split('\0').map(str::to_string).collect())
        .unwrap_or_default()
}

fn joined(r: std::thread::Result<Result<String, String>>) -> Result<String, String> {
    r.unwrap_or_else(|_| Err("git failed".into()))
}

fn sections(diff: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let Some(mut start) = diff.find("diff --git ") else { return out };
    loop {
        let next = diff.get(start + 1..).and_then(|rest| rest.find("\ndiff --git ")).map(|i| i + start + 1);
        let end = next.map_or(diff.len(), |n| n + 1);
        out.push(diff.get(start..end).unwrap_or(""));
        match next {
            Some(n) => start = n + 1,
            None => return out,
        }
    }
}

fn section_path(section: &str) -> &str {
    let header = section.split('\n').next().unwrap_or("");
    header.rfind(" b/").and_then(|at| header.get(at + 3..)).unwrap_or(header)
}

fn is_binary(section: &str) -> bool {
    section.contains("\nBinary files ") || section.contains("\nGIT binary patch")
}

fn is_lock_file(path: &str) -> bool {
    LOCK_FILES.contains(&path.rsplit('/').next().unwrap_or(path))
}

fn with_count(text: &str, count: &str, separator: &str) -> String {
    if count.is_empty() { text.to_string() } else { format!("{text}{separator}{count}") }
}

fn unwrap(text: &str, mark: char) -> &str {
    if text.chars().count() < 2 {
        return text;
    }
    text.strip_prefix(mark).and_then(|t| t.strip_suffix(mark)).map_or(text, str::trim)
}

fn resolve_key(key: &str) -> String {
    match key.strip_prefix('$') {
        Some(name) => std::env::var(name).unwrap_or_default().trim().to_string(),
        None => key.trim().to_string(),
    }
}

fn scrub(text: &str, key: &str) -> String {
    if key.is_empty() { text.to_string() } else { text.replace(key, "[key]") }
}

fn trim_slash(url: &str) -> &str {
    url.trim().trim_end_matches('/')
}

fn login_url(text: &str) -> Option<String> {
    let start = text.find("https://")?;
    let rest = text.get(start..)?;
    let end = rest.find(char::is_whitespace)?;
    rest.get(..end).map(str::to_string)
}

fn clip(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

fn clip_bytes(text: &str, max: usize) -> &str {
    let mut end = max.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.get(..end).unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(id: &str) -> AiProvider {
        AiProvider { id: id.into(), name: id.into(), kind: "openai".into(), model: "m".into(), ..Default::default() }
    }

    #[test]
    fn config_parsing() {
        let none = parse_config("{nope");
        assert!(!none.enabled);
        assert_eq!(none.features.len(), 5);
        let old = parse_config(r#"{"enabled":true,"providers":[{"id":"a","kind":"anthropic"}]}"#);
        assert!(old.enabled);
        assert_eq!(old.features, all_features());
        assert_eq!(old.providers, vec![AiProvider { id: "a".into(), kind: "anthropic".into(), ..Default::default() }]);
        assert!(parse_config(r#"{"providers":[{"id":"a","kind":"gemini"}]}"#).providers.is_empty());
    }

    #[test]
    fn keys() {
        assert_eq!(mask_key("sk-or-v1-0123456789abcdef"), "sk-or-...cdef");
        assert_eq!(mask_key("short"), "...");
        assert_eq!(mask_key("$OPENROUTER_API_KEY"), "$OPENROUTER_API_KEY");
        let shown = masked(AiConfig {
            providers: vec![AiProvider { key: "sk-or-v1-0123456789abcdef".into(), ..provider("a") }],
            ..Default::default()
        });
        assert_eq!(shown.providers.first().map(|p| p.key.as_str()), Some("sk-or-...cdef"));
    }

    #[test]
    fn resolution() {
        let config = AiConfig {
            enabled: true,
            features: vec![],
            providers: vec![provider("a"), provider("b"), provider("c")],
            default_id: "b".into(),
            repos: vec![
                AiRepoProvider { host: "".into(), path: "/r1".into(), provider_id: "c".into() },
                AiRepoProvider { host: "".into(), path: "/r2".into(), provider_id: "gone".into() },
            ],
        };
        let id = |c: &AiConfig, host: &str, path: &str| provider_for(c, host, path).map(|p| p.id);
        assert_eq!(id(&config, "", "/r1").as_deref(), Some("c"));
        assert_eq!(id(&config, "server", "/r1").as_deref(), Some("b"));
        assert_eq!(id(&config, "", "/r2").as_deref(), Some("b"));
        let no_default = AiConfig { default_id: "x".into(), ..config.clone() };
        assert_eq!(id(&no_default, "", "/z").as_deref(), Some("a"));
        let empty = AiConfig { providers: vec![], ..config };
        assert_eq!(id(&empty, "", "/r1"), None);
    }

    #[test]
    fn claude_homes() {
        assert_eq!(claude_home("abc", "").as_deref(), Some(""));
        assert_eq!(
            claude_home("abc123", "own"),
            Some(config_dir().join("claude").join("abc123").to_string_lossy().into_owned())
        );
        assert_eq!(claude_home("../x", "own"), None);
        assert_eq!(claude_home("", "own"), None);
    }

    #[test]
    fn replies() {
        let m = |s: &str| {
            let r = parse_reply(s);
            (r.summary, r.description)
        };
        assert_eq!(m("Fix the thing\n\nIt was broken."), ("Fix the thing".into(), "It was broken.".into()));
        assert_eq!(m("```\nFix the thing\n\nBody\n```"), ("Fix the thing".into(), "Body".into()));
        assert_eq!(m("```text\nFix it\n```"), ("Fix it".into(), "".into()));
        assert_eq!(m("\"Fix the thing\""), ("Fix the thing".into(), "".into()));
        assert_eq!(m("\r\n\r\nFix it\r\n\r\nLine one\r\nLine two"), ("Fix it".into(), "Line one\nLine two".into()));
        assert_eq!(m("   "), ("".into(), "".into()));
    }

    #[test]
    fn prompt() {
        let section = |path: &str, body: &str| {
            format!("diff --git a/{path} b/{path}\nindex 1..2 100644\n--- a/{path}\n+++ b/{path}\n{body}\n")
        };
        let diff = section("src/a.ts", "+one")
            + &section("package-lock.json", "+lots")
            + "diff --git a/logo.png b/logo.png\nindex 1..2 100644\nBinary files a/logo.png and b/logo.png differ\n"
            + &section("src/big.ts", &format!("+{}", "x".repeat(500)));
        let numstat = "1\t0\tsrc/a.ts\n900\t20\tpackage-lock.json\n-\t-\tlogo.png\n1\t0\tsrc/big.ts\n";

        let trimmed = trim_diff(&diff, numstat, 200);
        assert!(trimmed.contains("+one"));
        assert!(trimmed.contains("package-lock.json (lock file, +900 -20)"));
        assert!(!trimmed.contains("+lots"));
        assert!(trimmed.contains("logo.png (binary)"));
        assert!(trimmed.contains("left out for length:\nsrc/big.ts +1 -0"));
        assert!(!trimmed.contains("xxxxx"));
        assert_eq!(trim_diff("New file: README.md\nhello\n", "", 200), "New file: README.md\nhello\n");

        let context = CommitContext {
            diff: diff.clone(),
            numstat: numstat.into(),
            recent: vec!["Add a thing\n\nBecause.".into(), "".into(), "Fix x".into()],
        };
        let prompt = build_prompt(&context, "fix login");
        assert!(prompt.contains("Add a thing\n\nBecause.\n\n-----\n\nFix x"));
        assert!(prompt.contains("fix login"));
        let bare = CommitContext { diff, numstat: numstat.into(), recent: vec![] };
        assert!(!build_prompt(&bare, "  ").contains("author's own note"));
    }
}
