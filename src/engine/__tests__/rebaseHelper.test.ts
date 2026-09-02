// The todo list gitc writes into somebody else's rebase.
//
// Worth testing on its own because nothing else can see it: git runs this as a
// separate process, in the middle of a rebase, and a wrong line here is a
// silently different history rather than an error.

import { rewriteTodo } from "../rebaseHelper.ts";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

const sandbox = mkdtempSync(join(tmpdir(), "gitc-rebase-"));

/** Runs rewriteTodo over one todo list and returns the lines it wrote. */
function run(command: string, hashes: string[], todo: string[]): string[] {
  const spec = join(sandbox, "spec.txt");
  const list = join(sandbox, "todo.txt");
  writeFileSync(spec, [command].concat(hashes).join("\n"), "utf8");
  writeFileSync(list, todo.join("\n"), "utf8");
  rewriteTodo(spec, list);
  return readFileSync(list, "utf8").split("\n");
}

// A todo list as git writes one: the picks, then a blank line, then the help
// it appends at the bottom.
const TODO = [
  "pick aaaaaaa first",
  "pick bbbbbbb second",
  "pick ccccccc third",
  "",
  "# Rebase 000000..ccccccc onto 000000 (3 commands)",
  "# p, pick <commit> = use commit",
];

// --- squash ---------------------------------------------------------------

eq(
  "squash marks the named commits",
  run("squash", ["aaaaaaa", "bbbbbbb"], TODO).filter((l) => !l.startsWith("exec")).slice(0, 3),
  ["squash aaaaaaa first", "squash bbbbbbb second", "pick ccccccc third"],
);

// The commit a squash produces keeps the OLDEST commit's author date, which is
// not when the collapsed history came to exist - hence the redate, and hence
// it going in as an exec right after the last fold rather than at the end.
eq(
  "squash redates, right after the last fold",
  run("squash", ["aaaaaaa"], TODO).slice(0, 3),
  ["squash aaaaaaa first", "exec git commit --amend --no-edit --date=now", "pick bbbbbbb second"],
);

// --- drop and reword ------------------------------------------------------

eq("drop marks only the named commits", run("drop", ["bbbbbbb"], TODO).slice(0, 3), [
  "pick aaaaaaa first",
  "drop bbbbbbb second",
  "pick ccccccc third",
]);

// A reword renames a commit that already exists; redating it would be a lie
// about when the work happened, and a drop creates no commit to date at all.
eq(
  "no redate for a reword",
  run("reword", ["bbbbbbb"], TODO).filter((l) => l.startsWith("exec")),
  [],
);
eq(
  "no redate for a drop",
  run("drop", ["bbbbbbb"], TODO).filter((l) => l.startsWith("exec")),
  [],
);

// --- what must survive untouched ------------------------------------------

// git explains its own todo format at the bottom of the file. Mangling that
// helps nobody debugging a stuck rebase.
eq("comments and blank lines pass through", run("drop", ["bbbbbbb"], TODO).slice(3), [
  "",
  "# Rebase 000000..ccccccc onto 000000 (3 commands)",
  "# p, pick <commit> = use commit",
]);

// A todo lists abbreviated hashes while the UI sends full ones, so matching
// has to work with the two at different lengths.
eq(
  "a full hash matches an abbreviated todo line",
  run("drop", ["bbbbbbbffffffffffffffffffffffffffffffffff"], TODO).slice(0, 3),
  ["pick aaaaaaa first", "drop bbbbbbb second", "pick ccccccc third"],
);

// The spec is written by ops.ts and read by a second process. One truncated
// half-way, or written by something else, must not be guessed at: an unchanged
// todo replays the run as it stands, which is the only harmless answer.
eq("an unknown command changes nothing", run("edit", ["bbbbbbb"], TODO), TODO);
eq("an empty spec changes nothing", run("", [], TODO), TODO);

// Nothing in the run matched - a stale hash, or a rebase that turned out to
// span different commits than the UI thought. Leaving every line a pick means
// the rebase is a no-op replay rather than a rewrite of the wrong commits.
eq("no match leaves every line a pick", run("drop", ["9999999"], TODO), TODO);

rmSync(sandbox, { recursive: true, force: true });

console.log(`
${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
