use crate::engine::types::{DiffLine, FileDiff, Hunk};

/// True when single hunks of this diff can be staged, unstaged or discarded on their own.
pub fn can_apply_hunks(diff: &FileDiff) -> bool {
    if diff.binary || diff.too_large || diff.whole {
        return false;
    }
    if diff.status == "A" && diff.old_path.is_none() && diff.hunks.len() == 1 {
        return false;
    }
    !diff.hunks.is_empty()
}

/// The patch for one whole hunk, ready for `git apply`.
pub fn hunk_patch(diff: &FileDiff, hunk: &Hunk) -> String {
    let mut out = header(diff);
    push_hunk(&mut out, hunk.old_start, hunk.old_count, hunk.new_start, hunk.new_count);
    for line in hunk.lines.iter().filter(|l| l.kind != "meta") {
        push_line(&mut out, marker(&line.kind), line);
    }
    out
}

/// The patch for only the picked changed lines, as (hunk index, line index) pairs.
///
/// `reverse` builds it for `git apply --reverse` (unstage, discard): the picked changes are undone and
/// every other change is kept as it is. Forward (stage) applies the picked changes and nothing else.
/// None when no add or del line was picked.
pub fn lines_patch(diff: &FileDiff, picked: &[(usize, usize)], reverse: bool) -> Option<String> {
    let mut out = header(diff);
    let mut delta: i64 = 0;
    let mut any = false;
    for (hi, hunk) in diff.hunks.iter().enumerate() {
        let mut body: Vec<(&str, &DiffLine)> = Vec::new();
        let (mut old, mut new, mut changes) = (0u64, 0u64, 0);
        for (li, line) in hunk.lines.iter().enumerate() {
            let chosen = picked.contains(&(hi, li));
            let mark = match (line.kind.as_str(), chosen, reverse) {
                ("add", true, _) => "+",
                ("del", true, _) => "-",
                ("add", false, false) | ("del", false, true) | ("meta", _, _) => continue,
                _ => " ",
            };
            match mark {
                "+" => new += 1,
                "-" => old += 1,
                _ => {
                    old += 1;
                    new += 1;
                }
            }
            if mark != " " {
                changes += 1;
            }
            body.push((mark, line));
        }
        if changes == 0 {
            continue;
        }
        any = true;
        let (old_start, new_start) = if reverse {
            (shift(hunk.new_start, -delta), hunk.new_start)
        } else {
            (hunk.old_start, shift(hunk.old_start, delta))
        };
        push_hunk(&mut out, old_start, old, new_start, new);
        for (mark, line) in body {
            push_line(&mut out, mark, line);
        }
        delta += new as i64 - old as i64;
    }
    any.then_some(out)
}

fn header(diff: &FileDiff) -> String {
    let old = diff.old_path.as_deref().unwrap_or(&diff.path);
    let new = &diff.path;
    format!("diff --git a/{old} b/{new}\n--- a/{old}\n+++ b/{new}\n")
}

fn push_hunk(out: &mut String, old_start: u64, old_count: u64, new_start: u64, new_count: u64) {
    out.push_str(&format!("@@ -{} +{} @@\n", range(old_start, old_count), range(new_start, new_count)));
}

fn push_line(out: &mut String, mark: &str, line: &DiffLine) {
    out.push_str(mark);
    out.push_str(&line.text);
    out.push('\n');
    if line.no_newline {
        out.push_str("\\ No newline at end of file\n");
    }
}

fn marker(kind: &str) -> &'static str {
    match kind {
        "add" => "+",
        "del" => "-",
        _ => " ",
    }
}

fn range(start: u64, count: u64) -> String {
    if count == 1 { start.to_string() } else { format!("{start},{count}") }
}

fn shift(start: u64, by: i64) -> u64 {
    (start as i64 + by).max(0) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(kind: &str, text: &str) -> DiffLine {
        DiffLine { kind: kind.into(), text: text.into(), ..Default::default() }
    }

    fn hunk() -> Hunk {
        Hunk {
            old_start: 10,
            old_count: 3,
            new_start: 10,
            new_count: 4,
            heading: String::new(),
            lines: vec![
                line("context", "unchanged before"),
                line("del", "the old line"),
                line("add", "the new line"),
                line("add", "and another"),
                line("context", "unchanged after"),
            ],
        }
    }

    fn diff() -> FileDiff {
        FileDiff { path: "src/app.ts".into(), status: "M".into(), hunks: vec![hunk()], ..Default::default() }
    }

    fn lines(text: &str) -> Vec<&str> {
        text.split('\n').collect()
    }

    #[test]
    fn hunk_patch_shape() {
        let text = hunk_patch(&diff(), &hunk());
        let l = lines(&text);
        assert_eq!(
            l.get(0..3),
            Some(&["diff --git a/src/app.ts b/src/app.ts", "--- a/src/app.ts", "+++ b/src/app.ts"][..])
        );
        assert_eq!(l.get(3), Some(&"@@ -10,3 +10,4 @@"));
        assert_eq!(
            l.get(4..9),
            Some(&[" unchanged before", "-the old line", "+the new line", "+and another", " unchanged after"][..])
        );
        assert!(text.ends_with('\n') && !text.ends_with("\n\n"));
    }

    #[test]
    fn hunk_patch_details() {
        let one = Hunk { old_count: 1, new_count: 1, ..hunk() };
        assert_eq!(lines(&hunk_patch(&diff(), &one)).get(3), Some(&"@@ -10 +10 @@"));

        let renamed = FileDiff { old_path: Some("src/old.ts".into()), ..diff() };
        assert_eq!(
            lines(&hunk_patch(&renamed, &hunk())).get(0..3),
            Some(&["diff --git a/src/old.ts b/src/app.ts", "--- a/src/old.ts", "+++ b/src/app.ts"][..])
        );

        let mut last = line("del", "last");
        last.no_newline = true;
        let h = Hunk { lines: vec![last, line("add", "last line")], ..hunk() };
        assert_eq!(
            lines(&hunk_patch(&diff(), &h)).get(4..7),
            Some(&["-last", "\\ No newline at end of file", "+last line"][..])
        );

        let crlf = Hunk { lines: vec![line("context", "text\r")], ..hunk() };
        assert_eq!(lines(&hunk_patch(&diff(), &crlf)).get(4), Some(&" text\r"));
    }

    #[test]
    fn can_apply_hunks_cases() {
        assert!(can_apply_hunks(&diff()));
        assert!(!can_apply_hunks(&FileDiff { binary: true, ..diff() }));
        assert!(!can_apply_hunks(&FileDiff { too_large: true, ..diff() }));
        assert!(!can_apply_hunks(&FileDiff { whole: true, ..diff() }));
        assert!(!can_apply_hunks(&FileDiff { status: "A".into(), ..diff() }));
        assert!(!can_apply_hunks(&FileDiff { hunks: Vec::new(), ..diff() }));
    }

    #[test]
    fn staging_one_added_line() {
        let text = lines_patch(&diff(), &[(0, 2)], false).unwrap_or_default();
        assert_eq!(
            lines(&text).get(3..9),
            Some(
                &["@@ -10,3 +10,4 @@", " unchanged before", " the old line", "+the new line", " unchanged after", ""][..]
            )
        );
    }

    #[test]
    fn staging_the_removal_only() {
        let text = lines_patch(&diff(), &[(0, 1)], false).unwrap_or_default();
        assert_eq!(
            lines(&text).get(3..7),
            Some(&["@@ -10,3 +10,2 @@", " unchanged before", "-the old line", " unchanged after"][..])
        );
    }

    #[test]
    fn discarding_one_added_line_keeps_the_others() {
        let text = lines_patch(&diff(), &[(0, 3)], true).unwrap_or_default();
        assert_eq!(
            lines(&text).get(3..8),
            Some(&["@@ -10,3 +10,4 @@", " unchanged before", " the new line", "+and another", " unchanged after"][..])
        );
    }

    #[test]
    fn context_only_picks_make_no_patch() {
        assert_eq!(lines_patch(&diff(), &[(0, 0), (0, 4)], false), None);
    }
}
