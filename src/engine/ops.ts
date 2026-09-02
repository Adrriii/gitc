// Repository operations reachable from the toolbar and context menus.
//
// One dispatcher rather than an endpoint per verb: these are all the same
// shape - take a few strings, run git, let the UI refresh - and a dozen
// near-identical handlers in main.ts would bury that.
//
// Everything here goes through git. None of it touches .git directly.

import { spawn } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { extractCoAuthors, git, gitOrNull } from "./git.ts";
import type { Person } from "./git.ts";
import { needInRepo, safeArgument, safeRemoteUrl, tempFile } from "./paths.ts";
import { readPending, readRemotes } from "./refs.ts";
import { at, atOr } from "./safe.ts";

export interface OpRequest {
  op: string;
  /** A branch, tag, or remote-tracking ref. */
  ref: string;
  /** A commit hash, or several for cherry-pick and revert. */
  shas: string[];
  /** New branch/tag name. */
  name: string;
  /** soft | mixed | hard, for reset. */
  mode: string;
  /** Tag or stash message. */
  message: string;
  /** Delete a remote branch as well / force a delete. */
  remote: string;
  force: boolean;
  /** Check out a branch immediately after creating it. */
  checkout: boolean;
  /** Repository-relative file path, for the operations that act on one. */
  path: string;
  /** A unified diff, for the operations that apply one. */
  patch: string;
}

/**
 * Why the remote refused a push, and what would actually fix it.
 *
 * git says "non-fast-forward" and suggests pulling, which is right half the
 * time and destroys nothing either way - but after a rebase, pulling merges
 * the old versions of your own commits back in, and the answer is to force.
 * The two cases are indistinguishable from the error text, so they are told
 * apart here rather than left to the person to guess at.
 *
 *   "none"     nothing was refused
 *   "behind"   we have nothing of our own to publish and have simply fallen
 *              behind. A fast-forward pull settles it.
 *   "rewrite"  the remote only holds older versions of commits we already
 *              have - a rebase, an amend, a squash. Forcing loses nothing.
 *   "diverged" the remote holds work that is not ours. Forcing would destroy
 *              it; pulling is the answer.
 */
export interface PushRefusal {
  kind: string;
  /** The tracking branch that refused, e.g. "origin/main". */
  upstream: string;
  ahead: number;
  behind: number;
  /** Remote commits that are NOT rewritten versions of our own. */
  theirs: number;
  /** A few of those, "author — subject", so the dialog can name them. */
  theirCommits: string[];
}

const NO_REFUSAL: PushRefusal = {
  kind: "none",
  upstream: "",
  ahead: 0,
  behind: 0,
  theirs: 0,
  theirCommits: [],
};

export interface OpResult {
  ok: boolean;
  /** Something worth telling the user that isn't an error. */
  note: string;
  /** Set when the operation stopped part-way and needs resolving. */
  pending: string;
  /** Set when a push was refused; `kind` is "none" otherwise. */
  refusal: PushRefusal;
  /**
   * The operation ran, but not the way it was probably meant to.
   *
   * Green for "done" and red for "broke" left nothing for the case that
   * matters most here: double-clicking a remote branch whose local
   * counterpart has diverged checks it out and then, correctly, refuses to
   * throw away the local commits. Reporting that in green as a success would
   * be telling somebody their branch is up to date when it is not.
   */
  warn: boolean;
  /**
   * Empty, or a question to put to the user - and answering yes re-runs the
   * same operation with force set.
   *
   * For the refusals git makes that are an objection rather than a failure.
   * Deleting an unmerged branch is the first: git declines and tells you to
   * go and type `git branch -D` yourself, which means leaving the
   * application to do the thing the application was asked to do. Warning
   * about it in advance is no better - the warning fires on every delete,
   * including the great majority that git would allow without complaint.
   */
  confirm: string;
}

const ok = (note: string): OpResult => ({
  ok: true,
  note,
  pending: "",
  refusal: NO_REFUSAL,
  warn: false,
  confirm: "",
});

/** Succeeded, with a caveat the user needs to see. */
const warned = (note: string): OpResult => ({
  ok: true,
  note,
  pending: "",
  refusal: NO_REFUSAL,
  warn: true,
  confirm: "",
});

/**
 * Quotes a path for the editor commands git will run through a shell.
 *
 * git hands GIT_SEQUENCE_EDITOR to the shell, so a path with a space in it -
 * "C:\Users\...\Local\Programs\gitc" being the normal install location -
 * has to survive that.
 */
function quoted(value: string): string {
  return '"' + value + '"';
}

/**
 * Hands a file to whatever the user edits with.
 *
 * GITC_EDITOR wins if it is set. Otherwise the platform's own opener decides,
 * which is the right default: it uses the association the user already chose
 * for that file type, and it cannot land them in a terminal editor with no
 * terminal to type into - which is exactly what honouring core.editor would
 * risk, since vim is a perfectly common value there.
 */
function openInEditor(file: string): void {
  const editor = process.env["GITC_EDITOR"];
  if (editor !== undefined && editor.length > 0) {
    spawn(editor, [file], { stdio: "ignore" });
    return;
  }

  if (process.platform === "win32") {
    // The empty argument is start's window-title parameter: without it a
    // quoted path is taken AS the title and nothing opens.
    spawn("cmd", ["/c", "start", "", file], { stdio: "ignore" });
    return;
  }
  if (process.platform === "darwin") {
    spawn("open", [file], { stdio: "ignore" });
    return;
  }
  spawn("xdg-open", [file], { stdio: "ignore" });
}

/**
 * Runs an operation that can legitimately stop half-way.
 *
 * A conflicted merge or cherry-pick is not a failure to report as an error -
 * it is an expected outcome with a next step. What git says about it is also
 * the wrong thing to repeat: the detail goes to stdout while the exit code
 * says only that something went wrong. So rather than parroting git, check
 * whether it left an operation in progress and say that instead.
 */
async function conflictProne(
  repo: string,
  args: string[],
  label: string,
  done: string,
  env?: Record<string, string>,
): Promise<OpResult> {
  try {
    await git(repo, args, env);
    return ok(done);
  } catch (e) {
    const pending = readPending(repo);
    if (pending.kind.length > 0) {
      return {
        ok: false,
        note: label + " stopped with conflicts. Resolve them, then continue - or abort.",
        pending: pending.kind,
        refusal: NO_REFUSAL,
        warn: false,
        confirm: "",
      };
    }
    throw e;
  }
}

/**
 * Whether the index holds unmerged entries.
 *
 * The only evidence a conflicted stash restore leaves. Unlike a merge or a
 * rebase there is no operation in progress and no marker file in .git, so
 * "did that conflict?" has to be asked of the index itself.
 */
async function hasUnmerged(repo: string): Promise<boolean> {
  const out = await gitOrNull(repo, ["--no-optional-locks", "ls-files", "--unmerged"]);
  return out !== null && out.trim().length > 0;
}

/**
 * Refuses a history rewrite that git's interactive rebase would get wrong.
 *
 * Two things have to hold for `rebase -i <oldest>^` to mean what the user
 * pointed at:
 *
 * - the run must be behind HEAD. Rewriting rewrites the CURRENT branch, so a
 *   commit that is not an ancestor of HEAD would not be touched at all - the
 *   rebase would replay unrelated history and appear to do nothing.
 * - nothing merged in between. A plain interactive rebase flattens merges: the
 *   second parent's commits are dropped from the todo entirely, so a reword of
 *   one commit would quietly delete the other side of every merge above it.
 *   `--rebase-merges` exists for that and produces a todo of label/reset lines
 *   that rewriteTodo does not speak, so the honest answer is to decline.
 */
/**
 * Refuses a run that has a merge commit in it.
 *
 * Asked of the commits themselves rather than derived from a range. The range
 * check in checkRewritable covers `oldest..HEAD`, which does contain every
 * merge in a contiguous selection - but "is any of THESE a merge" is the
 * question, and the answer to the question you are actually asking is worth
 * more than a correct inference from a different one. A merge in a squash or a
 * drop is the case that silently loses a whole branch.
 */
async function noMergesAmong(repo: string, shas: string[], what: string): Promise<void> {
  const found = await gitOrNull(repo, ["rev-list", "--no-walk", "--merges"].concat(shas));
  if (found === null || found.trim().length === 0) return;
  const n = found.trim().split(String.fromCharCode(10)).length;
  throw new Error(
    (n === 1 ? "one of those commits is a merge" : String(n) + " of those commits are merges") +
      ", and an interactive rebase leaves merges out of its todo entirely - so " +
      what +
      " would flatten what they merged",
  );
}

async function checkRewritable(repo: string, oldest: string, what: string): Promise<void> {
  const ancestor = await gitOrNull(repo, ["merge-base", "--is-ancestor", oldest, "HEAD"]);
  if (ancestor === null) {
    throw new Error(
      "that commit is not on the current branch, so " +
        what +
        " it would rewrite history you are not on - check the branch out first",
    );
  }

  // The run's own far end counts too: git leaves a merge out of the todo list
  // altogether, so the command would land on nothing while everything above it
  // was still replayed - the worst of both answers.
  const isMerge = await gitOrNull(repo, ["rev-list", "--no-walk", "--merges", oldest]);
  if (isMerge !== null && isMerge.trim().length > 0) {
    throw new Error(
      "that is a merge commit, and an interactive rebase leaves merges out of its " +
        "todo entirely - so " +
        what +
        " one would flatten the merge instead",
    );
  }

  const mergeOut = await gitOrNull(repo, ["rev-list", "--count", "--merges", oldest + "..HEAD"]);
  const merges = mergeOut === null ? 0 : parseInt(mergeOut.trim(), 10);
  if (!isNaN(merges) && merges > 0) {
    throw new Error(
      merges === 1
        ? "there is a merge commit between that commit and HEAD; " +
          "rewriting across it would flatten the merged branch away"
        : "there are " +
          String(merges) +
          " merge commits between that commit and HEAD; " +
          "rewriting across them would flatten the merged branches away",
    );
  }
}

// Field and record separators for the --format output read below.
//
// Split on the real characters, but ASKED for as %x00 and %x01 - git expands
// those itself. A literal NUL cannot travel in an argument: argv is
// NUL-terminated, so "--format=%an" plus a NUL plus "%ae" reaches git as
// "--format=%an" and everything after it is silently gone. That shipped once
// as a squash message made of nothing but concatenated author names.
const SEP = String.fromCharCode(0);
const RECORD = String.fromCharCode(1);

const CO_AUTHOR_LABEL = "Co-authored-by: ";

/** One person, however each trailer or author field happened to spell them. */
function personKey(person: Person): string {
  const email = person.email.trim().toLowerCase();
  return email.length > 0 ? email : person.name.trim().toLowerCase();
}

/** How a trailer writes one person. */
function personText(person: Person): string {
  const name = person.name.trim();
  const email = person.email.trim();
  if (email.length === 0) return name;
  if (name.length === 0) return "<" + email + ">";
  return name + " <" + email + ">";
}

/**
 * Everyone a squashed commit still has to credit.
 *
 * A squash keeps the OLDEST commit's author, which is right - the run starts
 * where that person started it - but it is only half the record. The other
 * commits had authors of their own, and any of them may have carried
 * `Co-authored-by:` trailers, and a squash that writes one new message drops
 * all of it: work by three people ends up looking like work by one.
 *
 * So everybody in the run is collected here - authors and trailers alike -
 * minus whoever ends up as the author, since crediting them as a co-author of
 * their own commit says nothing and forges show it twice.
 */
async function creditsFor(repo: string, shas: string[], author: Person): Promise<Person[]> {
  const seen = new Set<string>();
  seen.add(personKey(author));
  // Declared before the early return: a bare `[]` has no element type to infer
  // from here, and scriptc reads it as number[] (docs/toolchain.md).
  const credits: Person[] = [];

  // --no-walk so the listed commits are the ONLY ones read: without it git
  // walks their ancestors too, and a squash of two commits would collect the
  // whole history's authors. `=unsorted` with the run oldest-first so the
  // trailers come out in the order the work happened rather than in whatever
  // order the commit dates put them.
  const out = await gitOrNull(
    repo,
    ["log", "--no-walk=unsorted", "--format=%an%x00%ae%x00%B%x01"].concat(shas.slice().reverse()),
  );
  if (out === null) return credits;

  const remember = (person: Person) => {
    if (person.name.trim().length === 0 && person.email.trim().length === 0) return;
    const key = personKey(person);
    if (key.length === 0 || seen.has(key)) return;
    seen.add(key);
    credits.push(person);
  };

  for (const record of out.split(RECORD)) {
    if (record.trim().length === 0) continue;
    const fields = record.split(SEP);
    const name = atOr(fields, 0, "").replace(/[\r\n]/g, "").trim();
    const email = atOr(fields, 1, "").trim();
    // The whole message, subject included: a subject line cannot be a
    // trailer, so there is nothing to strip off first.
    const body = atOr(fields, 2, "");
    remember({ name, email });
    for (const person of extractCoAuthors(body).coAuthors) remember(person);
  }

  return credits;
}

/**
 * The message a squashed run gets, written from the run itself.
 *
 * The oldest commit keeps its subject, because it is the commit the squash
 * keeps - its place in history, its author, and so its title. Everything
 * folded into it goes into the body, subject and description together and
 * oldest first, so a run of small commits collapses into one that still says
 * what each of them did.
 *
 * Composed here rather than asked for in a dialog: a squash of six commits is
 * six messages, and nobody wants to retype them into a text box before the
 * operation they asked for will run. It is a commit like any other afterwards,
 * and amending it is a double-click away.
 */
async function squashMessage(repo: string, shas: string[]): Promise<string> {
  const LF = String.fromCharCode(10);

  // Oldest first, which is the order they were written in and the order the
  // squashed message should read in. `shas` arrives newest-first.
  //
  // `=unsorted` is what makes that hold. A plain --no-walk sorts by commit
  // date whatever order the arguments came in, so the message would come back
  // newest-first - and after any rebase, date order and graph order are not
  // the same thing anyway.
  const ordered = shas.slice().reverse();
  const out = await gitOrNull(
    repo,
    ["log", "--no-walk=unsorted", "--format=%s%x00%b%x01"].concat(ordered),
  );
  if (out === null) return "";

  const subjects: string[] = [];
  const bodies: string[] = [];
  for (const record of out.split(RECORD)) {
    if (record.trim().length === 0) continue;
    const fields = record.split(SEP);
    subjects.push(atOr(fields, 0, "").replace(/[\r\n]/g, "").trim());
    // Trailers come off here and are put back by withCredits(), so that a
    // Co-authored-by: from the middle of the run does not end up buried in
    // the body where no forge would read it.
    bodies.push(extractCoAuthors(atOr(fields, 1, "")).body.trim());
  }

  const paragraphs: string[] = [];
  const firstBody = atOr(bodies, 0, "");
  if (firstBody.length > 0) paragraphs.push(firstBody);
  for (let i = 1; i < subjects.length; i++) {
    const subject = atOr(subjects, i, "");
    const body = atOr(bodies, i, "");
    if (subject.length === 0 && body.length === 0) continue;
    paragraphs.push(body.length > 0 ? subject + LF + LF + body : subject);
  }

  const head = atOr(subjects, 0, "");
  return paragraphs.length === 0 ? head : head + LF + LF + paragraphs.join(LF + LF);
}

/**
 * Puts a set of co-author trailers onto a message, keeping what it already has.
 *
 * The blank line before the block is what makes them trailers rather than the
 * last paragraph of the body, and anyone the message already credits is left
 * exactly where they are - a person named twice is a person a forge shows
 * twice.
 */
function withCredits(message: string, credits: Person[]): string {
  const LF = String.fromCharCode(10);
  const already = new Set<string>();
  for (const person of extractCoAuthors(message).coAuthors) already.add(personKey(person));

  const lines: string[] = [];
  for (const person of credits) {
    if (already.has(personKey(person))) continue;
    already.add(personKey(person));
    lines.push(CO_AUTHOR_LABEL + personText(person));
  }
  if (lines.length === 0) return message;

  return message.trim() + LF + LF + lines.join(LF);
}

/**
 * Runs the interactive rebase gitc drives itself: one todo command, one run.
 *
 * `hashes` are the commits to apply `command` to and `oldest` is the far end
 * of the run - its parent becomes the rebase base, so nothing below it is
 * replayed. `message` is the commit message the rebase will ask for, for the
 * commands that ask (squash and reword); the rest pass null.
 *
 * See engine/rebaseHelper.ts for why the editors point back at this binary.
 */
async function rebaseWith(
  repo: string,
  command: string,
  hashes: string[],
  oldest: string,
  message: string | null,
  label: string,
  done: string,
): Promise<OpResult> {
  const stamp = String(Date.now());
  // In this process's own temp directory - see tempDir(). A guessable name in
  // the shared temp directory can be pre-created as a symlink by another
  // account on the machine, and this writes through it.
  const specPath = tempFile(command + "-" + stamp + ".txt");
  const msgPath = message === null ? "" : tempFile(command + "-msg-" + stamp + ".txt");

  const LF = String.fromCharCode(10);
  writeFileSync(specPath, [command].concat(hashes).join(LF), "utf8");
  if (message !== null) writeFileSync(msgPath, message, "utf8");

  // A root commit has no parent to rebase onto, so the whole history is
  // replayed instead.
  const parent = await gitOrNull(repo, ["rev-parse", "--verify", oldest + "^"]);
  const base = parent === null ? "--root" : oldest + "^";

  const self = process.execPath;
  const env: Record<string, string> = {
    GIT_SEQUENCE_EDITOR: quoted(self) + " --rebase-todo " + quoted(specPath),
  };
  // Left unset for a drop: nothing should be asking for a message, and if
  // something does, git's own refusal to open an editor is a better outcome
  // than silently writing a message we never prepared.
  if (message !== null) {
    env["GIT_EDITOR"] = quoted(self) + " --rebase-message " + quoted(msgPath);
  }

  try {
    return await conflictProne(repo, ["rebase", "-i", base], label, done, env);
  } finally {
    for (const file of [specPath, msgPath]) {
      try {
        if (file.length > 0 && existsSync(file)) unlinkSync(file);
      } catch {
        // A leftover temp file is not worth failing the operation over.
      }
    }
  }
}

/** Counts commits in a range, 0 if the range cannot be resolved. */
async function countCommits(repo: string, range: string): Promise<number> {
  const out = await gitOrNull(repo, ["rev-list", "--count", range]);
  if (out === null) return 0;
  const n = parseInt(out.trim(), 10);
  return isNaN(n) ? 0 : n;
}

/** True when git refused a push for being behind, rather than for a real error. */
function isRefusal(message: string): boolean {
  return (
    message.includes("non-fast-forward") ||
    message.includes("fetch first") ||
    message.includes("Updates were rejected")
  );
}

/**
 * Works out whether a refused push wants a force or a pull.
 *
 * The distinction is whether the commits we are missing are our own, in an
 * older form. `--cherry-pick` compares patches rather than hashes, so a
 * commit that was rebased, amended or reworded matches the version of itself
 * that is still on the remote and drops out of the count. What remains is
 * work that only exists there - somebody else's, or our own from another
 * machine - and forcing would destroy it.
 *
 * A fetch first, because the tracking ref is only as current as the last one
 * and the whole question is what the remote holds now.
 *
 * When anything here cannot be determined the answer is "diverged", which
 * recommends pulling. Being wrong in that direction costs a merge commit;
 * being wrong the other way costs somebody their work.
 */
async function classifyRefusal(repo: string, upstream: string): Promise<PushRefusal> {
  const slash = upstream.indexOf("/");
  const remote = slash === -1 ? upstream : upstream.substring(0, slash);
  if (remote.length > 0) await gitOrNull(repo, ["fetch", remote]);

  const ahead = await countCommits(repo, upstream + "..HEAD");
  const behind = await countCommits(repo, "HEAD.." + upstream);

  // Their side of the divergence, with our own rewritten commits removed.
  const theirsOut = await gitOrNull(repo, [
    "rev-list",
    "--count",
    "--left-only",
    "--cherry-pick",
    upstream + "..." + "HEAD",
  ]);
  const theirs = theirsOut === null ? -1 : parseInt(theirsOut.trim(), 10);

  const listed = await gitOrNull(repo, [
    "log",
    "--left-only",
    "--cherry-pick",
    "--max-count=5",
    "--format=%an — %s",
    upstream + "..." + "HEAD",
  ]);
  const theirCommits: string[] = [];
  if (listed !== null) {
    for (const line of listed.split(String.fromCharCode(10))) {
      if (line.trim().length > 0) theirCommits.push(line.trim());
    }
  }

  const unknown = theirs < 0 || isNaN(theirs);

  // Nothing of our own to publish: the push was refused only because the
  // branch has fallen behind. A plain fast-forward pull settles it, with no
  // divergence to reconcile and nothing a force could usefully do - forcing
  // here would delete the remote's commits and put nothing in their place.
  const kind = ahead === 0 && behind > 0 ? "behind" : unknown || theirs > 0 ? "diverged" : "rewrite";

  return {
    kind,
    upstream,
    ahead,
    behind,
    theirs: unknown ? behind : theirs,
    theirCommits,
  };
}

/**
 * Guards a ref argument.
 *
 * An empty string is not "no argument" to git - it is an argument that
 * happens to be empty, and it fails with something unhelpful like "empty
 * string is not a valid pathspec". Better to say what is actually missing.
 */
function needRef(ref: string, what: string): string {
  if (ref.trim().length === 0) throw new Error("no " + what + " given");
  // Every git call here builds its own argv, so there is no shell - but a ref
  // spelled as an option is read as one. "--upload-pack=<command>" reaching
  // `git fetch` is a command git runs, and this value arrives over the API.
  return safeArgument(ref, what);
}

/**
 * Whether a detached HEAD would lose commits by moving.
 *
 * Checking out away from a detached HEAD that has commits on it orphans them.
 * git prints a warning and carries on; we'd rather say so plainly.
 */
async function detachedWarning(repo: string): Promise<string> {
  const head = await gitOrNull(repo, ["symbolic-ref", "-q", "HEAD"]);
  if (head !== null) return "";
  const desc = await gitOrNull(repo, ["rev-parse", "--short", "HEAD"]);
  if (desc === null) return "";
  return "left detached HEAD at " + desc.trim();
}

/**
 * Checks out a ref, bringing uncommitted work along.
 *
 * git carries local changes across a checkout when they do not clash, and
 * refuses outright when they do - which leaves you having to stash by hand
 * before you can move. So on that specific refusal we do the obvious thing:
 * stash, switch, and put the changes back.
 *
 * The interesting case is the third step failing. A conflicted `stash pop`
 * leaves unmerged entries in the index and NO marker file anywhere in .git -
 * unlike a merge or a rebase, there is no operation in progress to detect. It
 * also deliberately keeps the stash entry, so nothing is lost. Both facts are
 * reported back so the UI can put the user into conflict resolution instead
 * of stranding them.
 */
async function checkoutCarryingChanges(
  repo: string,
  args: string[],
  ref: string,
  note: string,
): Promise<OpResult> {
  try {
    await git(repo, args);
    return ok(note);
  } catch (e) {
    const message = (e as Error).message;
    const blocked =
      message.includes("would be overwritten") ||
      message.includes("Please commit your changes") ||
      message.includes("Please, commit your changes");
    if (!blocked) throw e;
  }

  // Untracked files are included: they can block a checkout too, and leaving
  // them behind would make "carry my work across" only half true.
  const stashed = await git(repo, [
    "stash",
    "push",
    "--include-untracked",
    "-m",
    "gitc: switching to " + ref,
  ]);
  if (stashed.indexOf("No local changes") !== -1) {
    // Nothing to stash after all, so the refusal was about something else.
    await git(repo, args);
    return ok(note);
  }

  try {
    await git(repo, args);
  } catch (e) {
    // Could not switch even with a clean tree - put the work back before
    // reporting, so the failure costs nothing.
    await gitOrNull(repo, ["stash", "pop"]);
    throw e;
  }

  try {
    await git(repo, ["stash", "pop"]);
  } catch {
    const pending = readPending(repo);
    return {
      ok: false,
      note:
        "Switched to " +
        ref +
        ", but restoring your changes hit conflicts. Resolve them below — your work is also still saved in the stash until you drop it.",
      // No marker file exists for this, so name the state ourselves.
      pending: pending.kind.length > 0 ? pending.kind : "unmerged",
      refusal: NO_REFUSAL,
      warn: false,
      confirm: "",
    };
  }

  return ok("switched to " + ref + " and brought your changes across");
}

/** Whether a fully-qualified ref exists. */
async function refExists(repo: string, full: string): Promise<boolean> {
  return (await gitOrNull(repo, ["rev-parse", "--verify", "--quiet", full])) !== null;
}

/**
 * Links a local branch to the remote branch of the same name.
 *
 * A local `main` and an `origin/main` are the same branch as far as anyone
 * working is concerned, and every part of gitc that says "2 ahead, 1 behind",
 * or pushes without asking where to, needs the tracking config to say so.
 * Setting it by hand is `git branch --set-upstream-to=origin/main main`,
 * which is a thing nobody should have to remember.
 *
 * So checking a branch out adopts the obvious upstream when it has none.
 * Narrowly:
 *
 *  - an upstream that is already set is never touched. It may deliberately
 *    point somewhere else, and guessing over an explicit choice is worse than
 *    not guessing at all.
 *  - `prefer` wins when given - the remote whose branch was double-clicked.
 *  - otherwise exactly one remote must carry the name. With two, "the obvious
 *    upstream" is not obvious, and picking one silently would send a push to
 *    a place that was never chosen.
 *
 * Returns the upstream it set, or "" for "left alone".
 */
async function adoptUpstream(repo: string, name: string, prefer: string): Promise<string> {
  const existing = await gitOrNull(repo, [
    "for-each-ref",
    "--format=%(upstream:short)",
    "refs/heads/" + name,
  ]);
  if (existing !== null && existing.trim().length > 0) return "";

  let upstream = "";
  if (prefer.length > 0 && (await refExists(repo, "refs/remotes/" + prefer))) {
    upstream = prefer;
  } else {
    for (const remote of readRemotes(repo).remotes) {
      const candidate = remote + "/" + name;
      if (!(await refExists(repo, "refs/remotes/" + candidate))) continue;
      // A second one makes the answer ambiguous, so there is no answer.
      if (upstream.length > 0) return "";
      upstream = candidate;
    }
  }
  if (upstream.length === 0) return "";

  const done = await gitOrNull(repo, ["branch", "--set-upstream-to=" + upstream, name]);
  return done === null ? "" : upstream;
}

/**
 * Checking out what was double-clicked, which for a remote branch is not the
 * ref that was double-clicked.
 *
 * `git checkout origin/main` does exactly what it is told: it moves HEAD to a
 * remote-tracking ref, which detaches it. Nothing is broken at that moment,
 * and that is the trouble - the next operation is the one that fails, with
 * "not on a branch", well after the double-click that caused it.
 *
 * Nobody double-clicks `origin/main` wanting a detached HEAD. They want the
 * local branch of that name, holding what the remote holds. So:
 *
 *   no local branch     create one tracking the remote, and check it out
 *   local branch behind check it out and fast-forward it onto the remote
 *   local branch level  check it out; there is nothing to bring across
 *   local branch ahead  check it out; the remote has nothing we lack
 *   diverged            check it out and say so - a local commit that is not
 *                       on the remote would have to be destroyed to "update
 *                       to the remote version", and a double-click is not
 *                       consent to that. Rebase or reset says it properly.
 *
 * Only remote-tracking refs take this path. A local branch, a tag or a sha is
 * passed to git untouched, including the case where a local branch is itself
 * named `origin/something` - that ref is checked first for exactly that
 * reason.
 */
async function checkoutRef(repo: string, ref: string, note: string): Promise<OpResult> {
  const plain = () => checkoutCarryingChanges(repo, ["checkout", ref], ref, note);
  // `note` carries the "left a detached HEAD behind" warning when there is
  // one, and it outranks anything said below - so it is kept in front rather
  // than replaced by the outcome message. `tracking` is filled in late, by
  // whichever path adopted an upstream, and reported wherever it lands.
  let tracking = "";
  const say = (text: string): string => {
    const head = (note.length > 0 ? note + "; " : "") + text;
    if (tracking.length === 0) return head;
    // Some of these outcomes are fragments ("on main, already level with
    // origin/main") and one is two full sentences. A dash after a full stop
    // reads badly, so the clause matches whichever it is joining.
    return head.endsWith(".")
      ? head + " Now tracking " + tracking + "."
      : head + " - now tracking " + tracking;
  };

  if (await refExists(repo, "refs/heads/" + ref)) {
    const switchedLocal = await plain();
    if (!switchedLocal.ok) return switchedLocal;
    tracking = await adoptUpstream(repo, ref, "");
    return tracking.length === 0 ? switchedLocal : ok(say("on " + ref));
  }

  const slash = ref.indexOf("/");
  if (slash <= 0) return plain();
  if (!(await refExists(repo, "refs/remotes/" + ref))) return plain();

  const name = ref.substring(slash + 1);
  // `origin/HEAD` is a symbolic ref naming the remote's default branch, not a
  // branch called HEAD. Checking out a local "HEAD" is not a thing to do.
  if (name.length === 0 || name === "HEAD") return plain();

  if (!(await refExists(repo, "refs/heads/" + name))) {
    return checkoutCarryingChanges(
      repo,
      ["checkout", "-b", name, "--track", ref],
      name,
      say("created " + name + " from " + ref + " and checked it out"),
    );
  }

  const switched = await checkoutCarryingChanges(repo, ["checkout", name], name, note);
  // A conflicted stash pop on the way in wants resolving before anything is
  // merged on top of it.
  if (!switched.ok) return switched;

  // The remote that was double-clicked is the one meant, even where several
  // carry the name.
  tracking = await adoptUpstream(repo, name, ref);

  const behind = await countCommits(repo, name + ".." + ref);
  const ahead = await countCommits(repo, ref + ".." + name);
  const commits = (n: number): string => String(n) + (n === 1 ? " commit" : " commits");

  if (behind === 0) {
    if (ahead === 0) return ok(say("on " + name + ", already level with " + ref));
    return ok(
      say("on " + name + " - " + commits(ahead) + " ahead of " + ref + ", nothing to bring across"),
    );
  }

  if (ahead > 0) {
    return warned(
      say(
        "On " +
          name +
          ", but it has diverged from " +
          ref +
          " (" +
          String(ahead) +
          " ahead, " +
          String(behind) +
          " behind). Taking the remote's version would drop " +
          commits(ahead) +
          " of your own - rebase onto " +
          ref +
          ", or reset to it if you meant to discard them.",
      ),
    );
  }

  await git(repo, ["merge", "--ff-only", ref]);
  return ok(say("updated " + name + " to " + ref + " - " + commits(behind)));
}

export async function runOp(repo: string, req: OpRequest): Promise<OpResult> {
  switch (req.op) {
    // --- moving around ----------------------------------------------------

    case "checkout": {
      const ref = needRef(req.ref, "branch");
      const note = await detachedWarning(repo);
      return checkoutRef(repo, ref, note);
    }

    case "checkoutCommit": {
      const sha = at(req.shas, 0);
      if (sha === undefined) throw new Error("no commit given");
      safeArgument(sha, "commit");
      // Checking out a commit detaches HEAD. That is the intended behaviour
      // here - the UI says so before calling.
      await git(repo, ["checkout", "--detach", sha]);
      return ok("HEAD is now detached at " + sha.substring(0, 7));
    }

    // --- branches ---------------------------------------------------------

    case "createBranch": {
      if (req.name.trim().length === 0) throw new Error("branch needs a name");
      safeArgument(req.name, "branch name");
      // No start point means "from HEAD", which is the argument being absent
      // rather than being an empty string.
      const start = at(req.shas, 0) ?? req.ref;
      if (start.trim().length > 0) safeArgument(start, "start point");
      const args = req.checkout ? ["checkout", "-b", req.name] : ["branch", req.name];
      if (start.trim().length > 0) args.push(start);
      await git(repo, args);
      return ok(req.checkout ? "created and checked out " + req.name : "created " + req.name);
    }

    case "renameBranch": {
      if (req.name.trim().length === 0) throw new Error("branch needs a name");
      safeArgument(req.name, "branch name");
      needRef(req.ref, "branch");
      await git(repo, ["branch", "-m", req.ref, req.name]);
      return ok("renamed to " + req.name);
    }

    case "deleteBranch": {
      needRef(req.ref, "branch");
      // -D straight away only when the question below has already been
      // answered; otherwise -d, so git gets to raise the objection.
      if (req.force) {
        await git(repo, ["branch", "-D", req.ref]);
        return ok("deleted " + req.ref);
      }
      try {
        await git(repo, ["branch", "-d", req.ref]);
        return ok("deleted " + req.ref);
      } catch (e) {
        const message = (e as Error).message;
        // git's own words are "not fully merged", followed by a suggestion to
        // go and type `git branch -D` - which is the thing nobody should have
        // to leave the application to do. Turned into a question here; saying
        // yes re-runs this with force.
        if (!message.includes("not fully merged")) throw e;
        const ahead = await countCommits(repo, "HEAD.." + req.ref);
        return {
          ok: false,
          note:
            ahead === 1
              ? req.ref + " has 1 commit that is on no other branch. Deleting it loses that commit."
              : req.ref +
                " has " +
                String(ahead) +
                " commits that are on no other branch. Deleting it loses them.",
          pending: "",
          refusal: NO_REFUSAL,
          warn: false,
          confirm: "Delete " + req.ref + " anyway?",
        };
      }
    }

    case "deleteRemoteBranch": {
      needRef(req.ref, "branch");
      if (req.remote.trim().length === 0) throw new Error("no remote given");
      safeArgument(req.remote, "remote");
      await git(repo, ["push", req.remote, "--delete", req.ref]);
      return ok("deleted " + req.remote + "/" + req.ref);
    }

    case "merge": {
      needRef(req.ref, "branch");
      return conflictProne(
        repo,
        ["merge", "--no-edit", req.ref],
        "Merging " + req.ref,
        "merged " + req.ref,
      );
    }

    case "fastForward": {
      needRef(req.ref, "branch");
      await git(repo, ["merge", "--ff-only", req.ref]);
      return ok("fast-forwarded to " + req.ref);
    }

    case "rebaseOnto": {
      needRef(req.ref, "target");
      // core.editor=true makes any editor git wants a no-op that succeeds.
      // We cannot drive an editor: writing to a child's stdin is a compile
      // fence in scriptc (docs/toolchain.md).
      return conflictProne(
        repo,
        ["-c", "core.editor=true", "rebase", req.ref],
        "Rebase",
        "rebased onto " + req.ref,
      );
    }

    // --- rewriting --------------------------------------------------------

    case "cherryPick": {
      if (req.shas.length === 0) throw new Error("no commits given");
      for (const sha of req.shas) safeArgument(sha, "commit");
      // Oldest first, so the run lands in the order it was authored.
      const ordered = req.shas.slice().reverse();
      return conflictProne(
        repo,
        ["cherry-pick"].concat(ordered),
        "Cherry-pick",
        "cherry-picked " + req.shas.length + " commit(s)",
      );
    }

    /**
     * Undoes commits, either as a commit of its own or as pending changes.
     *
     * `mode` is "worktree" to leave the undoing in the working tree unstaged,
     * so it can be read, edited down or thrown away before it becomes history;
     * anything else commits it straight away with git's own `Revert "<subject>"`
     * message. Both are what someone means by "revert" often enough that
     * guessing gets it wrong half the time.
     */
    case "revert": {
      if (req.shas.length === 0) throw new Error("no commits given");
      for (const sha of req.shas) safeArgument(sha, "commit");
      // Newest first: reverting an older commit before a newer one that
      // touches the same lines conflicts almost every time.
      const many = req.shas.length > 1;
      const count = many ? String(req.shas.length) + " commits" : "1 commit";

      if (req.mode !== "worktree") {
        return conflictProne(
          repo,
          ["revert", "--no-edit"].concat(req.shas),
          "Revert",
          "reverted " + count,
        );
      }

      // The paths the revert is about to touch, read BEFORE it runs: they are
      // what gets unstaged afterwards. Unstaging wholesale with a bare
      // `git reset` would also throw away anything the user had staged for a
      // change of their own, which has nothing to do with this revert.
      const touched = new Set<string>();
      for (const sha of req.shas) {
        const out = await gitOrNull(repo, [
          "diff-tree",
          "-r",
          "--no-commit-id",
          "--name-only",
          sha,
        ]);
        if (out === null) continue;
        for (const line of out.split(String.fromCharCode(10))) {
          const path = line.trim();
          if (path.length > 0) touched.add(path);
        }
      }

      const result = await conflictProne(
        repo,
        ["revert", "--no-commit"].concat(req.shas),
        "Revert",
        "reverted " + count + " into the working tree",
      );
      if (!result.ok) return result;

      // `--no-commit` leaves REVERT_HEAD and the sequencer behind on purpose -
      // git is holding the door open for `revert --continue`. Nothing here
      // wants that, and left in place it shows up as a revert in progress
      // (readPending), so the state is cleared. `--quit` forgets the operation
      // and keeps the index and working tree, which is exactly the split we
      // want.
      await gitOrNull(repo, ["revert", "--quit"]);
      if (touched.size > 0) {
        await gitOrNull(repo, ["reset", "-q", "HEAD", "--"].concat([...touched]));
      }
      return result;
    }

    case "reset": {
      const sha = at(req.shas, 0);
      if (sha === undefined) throw new Error("no commit given");
      safeArgument(sha, "commit");
      const mode = req.mode === "soft" || req.mode === "hard" ? req.mode : "mixed";
      await git(repo, ["reset", "--" + mode, sha]);
      return ok("reset " + mode + " to " + sha.substring(0, 7));
    }

    // --- tags -------------------------------------------------------------

    case "createTag": {
      if (req.name.trim().length === 0) throw new Error("tag needs a name");
      safeArgument(req.name, "tag name");
      const at0 = safeArgument(at(req.shas, 0) ?? "HEAD", "commit");
      if (req.message.length > 0) {
        await git(repo, ["tag", "-a", req.name, "-m", req.message, at0]);
      } else {
        await git(repo, ["tag", req.name, at0]);
      }
      return ok("tagged " + req.name);
    }

    case "deleteTag": {
      needRef(req.ref, "tag");
      await git(repo, ["tag", "-d", req.ref]);
      return ok("deleted tag " + req.ref);
    }

    // --- stash ------------------------------------------------------------

    case "stash": {
      const args = ["stash", "push", "--include-untracked"];
      if (req.message.length > 0) {
        args.push("-m");
        args.push(req.message);
      }
      const out = await git(repo, args);
      if (out.indexOf("No local changes") !== -1) return ok("nothing to stash");
      return ok("stashed");
    }

    /**
     * Restoring a stash, either kind.
     *
     * `ref` names one - "stash@{2}" - or is empty for the most recent, which
     * is what the toolbar's Pop button sends and what git itself defaults to.
     *
     * Both can conflict, and a conflicted apply or pop is not a failure: git
     * leaves the working tree with markers in it and, crucially, KEEPS the
     * stash entry so nothing has been lost. That has to reach the UI as a
     * next step rather than as an error, which is what conflictProne does.
     */
    case "stashPop":
    case "stashApply": {
      const which = req.ref.trim();
      const keep = req.op === "stashApply";
      const args = ["stash", keep ? "apply" : "pop"];
      if (which.length > 0) args.push(which);
      const named = which.length > 0 ? which : "the latest stash";
      try {
        await git(repo, args);
        return ok((keep ? "applied " : "popped ") + named);
      } catch (e) {
        // conflictProne is no use here: it recognises a stopped operation by
        // the marker file git writes, and a conflicted stash restore writes
        // none - there is no operation in progress to abort, only unmerged
        // entries in the index. So the state is named here instead, the same
        // way the checkout path has to (docs, and `checkoutCarryingChanges`).
        const pending = readPending(repo);
        if (pending.kind.length === 0 && !(await hasUnmerged(repo))) throw e;
        return {
          ok: false,
          note:
            "Restoring " +
            named +
            " hit conflicts. Resolve them below - the stash itself is untouched, so nothing is lost either way.",
          pending: pending.kind.length > 0 ? pending.kind : "unmerged",
          refusal: NO_REFUSAL,
          warn: false,
          confirm: "",
        };
      }
    }

    case "stashDrop": {
      const which = needRef(req.ref, "stash");
      await git(repo, ["stash", "drop", which]);
      // Worth saying plainly: every stash below this one has just been
      // renumbered, so a selector read a moment ago now means something else.
      return ok("dropped " + which);
    }

    // --- rewriting a run of commits ---------------------------------------
    //
    // All three drive git's own interactive rebase through rebaseWith(), and
    // all three take the same selection: a contiguous run, newest first, which
    // is the only shape the UI can build (see ui/selection.ts).

    case "squash": {
      const picked = req.shas;
      if (picked.length < 2) throw new Error("select at least two commits to squash");

      const oldest = at(picked, picked.length - 1);
      if (oldest === undefined) throw new Error("nothing to squash");
      for (const sha of picked) safeArgument(sha, "commit");

      await noMergesAmong(repo, picked, "squashing them");
      await checkRewritable(repo, oldest, "squashing");

      // Everything except the oldest gets folded into it, so the run keeps the
      // oldest commit's position in history and its author.
      const folded: string[] = [];
      for (let i = 0; i < picked.length - 1; i++) {
        const hash = at(picked, i);
        if (hash !== undefined) folded.push(hash);
      }

      // The author the squashed commit ends up with is the oldest commit's -
      // that is what git's own `squash` does, and it is the right one. Everyone
      // else in the run has to be credited explicitly or the squash quietly
      // erases them; see creditsFor().
      const authorOut = await gitOrNull(repo, [
        "log",
        "--no-walk",
        "--format=%an%x00%ae",
        oldest,
      ]);
      const authorFields = (authorOut ?? "").trim().split(String.fromCharCode(0));
      const author: Person = {
        name: atOr(authorFields, 0, "").trim(),
        email: atOr(authorFields, 1, "").trim(),
      };
      // `message` is honoured if the caller supplied one - nothing does today,
      // and composing it here is what lets the squash run without stopping to
      // ask for one (see squashMessage).
      const typed = req.message.trim();
      const message = typed.length > 0 ? typed : await squashMessage(repo, picked);
      const credited = withCredits(message, await creditsFor(repo, picked, author));

      return rebaseWith(
        repo,
        "squash",
        folded,
        oldest,
        credited,
        "Squash",
        "squashed " + String(picked.length) + " commits",
      );
    }

    /**
     * Changes a commit's message and nothing else.
     *
     * HEAD is the common case and gets the cheap path: `commit --amend` needs
     * no rebase, so it works with a dirty working tree, which is exactly the
     * state someone is in when they notice the typo they just committed.
     *
     * `--only` with no paths is what makes that safe. A plain `--amend` folds
     * whatever is staged into the commit, so fixing a subject line would
     * silently absorb the next change; `--only` amends the message alone.
     *
     * No `--date=now` either, unlike the amend the staging panel offers. That
     * one is revising work; this one is correcting a sentence about work that
     * happened when it says it happened.
     */
    case "reword": {
      const sha = at(req.shas, 0);
      if (sha === undefined) throw new Error("no commit given");
      safeArgument(sha, "commit");

      const message = req.message.trim();
      if (message.length === 0) throw new Error("a commit needs a message");

      const head = await gitOrNull(repo, ["rev-parse", "HEAD"]);
      const isHead = head !== null && head.trim() === sha;

      if (isHead) {
        const path = tempFile("reword-" + String(Date.now()) + ".txt");
        writeFileSync(path, message + String.fromCharCode(10), "utf8");
        try {
          // --allow-empty because an empty commit is being kept exactly as
          // empty as it was. Without it git refuses to amend one at all,
          // offering to delete it instead - which is not what renaming it
          // asked for.
          await git(repo, ["commit", "--amend", "--only", "--allow-empty", "-F", path]);
        } finally {
          try {
            if (existsSync(path)) unlinkSync(path);
          } catch {
            // A leftover temp file is not worth failing the operation over.
          }
        }
        return ok("reworded " + sha.substring(0, 7));
      }

      await checkRewritable(repo, sha, "rewording");
      return rebaseWith(
        repo,
        "reword",
        [sha],
        sha,
        message,
        "Reword",
        "reworded " + sha.substring(0, 7),
      );
    }

    case "submoduleUpdate": {
      // --init so a submodule that was never checked out works from the same
      // action: "update" is what someone wants in both cases, and asking them
      // to notice the difference first is busywork.
      const target = req.path.trim();
      const args = ["submodule", "update", "--init", "--recursive"];
      if (target.length > 0) {
        args.push("--");
        args.push(target);
      }
      await git(repo, args);
      return ok(target.length > 0 ? "updated " + target : "updated all submodules");
    }

    case "submoduleUpdateRemote": {
      // Moves the submodule to the tip of its configured branch, which leaves
      // the superproject with a staged pointer change to commit.
      const target = req.path.trim();
      const args = ["submodule", "update", "--init", "--remote"];
      if (target.length > 0) {
        args.push("--");
        args.push(target);
      }
      await git(repo, args);
      return ok(
        (target.length > 0 ? target : "submodules") +
          " moved to the latest remote commit - commit the pointer to keep it",
      );
    }

    /**
     * Applies one hunk to the index or the working tree.
     *
     * Staging part of a file is `git apply --cached` with a patch holding
     * only that part; unstaging is the same patch reversed; discarding is the
     * reverse applied to the working tree instead of the index. git does the
     * work - the patch simply says which lines are meant.
     *
     * Through a file because piped stdin is a compile fence here, the same
     * reason commit messages go in with -F.
     */
    case "applyPatch": {
      const patch = req.patch;
      if (patch.trim().length === 0) throw new Error("no patch to apply");

      const args = ["apply"];
      if (req.mode === "stage" || req.mode === "unstage") args.push("--cached");
      if (req.mode === "unstage" || req.mode === "discard") args.push("--reverse");
      if (req.mode !== "stage" && req.mode !== "unstage" && req.mode !== "discard") {
        throw new Error("unknown patch target: " + req.mode);
      }
      // No --recount. It was here as insurance and was the opposite: the
      // header counts come straight from git's own parsed hunk and the body
      // is reproduced verbatim, so they always agree - while --recount made
      // every REVERSE apply fail to find its text ("patch does not apply"),
      // which is unstaging and discarding both.

      const file = tempFile("hunk-" + String(Date.now()) + ".patch");
      writeFileSync(file, patch, "utf8");
      try {
        await git(repo, args.concat([file]));
      } finally {
        if (existsSync(file)) unlinkSync(file);
      }

      if (req.mode === "stage") return ok("staged the hunk");
      if (req.mode === "unstage") return ok("unstaged the hunk");
      return ok("discarded the hunk");
    }

    case "editFile": {
      const rel = req.path;
      if (rel.trim().length === 0) throw new Error("no file to open");
      // openInEditor hands this to the platform's opener, which on Windows is
      // `cmd /c start` - it runs the file rather than merely showing it. A
      // path that could leave the repository was therefore a way to run any
      // executable on the machine.
      const full = needInRepo(repo, rel);
      // A file shown from a commit may not exist in the working tree at all -
      // deleted since, or never checked out on this branch. Say so rather than
      // silently opening nothing.
      if (!existsSync(full)) {
        throw new Error(rel + " is not in the working tree");
      }
      openInEditor(full);
      return ok("opened " + rel);
    }

    // --- managing remotes -------------------------------------------------

    case "addRemote": {
      if (req.name.trim().length === 0) throw new Error("the remote needs a name");
      safeArgument(req.name, "remote name");
      // The transport is the whole finding. "ext::sh -c <command>" is a valid
      // git URL that runs a shell command, and the fetch below happens
      // automatically - so this was remote code execution for anything that
      // could reach the port, which before the Origin check meant any website
      // the user visited. Confirmed against a running engine.
      const url = safeRemoteUrl(req.message);
      if (readRemotes(repo).remotes.includes(req.name)) {
        throw new Error("A remote called " + req.name + " already exists.");
      }
      await git(repo, ["remote", "add", req.name, url]);
      // Fetching immediately is what makes the remote useful rather than just
      // configured - its branches appear in the graph straight away.
      await gitOrNull(repo, ["fetch", req.name, "--prune"]);
      return ok("added " + req.name + " and fetched it");
    }

    case "renameRemote": {
      needRef(req.ref, "remote");
      if (req.name.trim().length === 0) throw new Error("the remote needs a name");
      safeArgument(req.name, "remote name");
      await git(repo, ["remote", "rename", req.ref, req.name]);
      return ok("renamed " + req.ref + " to " + req.name);
    }

    case "removeRemote": {
      needRef(req.ref, "remote");
      await git(repo, ["remote", "remove", req.ref]);
      return ok("removed " + req.ref);
    }

    case "setRemoteUrl": {
      needRef(req.ref, "remote");
      // Same transport hazard as addRemote: pointing an existing remote at
      // "ext::..." reaches the same helper on the next fetch.
      const url = safeRemoteUrl(req.message);
      await git(repo, ["remote", "set-url", req.ref, url]);
      return ok("updated the URL for " + req.ref);
    }

    case "fetchRemote": {
      needRef(req.ref, "remote");
      await git(repo, ["fetch", req.ref, "--prune"]);
      return ok("fetched " + req.ref);
    }

    case "pruneRemote": {
      needRef(req.ref, "remote");
      await git(repo, ["remote", "prune", req.ref]);
      return ok("pruned branches that no longer exist on " + req.ref);
    }

    // --- remotes ----------------------------------------------------------

    case "fetch": {
      await git(repo, ["fetch", "--all", "--prune"]);
      return ok("fetched");
    }

    case "pull": {
      // --ff-only by default rather than a silent merge or rebase: if the
      // branches have diverged the user should choose, not have a merge commit
      // appear. `mode` is that choice, once they have been shown what the
      // divergence actually is.
      if (req.mode === "rebase") {
        return conflictProne(
          repo,
          ["pull", "--rebase"],
          "Pull",
          "pulled - your commits are on top now, push again to publish",
        );
      }
      if (req.mode === "merge") {
        return conflictProne(
          repo,
          ["pull", "--no-rebase"],
          "Pull",
          "pulled and merged - push again to publish",
        );
      }
      await git(repo, ["pull", "--ff-only"]);
      return ok("pulled");
    }

    case "push": {
      // Trimmed: git ends it with a newline, and this goes into rev-list
      // ranges where "origin/main\n..HEAD" resolves to nothing at all.
      const upstreamRaw = await gitOrNull(repo, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
      const upstream = upstreamRaw === null ? null : upstreamRaw.trim();
      if (upstream !== null && upstream.length > 0) {
        if (req.force) {
          // --force-with-lease, never a bare --force: it refuses if the remote
          // has moved since our last fetch, so a force decided on one view of
          // the remote cannot land on a different one.
          try {
            await git(repo, ["push", "--force-with-lease"]);
            return ok("force-pushed to " + upstream);
          } catch (e) {
            const message = (e as Error).message;
            // The lease said no: somebody pushed between the decision and the
            // act. Ask again with current numbers rather than reporting a
            // failure - the answer may well be different now.
            if (!isRefusal(message) && !message.includes("stale info")) throw e;
            const refusal = await classifyRefusal(repo, upstream);
            return {
              ok: false,
              note: "The remote moved while you were deciding.",
              pending: "",
              refusal,
              warn: false,
              confirm: "",
            };
          }
        }

        try {
          await git(repo, ["push"]);
          return ok("pushed");
        } catch (e) {
          const message = (e as Error).message;
          if (!isRefusal(message)) throw e;
          const refusal = await classifyRefusal(repo, upstream);
          return {
            ok: false,
            note:
              refusal.kind === "rewrite"
                ? "The remote still has the old version of these commits."
                : refusal.kind === "behind"
                  ? "This branch is behind the remote."
                  : "The remote has commits you do not.",
            pending: "",
            refusal,
            warn: false,
            confirm: "",
          };
        }
      }

      // No upstream yet, so one has to be chosen. Defaulting to "origin"
      // silently picks a destination the user may not have meant when there
      // are several - and publishing to the wrong remote is not undoable.
      const remotes = readRemotes(repo).remotes;
      let remote = req.remote.trim();
      if (remote.length === 0) {
        if (remotes.length === 0) {
          throw new Error("This repository has no remotes configured.");
        }
        if (remotes.length > 1) {
          throw new Error("Choose which remote to push to: " + remotes.join(", "));
        }
        remote = remotes[0];
      } else if (!remotes.includes(remote)) {
        throw new Error("No such remote: " + remote);
      }

      await git(repo, ["push", "-u", remote, "HEAD"]);
      return ok("pushed to " + remote + " and set upstream");
    }

    // --- finishing or abandoning an in-progress operation -----------------

    case "abort": {
      // Each in-progress operation has its own abort; there is no generic one.
      const kind = needRef(req.ref, "operation");
      if (kind === "rebase") await git(repo, ["rebase", "--abort"]);
      else if (kind === "cherry-pick") await git(repo, ["cherry-pick", "--abort"]);
      else if (kind === "revert") await git(repo, ["revert", "--abort"]);
      else if (kind === "merge") await git(repo, ["merge", "--abort"]);
      else if (kind === "bisect") await git(repo, ["bisect", "reset"]);
      else throw new Error("nothing to abort");
      return ok("abandoned the " + kind);
    }

    case "continue": {
      const kind = needRef(req.ref, "operation");
      // --no-edit keeps git from opening an editor we cannot drive: stdin to
      // a child is a compile fence here (docs/toolchain.md).
      if (kind === "rebase") {
        return conflictProne(
          repo,
          ["-c", "core.editor=true", "rebase", "--continue"],
          "Rebase",
          "continued the rebase",
        );
      }
      if (kind === "cherry-pick") {
        return conflictProne(
          repo,
          ["cherry-pick", "--continue", "--no-edit"],
          "Cherry-pick",
          "continued the cherry-pick",
        );
      }
      if (kind === "revert") {
        return conflictProne(
          repo,
          ["revert", "--continue", "--no-edit"],
          "Revert",
          "continued the revert",
        );
      }
      if (kind === "merge") {
        await git(repo, ["commit", "--no-edit"]);
        return ok("completed the merge");
      }
      throw new Error("nothing to continue");
    }

    case "skip": {
      const kind = needRef(req.ref, "operation");
      if (kind === "rebase") await git(repo, ["rebase", "--skip"]);
      else if (kind === "cherry-pick") await git(repo, ["cherry-pick", "--skip"]);
      else if (kind === "revert") await git(repo, ["revert", "--skip"]);
      else throw new Error("nothing to skip");
      return ok("skipped a commit in the " + kind);
    }

    default:
      throw new Error("unknown operation: " + req.op);
  }
}
