export interface LineDiff {
  /** One per line of the new text. */
  marks: ("same" | "add" | "mod")[];
  /** The old text a "mod" line replaced, by new line index. */
  was: Map<number, string>;
  /** New line indexes with removed lines just above them; marks.length means at the end. */
  removed: Set<number>;
}

const MAX_CELLS = 4_000_000;

export function lineDiff(before: string[], after: string[]): LineDiff {
  const out: LineDiff = { marks: after.map(() => "same"), was: new Map(), removed: new Set() };

  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }

  const a = before.slice(head, before.length - tail);
  const b = after.slice(head, after.length - tail);
  // ponytail: one changed run past MAX_CELLS, a Myers diff if huge pastes ever matter
  if (a.length * b.length > MAX_CELLS) {
    mark(out, a, b.map((_, j) => head + j), head);
    return out;
  }

  const n = a.length;
  const m = b.length;
  const table = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[at(i, j)] =
        a[i] === b[j] ? table[at(i + 1, j + 1)] + 1 : Math.max(table[at(i + 1, j)], table[at(i, j + 1)]);
    }
  }

  let i = 0;
  let j = 0;
  let dels: string[] = [];
  let adds: number[] = [];
  const flush = () => {
    if (dels.length > 0 || adds.length > 0) mark(out, dels, adds, head + j);
    dels = [];
    adds = [];
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flush();
      i += 1;
      j += 1;
    } else if (j >= m || (i < n && table[at(i + 1, j)] >= table[at(i, j + 1)])) {
      dels.push(a[i]);
      i += 1;
    } else {
      adds.push(head + j);
      j += 1;
    }
  }
  flush();
  return out;
}

function mark(out: LineDiff, dels: string[], adds: number[], end: number) {
  adds.forEach((line, k) => {
    const old = dels[k];
    if (old === undefined) {
      out.marks[line] = "add";
      return;
    }
    out.marks[line] = "mod";
    out.was.set(line, old);
  });
  if (dels.length > adds.length) out.removed.add(adds[0] ?? end);
}
