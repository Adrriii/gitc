// Persisted session: which repos are open as tabs, the workspaces that sort
// them, and the recent list.
//
// Restoring the tab strip on launch is table stakes rather than a nicety: a
// tool you keep open all day should come back the way you left it.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { at } from "./engine/safe.ts";
import { configDir } from "./engine/paths.ts";

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
  /**
   * The workspaces this tab is shown in, by id - never empty. One repository
   * can belong to several, and is still one tab: closing it in one workspace
   * leaves it open in the others.
   */
  workspaces: string[];
}

/**
 * A named set of tabs. Only the current workspace's tabs are on the strip, so
 * a dozen repositories open for different jobs do not all compete for it.
 */
export interface Workspace {
  id: string;
  name: string;
  /** The tab that was in front when this workspace was last left. */
  activeId: string | null;
}

export interface Session {
  tabs: Tab[];
  activeId: string | null;
  recents: Tab[];
  workspaces: Workspace[];
  /** The current workspace's id. */
  workspace: string;
}

/**
 * The workspace every tab lands in when a session from before workspaces is
 * loaded, and the one a fresh session starts with.
 */
export const DEFAULT_WORKSPACE = "default";

const MAX_RECENTS = 30;

function statePath(): string {
  return join(configDir(), "session.json");
}

function defaultWorkspace(): Workspace {
  return { id: DEFAULT_WORKSPACE, name: "Default", activeId: null };
}

function empty(): Session {
  return { tabs: [], activeId: null, recents: [], workspaces: [defaultWorkspace()], workspace: DEFAULT_WORKSPACE };
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
  /** Absent before workspaces existed. */
  workspaces?: string[];
}

/**
 * Fills in what an older file does not carry, so the rest can assume it.
 *
 * A tab saved before workspaces existed - or left naming only workspaces
 * that are gone - goes into `fallback`, so the migration never loses a tab.
 */
function restore(t: StoredTab, known: Set<string>, fallback: string): Tab {
  const workspaces = (t.workspaces ?? []).filter((w) => known.has(w));
  return {
    id: t.id,
    name: t.name,
    path: t.path,
    host: t.host ?? null,
    workspaces: workspaces.length > 0 ? workspaces : [fallback],
  };
}

/** Reads the saved session, falling back to an empty one on any problem. */
/**
 * One tab per id, keeping the LAST of any duplicates.
 *
 * Tabs are appended as they are opened, so the newest entry for an id is the
 * one somebody is actually looking at - and the stale one is what shadowed it
 * in findTab, which takes the first match.
 */
function byLastId(tabs: Tab[]): Tab[] {
  const out: Tab[] = [];
  const seen = new Set<string>();
  for (let i = tabs.length - 1; i >= 0; i--) {
    const tab = at(tabs, i);
    if (tab === undefined || seen.has(tab.id)) continue;
    seen.add(tab.id);
    out.push(tab);
  }
  out.reverse();
  return out;
}

/**
 * One entry per id, keeping the FIRST - the opposite of byLastId, and
 * deliberately so.
 *
 * Recents are held newest-first, so here the first entry is the live one.
 * Getting this backwards keeps the stale path and drops the good one, which
 * is a mistake worth naming because it was made once already while repairing
 * a session by hand.
 */
function byFirstId(tabs: Tab[]): Tab[] {
  const out: Tab[] = [];
  const seen = new Set<string>();
  for (const tab of tabs) {
    if (seen.has(tab.id)) continue;
    seen.add(tab.id);
    out.push(tab);
  }
  return out;
}

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
      workspaces?: { id: string; name: string; activeId?: string | null }[];
      workspace?: string;
    };
    const stored = parsed.workspaces ?? [];
    const workspaces: Workspace[] =
      stored.length > 0
        ? stored.map((w) => ({ id: w.id, name: w.name, activeId: w.activeId ?? null }))
        : [defaultWorkspace()];
    const known = new Set(workspaces.map((w) => w.id));
    const first = at(workspaces, 0);
    const fallback = first === undefined ? DEFAULT_WORKSPACE : first.id;
    const current = parsed.workspace !== undefined && known.has(parsed.workspace) ? parsed.workspace : fallback;
    const session: Session = {
      // Repaired on the way in, not merely prevented on the way out: a
      // session written by a version that allowed two tabs to share an id is
      // still on disk, and loading it faithfully would reinstate the fault
      // for the life of that file.
      tabs: byLastId(parsed.tabs.map((t) => restore(t, known, fallback))),
      activeId: parsed.activeId,
      recents: byFirstId(parsed.recents.map((t) => restore(t, known, fallback))),
      workspaces,
      workspace: current,
    };
    session.activeId = frontOf(session, session.activeId);
    return session;
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
    // Host as well as path. The same path on two machines is two different
    // repositories - which the Recent list and its keys already assume - and
    // matching on path alone silently evicted the remote entry the moment the
    // same path was opened locally, with no way back to it but retyping the
    // host and browsing again.
    if (r.path !== tab.path || r.host !== tab.host) kept.push(r);
  }
  kept.unshift(tab);
  session.recents = kept.slice(0, MAX_RECENTS);
}

// --- workspaces ----------------------------------------------------------------

/** The tabs on the strip: the current workspace's, in the session's order. */
export function shownTabs(session: Session): Tab[] {
  return session.tabs.filter((t) => t.workspaces.includes(session.workspace));
}

/** `wanted` when it is on the strip, otherwise its first tab, or null for none. */
function frontOf(session: Session, wanted: string | null): string | null {
  const shown = shownTabs(session);
  const found = shown.find((t) => t.id === wanted) ?? at(shown, 0);
  return found === undefined ? null : found.id;
}

/** Puts a tab in the current workspace too, for one being opened from it. */
export function adoptTab(session: Session, tab: Tab): void {
  if (!tab.workspaces.includes(session.workspace)) tab.workspaces.push(session.workspace);
}

/**
 * Makes another workspace the current one, back on the tab that was in front
 * when it was left. False when there is no such workspace.
 */
export function switchWorkspace(session: Session, id: string): boolean {
  const target = session.workspaces.find((w) => w.id === id);
  if (target === undefined) return false;
  const leaving = session.workspaces.find((w) => w.id === session.workspace);
  if (leaving !== undefined) leaving.activeId = session.activeId;
  session.workspace = id;
  session.activeId = frontOf(session, target.activeId);
  return true;
}

/** A new, empty workspace, which becomes the current one. */
export function addWorkspace(session: Session, name: string): Workspace {
  let n = session.workspaces.length + 1;
  while (session.workspaces.some((w) => w.id === "w" + String(n))) n += 1;
  const workspace: Workspace = { id: "w" + String(n), name, activeId: null };
  session.workspaces.push(workspace);
  switchWorkspace(session, workspace.id);
  return workspace;
}

/**
 * Puts the workspaces in the order given. Any the order leaves out keep their
 * place after it, so a workspace added meanwhile is not lost.
 */
export function reorderWorkspaces(session: Session, order: string[]): void {
  const named: Workspace[] = [];
  for (const id of order) {
    const w = session.workspaces.find((x) => x.id === id);
    if (w !== undefined && !named.includes(w)) named.push(w);
  }
  session.workspaces = [...named, ...session.workspaces.filter((w) => !named.includes(w))];
}

export function renameWorkspace(session: Session, id: string, name: string): boolean {
  const workspace = session.workspaces.find((w) => w.id === id);
  if (workspace === undefined) return false;
  workspace.name = name;
  return true;
}

/**
 * Deletes a workspace, closing the tabs that were only in it. Returns them, so
 * the caller can let go of whatever they held; null when it cannot be deleted,
 * because it does not exist or is the last one.
 */
export function removeWorkspace(session: Session, id: string): Tab[] | null {
  if (session.workspaces.length <= 1 || !session.workspaces.some((w) => w.id === id)) return null;
  session.workspaces = session.workspaces.filter((w) => w.id !== id);
  const closed: Tab[] = [];
  const kept: Tab[] = [];
  for (const t of session.tabs) {
    t.workspaces = t.workspaces.filter((w) => w !== id);
    if (t.workspaces.length === 0) closed.push(t);
    else kept.push(t);
  }
  session.tabs = kept;
  if (session.workspace === id) {
    const first = at(session.workspaces, 0);
    if (first !== undefined) switchWorkspace(session, first.id);
  } else {
    session.activeId = frontOf(session, session.activeId);
  }
  return closed;
}

/**
 * Chooses the workspaces a tab is in. Unknown ids are dropped, and a tab has
 * to stay in at least one - closing it is how it leaves the last.
 */
export function setTabWorkspaces(session: Session, tabId: string, ids: string[]): boolean {
  const tab = session.tabs.find((t) => t.id === tabId);
  const wanted = ids.filter((id) => session.workspaces.some((w) => w.id === id));
  if (tab === undefined || wanted.length === 0) return false;
  tab.workspaces = wanted;
  session.activeId = frontOf(session, session.activeId);
  return true;
}

/**
 * Closes a tab in the current workspace.
 *
 * A tab other workspaces also hold only leaves this one; otherwise - or with
 * `everywhere`, for a repository that is gone - it is closed outright and
 * returned, so the caller can let go of what it held. `next` is the tab to
 * bring forward when the one closing was in front.
 */
export function closeTab(session: Session, id: string, next: string | null, everywhere: boolean): Tab | null {
  const tab = session.tabs.find((t) => t.id === id);
  if (tab === undefined) return null;
  const elsewhere = tab.workspaces.filter((w) => w !== session.workspace);
  let closed: Tab | null = null;
  if (!everywhere && elsewhere.length > 0) {
    tab.workspaces = elsewhere;
  } else {
    session.tabs = session.tabs.filter((t) => t.id !== id);
    closed = tab;
  }
  if (session.activeId === id) session.activeId = frontOf(session, next);
  return closed;
}
