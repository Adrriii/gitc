// Containment and argument-shape checks for values that arrive over the API.
//
// The engine listens on loopback with no authentication, and every repository
// call names the thing it acts on as a plain string: a file path relative to
// the repository, a ref, a remote name, a URL. Those strings are trusted by
// the operating system and by git the moment they are used, and nothing else
// in the codebase was checking their shape - so a path could leave the
// repository, and a ref could arrive spelled as a git option.
//
// Three separate hazards, deliberately kept apart:
//
//   inRepo()      a relative path must stay under the repository root
//   safeArgument()a value must not be readable by git as an option
//   safeRemoteUrl() a remote URL must not name a transport that runs a command
//
// None of them is a substitute for the others, and the last is the one that
// was a remote code execution: `git remote add x "ext::sh -c ..."` followed by
// the fetch that gitc does automatically runs that shell command.

import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, relative, isAbsolute, sep } from "node:path";

/**
 * Resolves a repository-relative path, refusing anything that leaves the
 * repository.
 *
 * `join(repo, path)` was the shape everywhere, and it happily accepts "..".
 * Reads went out through /api/diff and /api/conflict; the write in
 * resolveWithContent was an arbitrary file write with arbitrary content,
 * which is the whole machine on any platform where a shell profile or a
 * startup folder is writable by the user running gitc.
 *
 * Absolute paths are refused rather than resolved: nothing in the UI has one,
 * and on Windows `join()` does not even treat "C:/x" as absolute in second
 * position, so accepting it would mean two different meanings for one value.
 *
 * Returns the absolute path, or null when the value is not usable.
 */
export function inRepo(repo: string, path: string): string | null {
  if (path.length === 0) return null;
  // A NUL truncates the name every layer below this one, so the string being
  // checked would not be the string being opened.
  if (path.indexOf(String.fromCharCode(0)) !== -1) return null;
  if (isAbsolute(path)) return null;
  // Windows accepts both separators, and "C:x" is drive-relative rather than
  // absolute - isAbsolute says false for it, and it does not mean what the
  // caller thinks.
  if (/^[A-Za-z]:/.test(path)) return null;

  const root = resolve(repo);
  const full = resolve(root, path);
  if (!within(root, full)) return null;

  // Textual containment is not containment when a symlink is involved.
  //
  // A repository can contain one - git tracks symlinks - so "link/passwd"
  // with "link" pointing at /etc resolves inside the repository on paper and
  // opens a file outside it in fact. That is the shape of several real git
  // vulnerabilities, and it matters most where the repository came from
  // somebody else, which for a git client is the normal case.
  //
  // The link is followed and the result re-checked. A path that does not
  // exist yet - a file being created by a conflict resolution - has no
  // realpath, so the nearest existing ancestor is resolved instead: that is
  // the part a link could hide in, and the rest is names this process is
  // about to create.
  const real = realAncestor(full);
  if (real === null) return null;
  const realRoot = realAncestor(root);
  if (realRoot === null) return null;
  if (real !== realRoot && !within(realRoot, real)) return null;

  return full;
}

/** Whether `full` is strictly underneath `root`. */
function within(root: string, full: string): boolean {
  const rel = relative(root, full);
  // "" is the root itself, which is a directory and never a file the API
  // should act on.
  if (rel.length === 0) return false;
  if (rel === ".." || rel.startsWith(".." + sep)) return false;
  return !isAbsolute(rel);
}

/**
 * The path with every symlink resolved, using the nearest ancestor that
 * exists.
 *
 * realpath needs the file to be there. Half of what this checks is a file
 * about to be written, so the walk stops at the deepest existing ancestor and
 * re-attaches the names below it - which is sound, because a name that does
 * not exist cannot be a link to anywhere.
 */
function realAncestor(full: string): string | null {
  let head = full;
  const tail: string[] = [];

  for (let i = 0; i < 64; i++) {
    if (existsSync(head)) {
      try {
        const real = realpathSync(head);
        return tail.length === 0 ? real : resolve(real, tail.reverse().join(sep));
      } catch {
        return null;
      }
    }
    const parent = dirname(head);
    // The filesystem root, and nothing along the way existed.
    if (parent === head) return null;
    // Both separators, because gitc runs on all three platforms and this is
    // the character the local one happens to use. Leaving it on makes the
    // segment absolute - resolve() then throws the ancestor away and lands at
    // the filesystem root, which reads as "outside the repository" for every
    // file that does not exist yet.
    tail.push(head.substring(parent.length).replace(/^[\\/]+/, ""));
    head = parent;
  }
  // Deeper than anything real, which is a path built to exhaust this loop.
  return null;
}

/** inRepo, as an assertion, so callers read as one line. */
export function needInRepo(repo: string, path: string): string {
  const full = inRepo(repo, path);
  if (full === null) throw new Error(path + " is outside the repository");
  return full;
}

/**
 * Refuses a value git would read as an option rather than as a name.
 *
 * Every git call here builds its own argv, so there is no shell to escape -
 * but argv is exactly where option injection lives. A ref of
 * "--upload-pack=<command>" reaching `git fetch` is a command git runs, and
 * `--output=<path>` reaching a command that takes it is a file git writes.
 * The affected values are refs, branch and tag names, remote names and file
 * paths, none of which may legitimately begin with a dash.
 *
 * Not a character allowlist: refs and paths legitimately contain almost
 * anything, and a list narrow enough to be safe would refuse real names. The
 * leading dash is the whole of the problem.
 */
export function safeArgument(value: string, what: string): string {
  if (value.indexOf(String.fromCharCode(0)) !== -1) {
    throw new Error("that " + what + " contains a NUL byte");
  }
  if (value.startsWith("-")) {
    throw new Error('a ' + what + ' cannot start with "-" - git would read it as an option');
  }
  return value;
}

/**
 * The transports a remote URL may name.
 *
 * git's remote-helper mechanism turns a URL into a program to run: "ext::"
 * hands the rest of the string to a shell, and "transport-helper" style
 * schemes resolve to `git-remote-<scheme>` on PATH. gitc fetches a remote as
 * soon as it is added, so accepting an arbitrary URL here was accepting an
 * arbitrary command - reachable by anything that could reach the port.
 *
 * git's own `protocol.allow` defaults stop some of this for clones started by
 * a helper, but not for a remote a user "asked" for, which is what every call
 * from this engine looks like.
 */
const ALLOWED_SCHEMES = ["https://", "http://", "ssh://", "git://", "file://"];

/**
 * Whether a remote URL is one gitc will hand to git.
 *
 * Three accepted shapes, and nothing else:
 *   - an explicit scheme from ALLOWED_SCHEMES
 *   - scp-like ssh, "user@host:path", which is how most people write GitHub
 *   - a local path, absolute or relative, for a repository on this machine
 */
export function safeRemoteUrl(url: string): string {
  const value = url.trim();
  if (value.length === 0) throw new Error("the remote needs a URL");
  if (value.indexOf(String.fromCharCode(0)) !== -1) {
    throw new Error("that URL contains a NUL byte");
  }
  safeArgument(value, "URL");

  const lower = value.toLowerCase();
  for (const scheme of ALLOWED_SCHEMES) {
    if (lower.startsWith(scheme)) return value;
  }

  // "ext::", "transport::", and any other helper spelling. Checked before the
  // scp-like shape below, which would otherwise accept "ext::sh -c ..." as a
  // host called "ext" with an empty path.
  if (value.includes("::")) {
    throw new Error(
      "gitc will not add a remote using a git transport helper - " +
        "use an https, ssh, git or file URL",
    );
  }

  // A Windows path, "C:\src\repo" or "C:/src/repo". Checked before the
  // scp-like shape, which the colon would otherwise match.
  if (/^[A-Za-z]:[\\/]/.test(value)) return value;

  // scp-like: something before a colon, something after, no scheme.
  if (/^[A-Za-z0-9._~-]+(@[A-Za-z0-9._~\[\]-]+)?:/.test(value)) return value;

  // A plain path. Anything left that is not one is a spelling git would try
  // to resolve as a helper, and refusing it is the point of this function.
  if (value.startsWith("/") || value.startsWith(".") || value.startsWith("~")) return value;
  if (!value.includes(":")) return value;

  throw new Error("that does not look like a URL gitc can use for a remote");
}

// ------------------------------------------------------------ temp files

/**
 * A private directory for this process's temporary files.
 *
 * Every temp file here used to be a fixed or guessable name directly in the
 * system temp directory: "gitc-hunk-<Date.now()>.patch",
 * "gitc-squash-<stamp>.txt", "gitc/COMMIT_EDITMSG-<pid>". On Windows the temp
 * directory is per-user and that is merely untidy, but on Linux and macOS it
 * is shared by every account on the machine, and a name nobody has created
 * yet can be pre-created by somebody else - as a symlink pointing wherever
 * they like. gitc then writes the file, following the link, as the user
 * running gitc.
 *
 * mkdtemp is the fix rather than a better name: it creates the directory
 * atomically, with an unguessable name, owned by us and readable only by us,
 * and fails outright rather than reusing one that already exists.
 *
 * One directory for the life of the process, made on first use - a per-file
 * directory would leak one for every hunk staged.
 */
let privateDir: string | null = null;

export function tempDir(): string {
  if (privateDir !== null && existsSync(privateDir)) return privateDir;
  privateDir = mkdtempSync(join(tmpdir(), "gitc-"));
  return privateDir;
}

/** A path inside this process's private temp directory. */
export function tempFile(name: string): string {
  return join(tempDir(), name);
}

/**
 * Removes this process's temp directory, if it ever made one.
 *
 * mkdtemp leaves the directory behind on exit, and gitc is a program people
 * leave running for days and start many times - so without this the temp
 * directory collects an empty "gitc-XXXXXX" per launch. Best effort: a file
 * still open, or a directory already gone, is not worth failing an exit over.
 */
export function cleanTempDir(): void {
  if (privateDir === null) return;
  try {
    rmSync(privateDir, { recursive: true, force: true });
  } catch {
    // Something is still holding a file in there. It is a temp directory;
    // the operating system will get it.
  }
  privateDir = null;
}
