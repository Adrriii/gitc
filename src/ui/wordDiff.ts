/**
 * Which parts of a changed line actually changed.
 *
 * A unified diff is line-shaped: it says this line became that line and
 * leaves you to find the difference by eye. On a long line with one renamed
 * variable that is most of the work of reading a diff, and it is work a
 * machine can do.
 *
 * Two jobs here, kept apart because they fail differently. Pairing decides
 * WHICH removed line became WHICH added line, and is a guess. Comparing
 * decides which characters differ within one such pair, and is exact.
 */

/** A half-open character range within a line. */
export interface Span {
  start: number;
  end: number;
}

/**
 * Splits a line into comparable units.
 *
 * Words, runs of whitespace, and single characters for everything else. The
 * unit matters more than the algorithm: comparing by character marks the
 * shared letters inside two unrelated words and produces confetti, while
 * comparing whole lines is what we already have.
 */
export function tokenize(line: string): Span[] {
  const out: Span[] = [];
  let i = 0;
  const wordish = (c: string) => /[A-Za-z0-9_$]/.test(c);
  const space = (c: string) => c === " " || c === "\t";

  while (i < line.length) {
    const start = i;
    const c = line.charAt(i);
    if (wordish(c)) {
      while (i < line.length && wordish(line.charAt(i))) i += 1;
    } else if (space(c)) {
      while (i < line.length && space(line.charAt(i))) i += 1;
    } else {
      i += 1;
    }
    out.push({ start, end: i });
  }
  return out;
}

/**
 * Beyond this many tokens a side is compared by its ends only.
 *
 * The table below is O(n*m) in both time and memory. Ordinary source lines
 * are a few dozen tokens; a minified bundle on one line is tens of thousands,
 * and squaring that would hang the view for a highlight nobody asked for.
 */
const MAX_TOKENS = 400;

/**
 * The differing spans of two versions of a line.
 *
 * Matching ends are trimmed first - most edits keep their surroundings, and
 * trimming usually leaves a middle small enough to compare properly. What
 * remains goes through a longest-common-subsequence table, so several
 * separate edits on one line are each marked rather than being swallowed into
 * one span running from the first change to the last.
 *
 * Returns empty spans for identical lines, and for a pair with nothing at all
 * in common returns each side whole - marking every character of both is the
 * honest answer there, and it is what "this line was replaced" looks like.
 */
export function wordDiff(before: string, after: string): { before: Span[]; after: Span[] } {
  const none = { before: [] as Span[], after: [] as Span[] };
  if (before === after) return none;

  const a = tokenize(before);
  const b = tokenize(after);

  // Shared ends, in whole tokens.
  let head = 0;
  while (
    head < a.length &&
    head < b.length &&
    before.substring(a[head].start, a[head].end) === after.substring(b[head].start, b[head].end)
  ) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    before.substring(a[a.length - 1 - tail].start, a[a.length - 1 - tail].end) ===
      after.substring(b[b.length - 1 - tail].start, b[b.length - 1 - tail].end)
  ) {
    tail += 1;
  }

  const aMid = a.slice(head, a.length - tail);
  const bMid = b.slice(head, b.length - tail);
  if (aMid.length === 0 && bMid.length === 0) return none;

  const text = (line: string, t: Span) => line.substring(t.start, t.end);
  const join = (spans: Span[]): Span[] => {
    // Adjacent marks read as one change, which is what they are.
    const out: Span[] = [];
    for (const s of spans) {
      const last = out.length > 0 ? out[out.length - 1] : null;
      if (last !== null && last.end === s.start) last.end = s.end;
      else out.push({ start: s.start, end: s.end });
    }
    return out;
  };

  // Too big to compare properly: mark the whole middle. Still far better than
  // marking the line, because the trimmed ends are usually most of it.
  if (aMid.length > MAX_TOKENS || bMid.length > MAX_TOKENS) {
    return {
      before: aMid.length === 0 ? [] : [{ start: aMid[0].start, end: aMid[aMid.length - 1].end }],
      after: bMid.length === 0 ? [] : [{ start: bMid[0].start, end: bMid[bMid.length - 1].end }],
    };
  }

  // Longest common subsequence over the middle tokens.
  const n = aMid.length;
  const m = bMid.length;
  const table: number[] = new Array((n + 1) * (m + 1)).fill(0);
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[at(i, j)] =
        text(before, aMid[i]) === text(after, bMid[j])
          ? table[at(i + 1, j + 1)] + 1
          : Math.max(table[at(i + 1, j)], table[at(i, j + 1)]);
    }
  }

  const beforeSpans: Span[] = [];
  const afterSpans: Span[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (text(before, aMid[i]) === text(after, bMid[j])) {
      i += 1;
      j += 1;
    } else if (table[at(i + 1, j)] >= table[at(i, j + 1)]) {
      beforeSpans.push(aMid[i]);
      i += 1;
    } else {
      afterSpans.push(bMid[j]);
      j += 1;
    }
  }
  while (i < n) {
    beforeSpans.push(aMid[i]);
    i += 1;
  }
  while (j < m) {
    afterSpans.push(bMid[j]);
    j += 1;
  }

  return { before: join(beforeSpans), after: join(afterSpans) };
}

/**
 * Which removed line became which added line.
 *
 * A unified diff hands over a run of removed lines followed by a run of added
 * ones, with no statement about how they correspond. Pairing them in order is
 * the assumption every diff viewer makes and is right almost always: an edit
 * to three consecutive lines produces three of each, in order.
 *
 * Where the runs are different lengths the extra lines on the longer side are
 * left unpaired, which is correct - a line with no counterpart was added or
 * removed outright, and marking part of it would be inventing a relationship.
 */
export function pairRuns<T extends { kind: string }>(lines: T[]): Map<T, T> {
  const pairs = new Map<T, T>();
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind !== "del") {
      i += 1;
      continue;
    }
    const dels: T[] = [];
    while (i < lines.length && lines[i].kind === "del") {
      dels.push(lines[i]);
      i += 1;
    }
    const adds: T[] = [];
    while (i < lines.length && lines[i].kind === "add") {
      adds.push(lines[i]);
      i += 1;
    }
    const n = Math.min(dels.length, adds.length);
    for (let k = 0; k < n; k++) {
      pairs.set(dels[k], adds[k]);
      pairs.set(adds[k], dels[k]);
    }
  }
  return pairs;
}
