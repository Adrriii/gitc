import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

const home = mkdtempSync(join(tmpdir(), "gitc-ai-test-"));
mkdirSync(join(home, "gitc"), { recursive: true });
process.env["APPDATA"] = home;

const { loadAi, saveAi, masked, maskKey, parseConfig, providerFor, parseReply, trimDiff, buildPrompt, claudeHome, providerFromJson } =
  await import("../ai.ts");

const provider = (id: string, key = "") => ({
  id,
  name: id,
  kind: "openai",
  baseUrl: "https://openrouter.ai/api/v1",
  key,
  model: "m",
  account: "",
});

// --- store ---------------------------------------------------------------

eq("no file means AI off, with every feature ready for when it is on", loadAi(), {
  enabled: false,
  features: ["commitMessage", "explainCommit", "branchName", "squashMessage", "conflictAssist"],
  providers: [],
  defaultId: "",
  repos: [],
});

eq("a malformed file reads as the default", parseConfig("{nope").enabled, false);
eq(
  "an older file missing fields gets them filled",
  parseConfig('{"enabled":true,"providers":[{"id":"a","kind":"anthropic"}]}'),
  {
    enabled: true,
    features: ["commitMessage", "explainCommit", "branchName", "squashMessage", "conflictAssist"],
    providers: [{ id: "a", name: "", kind: "anthropic", baseUrl: "", key: "", model: "", account: "" }],
    defaultId: "",
    repos: [],
  },
);
eq(
  "an unknown kind is dropped",
  parseConfig('{"providers":[{"id":"a","kind":"gemini"}]}').providers.length,
  0,
);

writeFileSync(join(home, "gitc", "ai.json"), "garbage", "utf8");
eq("a garbage file on disk reads as the default", loadAi().providers.length, 0);

// --- keys ----------------------------------------------------------------

const secret = "sk-or-v1-0123456789abcdef";
eq("a long key is masked", maskKey(secret), "sk-or-...cdef");
eq("a short key is fully masked", maskKey("short"), "...");
eq("an environment reference is shown as written", maskKey("$OPENROUTER_API_KEY"), "$OPENROUTER_API_KEY");

const saved = saveAi({
  enabled: true,
  features: ["commitMessage"],
  providers: [provider("a", secret), provider("b")],
  defaultId: "a",
  repos: [],
});
eq("the window only ever sees the mask", masked(saved).providers[0]?.key, "sk-or-...cdef");

const resent = masked(loadAi());
resent.providers[1]!.name = "renamed";
saveAi(resent);
eq("a key sent back masked keeps the stored key", loadAi().providers[0]?.key, secret);
eq("and the other edit lands", loadAi().providers[1]?.name, "renamed");

const replaced = masked(loadAi());
replaced.providers[0]!.key = "sk-new-key-0000000000";
saveAi(replaced);
eq("a key typed over the mask replaces it", loadAi().providers[0]?.key, "sk-new-key-0000000000");

// --- resolution ----------------------------------------------------------

const config = {
  enabled: true,
  features: ["commitMessage"],
  providers: [provider("a"), provider("b"), provider("c")],
  defaultId: "b",
  repos: [
    { host: "", path: "/r1", providerId: "c" },
    { host: "", path: "/r2", providerId: "gone" },
  ],
};
eq("a pinned repo uses its provider", providerFor(config, "", "/r1")?.id, "c");
eq("the same path on a remote is a different repo", providerFor(config, "server", "/r1")?.id, "b");
eq("pinned to a removed provider falls back to the default", providerFor(config, "", "/r2")?.id, "b");
eq("a removed default falls back to the first", providerFor({ ...config, defaultId: "x" }, "", "/z")?.id, "a");
eq("no providers means none", providerFor({ ...config, providers: [] }, "", "/r1"), undefined);

const pruned = saveAi({ ...config, defaultId: "x" });
eq("saving repairs a dangling default", pruned.defaultId, "a");
eq("and drops repos pinned to nothing", pruned.repos.length, 1);

// --- Claude Code accounts --------------------------------------------------

eq("this machine's sign-in needs no folder", claudeHome("abc", ""), "");
eq("a separate account lives under gitc's settings", claudeHome("abc123", "own"), join(home, "gitc", "claude", "abc123"));
eq("an id that could leave that folder is refused", claudeHome("../x", "own"), undefined);
eq("an empty id is refused", claudeHome("", "own"), undefined);
eq("a provider sent by the window is read field by field", providerFromJson('{"id":"q","kind":"openai"}')?.account, "");
eq("garbage is not a provider", providerFromJson("{nope"), undefined);

// --- replies -------------------------------------------------------------

eq("subject and body", parseReply("Fix the thing\n\nIt was broken."), {
  summary: "Fix the thing",
  description: "It was broken.",
});
eq("a fenced reply", parseReply("```\nFix the thing\n\nBody\n```"), { summary: "Fix the thing", description: "Body" });
eq("a fenced reply with a language", parseReply("```text\nFix it\n```"), { summary: "Fix it", description: "" });
eq("a quoted reply", parseReply('"Fix the thing"'), { summary: "Fix the thing", description: "" });
eq("CRLF and leading blank lines", parseReply("\r\n\r\nFix it\r\n\r\nLine one\r\nLine two"), {
  summary: "Fix it",
  description: "Line one\nLine two",
});
eq("nothing", parseReply("   "), { summary: "", description: "" });

// --- prompt --------------------------------------------------------------

const section = (path: string, body: string) =>
  `diff --git a/${path} b/${path}\nindex 1..2 100644\n--- a/${path}\n+++ b/${path}\n${body}\n`;
const diff =
  section("src/a.ts", "+one") +
  section("package-lock.json", "+lots") +
  `diff --git a/logo.png b/logo.png\nindex 1..2 100644\nBinary files a/logo.png and b/logo.png differ\n` +
  section("src/big.ts", "+" + "x".repeat(500));
const numstat = "1\t0\tsrc/a.ts\n900\t20\tpackage-lock.json\n-\t-\tlogo.png\n1\t0\tsrc/big.ts\n";

const trimmed = trimDiff(diff, numstat, 200);
eq("a small file is kept whole", trimmed.includes("+one"), true);
eq("a lock file is one line with its counts", trimmed.includes("package-lock.json (lock file, +900 -20)"), true);
eq("its contents are not", trimmed.includes("+lots"), false);
eq("a binary is one line", trimmed.includes("logo.png (binary)"), true);
eq("past the cap a file is listed with its counts", trimmed.includes("left out for length:\nsrc/big.ts +1 -0"), true);
eq("and its contents are not", trimmed.includes("xxxxx"), false);

eq("text outside any diff section is kept", trimDiff("New file: README.md\nhello\n", "", 200), "New file: README.md\nhello\n");

const prompt = buildPrompt({ diff, numstat, recent: ["Add a thing\n\nBecause.", "", "Fix x"] }, "fix login");
eq("the prompt carries the examples", prompt.includes("Add a thing\n\nBecause.\n\n-----\n\nFix x"), true);
eq("and the hint", prompt.includes("fix login"), true);
eq(
  "no hint, no hint section",
  buildPrompt({ diff, numstat, recent: [] }, "  ").includes("author's own note"),
  false,
);

rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
