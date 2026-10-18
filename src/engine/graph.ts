// Lane assignment for the commit graph.
//
// Turns a flat topo-ordered commit list into per-row drawing instructions.
// This is the piece that makes the graph readable, so it is worth stating
// how it works:
//
// We walk the commits top to bottom holding an array of "lanes". Each lane
// holds the hash of the commit it is currently waiting for. When we reach a
// commit, whichever lane was waiting for it becomes that commit's lane; its
// first parent then continues in the same lane (which is what keeps a branch
// on one vertical line) and any further parents branch off into lanes of
// their own.
//
// Rendering is per-row rather than one long path per branch, so a viewport
// can draw only the rows it shows without walking the whole history.

import type { RawCommit } from "./git.ts";
import { at } from "./safe.ts";

/**
 * Lane colours, in assignment order.
 *
 * Chosen to stay distinguishable side by side on a dark background and to
 * survive the 2px strokes the graph draws them at - the same palette the UI
 * uses for status, so a green lane and a green diff mean the same green.
 */
export const LANE_COLORS = [
  "#4f8cff",
  "#3fb950",
  "#d29922",
  "#a371f7",
  "#39c5cf",
  "#f85149",
  "#db61a2",
  "#7ee787",
  "#ff9d5c",
];

/**
 * The colour kept for the trunk, and given to nothing else.
 *
 * master is the one line in a repository you look for rather than at, and it
 * is worth nothing if you have to re-learn its colour every time the rotation
 * happens to land somewhere different. So index 0 is taken out of the
 * rotation entirely: every other lane cycles through 1..8, and 0 goes to the
 * lane carrying the trunk - which makes it a colour that means something
 * rather than a colour that came up next.
 *
 * When a repository has no master or main, the rotation gets all nine back.
 * Reserving a colour for a branch that does not exist would only cost the
 * graph a colour.
 */
export const TRUNK_COLOR = 0;

/**
 * The colour every stash is drawn in.
 *
 * One colour for all of them, and not a member of the rotation. Stashes are
 * not branches - three of them sitting on your current commit are three
 * shelves, not three lines of work - and letting them take rotation colours
 * would both dress them up as branches and shove every real branch along by
 * three hues.
 *
 * Index 9, past the nine lanes, so the palette is unchanged and a theme can
 * give stashes their own colour without spending a lane on them.
 */
export const STASH_COLOR = LANE_COLORS.length;

/** The colour itself, appended past the lanes in the payload palette. */
export const STASH_LANE = "#8b93a1";

/** A line crossing a row without terminating in it. */
export interface Through {
  lane: number;
  color: number;
}

/** A curve between two lanes, drawn in one half of the row. */
export interface Link {
  /** Lane the curve leaves from. */
  from: number;
  /** Lane the curve arrives at. */
  to: number;
  color: number;
}

export interface GraphRow {
  hash: string;
  /** Lane the commit's dot sits in. */
  lane: number;
  /** Index into LANE_COLORS. */
  color: number;
  /** Lines passing straight through this row. */
  through: Through[];
  /** Curves converging into this commit from above (drawn in the top half). */
  merges: Link[];
  /** Curves leaving this commit toward extra parents (drawn in the bottom half). */
  forks: Link[];
  /** True when a line enters this row's own lane from above. */
  hasTop: boolean;
  /** True when this commit's lane continues below. */
  hasBottom: boolean;
  /** Widest lane index used anywhere in the row, for sizing the SVG. */
  width: number;
}

function firstFree(lanes: (string | null)[]): number {
  for (let i = 0; i < lanes.length; i++) {
    if (lanes[i] === null) return i;
  }
  lanes.push(null);
  return lanes.length - 1;
}

/**
 * Which commits sit on a lane that will reach the trunk's tip.
 *
 * A lane follows first parents downward, so the lane opened at commit X
 * carries the trunk exactly when the trunk's tip is on X's first-parent
 * chain. That is a question about what lies BELOW X, which the top-to-bottom
 * walk cannot answer when it needs to - by the time it reaches the trunk tip
 * the rows above are already coloured, and repainting them is not an option.
 *
 * So it is answered in one pass upward first. In reverse order a commit's
 * first parent has always been seen already, which makes it a lookup rather
 * than a walk: this is O(n), not O(n) chains of O(n).
 *
 * The common case is exactly the one this exists for - a topic branch two
 * commits ahead of master. Without it the lane would open at the topic's tip,
 * take whatever colour the rotation was on, and master's own chip would then
 * be sitting on it.
 */
function trunkLanes(commits: RawCommit[], trunkTip: string): Map<string, boolean> {
  const carries = new Map<string, boolean>();
  for (let i = commits.length - 1; i >= 0; i--) {
    const c = commits[i];
    if (c.hash === trunkTip) {
      carries.set(c.hash, true);
      continue;
    }
    const parent = c.parents.length > 0 ? c.parents[0] : "";
    carries.set(c.hash, parent.length > 0 && (carries.get(parent) ?? false));
  }
  return carries;
}

/**
 * Assigns lanes and produces one GraphRow per commit.
 *
 * `commits` must be in topological order (git log --topo-order), otherwise a
 * parent can appear above its child and the lanes will not close.
 *
 * `trunkTip` is the hash master (or main) points at, or "" when the
 * repository has neither. The lane carrying it gets TRUNK_COLOR and no other
 * lane can be given that colour.
 */
export function buildGraph(commits: RawCommit[], trunkTip: string = ""): GraphRow[] {
  // lanes[i] = hash the lane is waiting for, or null when the lane is free.
  const lanes: (string | null)[] = [];
  const laneColor: number[] = [];

  const hasTrunk = trunkTip.length > 0;
  const carries = hasTrunk ? trunkLanes(commits, trunkTip) : new Map<string, boolean>();
  /** Whether the trunk's colour has been handed out; it is given once. */
  let trunkTaken = false;

  // Steps through the colours the trunk is not using. With a trunk that is
  // 1..8; without one it is the whole palette, so a repository with no master
  // is not quietly short a colour.
  let nextColor = 0;
  const rotate = (): number => {
    const span = hasTrunk ? LANE_COLORS.length - 1 : LANE_COLORS.length;
    const c = nextColor % span;
    nextColor += 1;
    // Step over the reserved index rather than assuming it is the first.
    return hasTrunk && c >= TRUNK_COLOR ? c + 1 : c;
  };

  /** The trunk's colour for the lane that carries it, the rotation for the rest. */
  const colorFor = (hash: string): number => {
    if (!trunkTaken && (carries.get(hash) ?? false)) {
      trunkTaken = true;
      return TRUNK_COLOR;
    }
    return rotate();
  };

  const rows: GraphRow[] = [];

  for (const commit of commits) {
    // Every lane waiting for this commit converges here. The leftmost one
    // becomes the commit's lane; the rest close with a merge curve.
    const waiting: number[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === commit.hash) waiting.push(i);
    }

    let lane: number;
    let color: number;
    const hasTop = waiting.length > 0;

    if (waiting.length === 0) {
      // A branch tip: nothing pointed here, so open a fresh lane.
      lane = firstFree(lanes);
      color = colorFor(commit.hash);
      laneColor[lane] = color;
    } else {
      lane = waiting[0];
      color = laneColor[lane];
    }

    const merges: Link[] = [];
    for (let i = 1; i < waiting.length; i++) {
      const other = waiting[i];
      merges.push({ from: other, to: lane, color: laneColor[other] });
      lanes[other] = null;
    }

    // Lines that neither start nor end here just pass through.
    const through: Through[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (i === lane) continue;
      if (lanes[i] !== null) through.push({ lane: i, color: laneColor[i] });
    }

    // First parent inherits the lane; that is what keeps a branch straight.
    const forks: Link[] = [];
    if (commit.parents.length === 0) {
      lanes[lane] = null;
    } else {
      lanes[lane] = commit.parents[0];
    }

    for (let i = 1; i < commit.parents.length; i++) {
      const parent = commit.parents[i];
      let target = -1;
      for (let j = 0; j < lanes.length; j++) {
        if (lanes[j] === parent) {
          target = j;
          break;
        }
      }
      if (target === -1) {
        target = firstFree(lanes);
        lanes[target] = parent;
        // A merged-in branch can be the trunk itself - "merge master into
        // topic" opens master's lane right here.
        laneColor[target] = colorFor(parent);
      }
      forks.push({ from: lane, to: target, color: laneColor[target] });
    }

    let width = lane;
    for (const t of through) if (t.lane > width) width = t.lane;
    for (const m of merges) if (m.from > width) width = m.from;
    for (const f of forks) if (f.to > width) width = f.to;

    rows.push({
      hash: commit.hash,
      lane,
      color,
      through,
      merges,
      forks,
      hasTop,
      hasBottom: lanes[lane] !== null,
      width,
    });
  }

  return rows;
}

/**
 * Hangs the stashes off the commits they were taken from.
 *
 * A stash is drawn as a stub: one node, in its own lane to the right of
 * everything else on that row, with a curve down into the commit it came
 * from. Several stashes on the same commit stack outward from it, which is
 * how they look in the reference and how they read - a stash branches off
 * without being a branch, and nothing distinguishes two stashes on one
 * commit except that there are two of them.
 *
 * This runs AFTER the lane walk rather than inside it, and that is the point.
 * A stash row sits ABOVE its parent, so a walk that met it first would have
 * to place its lane without knowing where the parent's lane will be - and the
 * answer it would reach for, "the first free lane", is lane 0 whenever the
 * parent is a branch tip. Stashing on the branch you are standing on is the
 * ordinary case, so the ordinary case would push the trunk three lanes right
 * to make room for a shelf. Placed afterwards, the parent's lane is known and
 * the stubs go where they belong: outside it.
 *
 * `commits` and `rows` must be index-aligned, and come back index-aligned.
 * Stashes whose parent is not on screen - beyond the commit limit, or on a
 * hidden branch - are dropped, having nothing to hang from.
 */
export function spliceStashes(
  commits: RawCommit[],
  rows: GraphRow[],
  stashes: RawCommit[],
): { commits: RawCommit[]; rows: GraphRow[] } {
  if (stashes.length === 0) return { commits, rows };

  // Stashes waiting on each parent, newest first - which is the order
  // `git stash list` gives them, so stash@{0} ends up nearest the top.
  const waiting = new Map<string, RawCommit[]>();
  for (const stash of stashes) {
    const parent = stash.parents.length > 0 ? stash.parents[0] : "";
    if (parent.length === 0) continue;
    const list = waiting.get(parent);
    if (list === undefined) waiting.set(parent, [stash]);
    else list.push(stash);
  }

  const outCommits: RawCommit[] = [];
  const outRows: GraphRow[] = [];

  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];
    const row = at(rows, i);
    if (row === undefined) continue;

    const mine = waiting.get(commit.hash);
    if (mine === undefined) {
      outCommits.push(commit);
      outRows.push(row);
      continue;
    }

    // Every lane that exists in the rows above this one: the ones passing
    // through, the ones ending here from above, and this commit's own lane
    // when a line comes down into it. Its forks are excluded - those leave
    // downward and do not exist above.
    const above: Through[] = [];
    for (const t of row.through) above.push({ lane: t.lane, color: t.color });
    for (const m of row.merges) above.push({ lane: m.from, color: m.color });
    if (row.hasTop) above.push({ lane: row.lane, color: row.color });

    // Outside everything already drawn on the parent's row, which is exactly
    // what `width` records.
    const firstLane = row.width + 1;
    const merges: Link[] = [...row.merges];

    for (let j = 0; j < mine.length; j++) {
      const stash = mine[j];
      const lane = firstLane + j;
      // Lanes crossing the stash's own row: everything above the parent, plus
      // the stubs of any stashes higher up, which run down past this one.
      const through: Through[] = [...above];
      for (let k = 0; k < j; k++) {
        through.push({ lane: firstLane + k, color: STASH_COLOR });
      }
      let width = lane;
      for (const t of through) if (t.lane > width) width = t.lane;

      outCommits.push(stash);
      outRows.push({
        hash: stash.hash,
        lane,
        color: STASH_COLOR,
        through,
        merges: [],
        forks: [],
        // Nothing reaches a stash: it is a tip that only ever points down.
        hasTop: false,
        hasBottom: true,
        width,
      });

      merges.push({ from: lane, to: row.lane, color: STASH_COLOR });
    }

    const last = firstLane + mine.length - 1;
    outCommits.push(commit);
    outRows.push({
      ...row,
      merges,
      width: row.width > last ? row.width : last,
    });
  }

  return { commits: outCommits, rows: outRows };
}
