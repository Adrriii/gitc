use crate::engine::types::{AiConflictHunk, AiPick};

const OURS_MARK: &str = "<<<<<<<";
const BASE_MARK: &str = "|||||||";
const SPLIT_MARK: &str = "=======";
const THEIRS_MARK: &str = ">>>>>>>";
const CONTEXT: usize = 5;

#[derive(Debug, Clone, PartialEq)]
pub struct Region {
    pub ours: Vec<String>,
    pub theirs: Vec<String>,
    pub base: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Segment {
    Stable(Vec<String>),
    Conflict(Region),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Ours,
    Theirs,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Take {
    Only(Side),
    Both { theirs_first: bool },
}

/// The lines ticked on each side of one conflict, and the order the sides are written in.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Pick {
    pub ours: Vec<bool>,
    pub theirs: Vec<bool>,
    pub theirs_first: bool,
    /// Decided as "nothing": a side with no lines was taken.
    pub empty: bool,
}

/// A parsed conflicted file: what both sides agree on, and one decision per conflict.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Parsed {
    pub segments: Vec<Segment>,
    pub crlf: bool,
}

pub fn parse(text: &str) -> Parsed {
    let crlf = text.contains("\r\n");
    let mut lines: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    if lines.len() > 1 && lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }
    let mut segments = Vec::new();
    let mut stable: Vec<String> = Vec::new();
    let mut i = 0;
    let at = |i: usize, mark: &str| lines.get(i).is_some_and(|l| l.starts_with(mark));
    while let Some(line) = lines.get(i) {
        if !line.starts_with(OURS_MARK) {
            stable.push(line.to_string());
            i += 1;
            continue;
        }
        if !stable.is_empty() {
            segments.push(Segment::Stable(std::mem::take(&mut stable)));
        }
        i += 1;
        let mut ours = Vec::new();
        while i < lines.len() && !at(i, SPLIT_MARK) && !at(i, BASE_MARK) {
            ours.push(lines.get(i).copied().unwrap_or_default().to_string());
            i += 1;
        }
        let mut base = None;
        if at(i, BASE_MARK) {
            i += 1;
            let mut b = Vec::new();
            while i < lines.len() && !at(i, SPLIT_MARK) {
                b.push(lines.get(i).copied().unwrap_or_default().to_string());
                i += 1;
            }
            base = Some(b);
        }
        if at(i, SPLIT_MARK) {
            i += 1;
        }
        let mut theirs = Vec::new();
        while i < lines.len() && !at(i, THEIRS_MARK) {
            theirs.push(lines.get(i).copied().unwrap_or_default().to_string());
            i += 1;
        }
        if at(i, THEIRS_MARK) {
            i += 1;
        }
        segments.push(Segment::Conflict(Region { ours, theirs, base }));
    }
    if !stable.is_empty() {
        segments.push(Segment::Stable(stable));
    }
    Parsed { segments, crlf }
}

impl Parsed {
    pub fn regions(&self) -> impl Iterator<Item = &Region> {
        self.segments.iter().filter_map(|s| match s {
            Segment::Conflict(r) => Some(r),
            Segment::Stable(_) => None,
        })
    }

    /// Nothing picked to begin with: a default side would look like a reviewed resolution.
    pub fn empty_picks(&self) -> Vec<Pick> {
        self.regions()
            .map(|r| Pick {
                ours: vec![false; r.ours.len()],
                theirs: vec![false; r.theirs.len()],
                ..Default::default()
            })
            .collect()
    }

    /// The merged text, and the 0-based output line each conflict starts on.
    pub fn compose(&self, picks: &[Pick]) -> (String, Vec<usize>) {
        let mut out: Vec<&str> = Vec::new();
        let mut starts = Vec::new();
        let mut c = 0;
        for segment in &self.segments {
            let region = match segment {
                Segment::Stable(lines) => {
                    out.extend(lines.iter().map(String::as_str));
                    continue;
                }
                Segment::Conflict(region) => region,
            };
            starts.push(out.len());
            let pick = picks.get(c);
            c += 1;
            let Some(pick) = pick else { continue };
            let ours = region.ours.iter().zip(&pick.ours).filter(|(_, on)| **on).map(|(l, _)| l.as_str());
            let theirs = region.theirs.iter().zip(&pick.theirs).filter(|(_, on)| **on).map(|(l, _)| l.as_str());
            if pick.theirs_first {
                out.extend(theirs);
                out.extend(ours);
            } else {
                out.extend(ours);
                out.extend(theirs);
            }
        }
        let mut text = out.join("\n");
        if !out.is_empty() {
            text.push('\n');
        }
        (text, starts)
    }

    pub fn hunks(&self) -> Vec<AiConflictHunk> {
        let mut hunks = Vec::new();
        for (i, segment) in self.segments.iter().enumerate() {
            let Segment::Conflict(region) = segment else { continue };
            let before = match i.checked_sub(1).and_then(|p| self.segments.get(p)) {
                Some(Segment::Stable(lines)) => lines[lines.len().saturating_sub(CONTEXT)..].to_vec(),
                _ => Vec::new(),
            };
            let after = match self.segments.get(i + 1) {
                Some(Segment::Stable(lines)) => lines.iter().take(CONTEXT).cloned().collect(),
                _ => Vec::new(),
            };
            hunks.push(AiConflictHunk {
                ours: region.ours.clone(),
                theirs: region.theirs.clone(),
                base: region.base.clone(),
                before,
                after,
            });
        }
        hunks
    }
}

impl Pick {
    pub fn decided(&self) -> bool {
        self.empty || self.ours.iter().any(|b| *b) || self.theirs.iter().any(|b| *b)
    }

    pub fn side(&self, side: Side) -> &[bool] {
        match side {
            Side::Ours => &self.ours,
            Side::Theirs => &self.theirs,
        }
    }

    fn side_mut(&mut self, side: Side) -> &mut Vec<bool> {
        match side {
            Side::Ours => &mut self.ours,
            Side::Theirs => &mut self.theirs,
        }
    }

    /// Every line of this side is in the output (or the side is empty and was taken).
    pub fn taken(&self, side: Side) -> bool {
        let lines = self.side(side);
        if lines.is_empty() {
            return self.empty;
        }
        lines.iter().all(|b| *b)
    }

    /// Ticks or unticks one line. The first side ticked in an undecided conflict is written first.
    pub fn set_line(&mut self, side: Side, line: usize, on: bool) {
        if on && !self.decided() {
            self.theirs_first = side == Side::Theirs;
        }
        self.empty = false;
        if let Some(slot) = self.side_mut(side).get_mut(line) {
            *slot = on;
        }
    }

    pub fn take(&mut self, take: Take) {
        let (ours, theirs, theirs_first) = match take {
            Take::Only(Side::Ours) => (true, false, false),
            Take::Only(Side::Theirs) => (false, true, false),
            Take::Both { theirs_first } => (true, true, theirs_first),
        };
        self.ours.iter_mut().for_each(|b| *b = ours);
        self.theirs.iter_mut().for_each(|b| *b = theirs);
        self.theirs_first = theirs_first;
        self.empty = !self.ours.iter().chain(&self.theirs).any(|b| *b);
    }

    /// Drops one side again, leaving the other as it was.
    pub fn drop_side(&mut self, side: Side) {
        self.side_mut(side).iter_mut().for_each(|b| *b = false);
        self.empty = false;
    }

    /// Applies what the AI picked; a declined pick changes nothing.
    pub fn accept(&mut self, pick: &AiPick) {
        if pick.reason.is_some() {
            return;
        }
        let ours = pick.ours.as_deref().unwrap_or_default();
        let theirs = pick.theirs.as_deref().unwrap_or_default();
        self.ours.iter_mut().enumerate().for_each(|(i, b)| *b = ours.contains(&i));
        self.theirs.iter_mut().enumerate().for_each(|(i, b)| *b = theirs.contains(&i));
        self.theirs_first = false;
        self.empty = !self.ours.iter().chain(&self.theirs).any(|b| *b);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILE: &str = "a\n<<<<<<< HEAD\nours 1\nours 2\n=======\ntheirs 1\n>>>>>>> topic\nb\n";

    fn lines(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_stable_and_conflict_segments() {
        let parsed = parse(FILE);
        assert!(!parsed.crlf);
        assert_eq!(
            parsed.segments,
            vec![
                Segment::Stable(lines(&["a"])),
                Segment::Conflict(Region {
                    ours: lines(&["ours 1", "ours 2"]),
                    theirs: lines(&["theirs 1"]),
                    base: None
                }),
                Segment::Stable(lines(&["b"])),
            ]
        );
    }

    #[test]
    fn parses_diff3_base_and_crlf() {
        let parsed = parse("<<<<<<< ours\r\nx\r\n||||||| base\r\nw\r\n=======\r\ny\r\n>>>>>>> theirs\r\n");
        assert!(parsed.crlf);
        assert_eq!(
            parsed.segments,
            vec![Segment::Conflict(Region { ours: lines(&["x"]), theirs: lines(&["y"]), base: Some(lines(&["w"])) })]
        );
    }

    #[test]
    fn unterminated_conflict_does_not_lose_lines() {
        let parsed = parse("<<<<<<< a\nx\n=======\ny");
        assert_eq!(
            parsed.segments,
            vec![Segment::Conflict(Region { ours: lines(&["x"]), theirs: lines(&["y"]), base: None })]
        );
    }

    #[test]
    fn nothing_is_picked_at_first() {
        let parsed = parse(FILE);
        let picks = parsed.empty_picks();
        assert_eq!(picks.len(), 1);
        assert!(!picks.iter().any(Pick::decided));
        assert_eq!(parsed.compose(&picks), ("a\nb\n".to_string(), vec![1]));
    }

    #[test]
    fn composes_in_the_order_the_sides_were_picked() {
        let parsed = parse(FILE);
        let mut picks = parsed.empty_picks();
        let Some(pick) = picks.get_mut(0) else { return };
        pick.take(Take::Both { theirs_first: false });
        assert_eq!(parsed.compose(&picks).0, "a\nours 1\nours 2\ntheirs 1\nb\n");
        if let Some(pick) = picks.get_mut(0) {
            pick.take(Take::Both { theirs_first: true });
        }
        assert_eq!(parsed.compose(&picks).0, "a\ntheirs 1\nours 1\nours 2\nb\n");
    }

    #[test]
    fn single_lines_and_first_side_ticked_leads() {
        let parsed = parse(FILE);
        let mut picks = parsed.empty_picks();
        let Some(pick) = picks.get_mut(0) else { return };
        pick.set_line(Side::Theirs, 0, true);
        pick.set_line(Side::Ours, 1, true);
        assert!(pick.decided());
        assert!(pick.taken(Side::Theirs));
        assert!(!pick.taken(Side::Ours));
        assert_eq!(parsed.compose(&picks).0, "a\ntheirs 1\nours 2\nb\n");
        if let Some(pick) = picks.get_mut(0) {
            pick.drop_side(Side::Theirs);
            pick.set_line(Side::Ours, 1, false);
            assert!(!pick.decided());
        }
    }

    #[test]
    fn taking_an_empty_side_decides_the_conflict() {
        let parsed = parse("<<<<<<< a\n=======\ngone\n>>>>>>> b\n");
        let mut picks = parsed.empty_picks();
        let Some(pick) = picks.get_mut(0) else { return };
        pick.take(Take::Only(Side::Ours));
        assert!(pick.decided());
        assert!(pick.taken(Side::Ours));
        assert_eq!(parsed.compose(&picks).0, "");
    }

    #[test]
    fn accepts_ai_picks_and_ignores_bad_indexes() {
        let parsed = parse(FILE);
        let mut picks = parsed.empty_picks();
        let Some(pick) = picks.get_mut(0) else { return };
        pick.accept(&AiPick { ours: Some(vec![1, 9]), theirs: Some(vec![0]), reason: None });
        assert_eq!(parsed.compose(&picks).0, "a\nours 2\ntheirs 1\nb\n");
        let before = picks.clone();
        if let Some(pick) = picks.get_mut(0) {
            pick.accept(&AiPick { ours: None, theirs: None, reason: Some("needs a human".into()) });
        }
        assert_eq!(picks, before);
    }

    #[test]
    fn hunks_carry_context() {
        let hunks = parse(FILE).hunks();
        assert_eq!(hunks.len(), 1);
        let Some(h) = hunks.first() else { return };
        assert_eq!(h.before, lines(&["a"]));
        assert_eq!(h.after, lines(&["b"]));
        assert_eq!(h.ours, lines(&["ours 1", "ours 2"]));
    }
}
