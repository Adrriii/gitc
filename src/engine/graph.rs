use std::collections::{BTreeSet, HashMap};

use super::types::{GraphRow, Link, RawCommit, Through};

pub const LANE_COLORS: [&str; 9] =
    ["#4f8cff", "#3fb950", "#d29922", "#a371f7", "#39c5cf", "#f85149", "#db61a2", "#7ee787", "#ff9d5c"];
/// Reserved for the lane carrying master/main, and given to nothing else.
pub const TRUNK_COLOR: usize = 0;
/// Every stash, past the lane rotation.
pub const STASH_COLOR: usize = LANE_COLORS.len();
pub const STASH_LANE: &str = "#8b93a1";

struct Lanes<'a> {
    slots: Vec<Option<&'a str>>,
    colors: Vec<usize>,
    waiting: HashMap<&'a str, Vec<usize>>,
    free: BTreeSet<usize>,
}

/// One row per commit; `commits` must list children before parents.
/// The lane reaching `trunk_tip` (master or main, "" for none) gets TRUNK_COLOR.
pub fn build_graph(commits: &[RawCommit], trunk_tip: &str) -> Vec<GraphRow> {
    let has_trunk = !trunk_tip.is_empty();
    let carries = if has_trunk { trunk_lanes(commits, trunk_tip) } else { HashMap::new() };
    let mut trunk_taken = false;
    let mut next_color = 0usize;
    let mut color_for = |hash: &str| -> usize {
        if !trunk_taken && carries.get(hash).copied().unwrap_or(false) {
            trunk_taken = true;
            return TRUNK_COLOR;
        }
        let span = if has_trunk { LANE_COLORS.len() - 1 } else { LANE_COLORS.len() };
        let c = next_color % span;
        next_color += 1;
        if has_trunk { c + TRUNK_COLOR + 1 } else { c }
    };

    let mut lanes = Lanes { slots: Vec::new(), colors: Vec::new(), waiting: HashMap::new(), free: BTreeSet::new() };
    let mut rows = Vec::with_capacity(commits.len());

    for commit in commits {
        let mut waiting = lanes.waiting.remove(commit.hash.as_str()).unwrap_or_default();
        waiting.sort_unstable();
        let has_top = !waiting.is_empty();

        let (lane, color) = match waiting.first() {
            Some(&lane) => (lane, lanes.color(lane)),
            None => {
                let lane = lanes.first_free();
                let color = color_for(&commit.hash);
                lanes.set_color(lane, color);
                (lane, color)
            }
        };

        let mut merges = Vec::new();
        for &other in waiting.iter().skip(1) {
            merges.push(Link { from: other, to: lane, color: lanes.color(other) });
            lanes.release(other);
        }

        let through: Vec<Through> = lanes
            .slots
            .iter()
            .enumerate()
            .filter(|(i, slot)| *i != lane && slot.is_some())
            .map(|(i, _)| Through { lane: i, color: lanes.color(i) })
            .collect();

        lanes.clear_slot(lane);
        let first_parent = commit.parents.first().map(String::as_str);
        if let Some(parent) = first_parent {
            lanes.assign(lane, parent);
        } else {
            lanes.free.insert(lane);
        }

        let mut forks = Vec::new();
        for parent in commit.parents.iter().skip(1) {
            let existing = lanes.waiting.get(parent.as_str()).and_then(|l| l.iter().min().copied());
            let target = match existing {
                Some(t) => t,
                None => {
                    let t = lanes.first_free();
                    lanes.assign(t, parent);
                    lanes.set_color(t, color_for(parent));
                    t
                }
            };
            forks.push(Link { from: lane, to: target, color: lanes.color(target) });
        }

        let width = through
            .iter()
            .map(|t| t.lane)
            .chain(merges.iter().map(|m| m.from))
            .chain(forks.iter().map(|f| f.to))
            .fold(lane, usize::max);

        rows.push(GraphRow {
            hash: commit.hash.clone(),
            lane,
            color,
            through,
            merges,
            forks,
            has_top,
            has_bottom: first_parent.is_some(),
            width,
        });
    }
    rows
}

/// Hangs each stash off its parent's row, in lanes outside everything drawn there.
/// `commits` and `rows` are index-aligned and come back so; stashes whose parent is not listed are dropped.
pub fn splice_stashes(
    commits: Vec<RawCommit>,
    rows: Vec<GraphRow>,
    stashes: &[RawCommit],
) -> (Vec<RawCommit>, Vec<GraphRow>) {
    if stashes.is_empty() {
        return (commits, rows);
    }
    let mut waiting: HashMap<&str, Vec<&RawCommit>> = HashMap::new();
    for stash in stashes {
        let Some(parent) = stash.parents.first().filter(|p| !p.is_empty()) else { continue };
        waiting.entry(parent.as_str()).or_default().push(stash);
    }

    let mut out_commits = Vec::with_capacity(commits.len() + stashes.len());
    let mut out_rows = Vec::with_capacity(rows.len() + stashes.len());
    for (commit, row) in commits.into_iter().zip(rows) {
        let Some(mine) = waiting.get(commit.hash.as_str()).filter(|m| !m.is_empty()) else {
            out_commits.push(commit);
            out_rows.push(row);
            continue;
        };

        let mut above: Vec<Through> = row.through.clone();
        above.extend(row.merges.iter().map(|m| Through { lane: m.from, color: m.color }));
        if row.has_top {
            above.push(Through { lane: row.lane, color: row.color });
        }

        let first_lane = row.width + 1;
        let mut merges = row.merges.clone();
        for (j, stash) in mine.iter().enumerate() {
            let lane = first_lane + j;
            let mut through = above.clone();
            through.extend((0..j).map(|k| Through { lane: first_lane + k, color: STASH_COLOR }));
            let width = through.iter().map(|t| t.lane).fold(lane, usize::max);
            out_commits.push((*stash).clone());
            out_rows.push(GraphRow {
                hash: stash.hash.clone(),
                lane,
                color: STASH_COLOR,
                through,
                merges: Vec::new(),
                forks: Vec::new(),
                has_top: false,
                has_bottom: true,
                width,
            });
            merges.push(Link { from: lane, to: row.lane, color: STASH_COLOR });
        }
        let last = first_lane + mine.len() - 1;
        out_commits.push(commit);
        out_rows.push(GraphRow { merges, width: row.width.max(last), ..row });
    }
    (out_commits, out_rows)
}

impl<'a> Lanes<'a> {
    fn first_free(&mut self) -> usize {
        if let Some(lane) = self.free.pop_first() {
            return lane;
        }
        self.slots.push(None);
        self.colors.push(0);
        self.slots.len() - 1
    }

    fn assign(&mut self, lane: usize, hash: &'a str) {
        self.free.remove(&lane);
        if let Some(slot) = self.slots.get_mut(lane) {
            *slot = Some(hash);
        }
        self.waiting.entry(hash).or_default().push(lane);
    }

    fn clear_slot(&mut self, lane: usize) {
        let Some(slot) = self.slots.get_mut(lane) else { return };
        let Some(hash) = slot.take() else { return };
        if let Some(list) = self.waiting.get_mut(hash) {
            list.retain(|&l| l != lane);
            if list.is_empty() {
                self.waiting.remove(hash);
            }
        }
    }

    fn release(&mut self, lane: usize) {
        self.clear_slot(lane);
        self.free.insert(lane);
    }

    fn color(&self, lane: usize) -> usize {
        self.colors.get(lane).copied().unwrap_or(0)
    }

    fn set_color(&mut self, lane: usize, color: usize) {
        if let Some(c) = self.colors.get_mut(lane) {
            *c = color;
        }
    }
}

fn trunk_lanes<'a>(commits: &'a [RawCommit], trunk_tip: &str) -> HashMap<&'a str, bool> {
    let mut carries: HashMap<&str, bool> = HashMap::with_capacity(commits.len());
    for c in commits.iter().rev() {
        let on =
            c.hash == trunk_tip || c.parents.first().is_some_and(|p| carries.get(p.as_str()).copied().unwrap_or(false));
        carries.insert(c.hash.as_str(), on);
    }
    carries
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk(hash: &str, parents: &[&str]) -> RawCommit {
        RawCommit {
            hash: hash.into(),
            parents: parents.iter().map(|p| p.to_string()).collect(),
            ..RawCommit::default()
        }
    }

    fn color_of(rows: &[GraphRow], hash: &str) -> Option<usize> {
        rows.iter().find(|r| r.hash == hash).map(|r| r.color)
    }

    #[test]
    fn lane_reaching_trunk_tip_gets_trunk_color() {
        let rows = build_graph(&[mk("T1", &["T2"]), mk("T2", &["M1"]), mk("M1", &["M2"]), mk("M2", &[])], "M1");
        assert_eq!(color_of(&rows, "T1"), Some(TRUNK_COLOR));
        assert_eq!(color_of(&rows, "M1"), Some(TRUNK_COLOR));
    }

    #[test]
    fn side_branch_never_gets_trunk_color() {
        let rows = build_graph(&[mk("A1", &["M1"]), mk("B1", &["M1"]), mk("M1", &["M2"]), mk("M2", &[])], "M1");
        assert_eq!(color_of(&rows, "A1"), Some(TRUNK_COLOR));
        assert_ne!(color_of(&rows, "B1"), Some(TRUNK_COLOR));
        let m1 = rows.iter().find(|r| r.hash == "M1");
        assert_eq!(m1.map(|r| (r.lane, r.merges.len(), r.has_top)), Some((0, 1, true)));
    }

    #[test]
    fn unrelated_root_is_off_trunk() {
        let rows = build_graph(&[mk("O1", &[]), mk("M1", &["M2"]), mk("M2", &[])], "M1");
        assert_ne!(color_of(&rows, "O1"), Some(TRUNK_COLOR));
        assert_eq!(color_of(&rows, "M1"), Some(TRUNK_COLOR));
        assert_eq!(rows.get(1).map(|r| r.lane), Some(0));
    }

    #[test]
    fn rotation_skips_reserved_color() {
        let mut commits: Vec<RawCommit> = (0..LANE_COLORS.len() + 4).map(|i| mk(&format!("R{i}"), &[])).collect();
        commits.push(mk("M1", &[]));
        let rows = build_graph(&commits, "M1");
        let others: BTreeSet<usize> = rows.iter().filter(|r| r.hash != "M1").map(|r| r.color).collect();
        assert!(!others.contains(&TRUNK_COLOR));
        assert_eq!(color_of(&rows, "M1"), Some(TRUNK_COLOR));
        assert_eq!(others.len(), LANE_COLORS.len() - 1);
    }

    #[test]
    fn no_trunk_uses_every_color() {
        let commits: Vec<RawCommit> = (0..LANE_COLORS.len()).map(|i| mk(&format!("R{i}"), &[])).collect();
        let rows = build_graph(&commits, "");
        let colors: BTreeSet<usize> = rows.iter().map(|r| r.color).collect();
        assert_eq!(colors.len(), LANE_COLORS.len());
    }

    #[test]
    fn trunk_merged_in_as_second_parent() {
        let rows = build_graph(&[mk("T1", &["T2", "M1"]), mk("T2", &["M2"]), mk("M1", &["M2"]), mk("M2", &[])], "M1");
        assert_eq!(color_of(&rows, "M1"), Some(TRUNK_COLOR));
        assert_ne!(color_of(&rows, "T1"), Some(TRUNK_COLOR));
        let t1 = rows.first();
        assert_eq!(t1.map(|r| r.forks.len()), Some(1));
        let m2 = rows.iter().find(|r| r.hash == "M2");
        assert_eq!(m2.map(|r| (r.lane, r.merges.len(), r.has_bottom)), Some((0, 1, false)));
    }

    #[test]
    fn stashes_hang_outside_parent_row() {
        let commits = vec![mk("A", &["B"]), mk("B", &[])];
        let rows = build_graph(&commits, "");
        let (commits, rows) = splice_stashes(commits, rows, &[mk("S0", &["B"]), mk("S1", &["B"])]);
        let order: Vec<&str> = commits.iter().map(|c| c.hash.as_str()).collect();
        assert_eq!(order, ["A", "S0", "S1", "B"]);
        assert_eq!(rows.get(1).map(|r| (r.lane, r.color)), Some((1, STASH_COLOR)));
        assert_eq!(rows.get(2).map(|r| (r.lane, r.through.len())), Some((2, 2)));
        assert_eq!(rows.get(3).map(|r| (r.merges.len(), r.width)), Some((2, 2)));
    }

    #[test]
    fn fifty_thousand_commits_stay_fast() {
        let n = 50_000;
        let commits: Vec<RawCommit> = (0..n)
            .map(|i| {
                let parent = format!("c{}", i + 1);
                let side = format!("c{}", i + 7);
                if i + 1 >= n {
                    mk(&format!("c{i}"), &[])
                } else if i % 10 == 0 && i + 7 < n {
                    mk(&format!("c{i}"), &[&parent, &side])
                } else {
                    mk(&format!("c{i}"), &[&parent])
                }
            })
            .collect();
        let started = std::time::Instant::now();
        let rows = build_graph(&commits, "c0");
        assert_eq!(rows.len(), n);
        assert!(started.elapsed().as_secs() < 5);
    }
}
