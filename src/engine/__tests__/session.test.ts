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

// loadSession reads its path from the environment, so the whole test runs
// against a directory of its own rather than the real session.
const home = mkdtempSync(join(tmpdir(), "gitc-session-test-"));
mkdirSync(join(home, "gitc"), { recursive: true });
process.env["APPDATA"] = home;

const { loadSession } = await import("../../state.ts");

/**
 * The session that caused "spawn git ENOENT" on a healthy repository.
 *
 * A remote engine keeps its own session between connections and the client
 * chooses the ids, so it can be asked for an id it already has against a
 * different repository. Both tabs went into the list; findTab takes the first
 * match, so every request for t7 ran git in the older one - which by then had
 * been deleted, and a missing cwd is reported by Node as though git itself
 * were missing.
 */
writeFileSync(
  join(home, "gitc", "session.json"),
  JSON.stringify({
    tabs: [
      { id: "t4", name: "dex", path: "/main/dex", host: null },
      { id: "t7", name: "old", path: "/home/adri/deleted", host: null },
      { id: "t7", name: "collector", path: "/main/osu/farm/collector", host: null },
    ],
    activeId: "t7",
    // Newest first, which is the opposite order to tabs.
    recents: [
      { id: "t7", name: "collector", path: "/main/osu/farm/collector", host: null },
      { id: "t7", name: "old", path: "/home/adri/deleted", host: null },
      { id: "t4", name: "dex", path: "/main/dex", host: null },
    ],
  }),
  "utf8",
);

const session = loadSession();

eq("one tab per id", session.tabs.length, 2);
eq(
  "the live repository is the one kept",
  session.tabs.filter((t) => t.id === "t7").map((t) => t.path),
  ["/main/osu/farm/collector"],
);
eq("other tabs are untouched", session.tabs[0].path, "/main/dex");

// findTab takes the first match, so "the first t7 is the right t7" is the
// property that actually matters.
eq(
  "the first match for the id is the live one",
  session.tabs.find((t) => t.id === "t7")?.path,
  "/main/osu/farm/collector",
);

// Recents run newest-first, so the FIRST entry is the live one - the opposite
// rule to tabs, and getting it backwards keeps the stale path.
eq(
  "recents keep the newest, not the oldest",
  session.recents.filter((t) => t.id === "t7").map((t) => t.path),
  ["/main/osu/farm/collector"],
);
eq("recents keep their order", session.recents.map((t) => t.id), ["t7", "t4"]);

rmSync(home, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
