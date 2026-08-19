// Persisted session: which repos are open as tabs, and the recent list.
//
// Restoring the tab strip on launch is table stakes rather than a nicety: a
// tool you keep open all day should come back the way you left it.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface Tab {
  id: string;
  name: string;
  path: string;
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

/** Reads the saved session, falling back to an empty one on any problem. */
export function loadSession(): Session {
  const path = statePath();
  if (!existsSync(path)) return empty();
  try {
    // JSON.parse is typed as unknown here - the checked cast validates the
    // shape at runtime and throws if the file was hand-edited into nonsense.
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Session;
    return {
      tabs: parsed.tabs,
      activeId: parsed.activeId,
      recents: parsed.recents,
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
