import { nextAfter, stagedFiles, unstagedFiles } from "../staging.ts";
import type { WorkingFile } from "../types.ts";

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

/** A porcelain code as git writes it: index character, then worktree. */
const file = (path: string, code: string): WorkingFile => ({
  path,
  index: code.charAt(0),
  worktree: code.charAt(1),
  staged: code.charAt(0) !== " " && code.charAt(0) !== "?",
  untracked: code === "??",
});

const names = (files: WorkingFile[]) => files.map((f) => f.path);

console.log("which list a file belongs to");
{
  const status = [
    file("only-staged.txt", "M "),
    file("only-unstaged.txt", " M"),
    file("both.txt", "MM"),
    file("added-then-edited.txt", "AM"),
    file("untracked.txt", "??"),
    file("deleted-in-tree.txt", " D"),
    file("staged-delete.txt", "D "),
  ];

  eq("unstaged", names(unstagedFiles(status)), [
    "only-unstaged.txt",
    "both.txt",
    "added-then-edited.txt",
    "untracked.txt",
    "deleted-in-tree.txt",
  ]);

  eq("staged", names(stagedFiles(status)), [
    "only-staged.txt",
    "both.txt",
    "added-then-edited.txt",
    "staged-delete.txt",
  ]);

  // The bug this replaced: a file staged and then edited again appeared only
  // under Staged, so the later edit was invisible.
  eq(
    "a file staged and edited again is in both",
    [
      names(unstagedFiles(status)).includes("both.txt"),
      names(stagedFiles(status)).includes("both.txt"),
    ],
    [true, true],
  );
}

console.log("what to open once a file leaves the list");
{
  const before = ["a.txt", "b.txt", "c.txt"];
  eq("the file that takes its place", nextAfter(before, ["a.txt", "c.txt"], "b.txt"), "c.txt");
  eq("staging the first moves down", nextAfter(before, ["b.txt", "c.txt"], "a.txt"), "b.txt");
  // Nothing below it any more, so the end of the list is where you land.
  eq("staging the last moves up", nextAfter(before, ["a.txt", "b.txt"], "c.txt"), "b.txt");
  eq("an empty list closes the view", nextAfter(before, [], "a.txt"), null);
  // No memory of where it was - the top is the safe answer.
  eq("an unknown position starts at the top", nextAfter([], ["x.txt", "y.txt"], "gone.txt"), "x.txt");
}

console.log(`\n${pass} passed, ${fail} failed`);
// exitCode, not exit(): exit() can abort a queued stdout write on Windows.
if (fail > 0) process.exitCode = 1;
