// Which refs are hidden from the graph, per repository.
//
// Hiding a ref drops the commits only it reaches, which is how a repository
// with forty remote branches stays readable: the graph shows the history you
// care about rather than everyone else's topic branches.
//
// This lives in its own file rather than as a field on Tab for two reasons.
// The obvious one is that a saved session.json written by an earlier build has
// no such field, and reading a missing property is a runtime throw under
// scriptc, not `undefined` - so a new field on a persisted shape means a
// migration. The better one is that visibility belongs to the REPOSITORY, not
// to the tab: close a tab, reopen it, and your hidden branches should still be
// hidden.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

interface RepoVisibility {
  /** Work-tree root, as the tab records it. */
  path: string;
  /** Ref display names: "feature/a", "origin/feature/a", "v1.0". */
  hidden: string[];
}

interface VisibilityFile {
  repos: RepoVisibility[];
}

function configDir(): string {
  const appData = process.env["APPDATA"];
  if (appData !== undefined && appData.length > 0) return join(appData, "gitc");
  const home = process.env["HOME"];
  if (home !== undefined && home.length > 0) return join(home, ".config", "gitc");
  return ".gitc";
}

function filePath(): string {
  return join(configDir(), "hidden.json");
}

function loadAll(): VisibilityFile {
  const path = filePath();
  if (!existsSync(path)) return { repos: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as VisibilityFile;
    return { repos: parsed.repos };
  } catch {
    // A hand-edited or truncated file costs you your hidden list, which is a
    // preference - never a reason to fail to open the repository.
    return { repos: [] };
  }
}

/** The refs hidden in this repository. Empty when nothing is hidden. */
export function loadHidden(repo: string): string[] {
  for (const entry of loadAll().repos) {
    if (entry.path === repo) return entry.hidden;
  }
  return [];
}

export function saveHidden(repo: string, hidden: string[]): void {
  const all = loadAll();
  const kept: RepoVisibility[] = [];
  for (const entry of all.repos) {
    if (entry.path !== repo) kept.push(entry);
  }
  // Drop the entry entirely once nothing is hidden, so the file does not
  // accumulate a row for every repository ever opened.
  if (hidden.length > 0) kept.push({ path: repo, hidden });

  const dir = configDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath(), JSON.stringify({ repos: kept }), "utf8");
}
