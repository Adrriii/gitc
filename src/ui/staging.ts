import type { WorkingFile } from "./types";

/**
 * Splitting the working state into the two lists people act on.
 *
 * A path belongs to BOTH when it has staged changes and newer unstaged ones -
 * git's "MM". The index and the working tree are separate states, and the
 * porcelain code carries one character for each.
 */

/** Changes in the working tree, untracked files included. */
export function unstagedFiles(status: WorkingFile[]): WorkingFile[] {
  return status.filter((f) => f.untracked || (f.worktree.length > 0 && f.worktree !== " "));
}

/** Changes in the index. */
export function stagedFiles(status: WorkingFile[]): WorkingFile[] {
  return status.filter((f) => f.staged);
}

/**
 * What to look at once the file being viewed has left its list.
 *
 * Staging a file - or its last remaining hunk - takes it out of Unstaged, and
 * staying put means staring at a diff of nothing while the work you meant to
 * review next is a click away. So the view follows the list: it takes
 * whatever now occupies the place the file held, which is the next file down,
 * or the last one when the end of the list is reached.
 *
 * `previous` is the list as it was while the file was still in it - the only
 * place its position is still recorded.
 */
export function nextAfter(previous: string[], list: string[], path: string): string | null {
  if (list.length === 0) return null;
  const was = previous.indexOf(path);
  if (was === -1) return list[0];
  return list[Math.min(was, list.length - 1)];
}
