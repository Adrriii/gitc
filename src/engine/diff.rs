use super::git::{git, git_or_none, range_base};
use super::paths::{in_repo, safe_argument};
use super::types::{DiffLine, FileDiff, Hunk};

/// Context that makes git emit the whole file as one hunk.
pub const FULL_CONTEXT: usize = 1_000_000;

const MAX_INLINE_BYTES: u64 = 4 * 1024 * 1024;

/// One file's working-tree diff: the index against HEAD when `staged`, the working
/// tree against the index otherwise. `quiet` reads another worktree without
/// refreshing (and so locking) its index.
pub fn diff_working_file(
    repo: &str,
    path: &str,
    staged: bool,
    context: usize,
    untracked: bool,
    quiet: bool,
) -> Result<FileDiff, String> {
    if untracked && !staged {
        return Ok(new_file_diff(repo, path, context));
    }
    let mut args: Vec<String> = Vec::new();
    if quiet {
        args.push("--no-optional-locks".into());
    }
    if quiet && !staged {
        args.extend(["diff-files".into(), "-p".into()]);
    } else {
        args.push("diff".into());
    }
    args.extend([format!("-U{context}"), "--no-color".into()]);
    if staged {
        args.push("--cached".into());
    }
    args.extend(["--".into(), path.to_string()]);
    let raw = git(repo, &args)?;

    if raw.trim().is_empty() && !staged && git_or_none(repo, &["ls-files", "--error-unmatch", "--", path]).is_none() {
        return Ok(new_file_diff(repo, path, context));
    }
    Ok(parsed(&raw, path, context))
}

/// The combined diff a run of commits made to one file.
pub fn diff_range_file(repo: &str, from: &str, to: &str, path: &str, context: usize) -> Result<FileDiff, String> {
    safe_argument(from, "commit")?;
    safe_argument(to, "commit")?;
    let base = range_base(repo, from);
    let raw = git(repo, &["diff", &format!("-U{context}"), "--no-color", &base, to, "--", path])?;
    Ok(parsed(&raw, path, context))
}

/// The diff one commit made to one file, against its first parent.
pub fn diff_commit_file(repo: &str, sha: &str, path: &str, context: usize) -> Result<FileDiff, String> {
    safe_argument(sha, "commit")?;
    let raw =
        git(repo, &["show", &format!("-U{context}"), "--format=", "--no-color", "--first-parent", sha, "--", path])?;
    Ok(parsed(&raw, path, context))
}

/// Parses `git diff` output for a single file.
pub fn parse_unified(raw: &str, path: &str) -> FileDiff {
    let mut out = FileDiff { path: path.to_string(), status: "M".into(), ..Default::default() };
    let mut in_hunk = false;
    let (mut old_no, mut new_no) = (0u64, 0u64);
    const SKIP: [&str; 7] = ["index ", "--- ", "+++ ", "similarity index", "rename to ", "old mode", "new mode"];

    for line in raw.strip_suffix('\n').unwrap_or(raw).split('\n') {
        if line.starts_with("diff --git") {
            in_hunk = false;
            continue;
        }
        if line.starts_with("Binary files") || line.starts_with("GIT binary patch") {
            out.binary = true;
            continue;
        }
        if line.starts_with("new file mode") {
            out.status = "A".into();
            continue;
        }
        if line.starts_with("deleted file mode") {
            out.status = "D".into();
            continue;
        }
        if let Some(from) = line.strip_prefix("rename from ") {
            out.old_path = Some(from.to_string());
            out.status = "R".into();
            continue;
        }
        if SKIP.iter().any(|p| line.starts_with(p)) {
            continue;
        }
        if let Some(hunk) = hunk_header(line) {
            old_no = hunk.old_start;
            new_no = hunk.new_start;
            out.hunks.push(hunk);
            in_hunk = true;
            continue;
        }
        let Some(hunk) = out.hunks.last_mut().filter(|_| in_hunk) else {
            continue;
        };
        if line.starts_with('\\') {
            if let Some(prev) = hunk.lines.last_mut() {
                prev.no_newline = true;
            }
            continue;
        }
        let text = line.get(1..).unwrap_or("").to_string();
        let (kind, old, new) = match line.as_bytes().first() {
            Some(b'+') => ("add", None, Some(new_no)),
            Some(b'-') => ("del", Some(old_no), None),
            Some(b' ') | None => ("context", Some(old_no), Some(new_no)),
            _ => continue,
        };
        if old.is_some() {
            old_no += 1;
        }
        if new.is_some() {
            new_no += 1;
        }
        hunk.lines.push(DiffLine { kind: kind.into(), old_no: old, new_no: new, text, no_newline: false });
    }
    out
}

fn parsed(raw: &str, path: &str, context: usize) -> FileDiff {
    let mut diff = parse_unified(raw, path);
    diff.whole = context >= FULL_CONTEXT;
    diff
}

fn hunk_header(line: &str) -> Option<Hunk> {
    let rest = line.strip_prefix("@@")?;
    let close = rest.find("@@")?;
    let mut ranges = rest[..close].split_whitespace();
    let (old_start, old_count) = range(ranges.next()?.strip_prefix('-')?)?;
    let (new_start, new_count) = range(ranges.next()?.strip_prefix('+')?)?;
    let heading = rest[close + 2..].trim().to_string();
    Some(Hunk { old_start, old_count, new_start, new_count, heading, lines: Vec::new() })
}

fn range(spec: &str) -> Option<(u64, u64)> {
    match spec.split_once(',') {
        Some((start, count)) => Some((start.parse().ok()?, count.parse().ok()?)),
        None => Some((spec.parse().ok()?, 1)),
    }
}

/// Every line an addition, for a file git has never seen; touches nothing in the repository.
fn new_file_diff(repo: &str, path: &str, context: usize) -> FileDiff {
    let mut out =
        FileDiff { path: path.to_string(), status: "A".into(), whole: context >= FULL_CONTEXT, ..Default::default() };
    let Some(full) = in_repo(repo, path) else {
        return out;
    };
    let Ok(meta) = std::fs::metadata(&full) else {
        return out;
    };
    if meta.len() > MAX_INLINE_BYTES {
        out.too_large = true;
        return out;
    }
    let Ok(bytes) = std::fs::read(&full) else {
        return out;
    };
    if bytes.contains(&0) {
        out.binary = true;
        return out;
    }
    let content = String::from_utf8_lossy(&bytes);
    let lines: Vec<DiffLine> = content
        .lines()
        .enumerate()
        .map(|(i, text)| DiffLine {
            kind: "add".into(),
            old_no: None,
            new_no: Some(i as u64 + 1),
            text: text.to_string(),
            no_newline: false,
        })
        .collect();
    if lines.is_empty() {
        return out;
    }
    out.hunks.push(Hunk {
        old_start: 0,
        old_count: 0,
        new_start: 1,
        new_count: lines.len() as u64,
        heading: String::new(),
        lines,
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_hunk() {
        let raw = "diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@ fn x\n a\n-b\n+c\n\\ No newline at end of file\n";
        let d = parse_unified(raw, "f");
        assert_eq!(d.hunks.len(), 1);
        let h = &d.hunks[0];
        assert_eq!((h.old_start, h.old_count, h.new_start, h.new_count, h.heading.as_str()), (1, 2, 1, 2, "fn x"));
        let kinds: Vec<&str> = h.lines.iter().map(|l| l.kind.as_str()).collect();
        assert_eq!(kinds, ["context", "del", "add"]);
        assert!(h.lines[2].no_newline);
        assert_eq!((h.lines[2].old_no, h.lines[2].new_no), (None, Some(2)));
    }
}
