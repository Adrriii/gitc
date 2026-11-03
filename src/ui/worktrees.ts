/**
 * The repository's other checkouts, as the UI sees them.
 *
 * A worktree is either yours or somebody else's. Yours - the one a tab has
 * open - gets everything: staging, committing, every operation. Anyone
 * else's, which with coding agents usually means an agent's, is looked at
 * and never touched: its uncommitted work is a graph row you can select and
 * read, and editing it means opening it, deliberately, from the repository's tab.
 */
import type { Tab, Worktree } from "./types";

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
export function worktreeLabel(w: Pick<Worktree, "name" | "path">): string {
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

/**
 * Whether two paths name the same directory, as a tab's and a worktree's
 * would: git on Windows reports backslashes where a tab has slashes, and a
 * drive path's case means nothing. A POSIX path keeps its case.
 */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
    return /^[A-Za-z]:/.test(s) ? s.toLowerCase() : s;
  };
  return norm(a) === norm(b);
}

/**
 * The tab of the repository a worktree tab belongs to: its main working tree,
 * open on the same machine. Where closing a worktree's tab should land.
 */
export function mainTabOf(tabs: Tab[], from: Tab, worktrees: Worktree[]): Tab | undefined {
  const main = worktrees.find((w) => w.main);
  if (main === undefined || main.current) return undefined;
  return tabs.find((t) => t.id !== from.id && t.host === from.host && samePath(t.path, main.path));
}

/** A repository's tab and the tabs open on its other worktrees, shown as one. */
export interface TabGroup {
  head: Tab;
  members: Tab[];
}

/**
 * The tab strip as the bar draws it: a worktree's tab folds into its
 * repository's tab when that one is open on the same machine, and stands on
 * its own otherwise - there is nowhere else for it to go.
 *
 * @param mains Each tab's main working tree, where it is known yet. A tab not
 *   in it is drawn alone until it is.
 */
export function groupTabs(tabs: Tab[], mains: Map<string, string>): TabGroup[] {
  const headOf = (t: Tab): Tab | undefined => {
    const main = mains.get(t.id);
    if (main === undefined || samePath(t.path, main)) return undefined;
    return tabs.find((h) => h.id !== t.id && h.host === t.host && samePath(h.path, main));
  };

  const groups: TabGroup[] = [];
  const byHead = new Map<string, TabGroup>();
  // Heads first, so a worktree's tab left of its repository still joins it.
  for (const t of tabs) {
    if (headOf(t) !== undefined) continue;
    const g: TabGroup = { head: t, members: [] };
    groups.push(g);
    byHead.set(t.id, g);
  }
  for (const t of tabs) {
    const h = headOf(t);
    if (h !== undefined) byHead.get(h.id)?.members.push(t);
  }
  return groups;
}

/**
 * Moves the other repositories' tabs along when the checkout in front changes.
 *
 * Work spanning several repositories often has a worktree of the same name in
 * each, so switching one repository's tab to that worktree
 * switches every other tab that has it open by that exact name. Coming back
 * to the repository's own checkout takes back those that were on the same
 * worktree.
 *
 * @param shown Each repository's tab to the worktree tab it shows, updated in
 *   place. Nothing moves until the tab in front differs from what it records,
 *   so calling this on every render is safe.
 */
export function followWorktree(groups: TabGroup[], activeId: string | null, shown: Map<string, string>): void {
  const group = groups.find((g) => g.head.id === activeId || g.members.some((t) => t.id === activeId));
  if (group === undefined) return;
  const now = group.members.find((t) => t.id === activeId);
  const was = shown.get(group.head.id);
  if (was === now?.id) return;
  const wasName = group.members.find((t) => t.id === was)?.name;

  if (now === undefined) shown.delete(group.head.id);
  else shown.set(group.head.id, now.id);

  for (const g of groups) {
    if (g === group) continue;
    if (now === undefined) {
      const current = g.members.find((t) => t.id === shown.get(g.head.id));
      if (wasName !== undefined && current?.name === wasName) shown.delete(g.head.id);
      continue;
    }
    const same = g.members.find((t) => t.name === now.name);
    if (same !== undefined) shown.set(g.head.id, same.id);
  }
}

/** The summary the row and the list both show: "3 changed, 1 new". */
export function changeCounts(w: Worktree): { modified: number; added: number } {
  return {
    modified: w.status.filter((f) => !f.untracked).length,
    added: w.status.filter((f) => f.untracked).length,
  };
}
