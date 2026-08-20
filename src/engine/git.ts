// The git subprocess layer.
//
// Everything that MUTATES a repository goes through here, on purpose: git's
// own implementations of checkout/rebase/squash are correct and ours would
// not be. Reads that are hot enough to matter bypass this and parse .git
// directly - see refs.ts.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Field separator for --format output. NUL can't appear in any git field,
// so splitting on it is unambiguous - unlike the usual pipe/tab guesses,
// which commit subjects do contain.
const SEP = "\u0000";
const RECORD = "\u0001";

export interface Person {
  name: string;
  email: string;
}

export interface RawCommit {
  hash: string;
  parents: string[];
  subject: string;
  /** The message body with recognised trailers removed. */
  body: string;
  author: string;
  email: string;
  /** Unix seconds. */
  date: number;
  /**
   * People credited by `Co-authored-by:` trailers.
   *
   * git has no first-class notion of a second author - the convention is a
   * trailer in the message body, which forges read to attribute a commit to
   * more than one person. Showing them as raw text in the body would credit
   * nobody and clutter the message.
   */
  coAuthors: Person[];
}

/**
 * Splits `Name <email>` as it appears in a trailer.
 *
 * Tolerant on purpose: these are typed by hand and by a dozen different
 * tools, so a missing bracket should still credit the person.
 */
function parsePerson(value: string): Person | null {
  const text = value.trim();
  if (text.length === 0) return null;
  const open = text.lastIndexOf("<");
  const close = text.lastIndexOf(">");
  if (open === -1 || close < open) return { name: text, email: "" };
  const name = text.substring(0, open).trim();
  const email = text.substring(open + 1, close).trim();
  return { name: name.length > 0 ? name : email, email };
}

const CO_AUTHOR = "co-authored-by:";

/**
 * Pulls co-author trailers out of a message body.
 *
 * Returns the body with those lines removed, so the message reads as written
 * and the people are credited separately rather than twice.
 */
function extractCoAuthors(body: string): { body: string; coAuthors: Person[] } {
  const LF = String.fromCharCode(10);
  const kept: string[] = [];
  const coAuthors: Person[] = [];
  const seen = new Set<string>();

  for (const line of body.split(LF)) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase().startsWith(CO_AUTHOR)) {
      const person = parsePerson(trimmed.substring(CO_AUTHOR.length));
      if (person !== null) {
        const key = person.email.toLowerCase() + "|" + person.name.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          coAuthors.push(person);
        }
      }
      continue;
    }
    kept.push(line);
  }

  return { body: kept.join(LF).trim(), coAuthors };
}

/**
 * Every git command gitc runs, most recent last.
 *
 * gitc delegates all of its work to git, and this is the record of it. The
 * point is not diagnostics: it is that someone using gitc should end up
 * knowing git better, not more dependent on gitc. The UI shows the latest
 * command as it runs and keeps the rest one click away.
 */
export interface GitCall {
  /** Monotonic, so the UI can ask for "everything after what I have". */
  id: number;
  /** Milliseconds since the epoch. */
  at: number;
  /** The command as it would be typed, without the leading "git". */
  args: string;
  /** Repository it ran in. */
  repo: string;
  ms: number;
  ok: boolean;
  /**
   * How many times this command has just run in a row.
   *
   * The watch poll runs `git status` every second or so; without collapsing
   * repeats the record would be nothing else, and two thousand entries would
   * cover about half an hour of idling rather than a day's work.
   */
  count: number;
}

/** Two thousand commands is hours of work and a couple of hundred kilobytes. */
const HISTORY_LIMIT = 2000;

const history: GitCall[] = [];
let nextCallId = 1;

/**
 * Arguments that exist for gitc's benefit rather than the user's.
 *
 * The record is meant to teach git, and these teach nothing: they are the
 * machine-readable output formats and locking flags gitc needs in order to
 * parse what comes back. `git status` is the command someone would type;
 * `git status --porcelain=v1 -z -uall --no-optional-locks` is the same command
 * wearing gitc's plumbing.
 *
 * Deliberately a list rather than a rule - anything not named here is shown,
 * so a flag that changes what git DOES can never be hidden by accident.
 */
const NOISE_EXACT = [
  "-z",
  "--no-optional-locks",
  "--porcelain",
  "--no-color",
  "--null",
  "-uall",
];

const NOISE_PREFIX = ["--porcelain=", "--format=", "--pretty=format:", "--max-buffer="];

/** Drops the plumbing, keeping everything that changes what git does. */
function readable(args: string[]): string[] {
  const out: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // `-c key=value` is configuration for one invocation - core.editor=true to
    // stop git opening an editor, and the like. Two tokens, both plumbing.
    if (arg === "-c") {
      i += 1;
      continue;
    }

    if (NOISE_EXACT.includes(arg)) continue;

    let noisy = false;
    for (const prefix of NOISE_PREFIX) {
      if (arg.startsWith(prefix)) {
        noisy = true;
        break;
      }
    }
    if (noisy) continue;

    out.push(arg);
  }

  return out;
}

function record(repo: string, args: string[], started: number, ok: boolean): void {
  // Quoted only where it matters, so the line can be pasted into a terminal.
  const text = readable(args)
    .map((a) => (a.includes(" ") ? '"' + a + '"' : a))
    .join(" ");
  const ms = Date.now() - started;

  const last = history.length > 0 ? history[history.length - 1] : undefined;
  if (last !== undefined && last.args === text && last.repo === repo && last.ok === ok) {
    // The same command again: count it rather than repeating it. The id moves
    // so pollers asking for "anything after N" still receive the update.
    last.count += 1;
    last.at = started;
    last.ms = ms;
    last.id = nextCallId;
    nextCallId += 1;
    return;
  }

  history.push({
    id: nextCallId,
    at: started,
    args: text,
    repo,
    ms,
    ok,
    count: 1,
  });
  nextCallId += 1;
  // Trimmed from the front, so the newest are always the ones kept.
  while (history.length > HISTORY_LIMIT) history.shift();
}

/** The calls newer than `after`. Pass 0 for everything held. */
export function gitHistory(after: number): GitCall[] {
  const out: GitCall[] = [];
  for (const call of history) {
    if (call.id > after) out.push(call);
  }
  return out;
}

export class GitError extends Error {
  readonly stderr: string;
  constructor(message: string, stderr: string) {
    super(message);
    this.stderr = stderr;
  }
}

/** Runs git and returns stdout. Rejects with GitError on a non-zero exit. */
export async function git(
  repo: string,
  args: string[],
  /**
   * Extra environment for this call.
   *
   * What interactive rebase needs: GIT_SEQUENCE_EDITOR and GIT_EDITOR have to
   * point at something non-interactive, since a piped stdin is a compile fence
   * here and there is no terminal for git to open an editor in.
   */
  env?: Record<string, string>,
): Promise<string> {
  const started = Date.now();
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repo,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: env === undefined ? process.env : { ...process.env, ...env },
    });
    record(repo, args, started, true);
    return stdout;
  } catch (e) {
    record(repo, args, started, false);
    const err = e as Error;
    // execFile's message is "Command failed: <the whole command line>" with
    // git's stderr appended. The command line is noise to a user - they did
    // not type it - so keep the part git actually said.
    const raw = err.message;
    const marker = String.fromCharCode(10);
    let detail = raw;
    const nl = raw.indexOf(marker);
    if (raw.startsWith("Command failed:") && nl !== -1) {
      detail = raw.substring(nl + 1).trim();
    }
    if (detail.length === 0) detail = raw;
    throw new GitError(detail, detail);
  }
}

/** Same, but resolves to null instead of throwing - for probes. */
export async function gitOrNull(
  repo: string,
  args: string[],
): Promise<string | null> {
  try {
    return await git(repo, args);
  } catch {
    return null;
  }
}

/**
 * Reads the commit list.
 *
 * `--topo-order` matters: it keeps a branch's commits contiguous instead of
 * interleaving them by date, which is what makes the graph readable, and
 * what every graph viewer worth using does.
 */
export async function readCommits(
  repo: string,
  limit: number,
  /**
   * Explicit refs to walk, replacing the default families.
   *
   * Empty means "everything", which is the normal case. A non-empty list is
   * how hiding works: the caller passes only the refs still visible, and the
   * commits reachable solely from a hidden branch never enter the walk - so
   * they neither draw a lane nor consume the commit limit.
   */
  revs: string[] = [],
): Promise<RawCommit[]> {
  const fmt =
    "%x01%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%b";
  // Deliberately NOT `--all`: that includes refs/stash, and a stash is up to
  // three commits (the stash itself, the index, the untracked files) which
  // then appear in the graph as ordinary history. Naming the ref families we
  // actually want excludes those, and any other machinery living under refs/.
  // HEAD is listed so a detached checkout still shows where it is.
  const walk = ["log"];
  if (revs.length === 0) {
    walk.push("--branches");
    walk.push("--tags");
    walk.push("--remotes");
  } else {
    for (const rev of revs) walk.push(rev);
  }
  // HEAD is always walked, listed or not: you must be able to see where you
  // are, and hiding the branch you are standing on should not blank the graph.
  walk.push("HEAD");
  walk.push("--topo-order");
  walk.push("--max-count=" + limit);
  walk.push("--format=" + fmt);

  const raw = await git(repo, walk);

  const commits: RawCommit[] = [];
  for (const record of raw.split(RECORD)) {
    if (record.length === 0) continue;
    const f = record.split(SEP);
    if (f.length < 7) continue;
    const extracted = extractCoAuthors(f[6]);
    commits.push({
      hash: f[0],
      parents: f[1].length > 0 ? f[1].split(" ") : [],
      author: f[2],
      email: f[3],
      date: parseInt(f[4], 10),
      subject: f[5],
      body: extracted.body,
      coAuthors: extracted.coAuthors,
    });
  }
  return commits;
}

export interface FileChange {
  /** A, M, D, R, C */
  status: string;
  path: string;
  /** Set for renames. */
  oldPath: string | null;
}

function parseNameStatus(raw: string): FileChange[] {
  const out: FileChange[] = [];
  const parts = raw.split(SEP);
  let i = 0;
  while (i < parts.length) {
    const status = parts[i].trim();
    if (status.length === 0) {
      i += 1;
      continue;
    }
    // Renames and copies carry two paths.
    if (status.charAt(0) === "R" || status.charAt(0) === "C") {
      if (i + 2 >= parts.length) break;
      out.push({
        status: status.charAt(0),
        path: parts[i + 2],
        oldPath: parts[i + 1],
      });
      i += 3;
    } else {
      if (i + 1 >= parts.length) break;
      out.push({ status: status.charAt(0), path: parts[i + 1], oldPath: null });
      i += 2;
    }
  }
  return out;
}

/** Files touched by a single commit. */
export async function readCommitFiles(
  repo: string,
  hash: string,
): Promise<FileChange[]> {
  const raw = await git(repo, [
    "show",
    "--name-status",
    "--format=",
    "-z",
    "-m",
    "--first-parent",
    hash,
  ]);
  return parseNameStatus(raw);
}

/** The hash of git's empty tree - the stand-in parent for a root commit. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * The combined diff across a contiguous run of commits, oldest to newest.
 *
 * This is what a multi-commit selection shows: not each commit's files listed
 * separately, but the net effect of the whole run - a file touched by three of
 * them appears once.
 */
export async function readRangeFiles(
  repo: string,
  oldestHash: string,
  newestHash: string,
): Promise<FileChange[]> {
  // `oldest^` has no meaning for a root commit, so fall back to diffing
  // against the empty tree - which is exactly what "everything it added" means.
  let base = oldestHash + "^";
  const probe = await gitOrNull(repo, ["rev-parse", "--verify", base]);
  if (probe === null) base = EMPTY_TREE;

  const raw = await git(repo, ["diff", "--name-status", "-z", base, newestHash]);
  return parseNameStatus(raw);
}

export interface WorkingFile {
  path: string;
  /** Two-character porcelain code: index status then worktree status. */
  index: string;
  worktree: string;
  staged: boolean;
  untracked: boolean;
}

/** Working-directory state: the WIP node at the top of the graph. */
export async function readStatus(repo: string): Promise<WorkingFile[]> {
  const raw = await git(repo, ["status", "--porcelain=v1", "-z", "-uall"]);
  const out: WorkingFile[] = [];
  const parts = raw.split(SEP);
  let i = 0;
  while (i < parts.length) {
    const entry = parts[i];
    if (entry.length < 4) {
      i += 1;
      continue;
    }
    const index = entry.charAt(0);
    const worktree = entry.charAt(1);
    const path = entry.substring(3);
    // A rename's source path follows in its own NUL-delimited field.
    if (index === "R" || index === "C") i += 1;
    out.push({
      path,
      index,
      worktree,
      staged: index !== " " && index !== "?",
      untracked: index === "?",
    });
    i += 1;
  }
  return out;
}

/** Ahead/behind counts against the current branch's upstream, if any. */
export async function readAheadBehind(
  repo: string,
): Promise<{ ahead: number; behind: number } | null> {
  const raw = await gitOrNull(repo, [
    "rev-list",
    "--left-right",
    "--count",
    "HEAD...@{upstream}",
  ]);
  if (raw === null) return null;
  const f = raw.trim().split("\t");
  if (f.length < 2) return null;
  return { ahead: parseInt(f[0], 10), behind: parseInt(f[1], 10) };
}

/** Verifies a directory is inside a work tree before we adopt it as a tab. */
export async function isRepo(path: string): Promise<boolean> {
  const raw = await gitOrNull(path, ["rev-parse", "--is-inside-work-tree"]);
  return raw !== null && raw.trim() === "true";
}

/** The work tree root, so two tabs on the same repo dedupe correctly. */
export async function repoRoot(path: string): Promise<string | null> {
  const raw = await gitOrNull(path, ["rev-parse", "--show-toplevel"]);
  return raw === null ? null : raw.trim();
}
