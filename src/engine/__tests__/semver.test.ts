import { compare, isPrerelease, preStream } from "../semver.ts";

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

// --- streams ---------------------------------------------------------------
//
// Two branches can have candidates out at once. Before the prerelease part
// carried a name, the updater compared numbers alone and offered a tester on
// one branch's 0.4.5-rc.1 the other branch's 0.5.1-rc.1 - a different feature
// entirely, and no way to say no.

eq("a named stream", preStream("0.5.1-security.1"), "security");
eq("another", preStream("0.6.0-conflicts.2"), "conflicts");
eq("the historical spelling still reads", preStream("0.4.5-rc.1"), "rc");
eq("a released version has none", preStream("0.5.0"), null);
eq("a bare name", preStream("0.5.1-security"), "security");
eq("a hyphen in the name", preStream("0.5.1-remote-ssh.1"), "remote-ssh");
eq("numeric identifiers only", preStream("0.5.1-1.2"), null);
eq("an empty tail", preStream("0.5.1-"), null);

// Ordering is unchanged by any of this: streams are for filtering, and two
// versions still compare by their numbers first.
eq("streams do not reorder", Math.sign(compare("0.5.1-security.1", "0.4.5-rc.9")), 1);
eq("same stream, later candidate", Math.sign(compare("0.5.1-security.2", "0.5.1-security.1")), 1);
eq("a release still beats its candidate", Math.sign(compare("0.5.1", "0.5.1-security.9")), 1);

console.log(`
${pass} passed, ${fail} failed`);
// exitCode, not exit(): exit() can abort a queued stdout write on Windows.
process.exitCode = fail === 0 ? 0 : 1;
