use std::collections::HashMap;
use std::path::Path;

use super::ai::{DIFF_CAP, SYSTEM, complete, parse_reply, trim_diff};
use super::git::{git, git_with};
use super::types::{AiConflictHunk, AiPick, AiProvider, CommitContext, Message};

const EXPLAIN_SYSTEM: &str = "You explain git commits to a developer reviewing them. Write two to five short plain paragraphs: \
what changed, why it seems to have changed, and anything risky or worth checking. No headings, \
no bullet lists, no code fences. Never use tools.";

const BRANCH_SYSTEM: &str = "You name git branches. Answer with the branch name only, on one line: lowercase, words joined by \
hyphens, at most five words, in the naming style of the existing branches you are shown, with a \
prefix such as feature/ or fix/ when they use one. When the changes are only new files, name the branch after \
what they add. Never use tools.";

const CONFLICT_SYSTEM: &str = "You resolve git merge conflicts by choosing lines, never by writing code.
Each conflict shows side A and side B with every line numbered from 1, the common ancestor when known, and some surrounding lines.
The result of a conflict is the lines kept from A in their order, followed by the lines kept from B in their order. Nothing else can be produced.
Answer one line per conflict, exactly in this form: <n>: A <lines> B <lines>
where <lines> is a comma separated list of line numbers or ranges such as 1-3, or the word none.
When the right result needs lines in another order, text neither side has, or nothing from either side, answer instead: <n>: unresolved <short reason>
Do not guess. No other text. Never use tools.";

const CONFLICT_CAP: usize = 60000;
const NEW_FILES: usize = 10;
const NEW_FILE_BYTES: u64 = 20000;

/// The repository side of an AI task: "explain" or "squash" over `shas`, or "branch" over the working tree.
pub fn task_context(repo: &str, kind: &str, shas: &[String]) -> Result<CommitContext, String> {
    if kind == "branch" {
        return Ok(branch_context(repo));
    }
    if let Some(bad) = shas.iter().find(|s| !is_sha(s)) {
        return Err(format!("not a commit: {bad}"));
    }
    if shas.is_empty() {
        return Err("no commits given".into());
    }
    let ordered: Vec<&str> = shas.iter().rev().map(String::as_str).collect();
    let with = |head: &[&str]| -> Vec<String> { head.iter().chain(ordered.iter()).map(|s| s.to_string()).collect() };
    let log_args = with(&["log", "--no-walk=unsorted", "--format=%B%x00"]);

    let (log, diff, numstat) = match kind {
        "explain" => {
            let show = with(&["show", "--no-color", "--no-ext-diff", "--format="]);
            let stat = with(&["show", "--numstat", "--format="]);
            std::thread::scope(|s| {
                let log = s.spawn(|| quiet(repo, &log_args));
                let diff = s.spawn(|| quiet(repo, &show));
                let numstat = quiet(repo, &stat);
                (log.join().unwrap_or_default(), diff.join().unwrap_or_default(), numstat)
            })
        }
        "squash" => {
            let oldest = ordered.first().copied().unwrap_or("");
            let newest = ordered.last().copied().unwrap_or(oldest);
            let base = parent_of(repo, oldest);
            let base = base.as_str();
            std::thread::scope(|s| {
                let log = s.spawn(|| quiet(repo, &log_args));
                let diff = s.spawn(|| quiet(repo, &["diff", "--no-color", "--no-ext-diff", base, newest]));
                let numstat = quiet(repo, &["diff", "--numstat", base, newest]);
                (log.join().unwrap_or_default(), diff.join().unwrap_or_default(), numstat)
            })
        }
        other => return Err(format!("unknown context: {other}")),
    };
    let recent = log.split('\0').map(str::trim).filter(|m| !m.is_empty()).map(str::to_string).collect();
    Ok(CommitContext { diff, numstat, recent })
}

pub fn explain_commits(provider: &AiProvider, context: &CommitContext) -> Result<String, String> {
    if context.diff.trim().is_empty() && context.recent.is_empty() {
        return Err("Nothing to explain".into());
    }
    let user = format!(
        "Commit messages, oldest first:\n\n{}\n\n=====\n\nThe changes:\n\n{}",
        context.recent.join("\n\n-----\n\n"),
        trim_diff(&context.diff, &context.numstat, DIFF_CAP)
    );
    let text = unfence(&ask(provider, EXPLAIN_SYSTEM, &user)?);
    if text.is_empty() {
        return Err(format!("{} returned no explanation", provider.name));
    }
    Ok(text)
}

pub fn suggest_branch_name(provider: &AiProvider, context: &CommitContext) -> Result<String, String> {
    if context.diff.trim().is_empty() {
        return Err("No changes to name a branch after".into());
    }
    let user = format!(
        "Existing branches, most recent first, as style examples:\n{}\n\n=====\n\nThe uncommitted changes:\n\n{}",
        context.recent.join("\n"),
        trim_diff(&context.diff, &context.numstat, DIFF_CAP)
    );
    let name = branch_slug(&parse_reply(&ask(provider, BRANCH_SYSTEM, &user)?).summary);
    if name.is_empty() || name.split(['-', '/']).count() > 8 {
        return Err(format!("{} returned no usable name", provider.name));
    }
    Ok(name)
}

pub fn write_squash_message(provider: &AiProvider, context: &CommitContext) -> Result<Message, String> {
    let user = format!(
        "These commits are being squashed into one. Write the one message the result should have. \
         Their messages, oldest first, also show this repository's style:\n\n{}\n\n=====\n\nThe combined change:\n\n{}",
        context.recent.join("\n\n-----\n\n"),
        trim_diff(&context.diff, &context.numstat, DIFF_CAP)
    );
    let message = parse_reply(&ask(provider, SYSTEM, &user)?);
    if message.summary.is_empty() {
        return Err(format!("{} returned no message", provider.name));
    }
    Ok(message)
}

pub fn suggest_picks(provider: &AiProvider, path: &str, hunks: &[AiConflictHunk]) -> Result<Vec<AiPick>, String> {
    if hunks.is_empty() {
        return Err("No conflicts in this file".into());
    }
    Ok(parse_picks(&ask(provider, CONFLICT_SYSTEM, &conflict_prompt(path, hunks))?, hunks))
}

fn ask(provider: &AiProvider, system: &str, user: &str) -> Result<String, String> {
    complete(provider, system, user).map_err(|e| format!("{}: {e}", provider.name))
}

fn conflict_prompt(path: &str, hunks: &[AiConflictHunk]) -> String {
    let mut parts = vec![format!("File: {path}")];
    let mut size = 0;
    for (i, hunk) in hunks.iter().enumerate() {
        let text = describe_hunk(i + 1, hunk);
        if size + text.len() > CONFLICT_CAP {
            parts.push(format!(
                "Conflicts {} to {} are left out for length; answer only for those above.",
                i + 1,
                hunks.len()
            ));
            break;
        }
        size += text.len();
        parts.push(text);
    }
    parts.join("\n\n")
}

fn parse_picks(reply: &str, hunks: &[AiConflictHunk]) -> Vec<AiPick> {
    let mut answers: HashMap<usize, &str> = HashMap::new();
    for line in reply.lines().map(str::trim) {
        if let Some((n, rest)) = numbered_answer(line) {
            answers.entry(n).or_insert(rest);
        }
    }
    hunks
        .iter()
        .enumerate()
        .map(|(i, hunk)| match answers.get(&(i + 1)) {
            Some(said) => pick_from(said, hunk),
            None => reason("no suggestion for this conflict"),
        })
        .collect()
}

fn branch_slug(text: &str) -> String {
    let lowered = text.trim().to_lowercase();
    let mut name = String::new();
    let mut in_space = false;
    for c in lowered.chars().filter(|c| !matches!(c, '`' | '"' | '\'')) {
        if c.is_whitespace() {
            if !in_space {
                name.push('-');
            }
            in_space = true;
            continue;
        }
        in_space = false;
        if c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '/' | '.' | '_' | '-') {
            name.push(c);
        }
    }
    let mut squeezed = String::new();
    for c in name.chars() {
        if matches!(c, '-' | '/' | '.') && squeezed.ends_with(c) {
            continue;
        }
        squeezed.push(c);
    }
    let separators: &[char] = &['-', '/', '.'];
    let mut name = squeezed.trim_matches(separators).to_string();
    if let Some(stripped) = name.strip_suffix(".lock") {
        name = stripped.to_string();
    }
    name.chars().take(60).collect::<String>().trim_end_matches(separators).to_string()
}

fn numbered_answer(line: &str) -> Option<(usize, &str)> {
    let digits_at = line.find(|c: char| c.is_ascii_digit())?;
    if line.get(..digits_at)?.chars().count() > 12 {
        return None;
    }
    let rest = line.get(digits_at..)?;
    let digits_end = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
    let n = rest.get(..digits_end)?.parse().ok()?;
    let rest = rest.get(digits_end..)?.trim_start();
    let rest = rest.strip_prefix([':', '.', ')', '-'])?.trim_start();
    if rest.is_empty() {
        return None;
    }
    Some((n, rest))
}

fn pick_from(said: &str, hunk: &AiConflictHunk) -> AiPick {
    if let Some(why) = unresolved(said) {
        return reason(if why.is_empty() { "cannot be resolved by picking lines" } else { why });
    }
    let Some((a, b)) = sides(said) else { return reason("the suggestion could not be read") };
    let (Some(ours), Some(theirs)) = (line_list(a, hunk.ours.len()), line_list(b, hunk.theirs.len())) else {
        return reason("the suggestion named lines this conflict does not have");
    };
    if ours.is_empty() && theirs.is_empty() {
        return reason("it would keep nothing from either side");
    }
    AiPick { ours: Some(ours), theirs: Some(theirs), reason: None }
}

fn unresolved(said: &str) -> Option<&str> {
    let head = said.get(..10)?;
    if !head.eq_ignore_ascii_case("unresolved") {
        return None;
    }
    let rest = said.get(10..)?;
    if rest.chars().next().is_some_and(is_word) {
        return None;
    }
    Some(rest.trim_start_matches(|c: char| c.is_whitespace() || matches!(c, ':' | ',' | '-')).trim())
}

/// Finds `A <lines> [,] B <lines>` running to the end of the answer.
fn sides(said: &str) -> Option<(&str, &str)> {
    let starts = said.char_indices().filter(|&(i, c)| c.eq_ignore_ascii_case(&'a') && boundary_before(said, i));
    for (i, _) in starts {
        let Some((a, after)) = side_list(said.get(i + 1..)?) else { continue };
        let after = after.trim_start();
        let after = after.strip_prefix(',').unwrap_or(after).trim_start();
        let Some(b_rest) = after.strip_prefix(['B', 'b']) else { continue };
        let b_at = said.len() - after.len();
        if !boundary_before(said, b_at) {
            continue;
        }
        let Some((b, tail)) = side_list(b_rest) else { continue };
        if tail.trim().is_empty() {
            return Some((a, b));
        }
    }
    None
}

fn side_list(text: &str) -> Option<(&str, &str)> {
    let text = text.trim_start();
    let text = text.strip_prefix(':').unwrap_or(text).trim_start();
    let end =
        text.find(|c: char| !(c.is_ascii_digit() || c == ',' || c == '-' || c.is_whitespace())).unwrap_or(text.len());
    if end > 0 {
        return Some((text.get(..end)?, text.get(end..)?));
    }
    let word = text.get(..4)?;
    word.eq_ignore_ascii_case("none").then(|| (word, text.get(4..).unwrap_or("")))
}

fn line_list(text: &str, count: usize) -> Option<Vec<usize>> {
    let spec = text.trim().to_ascii_lowercase();
    let mut out: Vec<usize> = Vec::new();
    if spec == "none" || spec.is_empty() {
        return Some(out);
    }
    for part in spec.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let bounds: Vec<&str> = part.split('-').map(str::trim).collect();
        let from: usize = bounds.first()?.parse().ok()?;
        let to: usize = bounds.last()?.parse().ok()?;
        if from < 1 || to > count || from > to {
            return None;
        }
        for n in from..=to {
            if !out.contains(&(n - 1)) {
                out.push(n - 1);
            }
        }
    }
    out.sort_unstable();
    Some(out)
}

fn describe_hunk(n: usize, hunk: &AiConflictHunk) -> String {
    let mut lines = vec![format!("Conflict {n}")];
    if !hunk.before.is_empty() {
        lines.push("Lines before:".into());
        lines.extend(hunk.before.iter().cloned());
    }
    lines.push("Side A:".into());
    lines.extend(numbered(&hunk.ours));
    lines.push("Side B:".into());
    lines.extend(numbered(&hunk.theirs));
    if let Some(base) = &hunk.base {
        lines.push("Common ancestor:".into());
        lines.extend(base.iter().cloned());
    }
    if !hunk.after.is_empty() {
        lines.push("Lines after:".into());
        lines.extend(hunk.after.iter().cloned());
    }
    lines.join("\n")
}

fn numbered(lines: &[String]) -> Vec<String> {
    if lines.is_empty() {
        return vec!["(empty)".into()];
    }
    lines.iter().enumerate().map(|(i, l)| format!("{}| {l}", i + 1)).collect()
}

fn branch_context(repo: &str) -> CommitContext {
    let (diff, numstat, untracked, refs) = std::thread::scope(|s| {
        let diff = s.spawn(|| quiet(repo, &["diff", "--no-color", "--no-ext-diff", "HEAD"]));
        let numstat = s.spawn(|| quiet(repo, &["diff", "--numstat", "HEAD"]));
        let untracked = s.spawn(|| quiet(repo, &["ls-files", "--others", "--exclude-standard"]));
        let refs = quiet(
            repo,
            &[
                "for-each-ref",
                "--count=30",
                "--sort=-committerdate",
                "--format=%(refname:short)",
                "refs/heads",
                "refs/remotes",
            ],
        );
        (
            diff.join().unwrap_or_default(),
            numstat.join().unwrap_or_default(),
            untracked.join().unwrap_or_default(),
            refs,
        )
    });
    let recent =
        refs.lines().map(str::trim).filter(|r| !r.is_empty() && !r.ends_with("/HEAD")).map(str::to_string).collect();
    CommitContext { diff: diff + &new_files(repo, &untracked), numstat, recent }
}

fn new_files(repo: &str, untracked: &str) -> String {
    let mut out = String::new();
    let mut shown = 0;
    for name in untracked.lines().map(str::trim).filter(|n| !n.is_empty()) {
        let mut body = "(not shown)".to_string();
        if shown < NEW_FILES {
            if let Some(content) = small_text(&Path::new(repo).join(name)) {
                body = content;
                shown += 1;
            }
        }
        out += &format!("\nNew file, not tracked yet: {name}\n{body}\n");
    }
    out
}

fn small_text(path: &Path) -> Option<String> {
    if std::fs::metadata(path).ok()?.len() > NEW_FILE_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if bytes.contains(&0) {
        return None;
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn parent_of(repo: &str, sha: &str) -> String {
    let parent = quiet(repo, &["rev-parse", "--verify", "-q", &format!("{sha}^")]).trim().to_string();
    if !parent.is_empty() {
        return parent;
    }
    git_with(repo, &["hash-object", "-t", "tree", "--stdin"], &[], Some(""))
        .map(|t| t.trim().to_string())
        .unwrap_or_else(|_| sha.to_string())
}

fn quiet<S: AsRef<str>>(repo: &str, args: &[S]) -> String {
    git(repo, args).unwrap_or_default()
}

fn unfence(text: &str) -> String {
    let out = text.replace("\r\n", "\n").trim().to_string();
    if !out.starts_with("```") {
        return out;
    }
    let body = out.split_once('\n').map(|(_, rest)| rest).unwrap_or("");
    body.trim_end().strip_suffix("```").unwrap_or(body).trim().to_string()
}

fn is_sha(s: &str) -> bool {
    (4..=64).contains(&s.len()) && s.chars().all(|c| c.is_ascii_hexdigit())
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn boundary_before(text: &str, at: usize) -> bool {
    !text.get(..at).and_then(|t| t.chars().next_back()).is_some_and(is_word)
}

fn reason(text: &str) -> AiPick {
    AiPick { ours: None, theirs: None, reason: Some(text.to_string()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hunk(ours: &[&str], theirs: &[&str]) -> AiConflictHunk {
        AiConflictHunk {
            ours: ours.iter().map(|s| s.to_string()).collect(),
            theirs: theirs.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }

    fn picked(p: &AiPick) -> String {
        match (&p.ours, &p.theirs, &p.reason) {
            (Some(o), Some(t), None) => format!("{o:?} {t:?}"),
            (_, _, Some(r)) => r.clone(),
            _ => "?".into(),
        }
    }

    fn picks(reply: &str) -> Vec<String> {
        let two = [hunk(&["a1", "a2", "a3"], &["b1", "b2"]), hunk(&["x"], &["y"])];
        parse_picks(reply, &two).iter().map(picked).collect()
    }

    #[test]
    fn parsing_picks() {
        assert_eq!(picks("1: A 1,3 B 2\n2: A none B 1"), vec!["[0, 2] [1]", "[] [0]"]);
        assert_eq!(picks("1: A 1-3 B none")[0], "[0, 1, 2] []");
        assert_eq!(
            picks("1: unresolved both sides rename the same call\n2: A 1 B 1")[0],
            "both sides rename the same call"
        );
        assert_eq!(picks("1: A 1 B none")[1], "no suggestion for this conflict");
        assert_eq!(picks("1: A 4 B none")[0], "the suggestion named lines this conflict does not have");
        assert_eq!(picks("1: A none B none")[0], "it would keep nothing from either side");
        assert_eq!(picks("Conflict 2: A 1, B none\nThanks!")[1], "[0] []");
        assert_eq!(picks("1: take the first one")[0], "the suggestion could not be read");
        assert_eq!(picks("1: A 1 B none\n1: A 2 B none")[0], "[0] []");
        assert_eq!(picks("1) a: 2 b: 1-2")[0], "[1] [0, 1]");
    }

    #[test]
    fn branch_names() {
        assert_eq!(branch_slug("feature/ai-commit-messages"), "feature/ai-commit-messages");
        assert_eq!(branch_slug("Fix Login Redirect"), "fix-login-redirect");
        assert_eq!(branch_slug("`fix/login: redirect!`"), "fix/login-redirect");
        assert_eq!(branch_slug("/-feature/x-/"), "feature/x");
        assert_eq!(branch_slug("a..b//c"), "a.b/c");
        assert_eq!(branch_slug("refs.lock"), "refs");
        assert_eq!(branch_slug(&"x".repeat(80)).len(), 60);
    }

    #[test]
    fn prompt() {
        let two = [hunk(&["a1", "a2", "a3"], &["b1", "b2"]), hunk(&["x"], &["y"])];
        let prompt = conflict_prompt("src/a.ts", &two);
        assert!(prompt.contains("Side A:\n1| a1\n2| a2\n3| a3"));
        assert!(prompt.contains("Conflict 2"));
        let huge = [hunk(&[&"z".repeat(70000)], &["y"]), hunk(&["x"], &["y"])];
        assert!(conflict_prompt("f", &huge).contains("Conflicts 1 to 2 are left out"));
    }
}
