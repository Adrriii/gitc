// Where a push goes, and who decides - against a real
// clone made by git here.
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

process.env.GIT_AUTHOR_NAME = "t";
process.env.GIT_AUTHOR_EMAIL = "t@t";
process.env.GIT_COMMITTER_NAME = "t";
process.env.GIT_COMMITTER_EMAIL = "t@t";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function tracking(cwd: string, branch: string): string {
  try {
    const args = ["rev-parse", "--abbrev-ref", branch + "@{upstream}"];
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function commit(cwd: string, file: string) {
  writeFileSync(join(cwd, file), file);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", file);
}

function request(op: string, fields: Partial<OpRequest>): OpRequest {
  return {
    op,
    ref: "",
    shas: [],
    name: "",
    mode: "",
    message: "",
    remote: "",
    force: false,
    checkout: false,
    path: "",
    patch: "",
    ...fields,
  };
}

const root = realpathSync.native(mkdtempSync(join(tmpdir(), "gitc-upstream-test-")));
const upstream = join(root, "upstream");
git(root, "init", "-q", "--bare", "-b", "master", "upstream");
execFileSync("git", ["clone", "-q", upstream, "clone"], { cwd: root, stdio: "ignore" });
const clone = join(root, "clone");
commit(clone, "base");
git(clone, "push", "-q", "origin", "master");
// git's default, set in case the machine running this has another.
git(clone, "config", "push.default", "simple");

// What `git worktree add -b` or `git checkout -b` from a remote branch leave.
git(clone, "checkout", "-q", "-b", "feature", "origin/master");
eq("git itself tracks the start point", tracking(clone, "feature"), "origin/master");
commit(clone, "mine");
const asked = await runOp(clone, request("push", {}));
eq("pushing it asks where to", [asked.ok, asked.pushTo], [false, "origin/feature"]);
eq("and has pushed nothing", git(upstream, "branch", "--list", "feature"), "");

const pushed = await runOp(clone, request("push", { remote: "origin", name: "feature" }));
eq("the confirmed push succeeds", pushed.ok, true);
eq("under the name confirmed", git(upstream, "rev-parse", "feature"), git(clone, "rev-parse", "feature"));
eq("master is left alone", git(upstream, "log", "-1", "--format=%s", "master"), "base");
eq("which becomes the upstream", tracking(clone, "feature"), "origin/feature");
commit(clone, "more");
eq("after which a push just goes", (await runOp(clone, request("push", {}))).note, "pushed to origin/feature");

// Renamed locally, amended, and pushed back to the name it was published as.
git(clone, "branch", "-m", "feature", "feature_");
git(clone, "commit", "-q", "--amend", "-m", "more, amended");
const where = { remote: "origin", name: "feature" };
const refused = await runOp(clone, request("push", where));
eq("an amended commit is a rewrite", refused.refusal.kind, "rewrite");
const forced = await runOp(clone, request("push", { ...where, force: true }));
eq("forcing the same destination goes through", [forced.ok, forced.note], [true, "force-pushed to origin/feature"]);
eq("and lands", git(upstream, "log", "-1", "--format=%s", "feature"), "more, amended");

const created = await runOp(clone, request("createBranch", { name: "other", ref: "origin/master", checkout: true }));
eq("a branch made in gitc from origin/master", created.ok, true);
eq("tracks nothing", tracking(clone, "other"), "");
eq("and is asked about too", (await runOp(clone, request("push", {}))).pushTo, "origin/other");
git(clone, "checkout", "-q", "master");
git(clone, "branch", "-D", "feature_");
await runOp(clone, request("createBranch", { name: "feature", ref: "origin/feature" }));
eq("one made from its namesake tracks it", tracking(clone, "feature"), "origin/feature");

const set = await runOp(clone, request("setUpstream", { ref: "other", remote: "origin", name: "not-pushed-yet" }));
eq("an upstream that does not exist yet can be set", set.ok, true);
eq("it is in the config", git(clone, "config", "branch.other.merge"), "refs/heads/not-pushed-yet");
await runOp(clone, request("setUpstream", { ref: "other", remote: "origin", name: "master" }));
eq("an existing one too", tracking(clone, "other"), "origin/master");
await runOp(clone, request("setUpstream", { ref: "other", remote: "" }));
eq("and it can be unset", tracking(clone, "other"), "");
const bad = await runOp(clone, request("setUpstream", { ref: "other", remote: "nope", name: "x" })).catch(
  (e: Error) => e.message,
);
eq("an unknown remote is refused", bad, "No such remote: nope");

rmSync(root, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
