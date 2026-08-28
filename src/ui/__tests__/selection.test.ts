import { rangeSelect, toggleSelect, chainBetween } from "../selection.ts";

// Newest-first, like the graph. A(0) is newest.
// main:    A - B - C - D - E          (first-parent line)
// feature:      F - G  merged into B  (B's second parent is F)
const mk = (hash: string, parents: string[]) =>
  ({
    hash,
    parents,
    subject: hash,
    body: "",
    author: "t",
    email: "t",
    date: 0,
    lane: 0,
    color: 0,
    refs: [],
    coAuthors: [],
  });

const commits = [
  mk("A", ["B"]),
  mk("B", ["C", "F"]),   // merge commit
  mk("F", ["G"]),
  mk("G", ["C"]),
  mk("C", ["D"]),
  mk("D", ["E"]),
  mk("E", []),
];

let pass = 0, fail = 0;
const eq = (name: string, got: string[], want: string[]) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// contiguous run down the first-parent line
eq("A..D is one branch", rangeSelect(commits, "A", "D"), ["A", "B", "C", "D"]);
eq("clicked older first (D anchor, A target)", rangeSelect(commits, "D", "A"), ["A", "B", "C", "D"]);
eq("single commit", rangeSelect(commits, "C", "C"), ["C"]);

// F/G are on a side branch: not reachable by first parents from A
eq("A..G crosses branches -> just G", rangeSelect(commits, "A", "G"), ["G"]);
eq("F..E crosses back onto main", rangeSelect(commits, "F", "E"), ["F", "G", "C", "D", "E"]);

// sticky anchor behaviour: anchor A, then extend further each time
eq("anchor A -> C", rangeSelect(commits, "A", "C"), ["A", "B", "C"]);
eq("anchor A -> E (not C->E)", rangeSelect(commits, "A", "E"), ["A", "B", "C", "D", "E"]);

// ctrl-click contiguity
eq("extend run by one below", toggleSelect(commits, ["A", "B"], "C"), ["A", "B", "C"]);
eq("extend run by one above", toggleSelect(commits, ["B", "C"], "A"), ["A", "B", "C"]);
eq("deselect an end shrinks", toggleSelect(commits, ["A", "B", "C"], "C"), ["A", "B"]);
eq("deselect a middle resets", toggleSelect(commits, ["A", "B", "C"], "B"), ["B"]);
eq("non-adjacent replaces", toggleSelect(commits, ["A", "B"], "E"), ["E"]);

console.log(`\n${pass} passed, ${fail} failed`);
// exitCode, not exit(): exit() can abort a queued stdout write on Windows.
process.exitCode = fail === 0 ? 0 : 1;
