// Persisted session: which repos are open as tabs, and the recent list.
//
// Restoring the tab strip on launch is table stakes rather than a nicety: a
// tool you keep open all day should come back the way you left it.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface Tab {
  id: string;
  name: string;
  /** The repository's path ON THE MACHINE THAT HOLDS IT - remote or not. */
  path: string;
  /**
   * The ssh destination this repository lives on, or null for this machine.
   *
   * A remote tab is served by a gitc running over there; everything the window
   * asks about it is answered by that engine and passed through this one. The
   * id is deliberately the SAME on both sides - see openRepo - so nothing has
   * to be rewritten in transit.
   */
  host: string | null;
}

export interface Session {
  tabs: Tab[];
  activeId: string | null;
  recents: Tab[];
}

const MAX_RECENTS = 30;

function configDir(): string {
  const appData = process.env["APPDATA"];
  if (appData !== undefined && appData.length > 0) return join(appData, "gitc");
  const home = process.env["HOME"];
  if (home !== undefined && home.length > 0) return join(home, ".config", "gitc");
  return ".gitc";
}

function statePath(): string {
  return join(configDir(), "session.json");
}

function empty(): Session {
  return { tabs: [], activeId: null, recents: [] };
}

/**
 * A tab as it may appear in a file written by an older gitc.
 *
 * `host` is optional here and not in Tab: every session saved before remote
 * tabs existed has entries without it, and this is the one place that has to
 * cope with their absence.
 */
interface StoredTab {
  id: string;
  name: string;
  path: string;
  host?: string | null;
}

/** Fills in what an older file does not carry, so the rest can assume it. */
function restore(t: StoredTab): Tab {
  return { id: t.id, name: t.name, path: t.path, host: t.host ?? null };
}

/** Reads the saved session, falling back to an empty one on any problem. */
export function loadSession(): Session {
  const path = statePath();
  if (!existsSync(path)) return empty();
  try {
    // JSON.parse is typed as unknown here - the checked cast validates the
    // shape at runtime and throws if the file was hand-edited into nonsense.
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      tabs: StoredTab[];
      activeId: string | null;
      recents: StoredTab[];
    };
    return {
      tabs: parsed.tabs.map(restore),
      activeId: parsed.activeId,
      recents: parsed.recents.map(restore),
    };
  } catch {
    return empty();
  }
}

export function saveSession(session: Session): void {
  const dir = configDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(statePath(), JSON.stringify(session), "utf8");
}

/** Moves a repo to the front of the recent list, deduped by path. */
export function touchRecent(session: Session, tab: Tab): void {
  const kept: Tab[] = [];
  for (const r of session.recents) {
    if (r.path !== tab.path) kept.push(r);
  }
  kept.unshift(tab);
  session.recents = kept.slice(0, MAX_RECENTS);
}
