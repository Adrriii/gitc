import {
  branchesElsewhere,
  isActive,
  isWip,
  wipHash,
  wipWorktree,
  worktreeLabel,
} from "../worktrees.ts";
import { groupRefs } from "../refGroups.ts";
import type { Worktree } from "../types.ts";

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

const tree = (over: Partial<Worktree>): Worktree => ({
  name: "agent",
  path: "/work/agent",
  main: false,
  current: false,
  branch: "topic",
  hash: "a".repeat(40),
  detached: false,
  locked: false,
  lockReason: "",
  prunable: false,
  pending: "",
  idleMs: 600_000,
  status: [],
  ...over,
});

console.log("WIP rows");
{
  eq("this tab's own is a WIP row", isWip("WIP"), true);
  eq("so is another worktree's", isWip(wipHash("agent")), true);
  eq("a commit is not", isWip("a".repeat(40)), false);
  eq("the worktree a row belongs to", wipWorktree(wipHash("agent")), "agent");
  // The main worktree is named "", and its row must still be told apart from
  // this tab's own - which is what a bare "WIP" is.
  eq("the main one, from a linked tab", wipWorktree(wipHash("")), "");
  eq("this tab's own belongs to no other", wipWorktree("WIP"), null);
  eq("a commit belongs to none", wipWorktree("a".repeat(40)), null);
}

console.log("labels");
{
  eq("a linked worktree by its directory", worktreeLabel(tree({ path: "/work/agent-7" })), "agent-7");
  eq("the main one too", worktreeLabel(tree({ name: "", main: true, path: "C:\\Code\\gitc" })), "gitc");
  eq("a trailing separator does not blank it", worktreeLabel(tree({ path: "/work/agent/" })), "agent");
}

console.log("who is working where");
{
  eq("moved seconds ago", isActive(tree({ idleMs: 3000 })), true);
  eq("left alone", isActive(tree({ idleMs: 600_000 })), false);
  eq("unknown is not active", isActive(tree({ idleMs: -1 })), false);
  eq("this tab's own never asks", isActive(tree({ current: true, idleMs: 0 })), false);

  const held = branchesElsewhere([
    tree({ name: "", main: true, current: true, branch: "master" }),
    tree({ name: "agent", branch: "topic" }),
    tree({ name: "loose", branch: null, detached: true }),
    tree({ name: "gone", branch: "old", prunable: true }),
  ]);
  eq("branches held by other worktrees", [...held.keys()], ["topic"]);
}

console.log("chips");
{
  const labels = {
    byBranch: new Map([["topic", "agent"]]),
    byName: new Map([["loose", "loose-dir"], ["", "gitc"]]),
  };
  const groups = groupRefs(["local:topic", "remote:origin/topic"], "master", labels);
  eq("a branch checked out elsewhere says where", groups.map((g) => g.elsewhere), ["agent"]);

  const own = groupRefs(["local:master"], "master", labels);
  eq("the branch you are on is not elsewhere", own.map((g) => [g.isHead, g.elsewhere]), [[true, ""]]);

  const detached = groupRefs(["worktree:loose", "tag:v1"], null, labels);
  eq(
    "a detached worktree is a chip of its own, before tags",
    detached.map((g) => [g.kind, g.name, g.actionKind, g.actionName]),
    [["worktree", "loose-dir", "worktree", "loose"], ["tag", "v1", "tag", "v1"]],
  );
  eq(
    "the main one is addressed by \"\"",
    groupRefs(["worktree:"], null, labels).map((g) => [g.name, g.actionName]),
    [["gitc", ""]],
  );
  eq("no worktrees, no marks", groupRefs(["local:topic"], null).map((g) => g.elsewhere), [""]);
}

console.log(`\n${pass} passed, ${fail} failed`);
// exitCode, not exit(): exit() can abort a queued stdout write on Windows.
if (fail > 0) process.exitCode = 1;
