// Cuts a release: version, build, commit, verify, tag, publish, check, notes.
//
// The steps are not hard, but there are nine of them and getting one wrong
// costs a bad release rather than a retry - a tag that fails to build has to
// be deleted, a published binary that does not start has to be pulled. So
// they live here rather than in somebody's memory.
//
//   node scripts/release.mjs <version|patch|minor|major|rc|minor-rc> [options]
//
//   `rc` cuts a test build - 0.4.5-rc.1, then rc.2, and so on - published as a
//   GitHub prerelease. /releases/latest skips those, so nobody on a released
//   gitc is offered one, while a tester already on an rc is offered each next
//   one and, eventually, the stable release that supersedes them.
//
//     -m <text>        commit message for the release commit
//     -F <file>        ... or read it from a file, which also becomes the
//                      release notes on the published page
//     --author "N <e>" author for the release commit (default: git's own)
//     --branch <name>  branch to release from (default: the current one)
//     --stream <name>  the line of development a candidate belongs to
//                      (default: the branch name). Testers follow one stream
//                      and are not offered another's candidates.
//     --skip-verify    tag without the build-only run first
//     --dry-run        print the plan and change nothing
//     --yes            allow the tag push without a terminal to confirm at
//
// Two properties worth keeping if this is ever edited:
//
//   Resumable. Every step checks whether it has already happened, so a run
//   that dies halfway - a dropped connection while watching a build - can be
//   run again with the same arguments and will pick up where it stopped.
//
//   The tag comes last, and only after a full build of both platforms has
//   passed on the runners. Everything before the tag can be undone with a
//   force-push; everything after it is public.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const windows = process.platform === "win32";
const WORKFLOW = "release.yml";

// --- arguments ---------------------------------------------------------------

const argv = process.argv.slice(2);

/** The flags that take a value, so their value is never read as the version. */
const VALUED = ["-m", "-F", "--author", "--branch", "--stream"];

function flag(name) {
  const i = argv.indexOf(name);
  return i === -1 ? null : (argv[i + 1] ?? null);
}
const has = (name) => argv.includes(name);

let target = null;
for (let i = 0; i < argv.length; i++) {
  if (VALUED.includes(argv[i])) {
    i += 1;
    continue;
  }
  if (argv[i].startsWith("-")) continue;
  target = argv[i];
  break;
}

const dryRun = has("--dry-run");
const skipVerify = has("--skip-verify");
const assumeYes = has("--yes");
const author = flag("--author");
const messageFile = flag("-F");
const messageText = flag("-m");

if (!target) {
  console.error("usage: node scripts/release.mjs <version|patch|minor|major> [options]");
  console.error("       see the header of this file for the options");
  process.exit(1);
}

// --- output ------------------------------------------------------------------

let stepNumber = 0;
const step = (text) => console.log(`\n[${++stepNumber}] ${text}`);
const info = (text) => console.log(`    ${text}`);
const skip = (text) => console.log(`    - ${text}`);

function die(message, detail) {
  console.error(`\nrelease stopped: ${message}`);
  if (detail) console.error(detail.trim());
  process.exit(1);
}

// --- running things ----------------------------------------------------------

/**
 * Runs a command, returning its output. Fails the release if it fails.
 *
 * `shell` is off by default and deliberately so: a release commit message is
 * several paragraphs with quotes and blank lines in it, and handing that to a
 * Windows shell to re-parse would rewrite the message or fail outright.
 * Arguments go straight to the process. Only npm and gh need the shell, being
 * .cmd shims that cannot be spawned directly on Windows.
 */
function run(cmd, args, { allowFail = false, quiet = true, cwd = root, shell = false } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: quiet ? "pipe" : "inherit",
    shell,
  });
  if (r.error) die(`could not run ${cmd}`, r.error.message);
  if (r.status !== 0 && !allowFail) {
    die(`${cmd} ${args.join(" ")} failed (exit ${r.status})`, `${r.stdout ?? ""}${r.stderr ?? ""}`);
  }
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

const git = (...args) => run("git", args);
const gh = (...args) => run("gh", args, { shell: windows });
const npm = (args, options = {}) => run("npm", args, { shell: windows, ...options });

/** For the steps that change something: honours --dry-run. */
function act(description, fn) {
  if (dryRun) {
    info(`would ${description}`);
    return null;
  }
  return fn();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- version -----------------------------------------------------------------

const pkgPath = join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
if (pkg.name !== "gitc") die(`this is not the gitc package (found "${pkg.name}")`);

function bumped(current, kind) {
  // The numbers only: a current version of 0.5.0-rc.2 bumps from 0.5.0.
  const [major, minor, patch] = current.split("-")[0].split(".").map(Number);
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * The next release candidate.
 *
 * On an rc already, this continues the run - 0.5.0-rc.1 to 0.5.0-rc.2 - so a
 * tester's own gitc offers them each build in turn. On a released version it
 * starts a run for the next patch, and `minor-rc` chooses a bigger target when
 * the branch is heading somewhere larger.
 */
function nextRc(current, base, stream) {
  // A candidate is for the version NEXT, never the one already out: 0.4.4-rc.1
  // sorts BELOW 0.4.4, so a tester on it would be offered the release it was
  // meant to precede, as though the test build were the newer thing.
  const target = base ?? (current.includes("-") ? current.split("-")[0] : bumped(current, "patch"));
  const prefix = `${target}-${stream}.`;
  if (!current.startsWith(prefix)) return `${target}-${stream}.1`;
  const n = Number(current.slice(prefix.length));
  return `${target}-${stream}.${Number.isFinite(n) ? n + 1 : 1}`;
}

/**
 * The line of development a candidate belongs to, taken from the branch.
 *
 * Every candidate used to be called "-rc.N", which said nothing about which
 * work it carried. The updater compared numbers alone, so tagging 0.5.1 on
 * one branch offered it to every tester on another branch's 0.4.5 - a
 * different feature entirely, with no way to decline. Naming the stream in
 * the version is what lets a tester follow one line and ignore the rest; see
 * preStream in engine/semver.ts, which reads it back.
 *
 * Semver splits the prerelease part on dots and allows only [0-9A-Za-z-] in
 * an identifier, so anything else in a branch name becomes a dash. A name
 * that is all digits would be read as a candidate number rather than a
 * stream, so it is refused rather than quietly mangled.
 */
function streamFrom(branchName) {
  const name = branchName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (name.length === 0) die(`cannot make a stream name out of the branch "${branchName}"`);
  if (/^[0-9]+$/.test(name)) die(`"${name}" would read as a candidate number, not a stream`);
  return name;
}

// Resolved before the version, because a candidate's version now carries the
// name of the line it belongs to.
const branch = flag("--branch") ?? git("rev-parse", "--abbrev-ref", "HEAD").out;
const stream = flag("--stream") ?? streamFrom(branch);

let version;
if (target === "rc") version = nextRc(pkg.version, null, stream);
else if (["major", "minor", "patch"].includes(target)) version = bumped(pkg.version, target);
else if (["major-rc", "minor-rc", "patch-rc"].includes(target)) {
  version = nextRc(pkg.version, bumped(pkg.version, target.slice(0, -3)), stream);
} else version = target;

// A prerelease part is allowed, and is what keeps a test build out of the main
// update stream: the workflow publishes any tag containing "-" as a GitHub
// prerelease, and /releases/latest - which every released gitc asks for - is
// defined to skip those.
// The hyphen inside the class is semver's, not decoration: a prerelease
// identifier is [0-9A-Za-z-], and stream names come from branch names, which
// have hyphens in them far more often than not.
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  die(`"${version}" is not a version like 1.2.3 or 1.2.3-rc.1`);
}
const prerelease = version.includes("-");

const tag = `v${version}`;
const binary = join(root, "dist", windows ? "gitc.exe" : "gitc");

console.log(`releasing gitc ${version}${dryRun ? "  (dry run)" : ""}`);

// --- 1. preflight ------------------------------------------------------------

step("Checking the ground");

info(`branch ${branch}${prerelease ? `  (prerelease, stream "${stream}")` : ""}`);

// A release candidate is for a branch. Cutting one from master would put a
// version nobody is offered on the branch everybody builds from.
if (prerelease && branch === "master") {
  die("a release candidate is for a branch - pass --branch, or release a plain version");
}

if (!run("gh", ["auth", "status"], { allowFail: true, shell: windows }).ok) {
  die("gh is not authenticated - run `gh auth login`");
}

// A tag that already exists means this version was released, or half-released.
// Either way the answer is a new version number, not a second attempt.
if (git("ls-remote", "--tags", "origin", tag).out.length > 0) {
  die(`${tag} already exists on origin`);
}
if (git("tag", "--list", tag).out.length > 0) {
  die(`${tag} already exists locally - delete it or pick another version`);
}

git("fetch", "origin", "--quiet");
const behind = git("rev-list", "--count", `HEAD..origin/${branch}`).out;
if (behind !== "0") die(`origin/${branch} has ${behind} commit(s) you do not - pull first`);

// --- 2. version --------------------------------------------------------------

step(`Setting the version to ${version}`);

if (pkg.version === version) {
  skip(`package.json already says ${version}`);
} else {
  act(`bump package.json from ${pkg.version} to ${version}`, () => {
    npm(["version", version, "--no-git-tag-version"]);
    info(`package.json ${pkg.version} -> ${version}`);
  });
}

// --- 3. build ----------------------------------------------------------------

step("Building - typecheck, tests, UI, binary");

act("run npm run build", () => {
  // Inherited output: this is the long step, and watching the tests go past is
  // the point of running it locally at all.
  npm(["run", "build"], { quiet: false });

  if (!existsSync(binary)) die(`the build did not produce ${binary}`);
  const reported = run(binary, ["--version"]).out;
  if (reported !== `gitc ${version}`) {
    die(`the binary reports "${reported}" rather than "gitc ${version}"`);
  }
  info(`${reported} - built and self-consistent`);
});

// --- 4. commit ---------------------------------------------------------------

step("Committing");

const dirty = git("status", "--porcelain").out;
if (dirty.length === 0) {
  skip("nothing to commit");
} else {
  let message = `Release ${version}`;
  if (messageFile !== null) message = readFileSync(messageFile, "utf8");
  else if (messageText !== null) message = messageText;

  act(`commit ${dirty.split("\n").length} file(s)`, () => {
    git("add", "-A");

    // --author would set the author and leave the committer as whoever ran
    // this, which shows up as two different names on one commit. Setting the
    // identity for the invocation moves both. Without --author, git's own
    // configuration is used and nothing here overrides it.
    const identity = [];
    if (author !== null) {
      const m = /^\s*(.+?)\s*<(.+?)>\s*$/.exec(author);
      if (m === null) die(`--author should look like "Name <email>", not "${author}"`);
      identity.push("-c", `user.name=${m[1]}`, "-c", `user.email=${m[2]}`);
    }

    git(...identity, "commit", "-q", "-m", message);
    info(git("log", "-1", "--format=%h %an <%ae>%n    %s").out);
  });
}

// --- 5. push -----------------------------------------------------------------

step(`Pushing ${branch}`);

const ahead = git("rev-list", "--count", `origin/${branch}..HEAD`).out;
if (ahead === "0") {
  skip("origin already has this commit");
} else {
  act(`push ${ahead} commit(s)`, () => {
    git("push", "origin", branch);
    info("pushed");
  });
}

// --- workflow helpers --------------------------------------------------------

/** The most recent run of the release workflow, or null. */
function latestRun(event) {
  const r = gh(
    "run", "list",
    "--workflow", WORKFLOW,
    "--event", event,
    "--limit", "1",
    "--json", "databaseId,status,conclusion,createdAt,headBranch",
  );
  const list = JSON.parse(r.out);
  return list.length > 0 ? list[0] : null;
}

/** Waits for a run to appear after `since`, then for it to finish. */
async function waitForRun(event, since, what) {
  let run = null;
  for (let i = 0; i < 30 && run === null; i++) {
    const candidate = latestRun(event);
    if (candidate !== null && new Date(candidate.createdAt).getTime() >= since - 5000) {
      run = candidate;
      break;
    }
    await sleep(2000);
  }
  if (run === null) die(`${what} never appeared in the Actions list`);

  info(`watching run ${run.databaseId}`);
  // gh's own watcher, so a slow build does not look like a hung script.
  const watched = watchRun(run.databaseId);
  if (!watched.ok) {
    die(
      `${what} failed`,
      `see https://github.com/${repoSlug()}/actions/runs/${run.databaseId}`,
    );
  }
  info(`${what} passed`);
  return run.databaseId;
}

function watchRun(id) {
  return run("gh", ["run", "watch", String(id), "--exit-status", "--interval", "10"], {
    allowFail: true,
    quiet: false,
    shell: windows,
  });
}

function repoSlug() {
  return gh("repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner").out;
}

// --- 6. verification build ---------------------------------------------------

step("Verifying the build on the runners");

if (skipVerify) {
  skip("--skip-verify");
} else if (dryRun) {
  info(`would dispatch ${WORKFLOW} on ${branch} and wait for both platforms`);
} else {
  // A manual run builds both platforms and stops before publishing, which is
  // exactly the question worth answering before a tag exists: does this commit
  // compile on Windows and on Linux? Finding out afterwards means deleting a
  // release.
  const at = Date.now();
  gh("workflow", "run", WORKFLOW, "--ref", branch);
  await waitForRun("workflow_dispatch", at, "the verification build");
}

// --- 7. tag ------------------------------------------------------------------

step(`Tagging ${tag}`);

if (!dryRun && !assumeYes && !process.stdin.isTTY) {
  die(
    "refusing to push a tag unattended without --yes",
    "everything up to here can be undone; the tag and its release cannot.",
  );
}

act(`tag ${tag} and push it`, () => {
  git("tag", "-a", tag, "-m", `gitc ${version}`);
  git("push", "origin", tag);
  info(`${tag} pushed - the tagged run publishes the release`);
});

// --- 8. publish and check ----------------------------------------------------

step("Waiting for the release to publish");

if (dryRun) {
  info("would wait for the tagged run, then verify the published assets");
  console.log("\ndry run: nothing was changed.");
  process.exit(0);
}

const at = Date.now();
await waitForRun("push", at, "the release build");

step("Checking what was published");

const wanted = ["gitc", "gitc.exe", "SHA256SUMS"];
const assets = JSON.parse(gh("release", "view", tag, "--json", "assets").out).assets.map(
  (a) => a.name,
);
for (const name of wanted) {
  if (!assets.includes(name)) die(`the release is missing ${name}`, `it has: ${assets.join(", ")}`);
}
info(`assets: ${assets.join(", ")}`);

// Downloads what a user would download and checks it against the checksums
// published beside it. This is the only step that tests the release rather
// than the build - the artifacts could be right and the upload still wrong.
const dir = mkdtempSync(join(tmpdir(), "gitc-release-"));
gh("release", "download", tag, "--dir", dir);

const sums = new Map();
for (const line of readFileSync(join(dir, "SHA256SUMS"), "utf8").trim().split("\n")) {
  const [sum, name] = line.trim().split(/\s+/);
  sums.set(name.replace(/^\*/, ""), sum);
}

for (const name of readdirSync(dir)) {
  if (name === "SHA256SUMS") continue;
  const digest = createHash("sha256").update(readFileSync(join(dir, name))).digest("hex");
  const expected = sums.get(name);
  if (expected === undefined) die(`${name} is not listed in SHA256SUMS`);
  if (digest !== expected) die(`${name} does not match its checksum`, `${digest}\n${expected}`);
  info(`${name} matches its checksum`);
}

// --- 9. put the notes on the release -----------------------------------------

// The workflow's action-gh-release writes the body itself: the download
// instructions, plus the "What's Changed" GitHub generates from pull request
// titles. That is the entire release page for everybody who is not reading
// `git log`, and it does not say what changed - 0.5.0 shipped remote SSH
// repositories and the page credited a pull request.
//
// So the notes this release was committed with go back into the body here,
// above the generated list. It has to be after the publish: the release does
// not exist until the tagged run creates it.
if (messageFile !== null) {
  step("Putting the notes on the release");

  // Both sides are normalised to LF before anything compares them: gh hands
  // back CRLF on Windows, and a body that never matches the notes is a run
  // that appends them a second time every time it is resumed.
  const lf = (text) => text.replace(/\r\n/g, "\n");

  // The leading "# gitc 0.5.0" is dropped - the page is already titled with
  // the version, and a heading repeating it reads as a mistake.
  const notes = lf(readFileSync(messageFile, "utf8")).replace(/^#[^\n]*\n+/, "").trim();
  const body = lf(gh("release", "view", tag, "--json", "body", "-q", ".body").out);

  if (body.includes(notes)) {
    skip("the release already carries them");
  } else {
    const generated = body.indexOf("## What's Changed");
    const merged =
      generated === -1
        ? `${body.trimEnd()}\n\n${notes}\n`
        : `${body.slice(0, generated).trimEnd()}\n\n${notes}\n\n${body.slice(generated)}`;

    const file = join(mkdtempSync(join(tmpdir(), "gitc-notes-")), "notes.md");
    writeFileSync(file, merged);
    gh("release", "edit", tag, "--notes-file", file);
    info("the changelog is on the release page");
  }
}

const url = gh("release", "view", tag, "--json", "url", "-q", ".url").out;
console.log(`\ngitc ${version} is out: ${url}`);
