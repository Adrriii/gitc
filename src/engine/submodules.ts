// Submodules: what the superproject records, and what is actually on disk.
//
// Two sources, because neither alone is enough. `.gitmodules` is the declared
// list - name, path, url - and it is committed, so it lists submodules that
// have never been checked out. `git submodule status` is the live state, and
// it is the only thing that knows whether a submodule is initialised, sitting
// at the recorded commit, or has moved.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { gitOrNull } from "./git.ts";

export type SubmoduleState =
  /** Declared but never checked out - the directory is empty. */
  | "uninitialized"
  /** Checked out at exactly the commit the superproject records. */
  | "current"
  /** Checked out, but at a different commit than the superproject records. */
  | "moved"
  /**
   * Checked out at the recorded commit, but with uncommitted work inside it.
   *
   * Reported here rather than in the staging panel, which is where git puts
   * it and where it cannot be acted on: staging a submodule stages the
   * commit the superproject records, and that has not moved. So the panel
   * showed a row that did nothing, and this says the same thing somewhere it
   * means something.
   */
  | "dirty"
  /** Merge conflicts inside the submodule. */
  | "conflicted"
  /**
   * Declared, but its live state has not been read yet.
   *
   * The declared list is one file read. The live state is `git submodule
   * status`, which walks into every submodule and measured at 727ms on a
   * repository with one and 892ms on a repository with five - two thirds of
   * the entire cold load, paid again on every refresh. Nothing on screen
   * needs it to draw the window, so the list now arrives with the graph
   * wearing this, and the states land when they land.
   */
  | "pending";

export interface Submodule {
  /** The name in .gitmodules, which is not always the path. */
  name: string;
  /** Path relative to the superproject. */
  path: string;
  /** Absolute path, so the UI can open it as a repository. */
  absolute: string;
  url: string;
  state: SubmoduleState;
  /** The commit the submodule is at, or the one recorded when uninitialised. */
  sha: string;
  /** What git prints in brackets: a branch, a tag, a describe. Often empty. */
  label: string;
}

/**
 * Parses .gitmodules.
 *
 * It is git config syntax, but a plain file rather than something git will
 * hand over wholesale - and reading it directly means submodules that were
 * never initialised still appear, which is the case that most needs showing.
 */
function declared(repo: string): { name: string; path: string; url: string }[] {
  const out: { name: string; path: string; url: string }[] = [];

  const file = join(repo, ".gitmodules");
  if (!existsSync(file)) return out;

  let raw = "";
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return out;
  }
  let name = "";
  let path = "";
  let url = "";

  const flush = () => {
    if (name.length > 0 && path.length > 0) out.push({ name, path, url });
    name = "";
    path = "";
    url = "";
  };

  for (const line of raw.split(String.fromCharCode(10))) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[submodule ")) {
      flush();
      // [submodule "some name"]
      const open = trimmed.indexOf('"');
      const close = trimmed.lastIndexOf('"');
      if (open !== -1 && close > open) name = trimmed.substring(open + 1, close);
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.substring(0, eq).trim().toLowerCase();
    const value = trimmed.substring(eq + 1).trim();
    if (key === "path") path = value;
    if (key === "url") url = value;
  }
  flush();

  return out;
}

/**
 * Reads live state for each submodule.
 *
 * `git submodule status` prefixes each line with the state: "-" for not
 * initialised, "+" for checked out at a different commit than recorded, "U"
 * for conflicts, and a space for in sync.
 */
async function liveState(repo: string): Promise<Map<string, { state: SubmoduleState; sha: string; label: string }>> {
  const byPath = new Map<string, { state: SubmoduleState; sha: string; label: string }>();

  const raw = await gitOrNull(repo, ["submodule", "status"]);
  if (raw === null) return byPath;

  for (const line of raw.split(String.fromCharCode(10))) {
    if (line.trim().length === 0) continue;

    const marker = line.charAt(0);
    let state: SubmoduleState = "current";
    if (marker === "-") state = "uninitialized";
    else if (marker === "+") state = "moved";
    else if (marker === "U") state = "conflicted";

    // "<marker><sha> <path> (<label>)", where the label is often absent.
    const rest = line.substring(1).trim();
    const space = rest.indexOf(" ");
    if (space === -1) continue;
    const sha = rest.substring(0, space);

    let tail = rest.substring(space + 1).trim();
    let label = "";
    const open = tail.lastIndexOf(" (");
    if (open !== -1 && tail.endsWith(")")) {
      label = tail.substring(open + 2, tail.length - 1);
      tail = tail.substring(0, open).trim();
    }

    byPath.set(tail, { state, sha, label });
  }

  return byPath;
}

/**
 * Which submodules have uncommitted work inside them.
 *
 * `git submodule status` does not say - a dirty submodule and a clean one
 * both come back with a leading space - so it takes a second question. This
 * is the walk `readStatus` stopped doing on the critical path, asked once
 * here where nothing is waiting on it.
 *
 * `-uno` because untracked files in the superproject are irrelevant to the
 * question and enumerating them is not free.
 */
async function dirtyPaths(repo: string): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();

  const raw = await gitOrNull(repo, [
    "--no-optional-locks",
    "status",
    "--porcelain=v1",
    "-z",
    "-uno",
    "--ignore-submodules=none",
  ]);
  if (raw === null) return out;

  const NUL = String.fromCharCode(0);
  const parts = raw.split(NUL);
  let i = 0;
  while (i < parts.length) {
    const entry = parts[i];
    if (entry.length < 4) {
      i += 1;
      continue;
    }
    // A rename carries its old path in the next field; skip it.
    if (entry.charAt(0) === "R" || entry.charAt(0) === "C") i += 1;
    out.set(entry.substring(3), true);
    i += 1;
  }
  return out;
}

export async function readSubmodules(repo: string): Promise<Submodule[]> {
  const out: Submodule[] = [];

  const list = declared(repo);
  if (list.length === 0) return out;

  const live = await liveState(repo);
  const dirty = await dirtyPaths(repo);

  for (const entry of list) {
    const state = live.get(entry.path);
    out.push({
      name: entry.name,
      path: entry.path,
      absolute: join(repo, entry.path),
      url: entry.url,
      // Declared but absent from `submodule status` means git does not know
      // about it yet either - which is the uninitialised case.
      //
      // "dirty" is the weakest of these and only applies when nothing louder
      // does: a submodule that has MOVED is reported as moved whether or not
      // it is also dirty, because the moved commit is the part this
      // repository records and can stage.
      state:
        state === undefined
          ? "uninitialized"
          : state.state === "current" && (dirty.get(entry.path) ?? false)
            ? "dirty"
            : state.state,
      sha: state === undefined ? "" : state.sha,
      label: state === undefined ? "" : state.label,
    });
  }

  out.sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()));
  return out;
}

/**
 * The declared submodules, without asking git anything.
 *
 * Everything here comes out of .gitmodules: enough to draw the section, name
 * every entry, and open one as its own tab. Only the state is missing, and
 * only the state costs a subprocess.
 */
export function listSubmodules(repo: string): Submodule[] {
  const out: Submodule[] = [];
  for (const entry of declared(repo)) {
    out.push({
      name: entry.name,
      path: entry.path,
      absolute: join(repo, entry.path),
      url: entry.url,
      state: "pending",
      sha: "",
      label: "",
    });
  }
  out.sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()));
  return out;
}
