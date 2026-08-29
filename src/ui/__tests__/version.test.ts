import { bump, meets, shouldPrompt } from "../version.ts";

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

eq("a patch step", bump("0.4.3", "0.4.4"), "patch");
eq("a minor step", bump("0.4.3", "0.5.0"), "minor");
eq("a major step", bump("0.4.3", "1.0.0"), "major");

// The reason this is numeric rather than a string comparison.
eq("0.10.0 is newer than 0.9.0", bump("0.9.0", "0.10.0"), "minor");
eq("0.4.10 is newer than 0.4.9", bump("0.4.9", "0.4.10"), "patch");

eq("the same version is not an update", bump("0.4.3", "0.4.3"), null);
eq("older is not an update", bump("0.4.3", "0.4.2"), null);
eq("older by a major is not an update", bump("1.0.0", "0.9.9"), null);

eq("a leading v is tolerated", bump("v0.4.3", "v0.5.0"), "minor");
eq("missing components read as zero", bump("1", "1.0.1"), "patch");
eq("nothing to compare against", bump("", "0.4.4"), null);
eq("a prerelease is not a version", bump("0.4.3", "0.5.0-rc1"), null);

// The biggest differing component wins, not the number of changes.
eq("major wins over the rest", bump("0.4.3", "2.9.9"), "major");
eq("minor wins over patch", bump("0.4.3", "0.6.1"), "minor");

eq("patch threshold takes a patch", meets("patch", "patch"), true);
eq("minor threshold refuses a patch", meets("patch", "minor"), false);
eq("minor threshold takes a minor", meets("minor", "minor"), true);
eq("minor threshold takes a major", meets("major", "minor"), true);
eq("major threshold refuses a minor", meets("minor", "major"), false);
eq("major threshold takes a major", meets("major", "major"), true);

eq("default threshold prompts for a patch", shouldPrompt("0.4.3", "0.4.4", "patch"), true);
eq("features threshold stays quiet on a patch", shouldPrompt("0.4.3", "0.4.4", "minor"), false);
eq("features threshold speaks up on a minor", shouldPrompt("0.4.3", "0.5.0", "minor"), true);
eq("nothing newer, nothing to say", shouldPrompt("0.4.3", "0.4.3", "patch"), false);

// A test build hears about the next one whatever the threshold says: rc.1 to
// rc.2 has no bump level to measure, and running an rc is already a choice to
// be interrupted.
eq(
  "rc to rc prompts even on the strictest threshold",
  shouldPrompt("0.5.0-rc.1", "0.5.0-rc.2", "major"),
  true,
);
eq("rc to its release prompts", shouldPrompt("0.5.0-rc.2", "0.5.0", "major"), true);
eq("the same rc does not", shouldPrompt("0.5.0-rc.1", "0.5.0-rc.1", "patch"), false);
eq("a stable user is unaffected by the rule", shouldPrompt("0.4.3", "0.4.4", "minor"), false);

console.log(`\n${pass} passed, ${fail} failed`);
// exitCode, not exit(): exit() can abort a queued stdout write on Windows.
process.exitCode = fail === 0 ? 0 : 1;
