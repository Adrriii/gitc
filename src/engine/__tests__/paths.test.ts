import { inRepo, safeArgument, safeRemoteUrl } from "../paths.ts";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
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

/** Did this throw? The guards report by throwing, so that is what is tested. */
function threw(f: () => unknown): boolean {
  try {
    f();
    return false;
  } catch {
    return true;
  }
}

const repo = resolve("/tmp/repo");

// --- inRepo ---------------------------------------------------------------

eq("a plain file", inRepo(repo, "src/main.ts"), resolve(repo, "src/main.ts"));
eq("a dot segment resolves", inRepo(repo, "./src/../a.txt"), resolve(repo, "a.txt"));

// The vulnerability: /api/diff, /api/conflict and /api/resolve all built their
// path with join(), which resolves ".." happily. The read was measured against
// a running engine and the write landed outside the repository.
eq("climbing out", inRepo(repo, "../secret.txt"), null);
eq("climbing far out", inRepo(repo, "../../../../etc/passwd"), null);
eq("climbing out and back in is fine", inRepo(repo, "../repo/a.txt"), resolve(repo, "a.txt"));
// A backslash is a separator on Windows and an ordinary filename character
// everywhere else, so this is two different assertions rather than one.
// Asserting the Windows answer unconditionally made `npm test` fail on Linux
// - and since `npm test` runs inside `npm run build`, which release.yml runs
// on its ubuntu leg, that failure would have appeared half way through
// cutting a release with the Windows leg green beside it.
if (process.platform === "win32") {
  eq("a backslash climb", inRepo(repo, "..\\secret.txt"), null);
} else {
  eq(
    "a backslash is just a character here",
    inRepo(repo, "..\\secret.txt"),
    resolve(repo, "..\\secret.txt"),
  );
}
eq("absolute posix", inRepo(repo, "/etc/passwd"), null);
eq("a drive letter", inRepo(repo, "C:/Windows/win.ini"), null);
eq("drive-relative", inRepo(repo, "C:secret.txt"), null);
eq("empty", inRepo(repo, ""), null);
eq("the root itself", inRepo(repo, "."), null);
eq("a NUL", inRepo(repo, "a\u0000.txt"), null);

// --- safeArgument ---------------------------------------------------------

eq("an ordinary branch", safeArgument("feature/login", "branch"), "feature/login");
eq("a branch with a dash inside", safeArgument("my-branch", "branch"), "my-branch");

// git builds argv here, so there is no shell - but a value spelled as an
// option is read as one, and --upload-pack= is a command git runs.
eq("an option-shaped ref", threw(() => safeArgument("--upload-pack=sh", "ref")), true);
eq("a bare dash", threw(() => safeArgument("-", "ref")), true);
eq("a short option", threw(() => safeArgument("-x", "ref")), true);
eq("a NUL in a ref", threw(() => safeArgument("a\u0000b", "ref")), true);

// --- safeRemoteUrl --------------------------------------------------------

eq("https", safeRemoteUrl("https://github.com/a/b.git"), "https://github.com/a/b.git");
eq("ssh scheme", safeRemoteUrl("ssh://git@host/a/b.git"), "ssh://git@host/a/b.git");
eq("scp-like", safeRemoteUrl("git@github.com:a/b.git"), "git@github.com:a/b.git");
eq("a bare host", safeRemoteUrl("host:a/b.git"), "host:a/b.git");
eq("a local path", safeRemoteUrl("/srv/git/b.git"), "/srv/git/b.git");
eq("a relative path", safeRemoteUrl("../other"), "../other");
eq("a windows path", safeRemoteUrl("C:/src/other"), "C:/src/other");
eq("whitespace is trimmed", safeRemoteUrl("  https://x/y  "), "https://x/y");

// The remote code execution. `git remote add x "ext::sh -c <command>"` and the
// fetch gitc runs straight afterwards executes that command; confirmed against
// a running engine before this check existed.
eq("ext transport", threw(() => safeRemoteUrl("ext::sh -c whoami")), true);

// The allowlist has to actually be an allowlist. The scp-like fallback below
// matches any bare "word:" prefix, so every one of these reached git until
// unknown "<scheme>://" spellings were refused explicitly - and git resolves
// a scheme it has no native support for to git-remote-<scheme> on PATH.
eq("sftp", threw(() => safeRemoteUrl("sftp://evil.example/x")), true);
eq("gcrypt", threw(() => safeRemoteUrl("gcrypt://h/x")), true);
eq("hg", threw(() => safeRemoteUrl("hg://h/x")), true);
eq("fd", threw(() => safeRemoteUrl("fd://x")), true);
eq("an invented scheme", threw(() => safeRemoteUrl("helper://a")), true);
// And the allowed ones still are.
eq("http stays", safeRemoteUrl("http://h/x"), "http://h/x");
eq("git stays", safeRemoteUrl("git://h/x"), "git://h/x");
eq("file stays", safeRemoteUrl("file:///srv/x"), "file:///srv/x");
eq("ext with a payload", threw(() => safeRemoteUrl("ext::sh -c touch% /tmp/x")), true);
eq("any helper spelling", threw(() => safeRemoteUrl("weird::whatever")), true);
eq("an option-shaped URL", threw(() => safeRemoteUrl("--upload-pack=sh")), true);
eq("empty", threw(() => safeRemoteUrl("   ")), true);

// --- symlinks -------------------------------------------------------------
//
// Textual containment is not containment. git tracks symlinks, so a
// repository - which for a git client normally came from somebody else - can
// contain one pointing anywhere, and "link/passwd" is inside the repository
// on paper while opening a file outside it in fact.

const sandbox = mkdtempSync(join(tmpdir(), "gitc-paths-test-"));
const repoDir = join(sandbox, "repo");
const outside = join(sandbox, "outside");
mkdirSync(repoDir);
mkdirSync(outside);
writeFileSync(join(outside, "secret.txt"), "not yours", "utf8");
mkdirSync(join(repoDir, "real"));
writeFileSync(join(repoDir, "real", "a.txt"), "mine", "utf8");

// A directory link, made as a junction: Windows needs a privilege or
// developer mode for a real symlink, and a junction needs neither while
// resolving the same way. The type argument is ignored on POSIX, so this is
// an ordinary symlink there.
let dirLink = true;
try {
  symlinkSync(outside, join(repoDir, "escape"), "junction");
} catch {
  dirLink = false;
  console.log("  --   directory link case skipped (not permitted on this machine)");
}

/** A file symlink has no unprivileged equivalent, so this one may skip. */
let fileLink = true;
try {
  symlinkSync(join(outside, "secret.txt"), join(repoDir, "escape-file"), "file");
} catch {
  fileLink = false;
  console.log("  --   file link case skipped (not permitted on this machine)");
}

eq("a real file inside", inRepo(repoDir, "real/a.txt"), join(repoDir, "real", "a.txt"));
eq("a file not created yet", inRepo(repoDir, "real/new.txt"), join(repoDir, "real", "new.txt"));
eq("a whole new subtree", inRepo(repoDir, "brand/new/deep.txt"), join(repoDir, "brand/new/deep.txt"));

if (dirLink) {
  eq("through a directory link", inRepo(repoDir, "escape/secret.txt"), null);
  // The write a conflict resolution would do: the file does not exist yet,
  // but the directory it lands in is a link out of the repository.
  eq("a new file under a link", inRepo(repoDir, "escape/planted.txt"), null);
}
if (fileLink) {
  eq("a file symlink out", inRepo(repoDir, "escape-file"), null);
}

rmSync(sandbox, { recursive: true, force: true });

console.log(`
${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
