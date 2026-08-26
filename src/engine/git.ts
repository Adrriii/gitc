// The git subprocess layer.
//
// Everything that MUTATES a repository goes through here, on purpose: git's
// own implementations of checkout/rebase/squash are correct and ours would
// not be. Reads that are hot enough to matter bypass this and parse .git
// directly - see refs.ts.

import { spawn } from "node:child_process";

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
  /** Identifies this entry for its whole life. Never changes. */
  id: number;
  /**
   * Bumped whenever the entry changes, and what the UI polls against.
   *
   * An entry is written when its command STARTS and written again when it
   * finishes, so "everything after what I have" cannot be a position in the
   * list - an entry already sent has to be sendable again. The cursor and the
   * identity are therefore two different numbers.
   */
  seq: number;
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
  /** Still running. `ms` is meaningless until this goes false. */
  running: boolean;
}

/** Two thousand commands is hours of work and a couple of hundred kilobytes. */
const HISTORY_LIMIT = 2000;

const history: GitCall[] = [];
let nextCallId = 1;
let nextSeq = 1;

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

/**
 * Records that a command has started. Returns its entry's id.
 *
 * Recording at the start rather than at the end is what makes the ticker feel
 * like part of the action: pressing Fetch used to do nothing visible for two
 * seconds and then produce a burst of commands that had all already run. Now
 * the command appears as it is issued, and gains its duration when it ends.
 */
function begin(repo: string, args: string[]): number {
  // Quoted only where it matters, so the line can be pasted into a terminal.
  const text = readable(args)
    .map((a) => (a.includes(" ") ? '"' + a + '"' : a))
    .join(" ");

  // The same command again, counted rather than repeated - but only into an
  // entry that finished and succeeded. A failure stays a row of its own,
  // since "this ran five times" and "this failed" are different facts and
  // collapsing them would report four successes as failures.
  const last = history.length > 0 ? history[history.length - 1] : undefined;
  if (
    last !== undefined &&
    last.args === text &&
    last.repo === repo &&
    !last.running &&
    last.ok
  ) {
    last.count += 1;
    last.at = Date.now();
    last.ms = 0;
    last.running = true;
    last.seq = nextSeq;
    nextSeq += 1;
    return last.id;
  }

  const id = nextCallId;
  nextCallId += 1;
  history.push({
    id,
    seq: nextSeq,
    at: Date.now(),
    args: text,
    repo,
    ms: 0,
    ok: true,
    count: 1,
    running: true,
  });
  nextSeq += 1;
  // Trimmed from the front, so the newest are always the ones kept.
  while (history.length > HISTORY_LIMIT) history.shift();
  return id;
}

/** Records how a started command ended. */
function finish(id: number, started: number, ok: boolean): void {
  // From the end: the command that just finished is almost always among the
  // last few started.
  for (let i = history.length - 1; i >= 0; i--) {
    const call = history[i];
    if (call.id !== id) continue;

    // A failure that landed on a row counting earlier successes is split off,
    // so the row keeps saying what actually happened to each run.
    if (!ok && call.count > 1) {
      call.count -= 1;
      call.running = false;
      call.seq = nextSeq;
      nextSeq += 1;

      const fresh = nextCallId;
      nextCallId += 1;
      history.push({
        id: fresh,
        seq: nextSeq,
        at: started,
        args: call.args,
        repo: call.repo,
        ms: Date.now() - started,
        ok: false,
        count: 1,
        running: false,
      });
      nextSeq += 1;
      while (history.length > HISTORY_LIMIT) history.shift();
      return;
    }

    call.ms = Date.now() - started;
    call.ok = ok;
    call.running = false;
    call.seq = nextSeq;
    nextSeq += 1;
    return;
  }
  // Not found: trimmed out of the history while it ran. Nothing to update.
}

/**
 * The calls changed since `after`. Pass 0 for everything held.
 *
 * Against the sequence rather than the id, so an entry that started before
 * the caller's last poll and finished after it is sent again with its
 * duration filled in.
 */
export function gitHistory(after: number): GitCall[] {
  const out: GitCall[] = [];
  for (const call of history) {
    if (call.seq > after) out.push(call);
  }
  return out;
}

interface Ran {
  code: number;
  out: string;
  err: string;
}

/**
 * Runs git without stopping everything else.
 *
 * This used to be promisify(execFile), which is awaited and looks
 * asynchronous and is not: measured against a running engine, a `git fetch`
 * that sat for twenty seconds answered no request in that time - not even
 * /api/ping. Everything the window asked for arrived at once when git
 * finished, which is why an action felt like a pause followed by a burst.
 * The same measurement with spawn: a 100ms timer fired 197 times during an
 * identical fetch, so the loop is genuinely free.
 *
 * That matters beyond the command log. The window's heartbeat gives up after
 * ten seconds of silence, so a fetch slow enough - a big repository on a bad
 * connection - had the window concluding the engine was dead while it was
 * merely busy.
 *
 * stdin stays closed rather than piped: piped stdin is a compile fence here,
 * which is also why commit messages go in through -F and rebase through
 * GIT_SEQUENCE_EDITOR.
 */
function run(repo: string, args: string[], env?: Record<string, string>): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: repo,
      stdio: ["ignore", "pipe", "pipe"],
      env: env === undefined ? process.env : { ...process.env, ...env },
    });

    const out: Uint8Array[] = [];
    const err: Uint8Array[] = [];
    let code = 0;
    let exited = false;
    let open = 2;

    // Both streams have to END before the output is complete. `exit` can
    // arrive with bytes still unread, and this compiler has no `close` event
    // to mean "exited AND drained" - so that condition is assembled here.
    const settle = () => {
      if (!exited || open > 0) return;
      resolve({
        code,
        out: Buffer.concat(out).toString("utf8"),
        err: Buffer.concat(err).toString("utf8"),
      });
    };

    const stdout = child.stdout;
    const stderr = child.stderr;
    if (stdout === null || stderr === null) {
      reject(new Error("git produced no output streams"));
      return;
    }

    stdout.on("data", (chunk: Buffer) => out.push(chunk));
    stdout.on("end", () => {
      open -= 1;
      settle();
    });
    stderr.on("data", (chunk: Buffer) => err.push(chunk));
    stderr.on("end", () => {
      open -= 1;
      settle();
    });

    child.on("exit", (status: number | null) => {
      // A signal death reports null; treat it as a failure with no code.
      code = status === null ? 1 : status;
      exited = true;
      settle();
    });
    child.on("error", (e: Error) => reject(e));
  });
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
  const call = begin(repo, args);

  try {
    const result = await run(repo, args, env);
    finish(call, started, result.code === 0);
    if (result.code !== 0) {
      const detail = result.err.trim().length > 0 ? result.err.trim() : "git exited with " + String(result.code);
      throw new GitError(detail, detail);
    }
    return result.out;
  } catch (e) {
    if (e instanceof GitError) throw e;
    // Failing to START git at all - not on PATH, or no permission.
    finish(call, started, false);
    const err = e as Error;
    throw new GitError(err.message, err.message);
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
 * Refs kept out of the graph walk, named as they are within their family:
 * "topic", "origin/topic", "v1.0" - which is exactly how the hidden list
 * already stores them.
 */
export interface RefFilter {
  branches: string[];
  remotes: string[];
  tags: string[];
}

/**
 * Reads the commit list.
 *
 * `--date-order`, not `--topo-order`. Both guarantee the one thing the lane
 * builder needs - a parent never appears above its child - and they differ in
 * what they do with the freedom that leaves.
 *
 * `--topo-order` spends it keeping each branch's commits contiguous, which
 * sounds like readability and is not: it means a branch nobody has touched
 * since March gets its whole run printed in the middle of this week's work,
 * purely because of where it attaches. The graph then says two things that
 * are both false - that those commits happened then, and that the ones either
 * side of them are related to them.
 *
 * `--date-order` spends it on the date, which is the thing the column is
 * labelled with and the thing anybody scanning the list is actually reading.
 * Branches interleave, which is what really happened.
 */
export async function readCommits(
  repo: string,
  limit: number,
  /**
   * Refs to leave out of the walk, by family.
   *
   * Hiding used to work the other way round - the caller listed every ref
   * still visible, and those replaced the families. It gave the same graph
   * and was a bad way to ask for it: hiding one branch in a repository with
   * three hundred of them produced a command line with three hundred refs on
   * it, which is unreadable in the command log and, on Windows, within sight
   * of the 8191-character limit on a command line. Naming what to leave out
   * is shorter, because there is always less of it.
   */
  hide: RefFilter = { branches: [], remotes: [], tags: [] },
): Promise<RawCommit[]> {
  const fmt =
    "%x01%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%b";
  // Deliberately NOT `--all`: that includes refs/stash, and a stash is up to
  // three commits (the stash itself, the index, the untracked files) which
  // then appear in the graph as ordinary history. Naming the ref families we
  // actually want excludes those, and any other machinery living under refs/.
  // HEAD is listed so a detached checkout still shows where it is.
  //
  // --exclude accumulates until the family option it applies to, and is then
  // forgotten - so each family's exclusions have to sit immediately in front
  // of it. The patterns are matched against the name WITHIN that family:
  // "topic" excludes refs/heads/topic from --branches, while the full path
  // would match nothing at all, silently.
  const walk = ["log"];
  for (const name of hide.branches) walk.push("--exclude=" + name);
  walk.push("--branches");
  for (const name of hide.tags) walk.push("--exclude=" + name);
  walk.push("--tags");
  for (const name of hide.remotes) walk.push("--exclude=" + name);
  walk.push("--remotes");
  // HEAD is always walked, listed or not: you must be able to see where you
  // are, and hiding the branch you are standing on should not blank the graph.
  walk.push("HEAD");
  walk.push("--date-order");
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

/** A stash entry: the commit git made for it, and how to name it again. */
export interface RawStash {
  commit: RawCommit;
  /**
   * Reflog selector - "stash@{0}".
   *
   * Positional, and it MOVES: dropping stash@{1} renumbers everything below
   * it, and pushing a new stash renumbers everything. So it is fine to show
   * and fine to pass straight to a command run now, and no use at all as
   * something to remember.
   */
  selector: string;
}

/**
 * The stashes, newest first.
 *
 * A stash is a real commit, which is why it can be drawn in the graph at all -
 * but it is a commit with up to three parents: what you were sitting on, a
 * commit holding the index, and (with -u) one holding the untracked files.
 * Only the first is history. The other two are git's own bookkeeping and have
 * no business in a graph, so they are dropped here rather than filtered out
 * later - that is the whole reason `readCommits` refuses `--all`.
 */
export async function readStashes(repo: string): Promise<RawStash[]> {
  const fmt = "%x01%H%x00%P%x00%an%x00%ae%x00%at%x00%gd%x00%gs";
  // Declared before the early return, not returned as a bare `[]`: scriptc
  // types an empty array literal as number[] and then refuses to widen it
  // (SC2002). See docs/toolchain.md.
  const out: RawStash[] = [];

  // Null rather than an error when there is no stash ref at all.
  const raw = await gitOrNull(repo, ["stash", "list", "--format=" + fmt]);
  if (raw === null) return out;

  for (const record of raw.split(RECORD)) {
    if (record.length === 0) continue;
    const f = record.split(SEP);
    if (f.length < 7) continue;
    const parents = f[1].length > 0 ? f[1].split(" ") : [];
    out.push({
      selector: f[5],
      commit: {
        hash: f[0],
        parents: parents.length > 0 ? [parents[0]] : [],
        author: f[2],
        email: f[3],
        date: parseInt(f[4], 10),
        // The reflog subject, which is what `git stash list` itself prints:
        // "On main: fixing the parser", or "WIP on main: 1a2b3c subject"
        // when the stash was taken without a message.
        subject: f[6].trim(),
        body: "",
        coAuthors: [],
      },
    });
  }
  return out;
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
/**
 * The working tree, as the staging panel lists it.
 *
 * `--ignore-submodules=dirty` is a performance fix that is also the more
 * honest answer. `git status` otherwise walks into every submodule looking
 * for uncommitted work inside it - on a superproject with five of them that
 * was 223ms of the 228ms this call cost, and `-uno` proved it was nothing to
 * do with untracked files.
 *
 * What it drops is a row you cannot act on. A submodule with modified content
 * but an unmoved HEAD lists as `M vendor`, and `git add vendor` then stages
 * nothing at all: from the superproject's point of view nothing has changed,
 * because the commit it records is the same one. What it KEEPS is the row you
 * can act on - a submodule whose recorded commit moved, which is a real
 * change to this repository and is stageable.
 *
 * The dirt inside is not lost, it is reported where it belongs: the deferred
 * submodule read marks such a submodule "dirty" (see submodules.ts).
 */
export async function readStatus(repo: string): Promise<WorkingFile[]> {
  const raw = await git(repo, [
    "status",
    "--porcelain=v1",
    "-z",
    "-uall",
    "--ignore-submodules=dirty",
  ]);
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

/**
 * The commit each annotated tag actually points at.
 *
 * An annotated tag is an object in its own right - it has a message and a
 * tagger - and `refs/tags/v1.0` holds THAT object's hash, not the commit's.
 * Reading the ref file therefore gives a hash which matches no commit in the
 * graph, and the tag silently fails to appear on any row. Since annotated is
 * what `git tag -a`, `git tag -s` and every forge's release button produce,
 * that meant most real release tags were invisible.
 *
 * Peeling needs the object read, which means git: a loose tag object is zlib
 * and there is no inflate here. One call, and only for repositories that have
 * tags at all.
 *
 * Lightweight tags report an empty peeled field and are left alone - their
 * ref already names the commit.
 */
export async function peeledTags(repo: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  // Separated by a space, not by %x00: for-each-ref does not interpret the
  // hex escape that `git log --format` does - it emits the four characters
  // literally, and the parse then finds one field where it wanted two. A
  // space is unambiguous here because git forbids one in a ref name.
  const raw = await gitOrNull(repo, [
    "for-each-ref",
    "--format=%(refname) %(*objectname)",
    "refs/tags",
  ]);
  if (raw === null) return out;

  for (const line of raw.split(String.fromCharCode(10))) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const space = trimmed.indexOf(" ");
    if (space === -1) continue;
    const name = trimmed.substring(0, space);
    const commit = trimmed.substring(space + 1).trim();
    if (name.length > 0 && commit.length > 0) out.set(name, commit);
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
