// Pulling a branch that moved while there are uncommitted changes, against a
// real clone made by git here.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runOp } from "../ops.ts";
import type { OpRequest } from "../ops.ts";

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

process.env.GIT_AUTHOR_NAME = "t";
process.env.GIT_AUTHOR_EMAIL = "t@t";
process.env.GIT_COMMITTER_NAME = "t";
process.env.GIT_COMMITTER_EMAIL = "t@t";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function pull(mode: string): OpRequest {
  return {
    op: "pull",
    ref: "",
    shas: [],
    name: "",
    mode,
    message: "",
    remote: "",
    force: false,
    checkout: false,
    path: "",
    patch: "",
  };
}

const root = realpathSync.native(mkdtempSync(join(tmpdir(), "gitc-pull-test-")));
const upstream = join(root, "upstream");
git(root, "init", "-q", "--bare", "-b", "master", "upstream");
git(root, "clone", "-q", upstream, "other");
const other = join(root, "other");
writeFileSync(join(other, "f"), "1\n2\n3\n");
writeFileSync(join(other, "g"), "x\n");
git(other, "add", ".");
git(other, "commit", "-q", "-m", "base");
git(other, "push", "-q", "origin", "master");

let n = 0;
/** A clone with `edit` applied to one of its files, left uncommitted after the remote moved line 2 of f. */
function behindWithEdit(file: string, edit: (lines: string[]) => void): string {
  n += 1;
  git(root, "clone", "-q", "-c", "core.autocrlf=false", upstream, "c" + String(n));
  const clone = join(root, "c" + String(n));
  writeFileSync(join(other, "f"), "1\ntheirs " + String(n) + "\n3\n");
  git(other, "commit", "-q", "-am", "theirs " + String(n));
  git(other, "push", "-q");
  git(clone, "fetch", "-q");
  const lines = readFileSync(join(clone, file), "utf8").split("\n");
  edit(lines);
  writeFileSync(join(clone, file), lines.join("\n"));
  return clone;
}

const apart = behindWithEdit("g", (l) => (l[0] = "mine"));
const r1 = await runOp(apart, pull(""));
eq("an edit elsewhere: pulled", r1.ok, true);
eq("caught up", git(apart, "rev-parse", "HEAD"), git(apart, "rev-parse", "origin/master"));
eq("the edit is still there", readFileSync(join(apart, "g"), "utf8"), "mine\n");

const sameFile = behindWithEdit("f", (l) => l.splice(3, 0, "mine"));
const r2 = await runOp(sameFile, pull(""));
eq("an edit in a file that moved: pulled", r2.ok, true);
eq("both changes in it", readFileSync(join(sameFile, "f"), "utf8"), "1\ntheirs 2\n3\nmine\n");
eq("nothing left in the stash", git(sameFile, "stash", "list"), "");

const sameLine = behindWithEdit("f", (l) => (l[1] = "mine"));
const r3 = await runOp(sameLine, pull(""));
eq("an edit on the line that moved is a conflict", [r3.ok, r3.pending], [false, "unmerged"]);
eq("the branch still caught up", git(sameLine, "rev-parse", "HEAD"), git(sameLine, "rev-parse", "origin/master"));
eq("the file is conflicted", git(sameLine, "status", "--porcelain"), "UU f");
eq("and a copy of the edit is kept", git(sameLine, "stash", "list").includes("autostash"), true);

const rebased = behindWithEdit("g", (l) => (l[0] = "mine"));
writeFileSync(join(rebased, "h"), "h\n");
git(rebased, "add", "h");
git(rebased, "commit", "-q", "-m", "own");
writeFileSync(join(rebased, "g"), "mine\n");
const r4 = await runOp(rebased, pull("rebase"));
eq("a rebase pull with an edit goes through", r4.ok, true);
eq("own commit on top", git(rebased, "log", "-1", "--format=%s"), "own");
eq("the edit is still there", git(rebased, "status", "--porcelain"), "M g");

rmSync(root, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
