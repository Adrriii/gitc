use std::ops::Range;

pub type Span = Range<usize>;

const MAX_TOKENS: usize = 400;

/// The differing byte spans of two versions of a line, (before, after). Empty for identical lines.
pub fn word_diff(before: &str, after: &str) -> (Vec<Span>, Vec<Span>) {
    if before == after {
        return (Vec::new(), Vec::new());
    }
    let a = tokenize(before);
    let b = tokenize(after);
    let ta = |i: usize| a.get(i).and_then(|s| before.get(s.clone())).unwrap_or("");
    let tb = |j: usize| b.get(j).and_then(|s| after.get(s.clone())).unwrap_or("");

    let mut head = 0;
    while head < a.len() && head < b.len() && ta(head) == tb(head) {
        head += 1;
    }
    let mut tail = 0;
    while tail < a.len() - head && tail < b.len() - head && ta(a.len() - 1 - tail) == tb(b.len() - 1 - tail) {
        tail += 1;
    }
    let (a0, a1) = (head, a.len() - tail);
    let (b0, b1) = (head, b.len() - tail);
    let (n, m) = (a1 - a0, b1 - b0);
    if n == 0 && m == 0 {
        return (Vec::new(), Vec::new());
    }

    if n > MAX_TOKENS || m > MAX_TOKENS {
        let whole = |t: &[Span], from: usize, to: usize| -> Vec<Span> {
            match (t.get(from), to.checked_sub(1).and_then(|last| t.get(last))) {
                (Some(first), Some(last)) if to > from => std::iter::once(first.start..last.end).collect(),
                _ => Vec::new(),
            }
        };
        return (whole(&a, a0, a1), whole(&b, b0, b1));
    }

    let width = m + 1;
    let mut table = vec![0u32; (n + 1) * width];
    let cell = |t: &Vec<u32>, i: usize, j: usize| t.get(i * width + j).copied().unwrap_or(0);
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            let v = if ta(a0 + i) == tb(b0 + j) {
                cell(&table, i + 1, j + 1) + 1
            } else {
                cell(&table, i + 1, j).max(cell(&table, i, j + 1))
            };
            if let Some(slot) = table.get_mut(i * width + j) {
                *slot = v;
            }
        }
    }

    let mut left = Vec::new();
    let mut right = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < n && j < m {
        if ta(a0 + i) == tb(b0 + j) {
            i += 1;
            j += 1;
        } else if cell(&table, i + 1, j) >= cell(&table, i, j + 1) {
            left.extend(a.get(a0 + i).cloned());
            i += 1;
        } else {
            right.extend(b.get(b0 + j).cloned());
            j += 1;
        }
    }
    left.extend(a.get(a0 + i..a1).into_iter().flatten().cloned());
    right.extend(b.get(b0 + j..b1).into_iter().flatten().cloned());
    (join(left), join(right))
}

/// Which removed line became which added line: for each line, the index of its partner.
/// A run of removals pairs in order with the run of additions right after it; extras stay unpaired.
pub fn pair_runs(kinds: &[&str]) -> Vec<Option<usize>> {
    let mut pairs = vec![None; kinds.len()];
    let kind = |i: usize| kinds.get(i).copied().unwrap_or("");
    let mut i = 0;
    while i < kinds.len() {
        if kind(i) != "del" {
            i += 1;
            continue;
        }
        let dels = i;
        while kind(i) == "del" {
            i += 1;
        }
        let adds = i;
        while kind(i) == "add" {
            i += 1;
        }
        for k in 0..(adds - dels).min(i - adds) {
            if let Some(slot) = pairs.get_mut(dels + k) {
                *slot = Some(adds + k);
            }
            if let Some(slot) = pairs.get_mut(adds + k) {
                *slot = Some(dels + k);
            }
        }
    }
    pairs
}

/// Words, runs of blanks, and single characters for everything else.
pub fn tokenize(line: &str) -> Vec<Span> {
    let mut out: Vec<Span> = Vec::new();
    let mut chars = line.char_indices().peekable();
    while let Some((start, c)) = chars.next() {
        let mut end = start + c.len_utf8();
        let same: Option<fn(char) -> bool> = if wordish(c) {
            Some(wordish)
        } else if blank(c) {
            Some(blank)
        } else {
            None
        };
        if let Some(same) = same {
            while let Some(&(at, next)) = chars.peek() {
                if !same(next) {
                    break;
                }
                end = at + next.len_utf8();
                chars.next();
            }
        }
        out.push(start..end);
    }
    out
}

fn wordish(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '$'
}

fn blank(c: char) -> bool {
    c == ' ' || c == '\t'
}

fn join(spans: Vec<Span>) -> Vec<Span> {
    let mut out: Vec<Span> = Vec::new();
    for s in spans {
        match out.last_mut() {
            Some(last) if last.end == s.start => last.end = s.end,
            _ => out.push(s),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn marks<'a>(line: &'a str, spans: &[Span]) -> Vec<&'a str> {
        spans.iter().map(|s| line.get(s.clone()).unwrap_or("")).collect()
    }

    #[test]
    fn tokenize_units() {
        let lens = |l: &str| tokenize(l).iter().map(|t| t.end - t.start).collect::<Vec<_>>();
        assert_eq!(lens("a b.c"), vec![1, 1, 1, 1, 1]);
        assert_eq!(tokenize("a   b").len(), 3);
        assert_eq!(lens("someName++"), vec![8, 1, 1]);
    }

    #[test]
    fn word_diff_cases() {
        let (a, b) = ("const timeout = 30;", "const timeout = 60;");
        let d = word_diff(a, b);
        assert_eq!(marks(a, &d.0), vec!["30"]);
        assert_eq!(marks(b, &d.1), vec!["60"]);

        let d = word_diff("call(a, b)", "call(a, c)");
        assert_eq!(marks("call(a, c)", &d.1), vec!["c"]);

        let (a, b) = ("the quick brown fox", "the slow brown cat");
        let d = word_diff(a, b);
        assert_eq!(marks(a, &d.0), vec!["quick", "fox"]);
        assert_eq!(marks(b, &d.1), vec!["slow", "cat"]);

        assert_eq!(word_diff("same", "same"), (Vec::new(), Vec::new()));

        let d = word_diff("aaa", "zzz");
        assert_eq!((marks("aaa", &d.0), marks("zzz", &d.1)), (vec!["aaa"], vec!["zzz"]));

        let (a, b) = ("x = 1", "x = 1 + extra");
        let d = word_diff(a, b);
        assert!(d.0.is_empty());
        assert_eq!(marks(b, &d.1).join(""), " + extra");

        let a = "value(1)";
        assert_eq!(marks(a, &word_diff(a, "other(2)").0), vec!["value", "1"]);

        let a = "x = 1 + 2";
        assert_eq!(marks(a, &word_diff(a, "x = 2").0), vec!["1 + "]);
    }

    #[test]
    fn pair_runs_cases() {
        let p = pair_runs(&["context", "del", "del", "add", "add", "context"]);
        assert_eq!(p, vec![None, Some(3), Some(4), Some(1), Some(2), None]);

        let p = pair_runs(&["del", "add", "add"]);
        assert_eq!(p, vec![Some(1), Some(0), None]);

        let p = pair_runs(&["add", "del", "add"]);
        assert_eq!(p, vec![None, Some(2), Some(1)]);
    }
}
