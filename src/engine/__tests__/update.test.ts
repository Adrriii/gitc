import { compare, isPrerelease } from "../update.ts";

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

/** -1, 0, 1 rather than the raw difference, which is what callers compare. */
const cmp = (a: string, b: string) => Math.sign(compare(a, b));

eq("newer patch", cmp("0.4.5", "0.4.4"), 1);
eq("older patch", cmp("0.4.4", "0.4.5"), -1);
eq("equal", cmp("0.4.4", "0.4.4"), 0);

// The reason this is not a string comparison.
eq("0.10.0 beats 0.9.0", cmp("0.10.0", "0.9.0"), 1);
eq("0.4.10 beats 0.4.9", cmp("0.4.10", "0.4.9"), 1);

// Semver: a version WITH a prerelease is older than the same one without.
// Getting this wrong made rc.1, rc.2 and the release all compare equal, so a
// tester was never offered any of them.
eq("a candidate is older than its release", cmp("0.5.0-rc.1", "0.5.0"), -1);
eq("and the release is newer than it", cmp("0.5.0", "0.5.0-rc.1"), 1);
eq("candidates order among themselves", cmp("0.5.0-rc.2", "0.5.0-rc.1"), 1);
eq("numerically, not as text", cmp("0.5.0-rc.10", "0.5.0-rc.9"), 1);
eq("the same candidate", cmp("0.5.0-rc.1", "0.5.0-rc.1"), 0);

// A candidate is for the version NEXT: 0.4.5-rc.1 must beat the release it
// follows, or a tester is offered the version their build supersedes.
eq("a candidate beats the previous release", cmp("0.4.5-rc.1", "0.4.4"), 1);
eq("but not the one it precedes", cmp("0.4.5-rc.1", "0.4.5"), -1);

// A shorter run of otherwise equal identifiers is the older one.
eq("rc is older than rc.1", cmp("0.5.0-rc", "0.5.0-rc.1"), -1);

eq("a release is not a prerelease", isPrerelease("0.4.4"), false);
eq("a candidate is", isPrerelease("0.5.0-rc.1"), true);

console.log(`\n${pass} passed, ${fail} failed`);
// exitCode, not exit(): exit() can abort a queued stdout write on Windows.
process.exitCode = fail === 0 ? 0 : 1;
