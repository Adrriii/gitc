// Reads refs straight out of .git, without spawning git.
//
// This is the fast half of the hybrid backend. Refs are re-read on every
// graph refresh and on every filesystem change, so the subprocess cost
// actually shows up on large repos - and the on-disk format here is simple,
// stable, and documented, which is not true of most of git's output.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface Ref {
  /** Full ref name, e.g. refs/heads/main. */
  name: string;
  /** Display name, e.g. main or origin/main. */
  short: string;
  hash: string;
  kind: "local" | "remote" | "tag";
  /** For remote refs, the remote's name. */
  remote: string | null;
}

export interface Head {
  /** Branch name when attached, null when detached. */
  branch: string | null;
  hash: string | null;
  detached: boolean;
}

/**
 * Resolves a repo's git directory.
 *
 * `.git` is usually a directory, but it is a file containing `gitdir: <path>`
 * for worktrees and submodules - both of which this user has, so it is not a
 * theoretical case.
 */
export function gitDir(repo: string): string {
  const dot = join(repo, ".git");
  if (!existsSync(dot)) return dot;
  const st = statSync(dot);
  if (st.isDirectory()) return dot;
  const content = readFileSync(dot, "utf8").trim();
  if (content.startsWith("gitdir:")) {
    const target = content.substring("gitdir:".length).trim();
    return target;
  }
  return dot;
}

export function readHead(repo: string): Head {
  const path = join(gitDir(repo), "HEAD");
  if (!existsSync(path)) return { branch: null, hash: null, detached: false };
  const raw = readFileSync(path, "utf8").trim();
  if (raw.startsWith("ref: ")) {
    const name = raw.substring(5).trim();
    const branch = name.startsWith("refs/heads/")
      ? name.substring("refs/heads/".length)
      : name;
    return { branch, hash: resolveRef(repo, name), detached: false };
  }
  return { branch: null, hash: raw, detached: true };
}

function resolveRef(repo: string, name: string): string | null {
  const loose = join(gitDir(repo), name);
  if (existsSync(loose)) return readFileSync(loose, "utf8").trim();
  for (const ref of readPackedRefs(repo)) {
    if (ref.name === name) return ref.hash;
  }
  return null;
}

function classify(name: string): Ref | null {
  if (name.startsWith("refs/heads/")) {
    return {
      name,
      short: name.substring("refs/heads/".length),
      hash: "",
      kind: "local",
      remote: null,
    };
  }
  if (name.startsWith("refs/remotes/")) {
    const rest = name.substring("refs/remotes/".length);
    const slash = rest.indexOf("/");
    if (slash === -1) return null;
    return {
      name,
      short: rest,
      hash: "",
      kind: "remote",
      remote: rest.substring(0, slash),
    };
  }
  if (name.startsWith("refs/tags/")) {
    return {
      name,
      short: name.substring("refs/tags/".length),
      hash: "",
      kind: "tag",
      remote: null,
    };
  }
  return null;
}

function readPackedRefs(repo: string): Ref[] {
  const path = join(gitDir(repo), "packed-refs");
  if (!existsSync(path)) return [];
  const out: Ref[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    // Comments start with #; a leading ^ line is a tag's peeled target,
    // which we deliberately skip - we want the tag object, not its commit.
    if (line.length === 0) continue;
    const c = line.charAt(0);
    if (c === "#" || c === "^") continue;
    const space = line.indexOf(" ");
    if (space === -1) continue;
    const hash = line.substring(0, space);
    const name = line.substring(space + 1).trim();
    const ref = classify(name);
    if (ref === null) continue;
    ref.hash = hash;
    out.push(ref);
  }
  return out;
}

function walkLoose(dir: string, prefix: string, out: Ref[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const name = prefix + "/" + entry;
    const st = statSync(full);
    if (st.isDirectory()) {
      // Branch names contain slashes (feat/login), so this must recurse.
      walkLoose(full, name, out);
      continue;
    }
    const ref = classify(name);
    if (ref === null) continue;
    ref.hash = readFileSync(full, "utf8").trim();
    out.push(ref);
  }
}

/** All refs, loose and packed, deduped with loose winning. */
export function readRefs(repo: string): Ref[] {
  const dir = gitDir(repo);
  const loose: Ref[] = [];
  walkLoose(join(dir, "refs", "heads"), "refs/heads", loose);
  walkLoose(join(dir, "refs", "remotes"), "refs/remotes", loose);
  walkLoose(join(dir, "refs", "tags"), "refs/tags", loose);

  const seen = new Set<string>();
  const out: Ref[] = [];
  for (const ref of loose) {
    // A loose ref shadows the packed copy of the same name.
    seen.add(ref.name);
    out.push(ref);
  }
  for (const ref of readPackedRefs(repo)) {
    if (seen.has(ref.name)) continue;
    out.push(ref);
  }

  // HEAD is not a branch; a remote's HEAD pointer would show as a duplicate.
  return out.filter((r) => !r.short.endsWith("/HEAD"));
}

/** Refs grouped by the hash they point at, for drawing chips on graph rows. */
export function refsByHash(refs: Ref[]): Map<string, Ref[]> {
  const map = new Map<string, Ref[]>();
  for (const ref of refs) {
    const list = map.get(ref.hash);
    if (list === undefined) map.set(ref.hash, [ref]);
    else list.push(ref);
  }
  return map;
}

/**
 * An operation git is part-way through.
 *
 * A conflicted merge, cherry-pick, revert or rebase leaves the repository in
 * a state that must be finished or abandoned before anything else will work.
 * git tracks this with marker files, so it costs one stat each to notice -
 * far cheaper than asking git, and this is read on every refresh.
 *
 * Without surfacing it, a failed cherry-pick just looks like an error message
 * and the user is stuck in a state gitc never mentions again.
 */
export interface Pending {
  /** merge | cherry-pick | revert | rebase | bisect, or "" when idle. */
  kind: string;
  /** True when there are unresolved conflicts to deal with first. */
  conflicted: boolean;
}

export function readPending(repo: string): Pending {
  const dir = gitDir(repo);
  const has = (name: string): boolean => existsSync(join(dir, name));

  let kind = "";
  if (has("rebase-merge") || has("rebase-apply")) kind = "rebase";
  else if (has("CHERRY_PICK_HEAD")) kind = "cherry-pick";
  else if (has("REVERT_HEAD")) kind = "revert";
  else if (has("MERGE_HEAD")) kind = "merge";
  else if (has("BISECT_LOG")) kind = "bisect";

  return { kind, conflicted: false };
}

/**
 * Remotes and upstream tracking, read from .git/config.
 *
 * Parsed here rather than asked of git because this is read on every refresh
 * and the format is a stable, simple INI: section headers and indented
 * key = value pairs.
 */
export interface Remote {
  name: string;
  /** Fetch URL. */
  url: string;
  /** Push URL when it differs from the fetch URL, otherwise "". */
  pushUrl: string;
}

export interface RemoteInfo {
  /** Configured remote names, in the order they appear. */
  remotes: string[];
  /** Full detail for each, in the same order. */
  detail: Remote[];
  /** Upstream of each local branch, as "remote/branch". */
  upstreams: Map<string, string>;
}

export function readRemotes(repo: string): RemoteInfo {
  const path = join(gitDir(repo), "config");
  const out: RemoteInfo = { remotes: [], detail: [], upstreams: new Map<string, string>() };
  if (!existsSync(path)) return out;

  const LF = String.fromCharCode(10);
  let section = "";
  let sectionName = "";
  let branchRemote = "";
  let branchMerge = "";

  const flushBranch = () => {
    if (section === "branch" && sectionName.length > 0 && branchRemote.length > 0) {
      const short = branchMerge.startsWith("refs/heads/")
        ? branchMerge.substring("refs/heads/".length)
        : branchMerge;
      if (short.length > 0) out.upstreams.set(sectionName, branchRemote + "/" + short);
    }
    branchRemote = "";
    branchMerge = "";
  };

  for (const raw of readFileSync(path, "utf8").split(LF)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      flushBranch();
      const close = line.indexOf("]");
      const header = close === -1 ? line.substring(1) : line.substring(1, close);
      const quote = header.indexOf('"');
      if (quote === -1) {
        section = header.trim();
        sectionName = "";
      } else {
        section = header.substring(0, quote).trim();
        const endQuote = header.lastIndexOf('"');
        sectionName = endQuote > quote ? header.substring(quote + 1, endQuote) : "";
      }
      if (section === "remote" && sectionName.length > 0 && !out.remotes.includes(sectionName)) {
        out.remotes.push(sectionName);
        out.detail.push({ name: sectionName, url: "", pushUrl: "" });
      }
      continue;
    }

    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.substring(0, eq).trim();
    const value = line.substring(eq + 1).trim();
    if (section === "branch") {
      if (key === "remote") branchRemote = value;
      if (key === "merge") branchMerge = value;
    }
    if (section === "remote" && sectionName.length > 0) {
      for (const r of out.detail) {
        if (r.name !== sectionName) continue;
        if (key === "url") r.url = value;
        if (key === "pushurl") r.pushUrl = value;
      }
    }
  }
  flushBranch();
  return out;
}
