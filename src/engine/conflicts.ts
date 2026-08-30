// Conflict state, and the three versions of every conflicted file.
//
// When a merge or rebase stops, git records enough to describe exactly what
// it could not decide: which files clash, in what way, and - through the
// index's numbered stages - the base, our and their content for each. Reading
// that is what lets gitc resolve a conflict rather than only report one.
//
// The rebase progress markers are read straight from .git. They are plain
// text files, they are read on every refresh, and asking git would mean a
// subprocess per poll.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { git, gitOrNull } from "./git.ts";
import { needInRepo } from "./paths.ts";
import { gitDir } from "./refs.ts";
import { at } from "./safe.ts";

/** How a file is conflicted, which decides what resolving it can mean. */
export type ConflictKind =
  | "both-modified"
  | "both-added"
  | "both-deleted"
  | "added-by-us"
  | "added-by-them"
  | "deleted-by-us"
  | "deleted-by-them";

export interface ConflictFile {
  path: string;
  kind: ConflictKind;
  /**
   * True when one side deleted the file. These cannot be merged line by line
   * - the only answers are keep or delete - so the UI asks a different
   * question for them.
   */
  deletion: boolean;
}

export interface ResolvedFile {
  path: string;
  /** A, M, D - what resolving it left behind. */
  status: string;
}

export interface RebaseProgress {
  /** 1-based index of the commit being applied. */
  current: number;
  total: number;
  /** Subject of the commit being applied. */
  subject: string;
  /** Branch being rebased. */
  branch: string;
  /** Short sha of what it is being rebased onto. */
  onto: string;
  /** A branch name for that sha when one exists - what the user recognises. */
  ontoName: string;
}

export interface ConflictState {
  /** merge | rebase | cherry-pick | revert, or "" when nothing is pending. */
  operation: string;
  conflicted: ConflictFile[];
  resolved: ResolvedFile[];
  /** Present only during a rebase. */
  progress: RebaseProgress | null;
  /** git's own conflict note, as it appears in the pending commit message. */
  message: string;
  /**
   * Stash entries currently held. A conflicted `stash pop` keeps its entry,
   * so this is how the UI can promise the work is still recoverable.
   */
  stashes: number;
}

/**
 * git's two-letter unmerged codes.
 *
 * A Map rather than a record object: in scriptc a record's slots are typed
 * and cannot hold undefined, so looking up a key that isn't there throws
 * ("record has no key") instead of yielding undefined. Map.get returns
 * undefined properly, which is what a lookup that may miss needs.
 */
const KINDS = new Map<string, ConflictKind>([
  ["DD", "both-deleted"],
  ["AU", "added-by-us"],
  ["UD", "deleted-by-them"],
  ["UA", "added-by-them"],
  ["DU", "deleted-by-us"],
  ["AA", "both-added"],
  ["UU", "both-modified"],
]);

function readTrimmed(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8").trim();
}

/**
 * Rebase progress, from git's own bookkeeping.
 *
 * Two layouts exist: `rebase-merge` for interactive and merge-based rebases,
 * `rebase-apply` for the older am-based path. Both are read because which one
 * appears depends on flags the user never sees.
 */
function readRebaseProgress(repo: string): RebaseProgress | null {
  const dir = gitDir(repo);

  const merge = join(dir, "rebase-merge");
  if (existsSync(merge)) {
    const headName = readTrimmed(join(merge, "head-name"));
    return {
      current: parseInt(readTrimmed(join(merge, "msgnum")) || "0", 10),
      total: parseInt(readTrimmed(join(merge, "end")) || "0", 10),
      subject: firstLine(readTrimmed(join(merge, "message"))),
      branch: headName.startsWith("refs/heads/")
        ? headName.substring("refs/heads/".length)
        : headName,
      onto: readTrimmed(join(merge, "onto")).substring(0, 7),
      ontoName: "",
    };
  }

  const apply = join(dir, "rebase-apply");
  if (existsSync(apply)) {
    const headName = readTrimmed(join(apply, "head-name"));
    return {
      current: parseInt(readTrimmed(join(apply, "next")) || "0", 10),
      total: parseInt(readTrimmed(join(apply, "last")) || "0", 10),
      subject: "",
      branch: headName.startsWith("refs/heads/")
        ? headName.substring("refs/heads/".length)
        : headName,
      onto: readTrimmed(join(apply, "onto")).substring(0, 7),
      ontoName: "",
    };
  }

  return null;
}

function firstLine(text: string): string {
  const LF = String.fromCharCode(10);
  const nl = text.indexOf(LF);
  return nl === -1 ? text : text.substring(0, nl);
}

/** The pending commit message, which carries git's own conflict note. */
function readPendingMessage(repo: string): string {
  const dir = gitDir(repo);
  for (const name of ["MERGE_MSG", "COMMIT_EDITMSG"]) {
    const path = join(dir, name);
    if (existsSync(path)) return readFileSync(path, "utf8").trim();
  }
  return "";
}

export async function readConflictState(
  repo: string,
  operation: string,
): Promise<ConflictState> {
  const NUL = String.fromCharCode(0);
  const raw = await git(repo, ["status", "--porcelain=v1", "-z", "-uall"]);

  const conflicted: ConflictFile[] = [];
  const resolved: ResolvedFile[] = [];

  const parts = raw.split(NUL);
  let i = 0;
  while (i < parts.length) {
    const entry = at(parts, i);
    if (entry === undefined || entry.length < 4) {
      i += 1;
      continue;
    }
    const code = entry.substring(0, 2);
    const path = entry.substring(3);

    // A rename's source path follows in its own NUL-delimited field.
    if (code.charAt(0) === "R" || code.charAt(0) === "C") i += 1;

    const kind = KINDS.get(code);
    if (kind !== undefined) {
      conflicted.push({
        path,
        kind,
        deletion: kind !== "both-modified" && kind !== "both-added",
      });
    } else if (code.charAt(0) !== " " && code.charAt(0) !== "?") {
      // Staged during this operation - either applied cleanly or already
      // resolved by the user.
      resolved.push({ path, status: code.charAt(0) });
    }
    i += 1;
  }

  // A conflicted `stash pop` leaves unmerged entries and no marker file, so
  // no caller can have known what to pass in. Name the state here rather than
  // at each call site, or one of them will forget - as one already did.
  const effective =
    operation.length === 0 && conflicted.length > 0 ? "unmerged" : operation;

  const progress = effective === "rebase" ? readRebaseProgress(repo) : null;

  // git records only the sha it is rebasing onto. Naming it costs one call
  // and turns "onto d823acb" into "onto main", which is what the user chose.
  if (progress !== null && progress.onto.length > 0) {
    const named = await gitOrNull(repo, [
      "name-rev",
      "--name-only",
      "--refs=refs/heads/*",
      "--refs=refs/remotes/*",
      progress.onto,
    ]);
    if (named !== null) {
      const clean = named.trim();
      // name-rev answers "main~2" when the sha is not a branch tip; that is
      // still more use than a bare hash.
      if (clean.length > 0 && clean !== "undefined") progress.ontoName = clean;
    }
  }

  const stashList = await gitOrNull(repo, ["stash", "list"]);
  const stashes =
    stashList === null
      ? 0
      : stashList.split(String.fromCharCode(10)).filter((l) => l.trim().length > 0).length;

  return {
    operation: effective,
    conflicted,
    resolved,
    progress,
    message: readPendingMessage(repo),
    stashes,
  };
}

/** The index stage numbers git assigns to the three sides of a conflict. */
const STAGE_BASE = 1;
const STAGE_OURS = 2;
const STAGE_THEIRS = 3;

export interface ConflictVersions {
  path: string;
  /** The common ancestor. Empty when the file is new on both sides. */
  base: string;
  /** The version on the branch being rebased onto / merged into. */
  ours: string;
  /** The version being applied. */
  theirs: string;
  /** The working-tree file, complete with git's conflict markers. */
  merged: string;
  binary: boolean;
  hasBase: boolean;
  hasOurs: boolean;
  hasTheirs: boolean;
}

async function stage(repo: string, n: number, path: string): Promise<string | null> {
  // `:N:path` addresses a numbered index stage. A missing stage means that
  // side does not have the file at all, which is itself the answer for a
  // delete conflict.
  return gitOrNull(repo, ["show", ":" + n + ":" + path]);
}

/** Reads all three sides of a conflicted file, plus the marked-up worktree copy. */
export async function readConflictVersions(
  repo: string,
  path: string,
): Promise<ConflictVersions> {
  const base = await stage(repo, STAGE_BASE, path);
  const ours = await stage(repo, STAGE_OURS, path);
  const theirs = await stage(repo, STAGE_THEIRS, path);

  let merged = "";
  // Repository-relative, and it comes off the query string. Without this the
  // "merged" field returned any file the engine could read.
  const worktree = needInRepo(repo, path);
  if (existsSync(worktree)) merged = readFileSync(worktree, "utf8");

  const NUL = String.fromCharCode(0);
  const binary =
    (ours ?? "").indexOf(NUL) !== -1 ||
    (theirs ?? "").indexOf(NUL) !== -1 ||
    merged.indexOf(NUL) !== -1;

  return {
    path,
    base: base ?? "",
    ours: ours ?? "",
    theirs: theirs ?? "",
    merged,
    binary,
    hasBase: base !== null,
    hasOurs: ours !== null,
    hasTheirs: theirs !== null,
  };
}

/**
 * Writes a resolved file and stages it.
 *
 * Staging is what marks a conflict resolved as far as git is concerned -
 * there is no separate "resolved" flag - so the two steps belong together.
 */
export async function resolveWithContent(
  repo: string,
  path: string,
  content: string,
): Promise<void> {
  // The write happens before git ever sees the path, so git's own "outside
  // repository" complaint was no protection at all: it was reported to the
  // caller AFTER the file had been written. This was an arbitrary file write
  // with arbitrary content, reachable by anything that could reach the port -
  // confirmed by writing outside the repository from a cross-site request.
  const full = needInRepo(repo, path);
  writeFileSync(full, content, "utf8");
  await git(repo, ["add", "--", path]);
}

/**
 * Resolves a conflict by taking one side wholesale.
 *
 * `ours` and `theirs` mean what git means by them, which during a REBASE is
 * the reverse of what a user expects: the commits being replayed are
 * "theirs", and the branch being rebased onto is "ours". The UI labels these
 * by branch name rather than by the words, so nobody has to hold that in
 * their head.
 */
export async function resolveWithSide(
  repo: string,
  path: string,
  side: string,
): Promise<void> {
  needInRepo(repo, path);
  if (side === "delete") {
    await git(repo, ["rm", "-f", "--", path]);
    return;
  }
  const flag = side === "theirs" ? "--theirs" : "--ours";
  // checkout of a conflicted path pulls that stage into the working tree; it
  // does not stage anything, so the add is still needed.
  await git(repo, ["checkout", flag, "--", path]);
  await git(repo, ["add", "--", path]);
}

/** Stages every conflicted file as-is, markers and all if still present. */
export async function markAllResolved(repo: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  for (const path of paths) needInRepo(repo, path);
  await git(repo, ["add", "--"].concat(paths));
}

/** Undoes a resolution, putting the file back into conflict. */
export async function unresolve(repo: string, path: string): Promise<void> {
  needInRepo(repo, path);
  await git(repo, ["checkout", "-m", "--", path]);
}
