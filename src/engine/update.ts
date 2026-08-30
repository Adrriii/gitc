// Updating gitc from inside gitc.
//
// The binary is one self-contained file, so an update is a download and a
// rename. There is no installer to run and nothing to migrate.
//
// The downloads go through `curl` rather than fetch. fetch drags the TLS and
// compression stack into the link and fails looking for a system zlib (see
// engine/instance.ts for the same lesson), and routing the bytes through the
// browser instead would put a CORS policy between gitc and its own release.
// curl ships with Windows 10 and every Linux worth the name.

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { promisify } from "node:util";

import { REPO, VERSION } from "../generated/version.ts";
import { installedBinary } from "./install.ts";
import { tempFile } from "./paths.ts";
import { compare, isPrerelease, preStream } from "./semver.ts";

const execFileAsync = promisify(execFile);
const windows = process.platform === "win32";

export interface UpdateInfo {
  current: string;
  /**
   * True when taking this means leaving the build stream behind rather than
   * moving forward in it - going back to stable from a release candidate.
   *
   * It is the same install either way; the UI says "switch" rather than
   * "update" so that a version number going DOWN is not read as a mistake.
   */
  switching: boolean;
  /** The newest released version, or "" when it could not be determined. */
  latest: string;
  available: boolean;
  /** Where the release can be read, for the "what changed" link. */
  page: string;
  /** Empty unless something went wrong, in which case it says what. */
  error: string;
  /**
   * The line of development being followed, "" for none.
   *
   * More than one branch can have candidates published at once, and before
   * this the updater compared numbers alone - so tagging a candidate on one
   * branch offered it to every tester on another, whose build had nothing to
   * do with it. A stream is chosen, and only that stream's candidates and
   * ordinary releases are offered.
   */
  stream: string;
  /** Every stream with candidates published, newest first. For the picker. */
  streams: string[];
}

/** Which releases a person wants to be offered. */
export type Channel = "stable" | "test";

/**
 * Where to look for a newer version.
 *
 * The build you are running decides your channel, which is why there is no
 * setting for this. A released gitc asks for /releases/latest, and GitHub
 * defines that as the newest release that is neither a draft nor a
 * prerelease - so a test build is invisible to everyone on a stable one,
 * without any filtering here.
 *
 * A test build asks for the whole list instead, so it sees the next rc AND
 * the stable release that eventually supersedes it. Otherwise installing an
 * rc would be a one-way door: /releases/latest would keep answering with a
 * version older than the one running, and the tester would sit on rc.1 for
 * ever with nothing offering them rc.2.
 */
function apiUrl(channel: Channel): string {
  const custom = process.env["GITC_UPDATE_API"];
  if (custom !== undefined && custom.length > 0) return secureUrl(custom, "GITC_UPDATE_API");
  const base = "https://api.github.com/repos/" + REPO + "/releases";
  // /releases/latest is defined as the newest release that is neither draft
  // nor prerelease, so the stable stream needs no filtering of its own. The
  // test stream asks for the list, which is the only way to see a prerelease
  // at all - and it still sees stable releases, since they are in the list too.
  return channel === "test" ? base + "?per_page=20" : base + "/latest";
}

/**
 * Where the assets themselves come from.
 *
 * GitHub by default, overridable along with the API endpoint so a fork or a
 * self-hosted build can publish somewhere else.
 */
function downloadBase(tag: string): string {
  const custom = process.env["GITC_UPDATE_BASE"];
  if (custom !== undefined && custom.length > 0) {
    const base = secureUrl(custom, "GITC_UPDATE_BASE");
    return base.endsWith("/") ? base + tag + "/" : base + "/" + tag + "/";
  }
  return "https://github.com/" + REPO + "/releases/download/" + tag + "/";
}

/**
 * Refuses an update source that is not https.
 *
 * These two variables exist so a fork or a self-hosted build can publish
 * somewhere else, which is a good reason for them to exist and no reason at
 * all for them to accept "http://". The whole of the trust in an update is
 * that the bytes came from the right host over TLS - the checksums sit beside
 * the binary, so they cannot vouch for it on their own - and a plaintext
 * source hands the next version of the binary to anybody on the path.
 *
 * Loopback is allowed because that is how the release flow is tested, and it
 * is not a network anyone else is on.
 */
function secureUrl(value: string, name: string): string {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("https://")) return trimmed;

  // The loopback exemption compares the parsed host, not a prefix.
  // startsWith("http://127.0.0.1") also accepts
  // "http://127.0.0.1.evil.example/", which is a name anybody can register -
  // and whoever set the variable serves both the binary and the checksums, so
  // fail-closed verification would have passed them happily.
  if (lower.startsWith("http://")) {
    const rest = lower.substring("http://".length);
    const cut = rest.search(/[/:?#]/);
    const host = cut === -1 ? rest : rest.substring(0, cut);
    if (host === "localhost" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return trimmed;
  }

  throw new Error(name + " must be an https URL - refusing to update over " + value);
}

/**
 * A tag as it may appear in a download URL.
 *
 * The tag comes out of the release feed and is pasted straight into a path.
 * Anything with a slash, a dot-dot or a query in it would fetch something
 * other than the release it names, so the shape is checked rather than
 * trusted: versions and tags are letters, digits, dots, dashes, underscores
 * and plus signs, and nothing here has ever needed more.
 */
function safeTag(tag: string): boolean {
  return tag.length > 0 && tag.length <= 100 && /^[A-Za-z0-9._+-]+$/.test(tag) && !tag.includes("..");
}

/** The asset this platform needs from a release. */
function assetName(): string {
  return windows ? "gitc.exe" : "gitc";
}

/** Every tag_name in the answer - one release, or a list of them. */
function tagNames(json: string): string[] {
  const out: string[] = [];
  const needle = '"tag_name":"';
  let from = 0;
  while (true) {
    const at = json.indexOf(needle, from);
    if (at === -1) break;
    const start = at + needle.length;
    const end = json.indexOf('"', start);
    if (end === -1) break;
    out.push(json.substring(start, end));
    from = end;
  }
  return out;
}

/**
 * How long curl may spend before giving up.
 *
 * `--connect-timeout` is the one that matters. With no network at all, a
 * connect attempt sits in DNS resolution and TCP retries for as long as the
 * platform's defaults allow - tens of seconds on Windows - and every second
 * of that used to be a second the engine answered nothing. Five is generous
 * for reaching a host that is actually there.
 *
 * The overall cap is per-call: a metadata request that takes half a minute
 * has failed, while a download legitimately takes as long as the file takes.
 */
const CONNECT_TIMEOUT = ["--connect-timeout", "5"];
const META_TIMEOUT = [...CONNECT_TIMEOUT, "--max-time", "30"];

/**
 * Runs curl, returning stdout or null.
 *
 * `spawn`, not `spawnSync`, and that is the whole point of this function's
 * shape. Every call here talks to the network, which is the one thing that
 * can take arbitrarily long, and a synchronous call blocks the engine's
 * single thread for its whole duration - answering no request at all, not
 * even a ping. The update check runs at launch by default, so on a machine
 * with no network gitc froze on startup for as long as curl took to give up,
 * and the window sat on the new-tab screen unable to open anything.
 *
 * This is the same bargain `run()` in git.ts makes for git, for the same
 * reason and with the same explicit stdio: scriptc has no `close` event, so
 * "exited AND drained" has to be assembled from the parts.
 */
function curl(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("curl", args, {
      stdio: ["ignore", "pipe", "pipe"],
      // Detached for the same reason git is - see run() in git.ts. curl is a
      // console program too, and the update check runs at launch.
      detached: true,
    });

    const out: Uint8Array[] = [];
    let code = 0;
    let exited = false;
    let open = 2;

    const settle = () => {
      if (!exited || open > 0) return;
      resolve(code === 0 ? Buffer.concat(out).toString("utf8") : null);
    };

    const stdout = child.stdout;
    const stderr = child.stderr;
    if (stdout === null || stderr === null) {
      resolve(null);
      return;
    }

    stdout.on("data", (chunk: Buffer) => out.push(chunk));
    stdout.on("end", () => {
      open -= 1;
      settle();
    });
    // Read and discarded: an unread pipe fills and stalls the child, and
    // curl's progress chatter is of no use to anyone here.
    stderr.on("data", () => {});
    stderr.on("end", () => {
      open -= 1;
      settle();
    });

    child.on("exit", (status: number | null) => {
      code = status === null ? 1 : status;
      exited = true;
      settle();
    });
    // curl missing entirely lands here rather than as a non-zero exit.
    child.on("error", () => resolve(null));
  });
}

async function curlAvailable(): Promise<boolean> {
  return (await curl(["--version"])) !== null;
}

/**
 * Pulls one string field out of a JSON document.
 *
 * The release payload is large and mostly irrelevant, and JSON.parse on an
 * unknown shape means describing that shape to the type checker. The two
 * fields that matter are unambiguous in the text.
 */
function field(json: string, key: string): string {
  const needle = "\"" + key + "\":\"";
  const at = json.indexOf(needle);
  if (at === -1) return "";
  const start = at + needle.length;
  const end = json.indexOf("\"", start);
  if (end === -1) return "";
  return json.substring(start, end);
}

/**
 * Every stream with a candidate published, newest first.
 *
 * The window shows these as the choice, so a name only appears once somebody
 * has actually published under it - there is no list to maintain anywhere,
 * and a stream that is finished with stops being offered as soon as its
 * candidates fall out of the page fetched.
 */
function streamsIn(versions: string[]): string[] {
  const newest = new Map<string, string>();
  for (const version of versions) {
    const stream = preStream(version);
    if (stream === null) continue;
    const held = newest.get(stream);
    if (held === undefined || compare(version, held) > 0) newest.set(stream, version);
  }
  const names = [...newest.keys()];
  names.sort((a, b) => {
    const av = newest.get(a) ?? "";
    const bv = newest.get(b) ?? "";
    return compare(bv, av);
  });
  return names;
}

/**
 * The stream to follow, given what the user chose and what this build is.
 *
 * A chosen stream wins. With none chosen, a build that is itself a candidate
 * follows its own line - which is what somebody handed a test build expects,
 * and it means an existing tester is never silently moved onto another
 * branch's work. A released build has no line of its own, so it follows none
 * until one is picked.
 */
function effectiveStream(chosen: string): string {
  if (chosen.length > 0) return chosen;
  return preStream(VERSION) ?? "";
}

export async function check(
  channel: Channel = "stable",
  chosenStream = "",
): Promise<UpdateInfo> {
  const info: UpdateInfo = {
    current: VERSION,
    latest: "",
    switching: false,
    available: false,
    page: REPO.length > 0 ? "https://github.com/" + REPO + "/releases/latest" : "",
    error: "",
    stream: channel === "test" ? effectiveStream(chosenStream) : "",
    streams: [],
  };

  if (REPO.length === 0) {
    info.error = "this build does not know which repository to check";
    return info;
  }
  if (!(await curlAvailable())) {
    info.error = "curl is not available, so gitc cannot check for updates";
    return info;
  }

  // apiUrl refuses a plaintext override, and that refusal is an answer to
  // report rather than a crash in the middle of a poll.
  let endpoint: string;
  try {
    endpoint = apiUrl(channel);
  } catch (e) {
    info.error = (e as Error).message;
    return info;
  }

  const body = await curl([
    ...META_TIMEOUT,
    "-fsSL",
    "-H",
    "accept: application/vnd.github+json",
    "-H",
    "user-agent: gitc/" + VERSION,
    endpoint,
  ]);

  if (body === null) {
    // A repository with no releases answers 404, which is not a failure worth
    // alarming anyone about - there is simply nothing newer.
    info.error = "no published release to compare against";
    return info;
  }

  // The highest, not the first. A list comes back newest-first by DATE, and a
  // stable hotfix published after an rc would otherwise be the only candidate
  // considered - hiding the rc that is actually newer.
  const tags = tagNames(body).filter(safeTag);
  if (tags.length === 0) {
    info.error = "the release could not be read";
    return info;
  }

  const versions: string[] = [];
  for (const tag of tags) versions.push(tag.startsWith("v") ? tag.substring(1) : tag);

  // Every stream with something published, so the window can offer the choice
  // rather than making the user guess a name. Newest first, which puts the
  // line being worked on now at the top.
  info.streams = streamsIn(versions);

  // What this build is willing to be offered.
  //
  // An ordinary release always counts: a tester has to be able to leave a
  // stream by taking the release that supersedes it, and that is the only way
  // off one. A candidate counts only when it belongs to the stream being
  // followed - which is the whole of the fix, since comparing numbers alone
  // is what marched a tester from one branch onto another.
  let best = "";
  for (const version of versions) {
    const stream = preStream(version);
    if (stream !== null) {
      if (info.stream.length === 0 || stream !== info.stream) continue;
    }
    if (best.length === 0 || compare(version, best) > 0) best = version;
  }

  info.latest = best;

  // Ordinarily, newer. But somebody on a release candidate who asks for the
  // stable stream is asking to go BACK to the newest stable, which compares
  // lower than what they are running - so "is it newer" would answer no and
  // strand them on a test build with no way out but a manual download. Leaving
  // the stream is a move they asked for, so it is offered like any other.
  const newer = compare(info.latest, VERSION) > 0;
  const leavingTest = channel === "stable" && isPrerelease(VERSION);
  info.switching = leavingTest && !newer && info.latest !== VERSION;
  info.available = newer || info.switching;
  return info;
}

export interface UpdateResult {
  ok: boolean;
  message: string;
  /** True when gitc is about to restart itself. */
  restarting: boolean;
}

/**
 * A megabyte at a time, so the window keeps being answered.
 *
 * This looks like an odd way to fetch a file, and it is. It was written when
 * the only asynchronous form known to work here was promisify(execFile),
 * which - measured against a running engine - does not actually yield: the
 * loop stops for the whole transfer, every request times out, and a timer
 * watching the file never runs. The first version of this progress bar
 * reported nothing at all, which is how that was caught.
 *
 * Ranged requests turn one long block into several short ones. Between
 * chunks the loop runs, the poll gets answered, and the bar moves. The cost
 * is a handful of extra connections on a file this size.
 *
 * git.ts has since established that spawn WITH PIPED OUTPUT does yield
 * properly, so this could become a single request with a timer watching the
 * file grow. It is left alone deliberately: this is the code path that
 * delivers every future version, it is verified against a host that honours
 * ranges and one that ignores them, and simplifying it buys nothing a user
 * can see.
 */
// Small enough that a request arriving just after a chunk started is not kept
// waiting long for it to end - that wait is the resolution of the progress
// bar, and of everything else the engine owes an answer to. Large enough that
// a release is a handful of requests rather than fifty.
const CHUNK_BYTES = 256 * 1024;

async function download(url: string, temp: string, total: number): Promise<boolean> {
  const agent = "gitc/" + VERSION;
  rmSync(temp, { force: true });

  // No declared length means no chunking worth doing: one request, and the
  // window shows an indeterminate bar rather than a wrong one.
  if (total <= 0) {
    return (await curl([...CONNECT_TIMEOUT, "-fsSL", "-A", agent, "-o", temp, url])) !== null;
  }

  const part = temp + ".part";
  // Held in memory and written once at the end. appendFileSync here takes a
  // string only, and a binary appended as text is a corrupt binary; the file
  // is a couple of megabytes, so keeping it is cheaper than working around
  // that.
  const parts: Uint8Array[] = [];
  let at = 0;

  while (at < total) {
    const end = Math.min(at + CHUNK_BYTES, total) - 1;
    rmSync(part, { force: true });

    if ((await curl([...CONNECT_TIMEOUT, "-fsSL", "-A", agent, "-r", at + "-" + end, "-o", part, url])) === null) {
      rmSync(part, { force: true });
      return false;
    }
    if (!existsSync(part)) return false;

    const size = statSync(part).size;
    if (size === 0) {
      rmSync(part, { force: true });
      return false;
    }

    parts.push(readFileSync(part));
    rmSync(part, { force: true });
    at += size;

    progress = {
      phase: "downloading",
      received: at,
      total,
      message: progress.message,
    };

    // A host that does not honour Range answers with the whole file and a
    // 200. Nothing is wrong with that - the file is complete - but asking for
    // the rest would append it a second time.
    if (size > CHUNK_BYTES) break;

    // Hand the loop back, so everything waiting on this engine gets served
    // before the next chunk. This is the entire point of the exercise.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  writeFileSync(temp, Buffer.concat(parts));
  return existsSync(temp);
}

/**
 * What the update is doing, for the window to show while it happens.
 *
 * An update is a multi-megabyte download over somebody's connection, and
 * before this existed the window simply sat there and then vanished, which is
 * indistinguishable from a crash. The phases are coarse on purpose - the only
 * one that takes real time is the download, and that one is measured.
 */
export interface UpdateProgress {
  phase: "idle" | "checking" | "downloading" | "verifying" | "installing" | "restarting" | "failed";
  /** Bytes fetched so far, and the total when the server declared one. */
  received: number;
  total: number;
  message: string;
}

let progress: UpdateProgress = { phase: "idle", received: 0, total: 0, message: "" };

export function updateProgress(): UpdateProgress {
  return progress;
}

function setPhase(phase: UpdateProgress["phase"], message: string): void {
  progress = { phase, received: progress.received, total: progress.total, message };
}

/**
 * How big the download is, so the bar can be a bar rather than a spinner.
 *
 * A HEAD through the redirects to wherever the asset really lives. Best
 * effort: if anything about it disappoints, the download still runs and the
 * window shows an indeterminate bar instead.
 */
async function contentLength(url: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("curl", ["-sIL", "-A", "gitc/" + VERSION, url], {
      encoding: "utf8",
    });
    let size = 0;
    for (const line of stdout.split(String.fromCharCode(10))) {
      const at = line.toLowerCase().indexOf("content-length:");
      // The last one wins: each hop of the redirect chain sends its own, and
      // the one that matters is the response that carries the bytes.
      if (at === 0) {
        const n = parseInt(line.substring(15).trim(), 10);
        if (!isNaN(n) && n > 0) size = n;
      }
    }
    return size;
  } catch {
    return 0;
  }
}

/**
 * Downloads the newest binary, puts it in place, and restarts.
 *
 * The swap works because a running executable can be RENAMED on Windows even
 * though it cannot be overwritten - so the old binary is moved aside, the new
 * one takes its name, and the leftover is deleted on the next start. On POSIX
 * replacing the file outright is fine.
 */
export async function apply(
  channel: Channel = "stable",
  chosenStream = "",
): Promise<UpdateResult> {
  progress = { phase: "checking", received: 0, total: 0, message: "Checking for the latest release" };

  // The same channel AND the same stream the check offered from, or pressing
  // the button would install something the window never mentioned - which
  // with more than one line of development published is not a hypothetical.
  const info = await check(channel, chosenStream);
  if (info.error.length > 0) {
    setPhase("failed", info.error);
    return { ok: false, message: info.error, restarting: false };
  }
  if (!info.available) {
    const message = "gitc " + VERSION + " is already the newest version on this stream";
    setPhase("failed", message);
    return { ok: false, message, restarting: false };
  }

  const tag = "v" + info.latest;
  if (!safeTag(tag)) {
    const message = "the release tag " + tag + " is not a shape gitc will fetch";
    setPhase("failed", message);
    return { ok: false, message, restarting: false };
  }
  let base: string;
  try {
    base = downloadBase(tag);
  } catch (e) {
    const message = (e as Error).message;
    setPhase("failed", message);
    return { ok: false, message, restarting: false };
  }
  const asset = assetName();
  // In this process's own temp directory. The old name was derived from the
  // release tag, so it was known in advance: on a shared /tmp another account
  // could pre-create it as a symlink, or - worse - swap the verified file for
  // their own between the checksum below and the copy that installs it.
  const temp = tempFile("update-" + info.latest + (windows ? ".exe" : ""));
  const url = base + asset;

  const total = await contentLength(url);
  progress = { phase: "downloading", received: 0, total, message: "Downloading gitc " + info.latest };

  const downloaded = await download(url, temp, total);

  if (!downloaded || !existsSync(temp)) {
    const message = "could not download " + asset + " for " + tag;
    setPhase("failed", message);
    return { ok: false, message, restarting: false };
  }

  // Verify against the checksums published beside the binary. A release
  // without them still installs - the file came from the same place either
  // way - but a mismatch is a hard stop.
  // Fails CLOSED. This check used to be skipped entirely when SHA256SUMS
  // could not be fetched, and again when the file did not list this asset -
  // so the one condition it was meant to catch, somebody able to interfere
  // with the download, was also the condition that switched it off. Whoever
  // can substitute the binary can drop the sums request just as easily.
  //
  // What this does and does not buy is worth being honest about: the sums
  // live beside the binary, so they are integrity against a corrupted or
  // truncated download, not authenticity. HTTPS to the release host is what
  // makes the pair mean anything, and a signature would be what replaces
  // this. Until then, a missing checksum is a refused update.
  setPhase("verifying", "Checking the download against its published checksum");
  const sums = await curl([...META_TIMEOUT, "-fsSL", base + "SHA256SUMS"]);
  if (sums === null) {
    rmSync(temp, { force: true });
    const message = "could not fetch the published checksums for " + tag + " - update cancelled";
    setPhase("failed", message);
    return { ok: false, message, restarting: false };
  }

  const actual = createHash("sha256").update(readFileSync(temp)).digest("hex");
  let expected = "";
  for (const line of sums.split(String.fromCharCode(10))) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && parts[1].replace(/^\*/, "") === asset) expected = parts[0];
  }
  if (expected.length === 0) {
    rmSync(temp, { force: true });
    const message = "the published checksums for " + tag + " do not list " + asset;
    setPhase("failed", message);
    return { ok: false, message, restarting: false };
  }
  if (expected.toLowerCase() !== actual.toLowerCase()) {
    rmSync(temp, { force: true });
    const message = "the download did not match its published checksum - update cancelled";
    setPhase("failed", message);
    return { ok: false, message, restarting: false };
  }

  setPhase("installing", "Putting the new version in place");

  // Prefer the installed copy; a portable run replaces itself where it stands.
  const installed = installedBinary();
  const target = existsSync(installed) ? installed : process.execPath;
  const aside = target + ".old";

  try {
    if (existsSync(aside)) rmSync(aside, { force: true });
    renameSync(target, aside);
  } catch {
    rmSync(temp, { force: true });
    return { ok: false, message: "could not move the current binary aside", restarting: false };
  }

  try {
    writeFileSync(target, readFileSync(temp));
    if (!windows) chmodSync(target, 0o755);
  } catch {
    // Put it back rather than leaving the user with no gitc at all.
    try {
      renameSync(aside, target);
    } catch {
      // Nothing more can be done here; the message says where the copy is.
    }
    rmSync(temp, { force: true });
    return { ok: false, message: "could not write the new binary - the old one is unchanged", restarting: false };
  }

  rmSync(temp, { force: true });

  setPhase("restarting", "Restarting gitc " + info.latest);

  // Start the new binary and step aside.
  //
  // --after-update is not decoration. This process is still listening on the
  // port for the few hundred milliseconds it takes to answer the request and
  // exit, and a plain start would find it, conclude that gitc is already
  // running, hand over and quit - leaving nothing running at all once this
  // one goes. That is exactly what happened: the window closed and never came
  // back. The flag makes the new instance wait for the port to go quiet
  // before deciding anything.
  //
  // detached, so it is not taken down with the process that spawned it.
  spawn(target, ["--after-update"], { stdio: "ignore", detached: true });
  return { ok: true, message: "updated to " + info.latest + " - restarting", restarting: true };
}

/** Removes the binary left aside by a previous update. Called at startup. */
export function cleanupPrevious(): void {
  const aside = installedBinary() + ".old";
  try {
    if (existsSync(aside)) rmSync(aside, { force: true });
  } catch {
    // Still locked by the process that just exited; the next start gets it.
  }
}
