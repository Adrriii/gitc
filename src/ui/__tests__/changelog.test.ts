// The release-notes reader.
//
// Worth testing for one reason above the others: the text comes off a release
// page over the network, and a link in it is the only piece that could carry a
// URL into the window. Everything that is not https has to come out as text.

import { changelogOnly, inlines, parseNotes } from "../changelog.ts";

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

// --- links, which are the part that matters -------------------------------

eq("an https link becomes a link", inlines("see [the commit](https://example.com/a)"), [
  { text: "see " },
  { text: "the commit", href: "https://example.com/a" },
]);

// Anything that is not https keeps its label and loses its target. A release
// page is somebody else's text; javascript: in it must not become clickable.
eq("javascript: is stripped to text", inlines("[click](javascript:alert)"), [{ text: "click" }]);
eq("data: is stripped to text", inlines("[x](data:text/html,<script>)"), [{ text: "x" }]);
eq("http is stripped to text", inlines("[x](http://example.com)"), [{ text: "x" }]);
eq("a relative path is stripped to text", inlines("[x](/api/quit)"), [{ text: "x" }]);

// --- the rest of the grammar ----------------------------------------------

eq("code spans", inlines("run `npm test` now"), [
  { text: "run " },
  { text: "npm test", code: true },
  { text: " now" },
]);
eq("bold", inlines("**Fixed** it"), [{ text: "Fixed", bold: true }, { text: " it" }]);
eq("plain text is one piece", inlines("nothing special here"), [
  { text: "nothing special here" },
]);

// A stray bracket is not a link and must not eat the rest of the line.
eq("an unclosed link stays text", inlines("[not a link"), [{ text: "[not a link" }]);

// --- block structure ------------------------------------------------------

const notes = [
  "## New Features",
  "",
  "- Amend a commit ([a1b2c3](https://example.com/c/a1b2c3))",
  "  - a nested note",
  "",
  "### Internal",
  "some prose",
  "",
  "",
].join("\n");

eq(
  "kinds and depths",
  parseNotes(notes).map((l) => `${l.kind}${l.depth}`),
  ["heading2", "blank0", "bullet0", "bullet1", "blank0", "heading3", "text0"],
);

eq("a bullet keeps its link", parseNotes(notes)[2].pieces, [
  { text: "Amend a commit (" },
  { text: "a1b2c3", href: "https://example.com/c/a1b2c3" },
  { text: ")" },
]);

// Trailing blanks would draw a gap under the last entry.
eq("trailing blanks are dropped", parseNotes("a\n\n\n").length, 1);

// Windows line endings arrive from the API as-is on some paths.
eq(
  "CRLF is handled",
  parseNotes("## One\r\n\r\n- two\r\n").map((l) => l.kind),
  ["heading", "blank", "bullet"],
);

eq("an empty body is no lines", parseNotes(""), []);

// The notes are hard-wrapped, so most entries span two or three lines. Each
// continuation belongs to the bullet above it, not to a paragraph of its own.
{
  const wrapped = parseNotes(
    [
      "- **A Thing**: the first line of it",
      "  and the rest of the sentence",
      "  ([abc](https://example.com/c/abc))",
    ].join("\n"),
  );
  eq("a wrapped bullet stays one bullet", wrapped.length, 1);
  eq(
    "the continuation is folded in",
    wrapped[0].pieces.map((p) => p.text).join(""),
    "A Thing: the first line of it and the rest of the sentence (abc)",
  );
  eq(
    "the commit link survives the fold",
    wrapped[0].pieces.some((p) => p.href === "https://example.com/c/abc"),
    true,
  );
}

// A nested bullet is still a bullet, not a continuation.
eq(
  "a nested bullet is not folded in",
  parseNotes(["- one", "  - two"].join("\n")).map((l) => `${l.kind}${l.depth}`),
  ["bullet0", "bullet1"],
);

// --- the changelog out of a release body ----------------------------------

// A release opens with the workflow's download instructions, not with its
// notes. None of that is what changed in the version.
const release = [
  "Download the file for your system and run it.",
  "",
  "| System | File |",
  "| ------ | ---- |",
  "",
  "**Full Changelog**: https://example.com/compare/v1...v2",
  "",
  "## New Features",
  "",
  "- Something ([abc](https://example.com/c/abc))",
  "",
  "## Known Limits",
  "",
  "- Still Linux only.",
].join("\n");

eq("the preamble is dropped", changelogOnly(release).split("\n")[0], "## New Features");
eq("the sections are kept", changelogOnly(release).includes("## Known Limits"), true);
eq("the download table is gone", changelogOnly(release).includes("| System |"), false);
eq("the Full Changelog link is gone", changelogOnly(release).includes("Full Changelog"), false);

// GitHub appends its own list of commit titles below the written notes, which
// is the thing the written notes exist to replace.
eq(
  "GitHub's own list is cut off",
  changelogOnly("## Real\n\n- a\n\n## What's Changed\n\n- raw commit"),
  "## Real\n\n- a",
);

eq("a release with no sections has no changelog", changelogOnly("just some prose"), "");
eq("an empty body is empty", changelogOnly(""), "");

console.log(`
${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
