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

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REPO, VERSION } from "../generated/version.ts";
import { installedBinary } from "./install.ts";

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
 * Downloads the newest binary, puts it in place, and restarts.
 *
 * The swap works because a running executable can be RENAMED on Windows even
 * though it cannot be overwritten - so the old binary is moved aside, the new
 * one takes its name, and the leftover is deleted on the next start. On POSIX
 * replacing the file outright is fine.
 */
export async function apply(): Promise<UpdateResult> {
  const info = check();
  if (info.error.length > 0) return { ok: false, message: info.error, restarting: false };
  if (!info.available) {
    return { ok: false, message: "gitc " + VERSION + " is already the newest version", restarting: false };
  }

  const tag = "v" + info.latest;
  const base = downloadBase(tag);
  const asset = assetName();
  const temp = join(tmpdir(), "gitc-update-" + info.latest + (windows ? ".exe" : ""));

  const downloaded = curl(["-fsSL", "-o", temp, base + asset]);
  if (downloaded === null || !existsSync(temp)) {
    return { ok: false, message: "could not download " + asset + " for " + tag, restarting: false };
  }

  // Verify against the checksums published beside the binary. A release
  // without them still installs - the file came from the same place either
  // way - but a mismatch is a hard stop.
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
      return {
        ok: false,
        message: "the download did not match its published checksum - update cancelled",
        restarting: false,
      };
    }
  }

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

  // Start the new binary and step aside. The window follows: its heartbeat
  // fails against this process and it closes, and the new instance opens its
  // own - which is the restart.
  spawn(target, [], { stdio: "ignore" });
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
