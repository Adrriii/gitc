import { compare, preStream } from "../semver.ts";

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

/**
 * What check() offers, as a function of what is published.
 *
 * The selection rule lives in update.ts, which cannot be imported here - it
 * reaches install.ts and from there generated/icons.ts, which does not exist
 * until the build has run (the same reason semver.ts was split out). So the
 * rule is restated, and these assertions pin the behaviour it has to keep.
 */
function offered(published: string[], running: string, stream: string): string {
  let best = "";
  for (const version of published) {
    const s = preStream(version);
    if (s !== null && (stream.length === 0 || s !== stream)) continue;
    if (best.length === 0 || compare(version, best) > 0) best = version;
  }
  return compare(best, running) > 0 ? best : "";
}

// What was actually published the day this was written, plus a second line of
// development to stand for the case that caused it.
const FEED = [
  "0.6.0-conflicts.1",
  "0.5.1-security.2",
  "0.5.1-security.1",
  "0.5.0",
  "0.4.5-remote-ssh.1",
  "0.4.4",
];

// The bug, in one assertion. Comparing numbers alone, a tester on the
// remote-ssh line was offered 0.6.0-conflicts.1 - the highest number in the
// feed, a different feature, and no way to decline it. What they get instead
// is 0.5.0: the ordinary release, which is where their own line's work
// actually shipped.
eq(
  "the highest number is not what you are offered",
  offered(FEED, "0.4.5-remote-ssh.1", "remote-ssh"),
  "0.5.0",
);

// Following a line means moving along it, and nowhere else.
eq("the next candidate on your own line", offered(FEED, "0.5.1-security.1", "security"), "0.5.1-security.2");
eq("and nothing beyond it", offered(FEED, "0.5.1-security.2", "security"), "");
eq("the conflicts line moves on its own", offered(FEED, "0.5.0", "conflicts"), "0.6.0-conflicts.1");

// An ordinary release is always offered, whichever line you follow. It is the
// only way off a stream, and the way a tester rejoins everybody else once the
// work ships.
eq(
  "a release supersedes the line you are on",
  offered(["0.5.1", "0.5.1-security.2", "0.5.0"], "0.5.1-security.2", "security"),
  "0.5.1",
);
eq(
  "a line with nothing newer on it offers nothing",
  offered(["0.4.5-remote-ssh.1", "0.4.4"], "0.4.5-remote-ssh.1", "remote-ssh"),
  "",
);

// Following nothing means candidates are not offered at all, which is what a
// released build gets until somebody picks a line.
eq("no stream, no candidates", offered(FEED, "0.5.0", ""), "");
eq("no stream still takes a release", offered(["0.5.1", "0.5.0"], "0.5.0", ""), "0.5.1");

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
