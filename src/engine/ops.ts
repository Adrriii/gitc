// Repository operations reachable from the toolbar and context menus.
//
// One dispatcher rather than an endpoint per verb: these are all the same
// shape - take a few strings, run git, let the UI refresh - and a dozen
// near-identical handlers in main.ts would bury that.
//
// Everything here goes through git. None of it touches .git directly.

import { spawn } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { git, gitOrNull } from "./git.ts";
import { readPending, readRemotes } from "./refs.ts";
import { at } from "./safe.ts";

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
}

export interface OpResult {
  ok: boolean;
  /** Something worth telling the user that isn't an error. */
  note: string;
  /** Set when the operation stopped part-way and needs resolving. */
  pending: string;
}

const ok = (note: string): OpResult => ({ ok: true, note, pending: "" });

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
 * it is an expected outcome with a next step. It also cannot be described
 * from git's message here: scriptc's promisified execFile does not carry
 * stdout or stderr on rejection, and git writes conflict detail to stdout. So
 * rather than parroting "Command failed", check whether git left an operation
 * in progress and say that instead.
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
      };
    }
    throw e;
  }
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
  return ref;
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
  ref: string,
  note: string,
): Promise<OpResult> {
  try {
    await git(repo, ["checkout", ref]);
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
    await git(repo, ["checkout", ref]);
    return ok(note);
  }

  try {
    await git(repo, ["checkout", ref]);
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
    };
  }

  return ok("switched to " + ref + " and brought your changes across");
}

export async function runOp(repo: string, req: OpRequest): Promise<OpResult> {
  switch (req.op) {
    // --- moving around ----------------------------------------------------

    case "checkout": {
      const ref = needRef(req.ref, "branch");
      const note = await detachedWarning(repo);
      return checkoutCarryingChanges(repo, ref, note);
    }

    case "checkoutCommit": {
      const sha = at(req.shas, 0);
      if (sha === undefined) throw new Error("no commit given");
      // Checking out a commit detaches HEAD. That is the intended behaviour
      // here - the UI says so before calling.
      await git(repo, ["checkout", "--detach", sha]);
      return ok("HEAD is now detached at " + sha.substring(0, 7));
    }

    // --- branches ---------------------------------------------------------

    case "createBranch": {
      if (req.name.trim().length === 0) throw new Error("branch needs a name");
      // No start point means "from HEAD", which is the argument being absent
      // rather than being an empty string.
      const start = at(req.shas, 0) ?? req.ref;
      const args = req.checkout ? ["checkout", "-b", req.name] : ["branch", req.name];
      if (start.trim().length > 0) args.push(start);
      await git(repo, args);
      return ok(req.checkout ? "created and checked out " + req.name : "created " + req.name);
    }

    case "renameBranch": {
      if (req.name.trim().length === 0) throw new Error("branch needs a name");
      needRef(req.ref, "branch");
      await git(repo, ["branch", "-m", req.ref, req.name]);
      return ok("renamed to " + req.name);
    }

    case "deleteBranch": {
      needRef(req.ref, "branch");
      // -d refuses to drop unmerged work; -D is the explicit override, and
      // the UI only sends force after saying what that means.
      await git(repo, ["branch", req.force ? "-D" : "-d", req.ref]);
      return ok("deleted " + req.ref);
    }

    case "deleteRemoteBranch": {
      needRef(req.ref, "branch");
      if (req.remote.trim().length === 0) throw new Error("no remote given");
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
      // Oldest first, so the run lands in the order it was authored.
      const ordered = req.shas.slice().reverse();
      return conflictProne(
        repo,
        ["cherry-pick"].concat(ordered),
        "Cherry-pick",
        "cherry-picked " + req.shas.length + " commit(s)",
      );
    }

    case "revert": {
      if (req.shas.length === 0) throw new Error("no commits given");
      // Newest first: reverting an older commit before a newer one that
      // touches the same lines conflicts almost every time.
      return conflictProne(
        repo,
        ["revert", "--no-edit"].concat(req.shas),
        "Revert",
        "reverted " + req.shas.length + " commit(s)",
      );
    }

    case "reset": {
      const sha = at(req.shas, 0);
      if (sha === undefined) throw new Error("no commit given");
      const mode = req.mode === "soft" || req.mode === "hard" ? req.mode : "mixed";
      await git(repo, ["reset", "--" + mode, sha]);
      return ok("reset " + mode + " to " + sha.substring(0, 7));
    }

    // --- tags -------------------------------------------------------------

    case "createTag": {
      if (req.name.trim().length === 0) throw new Error("tag needs a name");
      const at0 = at(req.shas, 0) ?? "HEAD";
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

    case "stashPop": {
      await git(repo, ["stash", "pop"]);
      return ok("popped the latest stash");
    }

    // --- managing remotes -------------------------------------------------

    case "squash": {
      // The selection is a contiguous run of commits, newest first - the UI
      // only ever offers squash for such a run (see selection.ts).
      const picked = req.shas;
      if (picked.length < 2) throw new Error("select at least two commits to squash");

      const newest = at(picked, 0);
      const oldest = at(picked, picked.length - 1);
      if (newest === undefined || oldest === undefined) throw new Error("nothing to squash");

      // Everything except the oldest gets folded into it, so the run keeps the
      // oldest commit's position in history and its author.
      const folded: string[] = [];
      for (let i = 0; i < picked.length - 1; i++) {
        const hash = at(picked, i);
        if (hash !== undefined) folded.push(hash);
      }

      const message = req.message.trim();
      if (message.length === 0) throw new Error("the squashed commit needs a message");

      const stamp = String(Date.now());
      const specPath = join(tmpdir(), "gitc-squash-" + stamp + ".txt");
      const msgPath = join(tmpdir(), "gitc-squash-msg-" + stamp + ".txt");
      writeFileSync(specPath, folded.join(String.fromCharCode(10)), "utf8");
      writeFileSync(msgPath, message, "utf8");

      // A root commit has no parent to rebase onto, so the whole history is
      // replayed instead.
      const parent = await gitOrNull(repo, ["rev-parse", "--verify", oldest + "^"]);
      const base = parent === null ? "--root" : oldest + "^";

      // gitc drives its own rebase: see engine/rebaseHelper.ts for why the
      // editors point back at this binary.
      const self = process.execPath;
      const env: Record<string, string> = {
        GIT_SEQUENCE_EDITOR: quoted(self) + " --rebase-todo " + quoted(specPath),
        GIT_EDITOR: quoted(self) + " --rebase-message " + quoted(msgPath),
      };

      try {
        return await conflictProne(
          repo,
          ["rebase", "-i", base],
          "Squash",
          "squashed " + String(picked.length) + " commits",
          env,
        );
      } finally {
        for (const file of [specPath, msgPath]) {
          try {
            if (existsSync(file)) unlinkSync(file);
          } catch {
            // A leftover temp file is not worth failing the operation over.
          }
        }
      }
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

    case "editFile": {
      const rel = req.path;
      if (rel.trim().length === 0) throw new Error("no file to open");
      const full = join(repo, rel);
      // A file shown from a commit may not exist in the working tree at all -
      // deleted since, or never checked out on this branch. Say so rather than
      // silently opening nothing.
      if (!existsSync(full)) {
        throw new Error(rel + " is not in the working tree");
      }
      openInEditor(full);
      return ok("opened " + rel);
    }

    case "addRemote": {
      if (req.name.trim().length === 0) throw new Error("the remote needs a name");
      const url = req.message.trim();
      if (url.length === 0) throw new Error("the remote needs a URL");
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
      const url = req.message.trim();
      if (url.length === 0) throw new Error("the remote needs a URL");
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
      // --ff-only rather than a silent merge or rebase: if the branches have
      // diverged the user should choose, not have a merge commit appear.
      await git(repo, ["pull", "--ff-only"]);
      return ok("pulled");
    }

    case "push": {
      const upstream = await gitOrNull(repo, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
      if (upstream !== null) {
        await git(repo, ["push"]);
        return ok("pushed");
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
