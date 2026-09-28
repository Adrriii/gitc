// Double-clicking a remote branch whose local branch has diverged, against a
// real clone made by git here.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
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

// Set on the process rather than per call: the rebase runOp starts commits
// too, with the environment it inherits.
process.env.GIT_AUTHOR_NAME = "t";
process.env.GIT_AUTHOR_EMAIL = "t@t";
process.env.GIT_COMMITTER_NAME = "t";
process.env.GIT_COMMITTER_EMAIL = "t@t";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(cwd: string, file: string) {
  writeFileSync(join(cwd, file), file);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", file);
}

function request(mode: string): OpRequest {
  return {
    op: "checkout",
    ref: "origin/topic",
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

const root = realpathSync.native(mkdtempSync(join(tmpdir(), "gitc-checkout-test-")));
const upstream = join(root, "upstream");
git(root, "init", "-q", "-b", "master", "upstream");
commit(upstream, "base");
git(upstream, "branch", "topic");

function divergedClone(name: string): string {
  const clone = join(root, name);
  git(root, "clone", "-q", upstream, name);
  git(clone, "checkout", "-q", "-b", "topic", "origin/topic");
  commit(clone, "mine-" + name);
  git(clone, "checkout", "-q", "master");
  git(upstream, "checkout", "-q", "topic");
  commit(upstream, "theirs-" + name);
  git(upstream, "checkout", "-q", "master");
  git(clone, "fetch", "-q");
  return clone;
}

const asked = divergedClone("asked");
const question = await runOp(asked, request(""));
eq("a diverged branch is asked about", question.confirm, "topic has diverged from origin/topic");
eq("and checked out meanwhile", git(asked, "branch", "--show-current"), "topic");
eq("nothing moved yet", git(asked, "rev-list", "--count", "origin/topic..topic"), "1");

const rebased = divergedClone("rebased");
writeFileSync(join(rebased, "base"), "edited");
const rebase = await runOp(rebased, request("rebase"));
eq("rebase succeeds", rebase.ok, true);
eq("the remote is under it", git(rebased, "rev-list", "--count", "topic..origin/topic"), "0");
eq("our commit is on top", git(rebased, "log", "-1", "--format=%s", "topic"), "mine-rebased");
eq("uncommitted work survives the rebase", git(rebased, "status", "--porcelain"), "M base");

const reset = divergedClone("reset");
writeFileSync(join(reset, "base"), "edited");
const overwrite = await runOp(reset, request("reset"));
eq("reset succeeds", overwrite.ok, true);
eq("the branch is the remote's", git(reset, "rev-parse", "topic"), git(reset, "rev-parse", "origin/topic"));
eq("uncommitted work survives", git(reset, "status", "--porcelain"), "M base");

rmSync(root, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
