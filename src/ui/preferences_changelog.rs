#[derive(Debug, Clone, PartialEq, Default)]
pub struct Piece {
    pub text: String,
    /// Only ever an https URL.
    pub href: Option<String>,
    pub code: bool,
    pub bold: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Kind {
    Heading,
    Bullet,
    Text,
    Blank,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Line {
    pub kind: Kind,
    /// Heading level, or bullet indent depth.
    pub depth: usize,
    pub pieces: Vec<Piece>,
}

/// The written notes out of a release body: from the first `##` section to GitHub's own list.
pub fn changelog_only(markdown: &str) -> String {
    let text = markdown.replace('\r', "");
    let lines: Vec<&str> = text.split('\n').collect();
    let Some(start) = lines.iter().position(|l| section_start(l)) else { return String::new() };
    let end = lines
        .iter()
        .skip(start)
        .position(|l| whats_changed(l) || l.starts_with("**Full Changelog**"))
        .map_or(lines.len(), |i| start + i);
    lines.get(start..end).unwrap_or_default().join("\n").trim().to_string()
}

pub fn parse_notes(markdown: &str) -> Vec<Line> {
    let mut out: Vec<Line> = Vec::new();
    for raw in markdown.replace('\r', "").split('\n') {
        let line = raw.trim_end();
        if line.trim().is_empty() {
            out.push(Line { kind: Kind::Blank, depth: 0, pieces: Vec::new() });
            continue;
        }
        if let Some((depth, rest)) = heading(line) {
            out.push(Line { kind: Kind::Heading, depth, pieces: inlines(rest) });
            continue;
        }
        if let Some((indent, rest)) = bullet(line) {
            out.push(Line { kind: Kind::Bullet, depth: indent / 2, pieces: inlines(rest) });
            continue;
        }
        if line.starts_with(char::is_whitespace) {
            if let Some(last) = out.last_mut().filter(|l| l.kind == Kind::Bullet) {
                last.pieces.extend(inlines(&format!(" {}", line.trim())));
                continue;
            }
        }
        out.push(Line { kind: Kind::Text, depth: 0, pieces: inlines(line.trim()) });
    }
    while out.last().is_some_and(|l| l.kind == Kind::Blank) {
        out.pop();
    }
    out
}

/// Splits one line into links, code spans and bold runs.
pub fn inlines(text: &str) -> Vec<Piece> {
    let mut out = Vec::new();
    let mut plain = String::new();
    let mut i = 0;
    while let Some(rest) = text.get(i..).filter(|r| !r.is_empty()) {
        let found = link(rest).or_else(|| code(rest)).or_else(|| bold(rest));
        if let Some((piece, used)) = found {
            if !plain.is_empty() {
                out.push(Piece { text: std::mem::take(&mut plain), ..Default::default() });
            }
            out.push(piece);
            i += used;
            continue;
        }
        let Some(c) = rest.chars().next() else { break };
        plain.push(c);
        i += c.len_utf8();
    }
    if !plain.is_empty() {
        out.push(Piece { text: plain, ..Default::default() });
    }
    out
}

fn link(rest: &str) -> Option<(Piece, usize)> {
    let inner = rest.strip_prefix('[')?;
    let close = inner.find(']')?;
    let label = inner.get(..close).filter(|l| !l.is_empty())?;
    let after = inner.get(close + 1..)?.strip_prefix('(')?;
    let end = after.find(')')?;
    let url = after.get(..end).filter(|u| !u.is_empty() && !u.contains(char::is_whitespace))?;
    let href = url.starts_with("https://").then(|| url.to_string());
    let used = 1 + close + 2 + end + 1;
    Some((Piece { text: label.to_string(), href, ..Default::default() }, used))
}

fn code(rest: &str) -> Option<(Piece, usize)> {
    let inner = rest.strip_prefix('`')?;
    let end = inner.find('`')?;
    let text = inner.get(..end).filter(|t| !t.is_empty())?;
    Some((Piece { text: text.to_string(), code: true, ..Default::default() }, end + 2))
}

fn bold(rest: &str) -> Option<(Piece, usize)> {
    let inner = rest.strip_prefix("**")?;
    let end = inner.find('*')?;
    let text = inner.get(..end).filter(|t| !t.is_empty())?;
    inner.get(end..)?.strip_prefix("**")?;
    Some((Piece { text: text.to_string(), bold: true, ..Default::default() }, end + 4))
}

fn heading(line: &str) -> Option<(usize, &str)> {
    let rest = line.trim_start_matches('#');
    let depth = line.len() - rest.len();
    if !(1..=4).contains(&depth) || !rest.starts_with(char::is_whitespace) {
        return None;
    }
    Some((depth, rest.trim_start()))
}

fn bullet(line: &str) -> Option<(usize, &str)> {
    let body = line.trim_start();
    let indent = line.get(..line.len() - body.len()).map_or(0, |s| s.chars().count());
    let rest = body.strip_prefix(['-', '*'])?;
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }
    Some((indent, rest.trim_start()))
}

fn section_start(line: &str) -> bool {
    line.strip_prefix("##").is_some_and(|rest| rest.starts_with(char::is_whitespace) && !rest.trim().is_empty())
}

fn whats_changed(line: &str) -> bool {
    let rest = line.trim_start_matches('#');
    if line.len() - rest.len() < 2 || !rest.starts_with(char::is_whitespace) {
        return false;
    }
    let lower = rest.trim_start().to_lowercase();
    let mut chars = lower.chars();
    let what: String = chars.by_ref().take(4).collect();
    what == "what" && chars.next().is_some() && chars.as_str().starts_with("s changed")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(text: &str) -> Piece {
        Piece { text: text.into(), ..Default::default() }
    }

    fn shape(lines: &[Line]) -> Vec<String> {
        lines.iter().map(|l| format!("{:?}{}", l.kind, l.depth)).collect()
    }

    #[test]
    fn links_are_https_only() {
        assert_eq!(
            inlines("see [the commit](https://example.com/a)"),
            vec![
                plain("see "),
                Piece { text: "the commit".into(), href: Some("https://example.com/a".into()), ..Default::default() }
            ]
        );
        assert_eq!(inlines("[click](javascript:alert)"), vec![plain("click")]);
        assert_eq!(inlines("[x](data:text/html,<script>)"), vec![plain("x")]);
        assert_eq!(inlines("[x](http://example.com)"), vec![plain("x")]);
        assert_eq!(inlines("[x](/api/quit)"), vec![plain("x")]);
    }

    #[test]
    fn inline_grammar() {
        assert_eq!(
            inlines("run `npm test` now"),
            vec![plain("run "), Piece { text: "npm test".into(), code: true, ..Default::default() }, plain(" now")]
        );
        assert_eq!(
            inlines("**Fixed** it"),
            vec![Piece { text: "Fixed".into(), bold: true, ..Default::default() }, plain(" it")]
        );
        assert_eq!(inlines("nothing special here"), vec![plain("nothing special here")]);
        assert_eq!(inlines("[not a link"), vec![plain("[not a link")]);
    }

    #[test]
    fn blocks() {
        let notes = "## New Features\n\n- Amend a commit ([a1b2c3](https://example.com/c/a1b2c3))\n  - a nested note\n\n### Internal\nsome prose\n\n";
        let parsed = parse_notes(notes);
        assert_eq!(shape(&parsed), ["Heading2", "Blank0", "Bullet0", "Bullet1", "Blank0", "Heading3", "Text0"]);
        assert_eq!(
            parsed.get(2).map(|l| l.pieces.clone()).unwrap_or_default(),
            vec![
                plain("Amend a commit ("),
                Piece {
                    text: "a1b2c3".into(),
                    href: Some("https://example.com/c/a1b2c3".into()),
                    ..Default::default()
                },
                plain(")"),
            ]
        );
        assert_eq!(parse_notes("a\n\n\n").len(), 1);
        assert_eq!(shape(&parse_notes("## One\r\n\r\n- two\r\n")), ["Heading2", "Blank0", "Bullet0"]);
        assert!(parse_notes("").is_empty());
    }

    #[test]
    fn wrapped_bullets() {
        let wrapped = parse_notes(
            "- **A Thing**: the first line of it\n  and the rest of the sentence\n  ([abc](https://example.com/c/abc))",
        );
        assert_eq!(wrapped.len(), 1);
        let pieces = wrapped.first().map(|l| l.pieces.clone()).unwrap_or_default();
        let text: String = pieces.iter().map(|p| p.text.as_str()).collect();
        assert_eq!(text, "A Thing: the first line of it and the rest of the sentence (abc)");
        assert!(pieces.iter().any(|p| p.href.as_deref() == Some("https://example.com/c/abc")));
        assert_eq!(shape(&parse_notes("- one\n  - two")), ["Bullet0", "Bullet1"]);
    }

    #[test]
    fn changelog_out_of_a_release() {
        let release = "Download the file for your system and run it.\n\n| System | File |\n| ------ | ---- |\n\n**Full Changelog**: https://example.com/compare/v1...v2\n\n## New Features\n\n- Something ([abc](https://example.com/c/abc))\n\n## Known Limits\n\n- Still Linux only.";
        let notes = changelog_only(release);
        assert_eq!(notes.lines().next(), Some("## New Features"));
        assert!(notes.contains("## Known Limits"));
        assert!(!notes.contains("| System |"));
        assert!(!notes.contains("Full Changelog"));
        assert_eq!(changelog_only("## Real\n\n- a\n\n## What's Changed\n\n- raw commit"), "## Real\n\n- a");
        assert_eq!(changelog_only("just some prose"), "");
        assert_eq!(changelog_only(""), "");
    }
}
