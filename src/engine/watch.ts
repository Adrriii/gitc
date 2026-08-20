// Noticing that a repository changed underneath us.
//
// gitc is not the only thing touching these files: you edit in an editor, run
// git in a terminal, and a build writes output. Without watching, the graph
// only refreshes after gitc's own actions, which is exactly when it is least
// needed.
//
// fs.watch is not enough here. `recursive: true` is a compile fence in
// scriptc, so a non-recursive watch could see .git's top level but never an
// edit to a file three directories deep in the working tree - which is the
// common case. So this polls instead, and the whole design is about making
// the poll cheap enough to run often:
//
//   - only the ACTIVE repository is fingerprinted, not every open tab
//   - the UI only asks while its window is focused
//   - each answer is cached briefly, so several askers cost one check
//   - the filesystem part runs first, and `git status` (the expensive part,
//     ~230ms on a large repo) only when it might tell us something new

import { existsSync, statSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { git } from "./git.ts";
import { gitDir } from "./refs.ts";

/** How long a fingerprint stands before it is recomputed. */
const CACHE_MS = 900;

interface Cached {
  at: number;
  value: string;
}

const cache = new Map<string, Cached>();

/** FNV-1a. Small, fast, and only ever compared against itself. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    // The shifts are FNV's 32-bit prime multiply, written to stay in range.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  // String(h), not h.toString(16): a radix argument needs scriptc's embedded
  // dynamic engine, which a static build does not carry. The value is only
  // ever compared with itself, so the base is irrelevant.
  return String(h);
}

function mtimeOf(path: string): string {
  if (!existsSync(path)) return "-";
  try {
    return String(statSync(path).mtimeMs);
  } catch {
    return "-";
  }
}

/** Walks the loose refs, whose mtimes move when a branch does. */
function refsFingerprint(dir: string, depth: number): string {
  if (depth > 4 || !existsSync(dir)) return "";
  let out = "";
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      out += st.isDirectory()
        ? refsFingerprint(full, depth + 1)
        : entry + ":" + String(st.mtimeMs) + ";";
    }
  } catch {
    // A ref being rewritten while we look is normal; the next poll catches it.
  }
  return out;
}

/**
 * When this repository last fetched, in epoch milliseconds; 0 if it never has.
 *
 * Read from FETCH_HEAD's mtime rather than remembered in gitc, because the
 * question is whether the remote data is stale - not whether *gitc* fetched
 * it. git writes this file on every fetch and every pull, so a fetch run in a
 * terminal counts exactly as much as one run from here, which is the answer a
 * person actually wants.
 */
export function lastFetch(repo: string): number {
  const path = join(gitDir(repo), "FETCH_HEAD");
  if (!existsSync(path)) return 0;
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * A value that changes whenever anything about the repository changes.
 *
 * Not a checksum of the repository - just something stable that moves when
 * the state does. The caller only ever compares it with the previous one.
 */
export async function fingerprint(repo: string): Promise<string> {
  const cached = cache.get(repo);
  const now = Date.now();
  if (cached !== undefined && now - cached.at < CACHE_MS) return cached.value;

  const dir = gitDir(repo);

  // The cheap half: HEAD, the index, the in-progress markers and the refs.
  // This alone catches commits, checkouts, staging, merges and rebases.
  let text = "";
  const headPath = join(dir, "HEAD");
  if (existsSync(headPath)) {
    try {
      text += readFileSync(headPath, "utf8").trim() + "|";
    } catch {
      text += "?|";
    }
  }
  for (const name of ["index", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "packed-refs"]) {
    text += name + "=" + mtimeOf(join(dir, name)) + ";";
  }
  text += refsFingerprint(join(dir, "refs"), 0);
  text += "rebase=" + mtimeOf(join(dir, "rebase-merge")) + ";";

  // The expensive half: what the working tree looks like. Nothing in .git
  // moves when a file is merely edited, so this is the only way to see it.
  //
  // --no-optional-locks matters more than it looks. A plain `git status`
  // refreshes the index as a side effect, which changes .git/index's mtime -
  // so the fingerprint would differ every time purely because we measured it,
  // and the UI would reload itself every poll forever.
  try {
    text += await git(repo, [
      "--no-optional-locks",
      "status",
      "--porcelain=v1",
      "-z",
      "-uall",
    ]);
  } catch {
    text += "status-failed";
  }

  const value = hash(text);
  cache.set(repo, { at: now, value });
  return value;
}
