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
 * Assigns lanes and produces one GraphRow per commit.
 *
 * `commits` must be in topological order (git log --topo-order), otherwise a
 * parent can appear above its child and the lanes will not close.
 */
export function buildGraph(commits: RawCommit[]): GraphRow[] {
  // lanes[i] = hash the lane is waiting for, or null when the lane is free.
  const lanes: (string | null)[] = [];
  const laneColor: number[] = [];
  let nextColor = 0;

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
      color = nextColor % LANE_COLORS.length;
      nextColor += 1;
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
        laneColor[target] = nextColor % LANE_COLORS.length;
        nextColor += 1;
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
