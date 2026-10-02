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

const { parsePicks, branchSlug, conflictPrompt } = await import("../aiTasks.ts");

const hunk = (ours: string[], theirs: string[]) => ({ ours, theirs, base: null, before: [], after: [] });
const two = [hunk(["a1", "a2", "a3"], ["b1", "b2"]), hunk(["x"], ["y"])];

// --- picks ---------------------------------------------------------------

eq("line numbers become picks, 0-based", parsePicks("1: A 1,3 B 2\n2: A none B 1", two), [
  { ours: [0, 2], theirs: [1] },
  { ours: [], theirs: [0] },
]);
eq("ranges", parsePicks("1: A 1-3 B none", two)[0], { ours: [0, 1, 2], theirs: [] });
eq("a reason is kept when it declines", parsePicks("1: unresolved both sides rename the same call\n2: A 1 B 1", two)[0], {
  reason: "both sides rename the same call",
});
eq("a missing answer is no suggestion", parsePicks("1: A 1 B none", two)[1], { reason: "no suggestion for this conflict" });
eq("a line the conflict does not have is refused", parsePicks("1: A 4 B none", two)[0], {
  reason: "the suggestion named lines this conflict does not have",
});
eq("keeping nothing is refused", parsePicks("1: A none B none", two)[0], { reason: "it would keep nothing from either side" });
eq("chatter around the answer is tolerated", parsePicks("Conflict 2: A 1, B none\nThanks!", two)[1], { ours: [0], theirs: [] });
eq("unreadable is said so", parsePicks("1: take the first one", two)[0], { reason: "the suggestion could not be read" });
eq("the first answer for a conflict wins", parsePicks("1: A 1 B none\n1: A 2 B none", two)[0], { ours: [0], theirs: [] });

// --- branch names ----------------------------------------------------------

eq("a plain name", branchSlug("feature/ai-commit-messages"), "feature/ai-commit-messages");
eq("spaces and case", branchSlug("Fix Login Redirect"), "fix-login-redirect");
eq("quotes and stray characters go", branchSlug("`fix/login: redirect!`"), "fix/login-redirect");
eq("no leading or trailing separators", branchSlug("/-feature/x-/"), "feature/x");
eq("no double dots or slashes", branchSlug("a..b//c"), "a.b/c");
eq("not ending in .lock", branchSlug("refs.lock"), "refs");
eq("long names are cut", branchSlug("x".repeat(80)).length, 60);

// --- prompt --------------------------------------------------------------

const prompt = conflictPrompt("src/a.ts", two);
eq("each side is numbered", prompt.includes("Side A:\n1| a1\n2| a2\n3| a3"), true);
eq("both conflicts are there", prompt.includes("Conflict 2"), true);
const huge = [hunk(["z".repeat(70000)], ["y"]), hunk(["x"], ["y"])];
eq("past the cap the rest is left out, and said so", conflictPrompt("f", huge).includes("Conflicts 1 to 2 are left out"), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
