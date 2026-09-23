// Reads a real repository with real linked worktrees, made by git here.
//
// Faking the layout by hand would test our idea of it; the point is git's.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

import { readRefs, readHead, readRemotes, gitDir, commonDir } from "../refs.ts";
import { listWorktrees, findWorktree, worktreeStatus, samePath } from "../worktrees.ts";

let pass = 0;
let fail = 0;

function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  console.log(
    `${ok ? "  ok  " : " FAIL "} ${label}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`,
  );
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).trim();
}

// The native realpath, because git writes paths fully resolved. On macOS the
// temp directory is behind a symlink; on a Windows CI runner it is an 8.3
// short name (C:\Users\RUNNER~1\...), which only the native call expands -
// the plain one left it short, and every path git wrote failed to match.
const root = realpathSync.native(mkdtempSync(join(tmpdir(), "gitc-worktrees-test-")));
const main = join(root, "main");
git(root, "init", "-q", "-b", "master", "main");
git(main, "commit", "-q", "--allow-empty", "-m", "first");
git(main, "branch", "topic");
git(main, "remote", "add", "origin", "https://example.invalid/r.git");
// Packed, so resolving a branch has to find packed-refs in the common dir.
git(main, "pack-refs", "--all");
git(main, "worktree", "add", "-q", join(root, "agent"), "topic");
git(main, "worktree", "add", "-q", "--detach", join(root, "loose"), "master");
git(main, "worktree", "add", "-q", "-b", "gone", join(root, "gone"));
git(main, "worktree", "lock", "--reason", "agent at work", join(root, "loose"));
const tip = git(main, "rev-parse", "HEAD");

const agent = join(root, "agent");

// --- refs from inside a linked worktree -----------------------------------

eq("a worktree's git dir is its own", samePath(gitDir(agent), join(main, ".git", "worktrees", "agent")), true);
eq("its common dir is the repository's", samePath(commonDir(agent), join(main, ".git")), true);
eq("an ordinary repository is its own common dir", samePath(commonDir(main), join(main, ".git")), true);
eq(
  "branches are visible from a worktree",
  readRefs(agent).map((r) => r.short).sort(),
  readRefs(main).map((r) => r.short).sort(),
);
eq("HEAD resolves through the shared packed-refs", readHead(agent), {
  branch: "topic",
  hash: tip,
  detached: false,
});
eq("remotes come from the shared config", readRemotes(agent).remotes, ["origin"]);

// git 2.48 can write the pointer relative to the worktree. Rewritten by hand
// so the test does not depend on the git it runs under.
// Removed first: git marks that file hidden, and Windows refuses to open a
// hidden file for writing in place (EPERM).
function rewrite(path: string, text: string) {
  rmSync(path, { force: true });
  writeFileSync(path, text);
}
const dotGit = join(agent, ".git");
const absolute = readFileSync(dotGit, "utf8").trim().substring("gitdir:".length).trim();
rewrite(dotGit, "gitdir: " + relative(agent, absolute).replace(/\\/g, "/") + "\n");
eq("a relative gitdir resolves against the worktree", readHead(agent).hash, tip);
rewrite(dotGit, "gitdir: " + absolute + "\n");

// --- the list ----------------------------------------------------------------

rmSync(join(root, "gone"), { recursive: true, force: true });

const seen = listWorktrees(agent).map((w) => ({
  name: w.name,
  main: w.main,
  current: w.current,
  branch: w.branch,
  detached: w.detached,
  locked: w.locked,
  lockReason: w.lockReason,
  prunable: w.prunable,
}));
eq("every worktree, main first, the rest by name", seen, [
  { name: "", main: true, current: false, branch: "master", detached: false, locked: false, lockReason: "", prunable: false },
  { name: "agent", main: false, current: true, branch: "topic", detached: false, locked: false, lockReason: "", prunable: false },
  { name: "gone", main: false, current: false, branch: "gone", detached: false, locked: false, lockReason: "", prunable: true },
  { name: "loose", main: false, current: false, branch: null, detached: true, locked: true, lockReason: "agent at work", prunable: false },
]);
eq(
  "paths are where the files are",
  listWorktrees(main).map((w) => samePath(w.path, join(root, w.name.length > 0 ? w.name : "main"))),
  [true, true, true, true],
);
eq("the main checkout is current from itself", listWorktrees(main).map((w) => w.current), [true, false, false, false]);

// --- the name gate -----------------------------------------------------------

eq("found by name", findWorktree(main, "agent") !== null, true);
eq("the main one is named \"\"", findWorktree(agent, "")?.main, true);
eq("a traversal names nothing", findWorktree(main, "../agent"), null);
eq("a path names nothing", findWorktree(main, join(root, "agent")), null);
eq("a worktree gone from disk is not readable", findWorktree(main, "gone"), null);

// --- status without the lock -------------------------------------------------

writeFileSync(join(agent, "note.txt"), "x");
const files = await worktreeStatus(agent);
eq("another worktree's changes", files.map((f) => f.path), ["note.txt"]);

rmSync(root, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
// exitCode, not exit(): exit() can abort a queued stdout write on Windows.
if (fail > 0) process.exitCode = 1;
