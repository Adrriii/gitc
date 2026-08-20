import { commandType } from "../gitCommand.ts";

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

console.log("commandType");
eq("a bare command", commandType("status"), "status");
eq("a command with flags", commandType("log --branches --tags HEAD"), "log");
eq("flags are not the command", commandType("--exclude=topic --branches"), "--exclude=topic --branches");
eq("a leading flag is skipped", commandType("-C /repo status"), "/repo");
eq("a subcommand's own word", commandType("stash list"), "stash");
eq("hyphenated commands", commandType("name-rev --name-only HEAD"), "name-rev");
eq("empty", commandType(""), "");

// What the engine actually records, so the hiding preference matches the rows
// people are looking at when they hide one.
console.log("as recorded by the engine");
eq("the graph walk", commandType("log --exclude=topic --branches --tags --remotes HEAD --topo-order"), "log");
eq("the watch poll", commandType("status"), "status");
eq("a fetch", commandType("fetch --all --prune"), "fetch");
eq("a commit's files", commandType("show --name-status -m --first-parent abc123"), "show");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
