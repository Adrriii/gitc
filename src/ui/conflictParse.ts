/**
 * Parsing git's conflict markers.
 *
 * When git cannot merge a file it writes both versions into the working copy
 * between markers:
 *
 *     <<<<<<< HEAD
 *     our lines
 *     ||||||| merged common ancestors      (only with diff3 / zdiff3 style)
 *     base lines
 *     =======
 *     their lines
 *     >>>>>>> the-other-thing
 *
 * The file is therefore a complete record of the disagreement: everything
 * outside the markers is agreed, and each marked block is one decision. That
 * is what the editor works from - splitting it into agreed segments and
 * decisions means both full versions can be reconstructed exactly, and the
 * output composed from whatever the user picks.
 */

export interface ConflictRegion {
  /** 0-based position among the conflicts in this file. */
  index: number;
  ours: string[];
  theirs: string[];
  /** The common ancestor, when the file was written in diff3 style. */
  base: string[] | null;
  /** Marker labels, which name the sides in git's own words. */
  oursLabel: string;
  theirsLabel: string;
}

export type Segment =
  | { kind: "stable"; lines: string[] }
  | { kind: "conflict"; region: ConflictRegion };

const OURS_MARK = "<<<<<<<";
const BASE_MARK = "|||||||";
const SPLIT_MARK = "=======";
const THEIRS_MARK = ">>>>>>>";

export function parseConflicts(text: string): Segment[] {
  const LF = String.fromCharCode(10);
  const CR = String.fromCharCode(13);
  const lines = text.split(LF).map((l) => (l.endsWith(CR) ? l.slice(0, -1) : l));

  const segments: Segment[] = [];
  let stable: string[] = [];
  let index = 0;
  let i = 0;

  const flushStable = () => {
    if (stable.length > 0) {
      segments.push({ kind: "stable", lines: stable });
      stable = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    if (!line.startsWith(OURS_MARK)) {
      stable.push(line);
      i += 1;
      continue;
    }

    // A conflict block opens here.
    flushStable();
    const oursLabel = line.substring(OURS_MARK.length).trim();
    i += 1;

    const ours: string[] = [];
    let base: string[] | null = null;
    const theirs: string[] = [];
    let theirsLabel = "";

    // ours, up to either the base marker or the split
    while (i < lines.length && !lines[i].startsWith(SPLIT_MARK) && !lines[i].startsWith(BASE_MARK)) {
      ours.push(lines[i]);
      i += 1;
    }

    if (i < lines.length && lines[i].startsWith(BASE_MARK)) {
      i += 1;
      base = [];
      while (i < lines.length && !lines[i].startsWith(SPLIT_MARK)) {
        base.push(lines[i]);
        i += 1;
      }
    }

    // skip the ======= line
    if (i < lines.length && lines[i].startsWith(SPLIT_MARK)) i += 1;

    while (i < lines.length && !lines[i].startsWith(THEIRS_MARK)) {
      theirs.push(lines[i]);
      i += 1;
    }

    if (i < lines.length && lines[i].startsWith(THEIRS_MARK)) {
      theirsLabel = lines[i].substring(THEIRS_MARK.length).trim();
      i += 1;
    }

    segments.push({
      kind: "conflict",
      region: { index, ours, theirs, base, oursLabel, theirsLabel },
    });
    index += 1;
  }

  flushStable();
  return segments;
}

/** Which lines of each side are included, per conflict. */
export interface Selection {
  ours: boolean[];
  theirs: boolean[];
}

export function emptySelection(segments: Segment[]): Selection[] {
  const out: Selection[] = [];
  for (const seg of segments) {
    if (seg.kind !== "conflict") continue;
    out.push({
      // Nothing is chosen to begin with, deliberately. A default of "take
      // ours" looks like a resolution that has been reviewed when it has not.
      ours: seg.region.ours.map(() => false),
      theirs: seg.region.theirs.map(() => false),
    });
  }
  return out;
}

/** True when the user has made a decision about this conflict. */
export function isDecided(sel: Selection): boolean {
  return sel.ours.some(Boolean) || sel.theirs.some(Boolean);
}

/**
 * Builds the merged file from the current choices.
 *
 * Our lines come before their lines within a conflict, which is the order the
 * markers had them in - so "take both" reads the same way round as the file
 * git wrote.
 */
export function compose(segments: Segment[], selections: Selection[]): string {
  const LF = String.fromCharCode(10);
  const out: string[] = [];
  let c = 0;

  for (const seg of segments) {
    if (seg.kind === "stable") {
      for (const line of seg.lines) out.push(line);
      continue;
    }
    const sel = selections[c];
    c += 1;
    if (sel === undefined) continue;
    seg.region.ours.forEach((line, i) => {
      if (sel.ours[i]) out.push(line);
    });
    seg.region.theirs.forEach((line, i) => {
      if (sel.theirs[i]) out.push(line);
    });
  }

  return out.join(LF);
}

/** Line count of each side's full file, for the gutters. */
export function countConflicts(segments: Segment[]): number {
  return segments.filter((s) => s.kind === "conflict").length;
}
