// Unified-diff parsing.
//
// All three view modes in docs/ui-spec.md render from this one structure:
//
//   Unified  - the hunks as they come, each under its @@ header
//   Inline   - the whole file, changes in place
//   Split    - the same rows, dealt into an old and a new column
//
// Inline and Split need the entire file, not just the changed neighbourhood.
// Rather than fetching the file separately and re-aligning it against the
// diff (which is where off-by-one bugs live), we ask git for the diff with a
// context large enough to swallow the file. One code path, one parser, and
// the line numbers are git's own.

import { readFileSync, existsSync, statSync } from "node:fs";

import { git, gitOrNull } from "./git.ts";
import { inRepo } from "./paths.ts";
import { at } from "./safe.ts";

/** Files past this size are reported rather than rendered line by line. */
const MAX_INLINE_BYTES = 4 * 1024 * 1024;

/** Context lines that make `git diff` emit the whole file as one hunk. */
export const FULL_CONTEXT = 1000000;

export type LineKind = "context" | "add" | "del" | "meta";

export interface DiffLine {
  kind: LineKind;
  /** Line number in the old file, or null for an addition. */
  oldNo: number | null;
  /** Line number in the new file, or null for a deletion. */
  newNo: number | null;
  text: string;
  /** True when git reported "\ No newline at end of file" after this line. */
  noNewline: boolean;
}

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** The text after the second @@, which git fills with the enclosing scope. */
  heading: string;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  oldPath: string | null;
  binary: boolean;
  /** Skipped for size rather than for being binary - a different message. */
  tooLarge: boolean;
  /** Set when the file is new, deleted, or renamed. */
  status: string;
  hunks: Hunk[];
  /** True when the requested context covered the whole file. */
  whole: boolean;
}

function parseHunkHeader(line: string): Hunk | null {
  // @@ -oldStart,oldCount +newStart,newCount @@ heading
  if (!line.startsWith("@@")) return null;
  const close = line.indexOf("@@", 2);
  if (close === -1) return null;

  const ranges = line.substring(2, close).trim();
  const heading = line.substring(close + 2).trim();

  const parts = ranges.split(" ");
  const oldPart = at(parts, 0);
  const newPart = at(parts, 1);
  if (oldPart === undefined || newPart === undefined) return null;

  const parseRange = (spec: string): number[] => {
    // "-12,7" or "+12" (count omitted means 1)
    const body = spec.substring(1);
    const comma = body.indexOf(",");
    if (comma === -1) return [parseInt(body, 10), 1];
    return [
      parseInt(body.substring(0, comma), 10),
      parseInt(body.substring(comma + 1), 10),
    ];
  };

  const o = parseRange(oldPart);
  const n = parseRange(newPart);
  const oldStart = at(o, 0);
  const oldCount = at(o, 1);
  const newStart = at(n, 0);
  const newCount = at(n, 1);
  if (
    oldStart === undefined || oldCount === undefined ||
    newStart === undefined || newCount === undefined
  ) {
    return null;
  }

  return { oldStart, oldCount, newStart, newCount, heading, lines: [] };
}

/** Parses `git diff` output for a single file. */
export function parseUnified(raw: string, path: string): FileDiff {
  const out: FileDiff = {
    path,
    oldPath: null,
    binary: false,
    tooLarge: false,
    status: "M",
    hunks: [],
    whole: false,
  };

  let hunk: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git")) {
      hunk = null;
      continue;
    }
    if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) {
      out.binary = true;
      continue;
    }
    if (line.startsWith("new file mode")) {
      out.status = "A";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      out.status = "D";
      continue;
    }
    if (line.startsWith("rename from ")) {
      out.oldPath = line.substring("rename from ".length);
      out.status = "R";
      continue;
    }
    // index/--- /+++ /mode lines carry nothing the viewer needs.
    if (
      line.startsWith("index ") || line.startsWith("--- ") ||
      line.startsWith("+++ ") || line.startsWith("similarity index") ||
      line.startsWith("rename to ") || line.startsWith("old mode") ||
      line.startsWith("new mode")
    ) {
      continue;
    }

    const header = parseHunkHeader(line);
    if (header !== null) {
      hunk = header;
      oldNo = header.oldStart;
      newNo = header.newStart;
      out.hunks.push(hunk);
      continue;
    }

    if (hunk === null) continue;

    if (line.startsWith("\\")) {
      // "\ No newline at end of file" annotates the line before it.
      const prev = at(hunk.lines, hunk.lines.length - 1);
      if (prev !== undefined) prev.noNewline = true;
      continue;
    }

    const marker = line.charAt(0);
    const text = line.substring(1);

    if (marker === "+") {
      hunk.lines.push({ kind: "add", oldNo: null, newNo, text, noNewline: false });
      newNo += 1;
    } else if (marker === "-") {
      hunk.lines.push({ kind: "del", oldNo, newNo: null, text, noNewline: false });
      oldNo += 1;
    } else if (marker === " " || line.length === 0) {
      // A truly empty line in the output is an empty context line.
      hunk.lines.push({ kind: "context", oldNo, newNo, text, noNewline: false });
      oldNo += 1;
      newNo += 1;
    }
  }

  return out;
}

function contextArg(context: number): string {
  return "-U" + context;
}

/** The diff a single commit made to one file, against its first parent. */
export async function diffCommitFile(
  repo: string,
  sha: string,
  path: string,
  context: number,
): Promise<FileDiff> {
  const raw = await git(repo, [
    "show",
    contextArg(context),
    "--format=",
    "--no-color",
    "--first-parent",
    sha,
    "--",
    path,
  ]);
  const parsed = parseUnified(raw, path);
  parsed.whole = context >= FULL_CONTEXT;
  return parsed;
}

/** The combined diff a run of commits made to one file. */
export async function diffRangeFile(
  repo: string,
  oldestSha: string,
  newestSha: string,
  path: string,
  context: number,
): Promise<FileDiff> {
  let base = oldestSha + "^";
  const probe = await gitOrNull(repo, ["rev-parse", "--verify", base]);
  if (probe === null) base = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

  const raw = await git(repo, [
    "diff",
    contextArg(context),
    "--no-color",
    base,
    newestSha,
    "--",
    path,
  ]);
  const parsed = parseUnified(raw, path);
  parsed.whole = context >= FULL_CONTEXT;
  return parsed;
}

/**
 * The working-directory diff for one file.
 *
 * `staged` picks which half of the WIP state you get: the index against HEAD,
 * or the working tree against the index - the same split the staging panel
 * shows.
 */
export async function diffWorkingFile(
  repo: string,
  path: string,
  staged: boolean,
  context: number,
  untracked: boolean,
): Promise<FileDiff> {
  // `git status` already told us this file is untracked, so take the caller's
  // word for it and read the file directly. This matters on big repos: the
  // alternative is a `git diff` that returns nothing followed by a
  // `git ls-files` to find out why - two process spawns per file, on a panel
  // that can list hundreds. Using a temp file as the diff base would add a
  // third rather than removing any.
  if (untracked && !staged) return newFileDiff(repo, path, context);

  const args = ["diff", contextArg(context), "--no-color"];
  if (staged) args.push("--cached");
  args.push("--", path);

  const raw = await git(repo, args);

  // An untracked file has no diff at all - git has nothing to compare it
  // against. `--no-index /dev/null` is the usual trick but there is no such
  // path on Windows, and `add -N` would mean mutating the index just to look
  // at a file. So the "everything is new" diff is synthesised here instead,
  // which touches nothing.
  if (raw.trim().length === 0 && !staged) {
    const untracked = await gitOrNull(repo, ["ls-files", "--error-unmatch", "--", path]);
    if (untracked === null) return newFileDiff(repo, path, context);
  }

  const parsed = parseUnified(raw, path);
  parsed.whole = context >= FULL_CONTEXT;
  return parsed;
}

/**
 * The diff for a file git has never seen: every line an addition.
 *
 * Built here rather than asked of git, because every git-native way of
 * diffing an untracked file either needs a /dev/null that Windows lacks or
 * writes to the index or object store. Looking at a file should not change
 * the repository.
 */

/**
 * Drops a trailing CR.
 *
 * Written with char codes rather than an escape because these constants get
 * mangled passing through tooling; String.fromCharCode is unambiguous.
 */
function stripCarriageReturn(text: string): string {
  const CR = String.fromCharCode(13);
  return text.endsWith(CR) ? text.substring(0, text.length - 1) : text;
}

function newFileDiff(repo: string, path: string, context: number): FileDiff {
  const out: FileDiff = {
    path,
    oldPath: null,
    binary: false,
    tooLarge: false,
    status: "A",
    hunks: [],
    whole: context >= FULL_CONTEXT,
  };

  // The caller's path is repository-relative and arrives over the API.
  // `join` resolves "..", so this read used to reach any file the engine
  // could open and hand it back as a diff of a "new" file - measured against
  // a running engine with ?untracked=1 and a path of "../secret.txt".
  const full = inRepo(repo, path);
  if (full === null) return out;
  if (!existsSync(full)) return out;

  if (statSync(full).size > MAX_INLINE_BYTES) {
    out.tooLarge = true;
    return out;
  }

  const content = readFileSync(full, "utf8");
  // A NUL byte is git's own heuristic for "this is not text".
  if (content.indexOf(String.fromCharCode(0)) !== -1) {
    out.binary = true;
    return out;
  }

  const lines = content.split(String.fromCharCode(10));
  // A trailing newline produces a final empty element that is not a line.
  if (lines.length > 0 && at(lines, lines.length - 1) === "") lines.pop();
  if (lines.length === 0) return out;

  const hunk: Hunk = {
    oldStart: 0,
    oldCount: 0,
    newStart: 1,
    newCount: lines.length,
    heading: "",
    lines: [],
  };
  for (let i = 0; i < lines.length; i++) {
    const text = at(lines, i);
    if (text === undefined) continue;
    hunk.lines.push({
      kind: "add",
      oldNo: null,
      newNo: i + 1,
      text: stripCarriageReturn(text),
      noNewline: false,
    });
  }
  out.hunks.push(hunk);
  return out;
}
