import { buildGraph, LANE_COLORS, TRUNK_COLOR } from "../graph.ts";

// Lane colouring, and in particular the colour kept for the trunk.
//
// The lane assignment itself is exercised through the app all the time; this
// covers the part that is easy to get subtly wrong and hard to see - which
// lane ends up wearing TRUNK_COLOR, and that nothing else ever does.

const mk = (hash: string, parents: string[]) => ({
  hash,
  parents,
  subject: hash,
  body: "",
  author: "t",
  email: "t",
  date: 0,
  coAuthors: [],
});

let pass = 0,
  fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(
    `${ok ? "  ok  " : " FAIL "} ${name}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`,
  );
  ok ? pass++ : fail++;
};

/** The colour assigned to the row for `hash`. */
const colorOf = (rows: ReturnType<typeof buildGraph>, hash: string) =>
  rows.find((r) => r.hash === hash)?.color ?? -1;

// --- the trunk owns its own lane ---------------------------------------------
//
// topic:  T1 - T2
//                \
// master:          M1 - M2
//
// Newest first, and topic's tip is NOT on master's first-parent line.

{
  const commits = [
    mk("T1", ["T2"]),
    mk("T2", ["M1"]),
    mk("M1", ["M2"]),
    mk("M2", []),
  ];
  const rows = buildGraph(commits, "M1");
  // T1 opens the first lane, and its first-parent chain runs into M1 - so
  // that lane IS master's, and takes master's colour. This is the case the
  // lookahead exists for: coloured naively, T1 would have taken whatever the
  // rotation was on and master's chip would be sitting on it.
  eq("lane reaching the trunk tip gets the trunk colour", colorOf(rows, "T1"), TRUNK_COLOR);
  eq("and keeps it down to the trunk tip", colorOf(rows, "M1"), TRUNK_COLOR);
}

// --- a side branch never gets the trunk colour -------------------------------
//
// Two independent tips over a shared master. Only one lane can carry the
// trunk; the other must be given something else, no matter how many lanes are
// opened before the walk reaches master.

{
  const commits = [
    mk("A1", ["M1"]),
    mk("B1", ["M1"]),
    mk("M1", ["M2"]),
    mk("M2", []),
  ];
  const rows = buildGraph(commits, "M1");
  const a = colorOf(rows, "A1");
  const b = colorOf(rows, "B1");
  eq("first lane to reach the trunk takes its colour", a, TRUNK_COLOR);
  eq("the second does not", b === TRUNK_COLOR, false);
}

// --- an unrelated tip is always off the trunk colour -------------------------
//
// orphan:  O1        (no path to master at all)
// master:  M1 - M2

{
  const commits = [mk("O1", []), mk("M1", ["M2"]), mk("M2", [])];
  const rows = buildGraph(commits, "M1");
  eq("an unrelated root does not take the trunk colour", colorOf(rows, "O1") === TRUNK_COLOR, false);
  eq("the trunk still gets it", colorOf(rows, "M1"), TRUNK_COLOR);
}

// --- the rotation never lands on the reserved colour -------------------------
//
// More tips than there are colours, none of them reaching the trunk: every
// one of them must avoid TRUNK_COLOR, which also proves the rotation wraps
// over the remaining eight rather than all nine.

{
  const commits = [];
  for (let i = 0; i < LANE_COLORS.length + 4; i++) commits.push(mk("R" + String(i), []));
  commits.push(mk("M1", []));
  const rows = buildGraph(commits, "M1");
  const others = rows.filter((r) => r.hash !== "M1").map((r) => r.color);
  eq("no other lane is ever given the trunk colour", others.includes(TRUNK_COLOR), false);
  eq("the trunk is", colorOf(rows, "M1"), TRUNK_COLOR);
  eq("and the rest still use the other eight", new Set(others).size, LANE_COLORS.length - 1);
}

// --- no trunk means no reservation -------------------------------------------
//
// Reserving a colour for a branch that does not exist would cost the graph a
// colour for nothing, so a repository with neither master nor main gets the
// whole palette back.

{
  const commits = [];
  for (let i = 0; i < LANE_COLORS.length; i++) commits.push(mk("R" + String(i), []));
  const rows = buildGraph(commits, "");
  eq(
    "with no trunk the rotation uses every colour",
    new Set(rows.map((r) => r.color)).size,
    LANE_COLORS.length,
  );
}

// --- merging the trunk INTO a topic branch -----------------------------------
//
// topic:  T1 (merge) - T2
//           \
// master:     M1 - M2
//
// T1's second parent is master's tip, so master's lane is opened as an extra
// parent rather than as a branch tip - the other place a colour is handed out.

{
  const commits = [
    mk("T1", ["T2", "M1"]),
    mk("T2", ["M2"]),
    mk("M1", ["M2"]),
    mk("M2", []),
  ];
  const rows = buildGraph(commits, "M1");
  eq("a trunk merged in as a second parent still gets its colour", colorOf(rows, "M1"), TRUNK_COLOR);
  eq("the topic it merged into does not", colorOf(rows, "T1") === TRUNK_COLOR, false);
}

console.log(`\n${pass} passed, ${fail} failed`);
// exitCode, not exit(): exit() can abort a queued stdout write on Windows.
process.exitCode = fail === 0 ? 0 : 1;
