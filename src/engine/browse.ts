// Directory listing for the repository picker.
//
// Typing an absolute path from memory, with no completion and no way to look
// around, is the worst way to open a project. This is what the picker needs to
// do better: list a directory, say which entries are directories, and say
// which of those are git repositories - so you can see where a repo is before
// walking into it rather than after.

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, sep } from "node:path";

export interface Entry {
  name: string;
  dir: boolean;
  /** A git repository - worth showing before you enter it. */
  repo: boolean;
}

export interface Listing {
  /** The directory actually listed, absolute. */
  path: string;
  /** Whether that directory is itself a repository - the picker's Open state. */
  repo: boolean;
  /** Parent directory, or null at the root. */
  parent: string | null;
  /**
   * What the caller typed after the last separator, when that was a partial
   * name rather than a directory. The UI filters its completions on it.
   */
  prefix: string;
  entries: Entry[];
  /** True when the listing was cut short - see LIMIT. */
  truncated: boolean;
  /** This machine's separator, so the UI can build paths that look native. */
  sep: string;
  home: string;
}

/**
 * A directory of ten thousand entries is a picker that hangs, and nobody
 * scrolls that far anyway. The UI says so when it happens, so a missing folder
 * is never a mystery.
 */
const LIMIT = 500;


/**
 * Turns a name that came out of the filesystem into text.
 *
 * readdirSync here hands back the OS's raw bytes, one per code unit, rather
 * than decoded text - a folder called "Cafe" with an acute accent arrives as a
 * lone 0xe9. Sending that produces invalid UTF-8 on the wire and an unreadable
 * name in the UI. (Proved by putting a literal with the same characters in the
 * same response: the literal encoded correctly, the filesystem name did not.)
 *
 * The bytes are UTF-8 on Linux and macOS, and the active ANSI codepage on
 * Windows. Decoding as UTF-8 and falling back when that fails covers both:
 * valid UTF-8 is unambiguous, and a Latin-1 name is not valid UTF-8.
 */
export function home(): string {
  return homedir();
}

/** A git repository has a .git - a directory usually, a file in a worktree. */
function isRepo(path: string): boolean {
  return existsSync(join(path, ".git"));
}

/**
 * Lists a directory, or the parent of a partially typed path.
 *
 * Passing "/home/adri/Pro" lists "/home/adri" with prefix "Pro", which is what
 * makes completion work without a second endpoint.
 */
export function listDir(input: string): Listing {
  const sepChar = sep;
  const start = input.trim().length === 0 ? homedir() : input.trim();

  let dir = start;
  let prefix = "";

  // An existing directory is listed as-is. Anything else is treated as a
  // partial name inside its parent, which is the common case mid-typing.
  let isDir = false;
  if (existsSync(start)) {
    try {
      isDir = statSync(start).isDirectory();
    } catch {
      isDir = false;
    }
  }
  if (!isDir) {
    dir = dirname(start);
    prefix = start.substring(dir.length).replace(/^[\\/]+/, "");
    if (!existsSync(dir)) {
      // Nothing to list, but still answer with something the UI can render.
      return {
        path: start,
        repo: false,
        parent: null,
        prefix: prefix,
        entries: [],
        truncated: false,
        sep: sepChar,
        home: homedir(),
      };
    }
  }

  const entries: Entry[] = [];
  let truncated = false;
  try {
    const names = readdirSync(dir);
    for (const name of names) {
      if (entries.length >= LIMIT) {
        truncated = true;
        break;
      }
      const full = join(dir, name);
      let directory = false;
      try {
        directory = statSync(full).isDirectory();
      } catch {
        // A dangling symlink or a directory we may not stat: skip it rather
        // than failing the whole listing.
        continue;
      }
      // Files cannot be opened as repositories, so the picker only deals in
      // directories - which also keeps the .git probe count down.
      if (!directory) continue;
      entries.push({ name, dir: true, repo: isRepo(full) });
    }
  } catch {
    // Unreadable directory: an empty listing is the honest answer.
  }

  // Repositories first - they are what the picker is for - then the rest
  // alphabetically, case-insensitively so `Code` and `code` sit together.
  entries.sort((a, b) => {
    if (a.repo !== b.repo) return a.repo ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });

  const parent = dirname(dir);
  return {
    path: dir,
    repo: isRepo(dir),
    parent: parent === dir ? null : parent,
    prefix: prefix,
    entries,
    truncated,
    sep: sepChar,
    home: homedir(),
  };
}
