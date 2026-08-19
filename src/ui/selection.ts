import type { Commit } from "./types";

/**
 * Multi-select is restricted to a contiguous run of commits on one branch.
 *
 * This is not a UI nicety - it's what makes the multi-commit operations
 * meaningful. Squash, drop, reorder and "merged diff" all assume a single
 * unbroken first-parent chain. A selection that skips a commit, or that
 * straddles two branches, has no sensible squash and no sensible combined
 * diff, so we don't let one be built in the first place.
 *
 * "Same branch" here means: walking first parents from the newer commit
 * reaches the older one. First parent specifically, because that is the line
 * a branch follows through its own merges.
 */

/** Newest-first index of each commit, matching graph row order. */
export function indexOf(commits: Commit[]): Map<string, number> {
  const map = new Map<string, number>();
  commits.forEach((c, i) => map.set(c.hash, i));
  return map;
}

/**
 * The first-parent chain from `newer` down to `older`, inclusive.
 * Returns null when `older` is not on `newer`'s first-parent line.
 */
export function chainBetween(
  commits: Commit[],
  byHash: Map<string, Commit>,
  newerHash: string,
  olderHash: string,
): string[] | null {
  if (newerHash === olderHash) return [newerHash];

  const chain: string[] = [];
  let cursor: string | undefined = newerHash;

  // Bounded by the loaded history; a repo can't chain further than that.
  for (let steps = 0; steps <= commits.length; steps++) {
    if (cursor === undefined) return null;
    chain.push(cursor);
    if (cursor === olderHash) return chain;
    const commit = byHash.get(cursor);
    if (commit === undefined) return null;
    cursor = commit.parents.length > 0 ? commit.parents[0] : undefined;
  }
  return null;
}

/**
 * Resolves a shift-click into a selection.
 *
 * Tries both directions, since the user may have clicked above or below the
 * anchor. Falls back to just the clicked commit when the two are not on one
 * branch - better than silently selecting something that can't be acted on.
 */
export function rangeSelect(
  commits: Commit[],
  anchorHash: string,
  targetHash: string,
): string[] {
  const byHash = new Map<string, Commit>();
  for (const c of commits) byHash.set(c.hash, c);

  const order = indexOf(commits);
  const a = order.get(anchorHash);
  const b = order.get(targetHash);
  if (a === undefined || b === undefined) return [targetHash];

  // Lower index = newer, because the list is newest-first.
  const newer = a < b ? anchorHash : targetHash;
  const older = a < b ? targetHash : anchorHash;

  const chain = chainBetween(commits, byHash, newer, older);
  return chain ?? [targetHash];
}

/**
 * Resolves a ctrl-click, keeping the selection a contiguous chain.
 *
 * Adding a commit that neighbours the run extends it; removing an end shrinks
 * it. Anything else replaces the selection, rather than leaving a set that
 * looks selected but can't be squashed.
 */
export function toggleSelect(
  commits: Commit[],
  selected: string[],
  hash: string,
): string[] {
  if (selected.length === 0) return [hash];

  const order = indexOf(commits);
  const idx = order.get(hash);
  if (idx === undefined) return [hash];

  const positions = selected
    .map((h) => order.get(h))
    .filter((n): n is number => n !== undefined)
    .sort((x, y) => x - y);
  if (positions.length === 0) return [hash];

  const top = positions[0];
  const bottom = positions[positions.length - 1];

  // Deselecting one of the two ends keeps the run contiguous.
  if (selected.includes(hash)) {
    if (idx === top || idx === bottom) return selected.filter((h) => h !== hash);
    return [hash];
  }

  // Extending by one, at either end.
  //
  // Adjacency is a question about the first-parent chain, NOT about list
  // position: side branches interleave in the graph order, so the commit
  // directly below `B` in the list can easily belong to another branch while
  // B's actual first parent sits several rows further down. So we ask the
  // chain - build the run that would result and accept it only if it is
  // exactly the current selection plus this one commit.
  const grown = (fromHash: string, toHash: string): string[] | null => {
    const run = rangeSelect(commits, fromHash, toHash);
    if (run.length !== selected.length + 1) return null;
    const inRun = new Set(run);
    for (const h of selected) if (!inRun.has(h)) return null;
    return run;
  };

  const newestSelected = commits[top].hash;
  const oldestSelected = commits[bottom].hash;

  return grown(newestSelected, hash) ?? grown(hash, oldestSelected) ?? [hash];
}
