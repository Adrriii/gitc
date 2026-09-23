// The other working trees of a repository.
//
// `git worktree add` gives one repository several checkouts, each with its own
// HEAD, index and uncommitted work, all sharing the same branches. Coding
// agents lean on this - one worktree each, so they cannot trample one another
// - which means the interesting work is often happening in a checkout that is
// not the one open in the tab.
//
// Read from .git directly, like the refs: the list is part of every graph
// refresh, and `git worktree list` would be a subprocess to learn what a
// handful of small files already say.
//
// Nothing here may take a lock in another worktree. An agent running
// `git add` while gitc holds that worktree's index.lock fails, and agents
// recover from that badly - so every git call below runs with
// --no-optional-locks, and none of them writes.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { readStatus } from "./git.ts";
import type { WorkingFile } from "./git.ts";
import { commonDir, gitDir, readHeadOf, readPendingOf } from "./refs.ts";

export interface Worktree {
  /**
   * How requests name it: the directory under .git/worktrees, "" for the main
   * working tree. A name rather than a path, so an endpoint taking one can
   * only ever reach a worktree git itself registered - never an arbitrary
   * directory someone typed into a query string.
   */
  name: string;
  /** Where its files are. */
  path: string;
  /** The repository's original working tree, the one .git sits in. */
  main: boolean;
  /** The worktree this tab has open. */
  current: boolean;
  branch: string | null;
  hash: string | null;
  detached: boolean;
  /** `git worktree lock` - protects it from prune and remove, not from edits. */
  locked: boolean;
  lockReason: string;
  /**
   * Registered but gone from disk. Agents tend to clean up with a plain
   * delete, which leaves these behind until something runs `git worktree
   * prune`.
   */
  prunable: boolean;
  /** An operation in progress there, as readPending names it; "" when idle. */
  pending: string;
  /**
   * Milliseconds since its HEAD or index last moved, measured here so a
   * remote's clock never has to agree with the window's. How the UI tells a
   * worktree someone is working in from one that has been left alone.
   */
  idleMs: number;
}

/** A worktree's admin directory: its HEAD, index and in-progress markers. */
interface Located {
  name: string;
  admin: string;
  path: string;
  main: boolean;
}

function readTrimmed(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

function mtime(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Two spellings of one directory. git writes forward slashes and whatever
 * case the command line used; Windows treats both as the same.
 */
export function samePath(a: string, b: string): boolean {
  const x = resolve(a);
  const y = resolve(b);
  if (process.platform === "win32") return x.toLowerCase() === y.toLowerCase();
  return x === y;
}

/**
 * The main working tree, when there is one.
 *
 * It is the directory the common .git sits in. A bare repository has no main
 * working tree - only linked ones - and neither does a submodule's, whose
 * git directory lives under the superproject's .git/modules; both are
 * recognised by the directory not being called ".git".
 */
function mainTree(common: string): Located | null {
  if (basename(common) !== ".git") return null;
  return { name: "", admin: common, path: dirname(common), main: true };
}

function locate(repo: string): Located[] {
  const common = commonDir(repo);
  const out: Located[] = [];
  const main = mainTree(common);
  if (main !== null) out.push(main);

  const root = join(common, "worktrees");
  if (!existsSync(root)) return out;
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return out;
  }
  // Sorted so the list does not reshuffle between refreshes: readdir makes
  // no promise about order.
  names.sort();
  for (const name of names) {
    const admin = join(root, name);
    // `gitdir` names the worktree's .git FILE, so the worktree is its parent.
    // Relative to the admin directory under worktree.useRelativePaths.
    const pointer = readTrimmed(join(admin, "gitdir"));
    if (pointer.length === 0) continue;
    out.push({ name, admin, path: dirname(resolve(admin, pointer)), main: false });
  }
  return out;
}

/** Every worktree of the repository `repo` belongs to, main first. */
export function listWorktrees(repo: string): Worktree[] {
  const own = gitDir(repo);
  const now = Date.now();
  const out: Worktree[] = [];
  for (const w of locate(repo)) {
    const head = readHeadOf(w.admin);
    const lockFile = join(w.admin, "locked");
    const locked = !w.main && existsSync(lockFile);
    const touched = Math.max(mtime(join(w.admin, "HEAD")), mtime(join(w.admin, "index")));
    out.push({
      name: w.name,
      path: w.path,
      main: w.main,
      current: samePath(w.admin, own),
      branch: head.branch,
      hash: head.hash,
      detached: head.detached,
      locked,
      lockReason: locked ? readTrimmed(lockFile) : "",
      prunable: !w.main && !existsSync(w.path),
      pending: readPendingOf(w.admin).kind,
      idleMs: touched === 0 ? -1 : Math.max(0, Math.round(now - touched)),
    });
  }
  return out;
}

/**
 * A worktree of this repository, by the name `listWorktrees` gave it.
 *
 * The gate every endpoint that reads another worktree goes through: the name
 * is looked up among the registered ones and never joined onto a path, so
 * "../../elsewhere" matches nothing and reaches nothing.
 */
export function findWorktree(repo: string, name: string): Worktree | null {
  for (const w of listWorktrees(repo)) {
    if (w.name === name && !w.prunable) return w;
  }
  return null;
}

// ------------------------------------------------------------- status

/**
 * How long another worktree's status stands before it is asked again.
 *
 * Longer than the open tab's, on purpose. Several agents editing at once
 * would otherwise mean several `git status` runs on every poll, for rows the
 * user is glancing at rather than working in.
 */
const OTHER_STATUS_MS = 4000;

interface CachedStatus {
  at: number;
  files: WorkingFile[];
}

const statusCache = new Map<string, CachedStatus>();

/**
 * Another worktree's uncommitted files, without locking anything there.
 *
 * Shared by the fingerprint and the graph payload so a refresh the one
 * triggers does not immediately run the same `git status` again for the
 * other.
 */
export async function worktreeStatus(path: string): Promise<WorkingFile[]> {
  const now = Date.now();
  const cached = statusCache.get(path);
  if (cached !== undefined && now - cached.at < OTHER_STATUS_MS) return cached.files;
  const files = await readStatus(path, true);
  statusCache.set(path, { at: now, files });
  return files;
}

/**
 * Statuses for every other live worktree, keyed by name. Started together
 * and collected in turn; a worktree whose status fails - deleted mid-read, or
 * no longer a checkout - is left out rather than failing the lot.
 */
export async function otherStatuses(worktrees: Worktree[]): Promise<Map<string, WorkingFile[]>> {
  const pending = new Map<string, Promise<WorkingFile[] | null>>();
  for (const w of worktrees) {
    if (w.current || w.prunable) continue;
    pending.set(
      w.name,
      worktreeStatus(w.path).catch((): null => null),
    );
  }
  const out = new Map<string, WorkingFile[]>();
  for (const [name, p] of pending) {
    const files = await p;
    if (files !== null) out.set(name, files);
  }
  return out;
}
