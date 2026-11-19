use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use super::types::{FileChange, GitCall, LineCounts, Person, RawCommit, WorkingFile, WorktreeChanges};

const HISTORY_LIMIT: usize = 2000;

const NOISE_EXACT: [&str; 6] = ["-z", "--no-optional-locks", "--porcelain", "--no-color", "--null", "-uall"];
const NOISE_PREFIX: [&str; 4] = ["--porcelain=", "--format=", "--pretty=format:", "--max-buffer="];

struct History {
    calls: Vec<GitCall>,
    next_id: u64,
    next_seq: u64,
}

static HISTORY: Mutex<History> = Mutex::new(History { calls: Vec::new(), next_id: 1, next_seq: 1 });

pub struct Ran {
    pub code: i32,
    pub out: Vec<u8>,
    pub err: String,
}

impl Ran {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.out).into_owned()
    }
}

/// Runs git and returns its stdout, or stderr (trimmed) as the error.
pub fn git<S: AsRef<str>>(repo: &str, args: &[S]) -> Result<String, String> {
    git_with(repo, args, &[], None)
}

pub fn git_with<S: AsRef<str>>(
    repo: &str,
    args: &[S],
    env: &[(&str, &str)],
    input: Option<&str>,
) -> Result<String, String> {
    let ran = run_logged(repo, args, env, input.map(|s| s.as_bytes()))?;
    if ran.code != 0 {
        let err = ran.err.trim();
        if err.is_empty() {
            return Err(format!("git exited with {}", ran.code));
        }
        return Err(err.to_string());
    }
    Ok(ran.text())
}

/// Raw stdout bytes, or None when git failed.
pub fn git_bytes<S: AsRef<str>>(repo: &str, args: &[S]) -> Option<Vec<u8>> {
    let ran = run_logged(repo, args, &[], None).ok()?;
    if ran.code != 0 {
        return None;
    }
    Some(ran.out)
}

pub fn git_or_none<S: AsRef<str>>(repo: &str, args: &[S]) -> Option<String> {
    git(repo, args).ok()
}

/// Runs git, recorded in the history, returning whatever it produced whatever its exit code.
pub fn run_logged<S: AsRef<str>>(
    repo: &str,
    args: &[S],
    env: &[(&str, &str)],
    input: Option<&[u8]>,
) -> Result<Ran, String> {
    let args: Vec<&str> = args.iter().map(|a| a.as_ref()).collect();
    let started = now_ms();
    let id = begin(repo, &args);
    let result = run(repo, &args, env, input);
    let ok = matches!(&result, Ok(r) if r.code == 0);
    finish(id, started, ok);
    result
}

/// The commands run since `after`, by sequence number.
pub fn git_history(after: u64) -> Vec<GitCall> {
    let Ok(h) = HISTORY.lock() else { return Vec::new() };
    h.calls.iter().filter(|c| c.seq > after).cloned().collect()
}

fn run(repo: &str, args: &[&str], env: &[(&str, &str)], input: Option<&[u8]>) -> Result<Ran, String> {
    let mut cmd = Command::new("git");
    cmd.args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if !repo.is_empty() {
        cmd.current_dir(repo);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    hide_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("cannot run git: {e}"))?;

    let mut stdin = child.stdin.take();
    let feed = input.map(|bytes| bytes.to_vec());
    let writer = std::thread::spawn(move || {
        if let (Some(pipe), Some(bytes)) = (stdin.as_mut(), feed) {
            let _ = pipe.write_all(&bytes);
        }
        drop(stdin);
    });
    let mut err_pipe = child.stderr.take();
    let reader = std::thread::spawn(move || {
        let mut err = Vec::new();
        if let Some(pipe) = err_pipe.as_mut() {
            let _ = pipe.read_to_end(&mut err);
        }
        err
    });
    let mut out = Vec::new();
    if let Some(mut pipe) = child.stdout.take() {
        let _ = pipe.read_to_end(&mut out);
    }
    let _ = writer.join();
    let err = reader.join().unwrap_or_default();
    let status = child.wait().map_err(|e| format!("git did not finish: {e}"))?;
    Ok(Ran { code: status.code().unwrap_or(1), out, err: String::from_utf8_lossy(&err).into_owned() })
}

/// Keeps a console program from flashing a window on Windows.
pub fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

fn readable(args: &[&str]) -> Vec<String> {
    let mut out = Vec::new();
    let mut skip = false;
    for arg in args {
        if skip {
            skip = false;
            continue;
        }
        if *arg == "-c" {
            skip = true;
            continue;
        }
        if NOISE_EXACT.contains(arg) || NOISE_PREFIX.iter().any(|p| arg.starts_with(p)) {
            continue;
        }
        out.push(if arg.contains(' ') { format!("\"{arg}\"") } else { arg.to_string() });
    }
    out
}

fn begin(repo: &str, args: &[&str]) -> u64 {
    let text = readable(args).join(" ");
    let Ok(mut h) = HISTORY.lock() else { return 0 };
    let seq = h.next_seq;
    h.next_seq += 1;
    if let Some(last) = h.calls.last_mut() {
        if last.args == text && last.repo == repo && !last.running && last.ok {
            last.count += 1;
            last.at = now_ms();
            last.ms = 0;
            last.running = true;
            last.seq = seq;
            return last.id;
        }
    }
    let id = h.next_id;
    h.next_id += 1;
    h.calls.push(GitCall {
        id,
        seq,
        at: now_ms(),
        args: text,
        repo: repo.to_string(),
        ms: 0,
        ok: true,
        count: 1,
        running: true,
    });
    let over = h.calls.len().saturating_sub(HISTORY_LIMIT);
    h.calls.drain(..over);
    id
}

fn finish(id: u64, started: u64, ok: bool) {
    let Ok(mut h) = HISTORY.lock() else { return };
    let Some(pos) = h.calls.iter().rposition(|c| c.id == id) else { return };
    let seq = h.next_seq;
    h.next_seq += 1;
    if !ok && h.calls[pos].count > 1 {
        let call = &mut h.calls[pos];
        call.count -= 1;
        call.running = false;
        call.seq = seq;
        let failed = GitCall {
            id: 0,
            seq: 0,
            at: started,
            args: call.args.clone(),
            repo: call.repo.clone(),
            ms: now_ms().saturating_sub(started),
            ok: false,
            count: 1,
            running: false,
        };
        let fresh_id = h.next_id;
        h.next_id += 1;
        let fresh_seq = h.next_seq;
        h.next_seq += 1;
        h.calls.push(GitCall { id: fresh_id, seq: fresh_seq, ..failed });
        let over = h.calls.len().saturating_sub(HISTORY_LIMIT);
        h.calls.drain(..over);
        return;
    }
    let call = &mut h.calls[pos];
    call.ms = now_ms().saturating_sub(started);
    call.ok = ok;
    call.running = false;
    call.seq = seq;
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

const SEP: char = '\u{0}';
const RECORD: char = '\u{1}';
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const CO_AUTHOR: &str = "co-authored-by:";

/// Refs left out of the graph walk, named within their family ("topic", "origin/topic", "v1.0").
#[derive(Debug, Clone, Default)]
pub struct RefFilter {
    pub branches: Vec<String>,
    pub remotes: Vec<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct RawStash {
    pub commit: RawCommit,
    /// "stash@{0}": positional, so only good for a command run now.
    pub selector: String,
}

/// The commit walk, in date order, never `--all` (that would pull in refs/stash).
pub fn read_commits(repo: &str, limit: usize, hide: &RefFilter, heads: &[String]) -> Result<Vec<RawCommit>, String> {
    let mut walk = vec!["log".to_string()];
    walk.extend(hide.branches.iter().map(|n| format!("--exclude={n}")));
    walk.push("--branches".into());
    walk.extend(hide.tags.iter().map(|n| format!("--exclude={n}")));
    walk.push("--tags".into());
    walk.extend(hide.remotes.iter().map(|n| format!("--exclude={n}")));
    walk.push("--remotes".into());
    walk.push("HEAD".into());
    walk.extend(heads.iter().filter(|h| is_hash(h)).cloned());
    walk.push("--date-order".into());
    walk.push(format!("--max-count={limit}"));
    walk.push("--format=%x01%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%b".into());

    let raw = git(repo, &walk)?;
    let mut commits = Vec::new();
    for record in raw.split(RECORD) {
        let f: Vec<&str> = record.split(SEP).collect();
        let [hash, parents, author, email, date, subject, body, ..] = f.as_slice() else { continue };
        let (body, co_authors) = extract_co_authors(body);
        commits.push(RawCommit {
            hash: hash.to_string(),
            parents: split_parents(parents),
            subject: subject.to_string(),
            body,
            author: author.to_string(),
            email: email.to_string(),
            date: date.trim().parse().unwrap_or(0),
            co_authors,
        });
    }
    Ok(commits)
}

/// Stashes newest first, each keeping only its first parent (the others are git's bookkeeping).
pub fn read_stashes(repo: &str) -> Vec<RawStash> {
    let Some(raw) = git_or_none(repo, &["stash", "list", "--format=%x01%H%x00%P%x00%an%x00%ae%x00%at%x00%gd%x00%gs"])
    else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for record in raw.split(RECORD) {
        let f: Vec<&str> = record.split(SEP).collect();
        let [hash, parents, author, email, date, selector, subject, ..] = f.as_slice() else { continue };
        let mut parents = split_parents(parents);
        parents.truncate(1);
        out.push(RawStash {
            selector: selector.to_string(),
            commit: RawCommit {
                hash: hash.to_string(),
                parents,
                subject: subject.trim().to_string(),
                author: author.to_string(),
                email: email.to_string(),
                date: date.trim().parse().unwrap_or(0),
                ..RawCommit::default()
            },
        });
    }
    out
}

pub fn read_commit_files(repo: &str, sha: &str) -> Result<Vec<FileChange>, String> {
    let raw = git(repo, &["show", "--name-status", "--format=", "-z", "-m", "--first-parent", sha])?;
    Ok(parse_name_status(&raw))
}

pub fn read_commit_lines(repo: &str, sha: &str) -> Result<LineCounts, String> {
    let raw = git(repo, &["show", "--shortstat", "--format=", "-m", "--first-parent", sha])?;
    Ok(parse_shortstat(&raw))
}

pub fn read_range_files(repo: &str, from: &str, to: &str) -> Result<Vec<FileChange>, String> {
    let base = range_base(repo, from);
    Ok(parse_name_status(&git(repo, &["diff", "--name-status", "-z", &base, to])?))
}

pub fn read_range_lines(repo: &str, from: &str, to: &str) -> Result<LineCounts, String> {
    let base = range_base(repo, from);
    Ok(parse_shortstat(&git(repo, &["diff", "--shortstat", &base, to])?))
}

/// What a run starting at `oldest` is diffed against: its parent, or the empty tree for a root commit.
pub fn range_base(repo: &str, oldest: &str) -> String {
    let base = format!("{oldest}^");
    match git_or_none(repo, &["rev-parse", "--verify", &base]) {
        Some(_) => base,
        None => EMPTY_TREE.to_string(),
    }
}

/// Polled for every open tab: never refreshes the index (`diff-index`, not `diff HEAD`).
pub fn worktree_changes(repo: &str) -> Result<WorktreeChanges, String> {
    let files = read_status_with(repo, true)?.len() as u64;
    if files == 0 {
        return Ok(WorktreeChanges::default());
    }
    let lines = git_or_none(repo, &["--no-optional-locks", "diff-index", "--shortstat", "HEAD"])
        .map(|s| parse_shortstat(&s))
        .unwrap_or_default();
    Ok(WorktreeChanges { files, added: lines.added, removed: lines.removed })
}

pub fn read_status(repo: &str) -> Result<Vec<WorkingFile>, String> {
    read_status_with(repo, false)
}

/// `quiet` reads without refreshing the index, as any worktree other than the tab's own must.
pub fn read_status_with(repo: &str, quiet: bool) -> Result<Vec<WorkingFile>, String> {
    let mut args = Vec::new();
    if quiet {
        args.push("--no-optional-locks");
    }
    args.extend(["status", "--porcelain=v1", "-z", "-uall", "--ignore-submodules=dirty"]);
    Ok(parse_status(&git(repo, &args)?))
}

/// Annotated tag ref name to the commit it points at.
pub fn peeled_tags(repo: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Some(raw) = git_or_none(repo, &["for-each-ref", "--format=%(refname) %(*objectname)", "refs/tags"]) else {
        return out;
    };
    for line in raw.lines() {
        let Some((name, commit)) = line.trim().split_once(' ') else { continue };
        let commit = commit.trim();
        if !name.is_empty() && !commit.is_empty() {
            out.insert(name.to_string(), commit.to_string());
        }
    }
    out
}

pub fn is_repo(path: &str) -> bool {
    git_or_none(path, &["rev-parse", "--is-inside-work-tree"]).is_some_and(|s| s.trim() == "true")
}

pub fn repo_root(path: &str) -> Option<String> {
    let root = git_or_none(path, &["rev-parse", "--show-toplevel"])?;
    let root = root.trim();
    if root.is_empty() {
        return None;
    }
    Some(root.to_string())
}

/// `Name <email>` from a trailer, tolerant of a missing bracket.
pub fn parse_person(value: &str) -> Option<Person> {
    let text = value.trim();
    if text.is_empty() {
        return None;
    }
    let (Some(open), Some(close)) = (text.rfind('<'), text.rfind('>')) else {
        return Some(Person { name: text.to_string(), email: String::new() });
    };
    if close < open {
        return Some(Person { name: text.to_string(), email: String::new() });
    }
    let name = text.get(..open).unwrap_or("").trim();
    let email = text.get(open + 1..close).unwrap_or("").trim().to_string();
    let name = if name.is_empty() { email.clone() } else { name.to_string() };
    Some(Person { name, email })
}

/// The body without its co-author trailers, and the people they credit.
pub fn extract_co_authors(body: &str) -> (String, Vec<Person>) {
    let mut kept = Vec::new();
    let mut people: Vec<Person> = Vec::new();
    for line in body.split('\n') {
        let trimmed = line.trim();
        let is_trailer = trimmed.get(..CO_AUTHOR.len()).is_some_and(|p| p.eq_ignore_ascii_case(CO_AUTHOR));
        if !is_trailer {
            kept.push(line);
            continue;
        }
        let Some(person) = trimmed.get(CO_AUTHOR.len()..).and_then(parse_person) else { continue };
        let dup = people.iter().any(|p| {
            p.email.to_lowercase() == person.email.to_lowercase() && p.name.to_lowercase() == person.name.to_lowercase()
        });
        if !dup {
            people.push(person);
        }
    }
    (kept.join("\n").trim().to_string(), people)
}

/// One `--shortstat` line; either count is left out by git when zero.
pub fn parse_shortstat(raw: &str) -> LineCounts {
    let mut counts = LineCounts::default();
    for part in raw.split(',') {
        let part = part.trim();
        let digits: String = part.chars().take_while(|c| c.is_ascii_digit()).collect();
        let Ok(n) = digits.parse::<u64>() else { continue };
        if part.contains("insertion") {
            counts.added = n;
        } else if part.contains("deletion") {
            counts.removed = n;
        }
    }
    counts
}

fn parse_status(raw: &str) -> Vec<WorkingFile> {
    let mut out = Vec::new();
    let mut parts = raw.split(SEP);
    while let Some(entry) = parts.next() {
        let mut chars = entry.chars();
        let (Some(index), Some(worktree)) = (chars.next(), chars.next()) else { continue };
        let Some(path) = entry.get(3..).filter(|p| !p.is_empty()) else { continue };
        if index == 'R' || index == 'C' {
            parts.next();
        }
        out.push(WorkingFile {
            path: path.to_string(),
            index: index.to_string(),
            worktree: worktree.to_string(),
            staged: index != ' ' && index != '?',
            untracked: index == '?',
        });
    }
    out
}

fn parse_name_status(raw: &str) -> Vec<FileChange> {
    let mut out = Vec::new();
    let mut parts = raw.split(SEP);
    while let Some(status) = parts.next() {
        let Some(code) = status.trim().chars().next() else { continue };
        let status = code.to_string();
        if code == 'R' || code == 'C' {
            let (Some(old), Some(path)) = (parts.next(), parts.next()) else { break };
            out.push(FileChange { status, path: path.to_string(), old_path: Some(old.to_string()) });
            continue;
        }
        let Some(path) = parts.next() else { break };
        out.push(FileChange { status, path: path.to_string(), old_path: None });
    }
    out
}

fn split_parents(field: &str) -> Vec<String> {
    field.split_whitespace().map(str::to_string).collect()
}

fn is_hash(s: &str) -> bool {
    (40..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortstat() {
        let c = parse_shortstat(" 3 files changed, 10 insertions(+), 2 deletions(-)\n");
        assert_eq!((c.added, c.removed), (10, 2));
        let c = parse_shortstat(" 1 file changed, 1 insertion(+)\n");
        assert_eq!((c.added, c.removed), (1, 0));
        let c = parse_shortstat(" 1 file changed, 4 deletions(-)\n");
        assert_eq!((c.added, c.removed), (0, 4));
        assert_eq!(parse_shortstat(""), LineCounts::default());
    }

    #[test]
    fn co_authors() {
        let body = "Fix it\n\nCo-authored-by: Ann <ann@x.io>\nco-authored-by: Ann <ann@x.io>\nCO-AUTHORED-BY: bob@y.io";
        let (rest, people) = extract_co_authors(body);
        assert_eq!(rest, "Fix it");
        assert_eq!(people.len(), 2);
        assert_eq!(people.first().map(|p| p.name.as_str()), Some("Ann"));
        assert_eq!(people.get(1).map(|p| p.name.as_str()), Some("bob@y.io"));
        assert_eq!(parse_person("<a@b>").map(|p| p.name), Some("a@b".to_string()));
        assert_eq!(parse_person("  "), None);
    }

    #[test]
    fn status_and_names() {
        let s = parse_status("R  new.txt\0old.txt\0?? u.txt\0 M m.txt\0");
        assert_eq!(s.len(), 3);
        assert_eq!(s.first().map(|f| (f.path.as_str(), f.staged)), Some(("new.txt", true)));
        assert_eq!(s.get(1).map(|f| f.untracked), Some(true));
        assert_eq!(s.get(2).map(|f| f.staged), Some(false));
        let n = parse_name_status("M\0a\0R100\0old\0new\0");
        assert_eq!(n.len(), 2);
        assert_eq!(n.get(1).and_then(|f| f.old_path.clone()), Some("old".to_string()));
    }
}
