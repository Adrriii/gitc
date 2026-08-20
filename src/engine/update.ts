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

import { execFile, spawn, spawnSync } from "node:child_process";
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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { REPO, VERSION } from "../generated/version.ts";
import { installedBinary } from "./install.ts";

const execFileAsync = promisify(execFile);
const windows = process.platform === "win32";

export interface UpdateInfo {
  current: string;
  /** The newest released version, or "" when it could not be determined. */
  latest: string;
  available: boolean;
  /** Where the release can be read, for the "what changed" link. */
  page: string;
  /** Empty unless something went wrong, in which case it says what. */
  error: string;
}

/**
 * Where releases are published.
 *
 * GitHub by default, overridable so a fork or a self-hosted build can point
 * somewhere else - the same reason automouse publishes to its own CDN. The API
 * endpoint must answer with a `tag_name`, and the download base must hold the
 * per-platform asset and optionally SHA256SUMS.
 */
function apiUrl(): string {
  const custom = process.env["GITC_UPDATE_API"];
  if (custom !== undefined && custom.length > 0) return custom;
  return "https://api.github.com/repos/" + REPO + "/releases/latest";
}

function downloadBase(tag: string): string {
  const custom = process.env["GITC_UPDATE_BASE"];
  if (custom !== undefined && custom.length > 0) {
    return custom.endsWith("/") ? custom + tag + "/" : custom + "/" + tag + "/";
  }
  return "https://github.com/" + REPO + "/releases/download/" + tag + "/";
}

/** The asset this platform needs from a release. */
function assetName(): string {
  return windows ? "gitc.exe" : "gitc";
}

/** Compares two dotted versions numerically. Returns >0 when a is newer. */
function compare(a: string, b: string): number {
  const left = a.split(".");
  const right = b.split(".");
  for (let i = 0; i < 3; i++) {
    const l = parseInt(left[i] ?? "0", 10);
    const r = parseInt(right[i] ?? "0", 10);
    const lv = isNaN(l) ? 0 : l;
    const rv = isNaN(r) ? 0 : r;
    if (lv !== rv) return lv - rv;
  }
  return 0;
}

/** Runs curl, returning stdout or null. */
function curl(args: string[]): string | null {
  // No maxBuffer here: spawnSync does not take one. Nothing read through this
  // is large - the binary itself is downloaded to a file with -o, not piped.
  const r = spawnSync("curl", args, { encoding: "utf8" });
  if (r.status !== 0) return null;
  return r.stdout;
}

function curlAvailable(): boolean {
  const r = spawnSync("curl", ["--version"], { encoding: "utf8" });
  return r.status === 0;
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

export function check(): UpdateInfo {
  const info: UpdateInfo = {
    current: VERSION,
    latest: "",
    available: false,
    page: REPO.length > 0 ? "https://github.com/" + REPO + "/releases/latest" : "",
    error: "",
  };

  if (REPO.length === 0) {
    info.error = "this build does not know which repository to check";
    return info;
  }
  if (!curlAvailable()) {
    info.error = "curl is not available, so gitc cannot check for updates";
    return info;
  }

  const body = curl([
    "-fsSL",
    "-H",
    "accept: application/vnd.github+json",
    "-H",
    "user-agent: gitc/" + VERSION,
    apiUrl(),
  ]);

  if (body === null) {
    // A repository with no releases answers 404, which is not a failure worth
    // alarming anyone about - there is simply nothing newer.
    info.error = "no published release to compare against";
    return info;
  }

  const tag = field(body, "tag_name");
  if (tag.length === 0) {
    info.error = "the release could not be read";
    return info;
  }

  info.latest = tag.startsWith("v") ? tag.substring(1) : tag;
  info.available = compare(info.latest, VERSION) > 0;
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
    return curl(["-fsSL", "-A", agent, "-o", temp, url]) !== null;
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

    if (curl(["-fsSL", "-A", agent, "-r", at + "-" + end, "-o", part, url]) === null) {
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
export async function apply(): Promise<UpdateResult> {
  progress = { phase: "checking", received: 0, total: 0, message: "Checking for the latest release" };

  const info = check();
  if (info.error.length > 0) {
    setPhase("failed", info.error);
    return { ok: false, message: info.error, restarting: false };
  }
  if (!info.available) {
    const message = "gitc " + VERSION + " is already the newest version";
    setPhase("failed", message);
    return { ok: false, message, restarting: false };
  }

  const tag = "v" + info.latest;
  const base = downloadBase(tag);
  const asset = assetName();
  const temp = join(tmpdir(), "gitc-update-" + info.latest + (windows ? ".exe" : ""));
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
  setPhase("verifying", "Checking the download against its published checksum");
  const sums = curl(["-fsSL", base + "SHA256SUMS"]);
  if (sums !== null) {
    const actual = createHash("sha256").update(readFileSync(temp)).digest("hex");
    let expected = "";
    for (const line of sums.split(String.fromCharCode(10))) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2 && parts[1].replace(/^\*/, "") === asset) expected = parts[0];
    }
    if (expected.length > 0 && expected.toLowerCase() !== actual.toLowerCase()) {
      rmSync(temp, { force: true });
      const message = "the download did not match its published checksum - update cancelled";
      setPhase("failed", message);
      return { ok: false, message, restarting: false };
    }
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
