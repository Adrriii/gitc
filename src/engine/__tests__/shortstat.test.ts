import { parseShortstat } from "../git.ts";

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

eq("both counts", parseShortstat(" 3 files changed, 10 insertions(+), 2 deletions(-)\n"), {
  added: 10,
  removed: 2,
});
eq("singular", parseShortstat(" 1 file changed, 1 insertion(+), 1 deletion(-)\n"), {
  added: 1,
  removed: 1,
});
// git drops a count that is zero rather than printing it.
eq("only insertions", parseShortstat(" 1 file changed, 4 insertions(+)\n"), { added: 4, removed: 0 });
eq("only deletions", parseShortstat(" 2 files changed, 7 deletions(-)\n"), { added: 0, removed: 7 });
// A pure rename or a binary file: files changed, no lines.
eq("no lines", parseShortstat(" 1 file changed\n"), { added: 0, removed: 0 });
eq("nothing changed", parseShortstat(""), { added: 0, removed: 0 });
// The file count must not be read as either side.
eq("files are not lines", parseShortstat(" 12 files changed, 3 deletions(-)"), { added: 0, removed: 3 });

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail > 0 ? 1 : 0;
