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

const {
  loadSession,
  addWorkspace,
  closeTab,
  removeWorkspace,
  reorderWorkspaces,
  setTabWorkspaces,
  shownTabs,
  switchWorkspace,
} = await import("../../state.ts");

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

// --- workspaces ----------------------------------------------------------------

// A session from before workspaces: every tab lands in the default one.
eq("an old session gets the default workspace", session.workspaces.map((w) => w.id), ["default"]);
eq("and is in it", session.workspace, "default");
eq("every tab moves into it", session.tabs.map((t) => t.workspaces), [["default"], ["default"]]);

const ids = (tabs: { id: string }[]) => tabs.map((t) => t.id);

const work = addWorkspace(session, "Work");
eq("a new workspace becomes the current one", session.workspace, work.id);
eq("and starts empty", ids(shownTabs(session)), []);
eq("with nothing in front", session.activeId, null);

eq("a tab can be in two workspaces", setTabWorkspaces(session, "t4", ["default", work.id]), true);
eq("and shows in both", ids(shownTabs(session)), ["t4"]);
eq("never in none", setTabWorkspaces(session, "t4", ["nowhere"]), false);

switchWorkspace(session, "default");
session.activeId = "t7";
switchWorkspace(session, work.id);
eq("switching shows that workspace's tab", session.activeId, "t4");

reorderWorkspaces(session, [work.id, "nowhere", work.id]);
eq(
  "workspaces take the order given, unknown and repeated ids aside, and the rest follow",
  session.workspaces.map((w) => w.id),
  [work.id, "default"],
);
reorderWorkspaces(session, ["default", work.id]);
switchWorkspace(session, "default");
eq("and switching back finds the tab left in front", session.activeId, "t7");

eq("closing a shared tab only leaves this workspace", closeTab(session, "t4", null, false), null);
eq("it is still open in the other", session.tabs.find((t) => t.id === "t4")?.workspaces, [work.id]);
eq("and gone from this one", ids(shownTabs(session)), ["t7"]);

const closed = removeWorkspace(session, work.id);
eq("deleting a workspace closes the tabs only it held", ids(closed ?? []), ["t4"]);
eq("leaving the rest", ids(session.tabs), ["t7"]);
eq("the last workspace cannot be deleted", removeWorkspace(session, "default"), null);

eq("a tab only here closes outright", closeTab(session, "t7", null, false)?.id, "t7");
eq("leaving nothing in front", session.activeId, null);

// A tab naming a workspace that is gone falls back rather than vanishing.
writeFileSync(
  join(home, "gitc", "session.json"),
  JSON.stringify({
    tabs: [{ id: "t1", name: "a", path: "/a", host: null, workspaces: ["gone"] }],
    activeId: "t1",
    recents: [],
    workspaces: [{ id: "w2", name: "Mine", activeId: null }],
    workspace: "w2",
  }),
  "utf8",
);
const later = loadSession();
eq("a tab in a deleted workspace lands in the first one", later.tabs[0].workspaces, ["w2"]);
eq("and stays in front", later.activeId, "t1");

rmSync(home, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
