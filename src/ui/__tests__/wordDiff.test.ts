import { tokenize, wordDiff, pairRuns } from "../wordDiff.ts";
import { markHtml } from "../markHtml.ts";

let pass = 0,
  fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(
    `${ok ? "  ok  " : " FAIL "} ${name}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`,
  );
  ok ? pass++ : fail++;
};

/** The marked text, which is what the reader actually sees. */
const marks = (line: string, spans: { start: number; end: number }[]) =>
  spans.map((s) => line.substring(s.start, s.end));

console.log("tokenize");
eq("words, spaces and punctuation are separate units", tokenize("a b.c").map((t) => t.end - t.start), [1, 1, 1, 1, 1]);
eq("a run of spaces is one unit", tokenize("a   b").length, 3);
eq("identifiers hold together", tokenize("someName++").map((t) => t.end - t.start), [8, 1, 1]);

console.log("wordDiff");
{
  const d = wordDiff("const timeout = 30;", "const timeout = 60;");
  eq("one changed number, before", marks("const timeout = 30;", d.before), ["30"]);
  eq("one changed number, after", marks("const timeout = 60;", d.after), ["60"]);
}
{
  const d = wordDiff("call(a, b)", "call(a, c)");
  eq("a changed argument is not confetti", marks("call(a, c)", d.after), ["c"]);
}
{
  const a = "the quick brown fox";
  const b = "the slow brown cat";
  const d = wordDiff(a, b);
  eq("two separate edits stay separate", marks(a, d.before), ["quick", "fox"]);
  eq("and on the other side too", marks(b, d.after), ["slow", "cat"]);
}
{
  const d = wordDiff("same", "same");
  eq("identical lines mark nothing", [d.before, d.after], [[], []]);
}
{
  const a = "aaa";
  const b = "zzz";
  const d = wordDiff(a, b);
  eq("nothing in common marks the whole of each", [marks(a, d.before), marks(b, d.after)], [["aaa"], ["zzz"]]);
}
{
  const a = "x = 1";
  const b = "x = 1 + extra";
  const d = wordDiff(a, b);
  eq("a pure insertion marks nothing on the removed side", d.before, []);
  eq("and marks the inserted tail on the added side", marks(b, d.after).join(""), " + extra");
}
{
  // The brackets are common to both, so they stay unmarked and the two
  // changed tokens are reported apart - marking through the "(" would claim
  // it changed.
  const a = "value(1)";
  const b = "other(2)";
  const d = wordDiff(a, b);
  eq("shared punctuation is not swallowed", marks(a, d.before), ["value", "1"]);
}
{
  // Here the unmatched tokens really are consecutive - "1", " ", "+", " " -
  // and four marks in a row would read as four separate edits.
  const a = "x = 1 + 2";
  const b = "x = 2";
  const d = wordDiff(a, b);
  eq("a run of adjacent marks becomes one", marks(a, d.before), ["1 + "]);
}

console.log("pairRuns");
{
  const L = (kind: string, id: string) => ({ kind, id });
  const del1 = L("del", "d1"), del2 = L("del", "d2");
  const add1 = L("add", "a1"), add2 = L("add", "a2");
  const ctx = L("context", "c");
  const pairs = pairRuns([ctx, del1, del2, add1, add2, ctx]);
  eq("removed lines pair with added ones in order", [pairs.get(del1)?.id, pairs.get(del2)?.id], ["a1", "a2"]);
  eq("and the pairing goes both ways", [pairs.get(add1)?.id, pairs.get(add2)?.id], ["d1", "d2"]);
}
{
  const L = (kind: string, id: string) => ({ kind, id });
  const d1 = L("del", "d1");
  const a1 = L("add", "a1"), a2 = L("add", "a2");
  const pairs = pairRuns([d1, a1, a2]);
  eq("an unmatched extra line is left unpaired", [pairs.get(d1)?.id, pairs.get(a2)], ["a1", undefined]);
}
{
  const L = (kind: string, id: string) => ({ kind, id });
  const d1 = L("del", "d1"), a1 = L("add", "a1");
  const pairs = pairRuns([L("add", "x"), d1, a1]);
  eq("an addition before any removal pairs with nothing", pairs.get(L("add", "x")), undefined);
  eq("the real pair still forms", pairs.get(d1)?.id, "a1");
}

console.log("markHtml");
eq(
  "plain text is wrapped at the right characters",
  markHtml("const x = 30;", [{ start: 10, end: 12 }], "w"),
  'const x = <mark class="w">30</mark>;',
);
eq(
  "a mark that straddles a tag closes and reopens rather than nesting badly",
  markHtml('a<span class="k">bc</span>d', [{ start: 0, end: 4 }], "w"),
  '<mark class="w">a</mark><span class="k"><mark class="w">bc</mark></span><mark class="w">d</mark>',
);
eq(
  "an entity counts as one character of text",
  markHtml("a &amp; b", [{ start: 2, end: 3 }], "w"),
  'a <mark class="w">&amp;</mark> b',
);
eq("no spans leaves the html untouched", markHtml('<span class="k">x</span>', [], "w"), '<span class="k">x</span>');
eq(
  "two spans in one line",
  markHtml("ab cd ef", [{ start: 0, end: 2 }, { start: 6, end: 8 }], "w"),
  '<mark class="w">ab</mark> cd <mark class="w">ef</mark>',
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
