import { canApplyHunks, hunkPatch } from "../patch.ts";
import type { DiffLine, FileDiff, Hunk } from "../types.ts";

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

const line = (kind: DiffLine["kind"], text: string, noNewline = false): DiffLine => ({
  kind,
  oldNo: null,
  newNo: null,
  text,
  noNewline,
});

const hunk = (over: Partial<Hunk> = {}): Hunk => ({
  oldStart: 10,
  oldCount: 3,
  newStart: 10,
  newCount: 4,
  heading: "",
  lines: [
    line("context", "unchanged before"),
    line("del", "the old line"),
    line("add", "the new line"),
    line("add", "and another"),
    line("context", "unchanged after"),
  ],
  ...over,
});

const diff = (over: Partial<FileDiff> = {}): FileDiff => ({
  path: "src/app.ts",
  oldPath: null,
  binary: false,
  tooLarge: false,
  status: "M",
  hunks: [hunk()],
  whole: false,
  ...over,
});

console.log("hunkPatch");
{
  const text = hunkPatch(diff(), hunk());
  const lines = text.split("\n");
  eq("header names both sides", lines.slice(0, 3), [
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
  ]);
  eq("hunk header carries git's own numbers", lines[3], "@@ -10,3 +10,4 @@");
  eq("body keeps the markers", lines.slice(4, 9), [
    " unchanged before",
    "-the old line",
    "+the new line",
    "+and another",
    " unchanged after",
  ]);
  eq("ends with a newline", text.endsWith("\n"), true);
  eq("and only one", text.endsWith("\n\n"), false);
}

// git writes a one-line range as just its start, and apply accepts both - but
// matching git keeps the patch identical to what it would have produced.
eq(
  "a single-line range drops the count",
  hunkPatch(diff(), hunk({ oldCount: 1, newCount: 1 })).split("\n")[3],
  "@@ -10 +10 @@",
);

eq(
  "a rename patches from the old path to the new",
  hunkPatch(diff({ oldPath: "src/old.ts" }), hunk()).split("\n").slice(0, 3),
  ["diff --git a/src/old.ts b/src/app.ts", "--- a/src/old.ts", "+++ b/src/app.ts"],
);

// Dropping this would silently give the file a trailing newline it never had.
eq(
  "a missing final newline is annotated",
  hunkPatch(diff(), hunk({ lines: [line("del", "last", true), line("add", "last line")] }))
    .split("\n")
    .slice(4, 7),
  ["-last", "\\ No newline at end of file", "+last line"],
);

// CRLF survives because the parser splits on \n only; a patch that dropped the
// \r would not apply to a CRLF file.
eq(
  "carriage returns are preserved",
  hunkPatch(diff(), hunk({ lines: [line("context", "text\r")] })).split("\n")[4],
  " text\r",
);

console.log("canApplyHunks");
eq("an ordinary modification", canApplyHunks(diff()), true);
eq("nothing loaded", canApplyHunks(null), false);
eq("binary", canApplyHunks(diff({ binary: true })), false);
eq("too large to render", canApplyHunks(diff({ tooLarge: true })), false);
eq("whole-file context is one hunk over everything", canApplyHunks(diff({ whole: true })), false);
eq("a newly added file is staged whole", canApplyHunks(diff({ status: "A" })), false);
eq("no hunks at all", canApplyHunks(diff({ hunks: [] })), false);

console.log(`\n${pass} passed, ${fail} failed`);
// exitCode, not exit(): exit() can abort a queued stdout write on Windows.
if (fail > 0) process.exitCode = 1;
