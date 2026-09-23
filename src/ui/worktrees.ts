/**
 * The repository's other checkouts, as the UI sees them.
 *
 * A worktree is either yours or somebody else's. Yours - the one a tab has
 * open - gets everything: staging, committing, every operation. Anyone
 * else's, which with coding agents usually means an agent's, is looked at
 * and never touched: its uncommitted work is a graph row you can select and
 * read, and editing it means opening it as a tab of its own, deliberately.
 */
import type { Worktree } from "./types";

/** The WIP row for this tab's own working tree. */
export const OWN_WIP = "WIP";

/** The graph row holding another worktree's uncommitted work. */
export function wipHash(name: string): string {
  return OWN_WIP + ":" + name;
}

/** Any WIP row - this tab's or another worktree's. Never a real commit. */
export function isWip(hash: string): boolean {
  return hash === OWN_WIP || hash.startsWith(OWN_WIP + ":");
}

/** Which worktree a WIP row belongs to, or null for this tab's own and for commits. */
export function wipWorktree(hash: string): string | null {
  return hash.startsWith(OWN_WIP + ":") ? hash.substring(OWN_WIP.length + 1) : null;
}

/** The last part of a path, whichever separator it uses. */
function leaf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut === -1 ? trimmed : trimmed.substring(cut + 1);
}

/**
 * What to call a worktree: its directory's name.
 *
 * The same name the tab gets when it is opened, so the list, the graph and
 * the tab bar agree. git's own name for a linked worktree is usually that
 * already; the main one has none.
 */
export function worktreeLabel(w: Worktree): string {
  const name = leaf(w.path);
  return name.length > 0 ? name : w.name;
}

/**
 * How recently a worktree has to have moved to count as being worked in.
 *
 * Measured on its HEAD and index, which move on every commit, checkout and
 * `git add` - the things an agent does in a loop. An agent that is only
 * editing files moves neither, so this is a hint, not a lock.
 */
export const ACTIVE_MS = 30_000;

/** Somebody - probably an agent - has been using it within ACTIVE_MS. */
export function isActive(w: Worktree): boolean {
  return !w.current && w.idleMs >= 0 && w.idleMs < ACTIVE_MS;
}

/**
 * Branches checked out in a worktree other than this tab's, to the worktree
 * holding each.
 *
 * git refuses to check out, delete or force-move a branch another worktree
 * has, and says so in an error that arrives after the click. Knowing up front
 * lets the chip say it and lets a double-click open that worktree instead.
 */
export function branchesElsewhere(worktrees: Worktree[]): Map<string, Worktree> {
  const out = new Map<string, Worktree>();
  for (const w of worktrees) {
    if (w.current || w.prunable || w.branch === null || w.detached) continue;
    out.set(w.branch, w);
  }
  return out;
}

/** A worktree by the name the engine gave it; "" is the main one. */
export function findWorktree(worktrees: Worktree[], name: string): Worktree | undefined {
  return worktrees.find((w) => w.name === name);
}

/** The summary the row and the list both show: "3 changed, 1 new". */
export function changeCounts(w: Worktree): { modified: number; added: number } {
  return {
    modified: w.status.filter((f) => !f.untracked).length,
    added: w.status.filter((f) => f.untracked).length,
  };
}
