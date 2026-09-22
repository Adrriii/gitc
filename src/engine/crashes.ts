// Crash reports: what went wrong, kept where somebody can find it afterwards.
//
// gitc is a GUI-subsystem binary started from a shortcut, so its stderr goes
// nowhere. A failed request answered 500 into a toast, an engine that died on
// a RangeError took its one line of explanation with it, and a window that
// blanked on a render error left nothing at all. The first question about any
// of them - "what did it say?" - had no answer.
//
// Three sources, because this runtime offers no single hook:
//
//   engine   an API request threw something nobody caught, or a promise
//            rejected with nothing listening
//   window   the UI's own errors, posted here by the window
//   stopped  a previous engine vanished without exiting - found on the next
//            start, from the marker it left behind
//
// The last exists because a fatal throw in scriptc exits 127 straight away:
// no uncaughtException event, and the `exit` hook does not run (measured
// 2026-09-22). So each engine writes a marker when it starts and removes it
// on every exit the runtime does report. A marker still there, belonging to
// an engine that no longer answers, is an engine that died - or was killed,
// which from here looks the same. The message is lost in that case; the time
// and version are not.
//
// No stack traces in the engine's reports: scriptc does not capture them. The
// window's reports carry the browser's, which are real.
//
// One file per report rather than one growing list: two engines sharing this
// directory (a dev engine beside the installed one) would otherwise rewrite
// each other's copy, and a report is written from the moment things are going
// wrong, which is the worst time to read-modify-write anything.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { VERSION } from "../generated/version.ts";
import { at } from "./safe.ts";

export interface CrashReport {
  /** The file name without its extension; what the window deletes by. */
  id: string;
  /** ISO 8601, UTC. */
  time: string;
  version: string;
  platform: string;
  source: string;
  message: string;
  /** Where it happened and anything else worth keeping - free text. */
  detail: string;
}

/** Oldest reports go past this. A loop that throws should not fill a disk. */
const KEEP = 50;

/** Report files are named by us; anything else in the directory is not one. */
const ID_SHAPE = /^[0-9TZ-]+-[a-z]+(-[0-9]+)?$/;

// The same directory as session.json, spelled the same way - see the note in
// approvals.ts on why each of these files keeps its own copy.
function configDir(): string {
  const appData = process.env["APPDATA"];
  if (appData !== undefined && appData.length > 0) return join(appData, "gitc");
  const home = process.env["HOME"];
  if (home !== undefined && home.length > 0) return join(home, ".config", "gitc");
  return ".gitc";
}

/** Where reports are written. Shown in Preferences so they can be attached. */
export function crashDir(): string {
  return join(configDir(), "crashes");
}

function ensureDir(): string {
  const dir = crashDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Identical reports written by this process, so a failing poll records once.
 *
 * /api/watch runs every second or two; a bug in it would otherwise write a
 * report on every tick and push every other one out of the list within a
 * minute.
 */
const written = new Set<string>();

/** Writes one report. Never throws: failing to log must not become the crash. */
export function recordCrash(source: string, message: string, detail: string): void {
  const key = source + "|" + message + "|" + detail;
  if (written.has(key)) return;
  written.add(key);
  writeReport(new Date().toISOString(), VERSION, source, message, detail);
}

function writeReport(
  time: string,
  version: string,
  source: string,
  message: string,
  detail: string,
): void {
  try {
    const dir = ensureDir();
    // Colons are not allowed in a Windows file name, and the dot before the
    // milliseconds would read as an extension.
    const stamp = time.replace(/[:.]/g, "-");
    let id = stamp + "-" + source;
    let n = 1;
    while (existsSync(join(dir, id + ".json"))) {
      n += 1;
      id = stamp + "-" + source + "-" + String(n);
    }
    const report: CrashReport = {
      id,
      time,
      version,
      platform: process.platform + " " + process.arch,
      source,
      message,
      detail,
    };
    writeFileSync(join(dir, id + ".json"), JSON.stringify(report), "utf8");
    prune(dir);
  } catch {
    // Nowhere left to say it.
  }
}

function reportIds(dir: string): string[] {
  const ids: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const id = name.substring(0, name.length - 5);
    if (ID_SHAPE.test(id)) ids.push(id);
  }
  // The names start with the time, so this is oldest first.
  ids.sort();
  return ids;
}

function prune(dir: string): void {
  const ids = reportIds(dir);
  for (let i = 0; i < ids.length - KEEP; i++) {
    const id = at(ids, i);
    if (id !== undefined) unlinkSync(join(dir, id + ".json"));
  }
}

/** Every report, newest first. A file that will not parse is skipped. */
export function listCrashes(): CrashReport[] {
  const out: CrashReport[] = [];
  const dir = crashDir();
  if (!existsSync(dir)) return out;
  const ids = reportIds(dir);
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = at(ids, i);
    if (id === undefined) continue;
    try {
      const r = JSON.parse(readFileSync(join(dir, id + ".json"), "utf8")) as CrashReport;
      out.push({
        id,
        time: r.time,
        version: r.version,
        platform: r.platform,
        source: r.source,
        message: r.message,
        detail: r.detail,
      });
    } catch {
      // Half-written by an engine that died mid-report. Nothing to show.
    }
  }
  return out;
}

/**
 * Deletes one report, or all of them when `id` is empty.
 *
 * The id is checked against the shape this module writes and against the
 * directory's own listing, so it cannot name any other file.
 */
export function clearCrashes(id: string): void {
  const dir = crashDir();
  if (!existsSync(dir)) return;
  for (const known of reportIds(dir)) {
    if (id.length === 0 || known === id) unlinkSync(join(dir, known + ".json"));
  }
}

// ------------------------------------------------------------ the marker

interface Marker {
  pid: number;
  port: number;
  started: string;
  version: string;
}

const MARKER_PREFIX = "running-";

function markerPath(pid: number): string {
  return join(crashDir(), MARKER_PREFIX + String(pid) + ".txt");
}

/**
 * Says "an engine is running here" until it exits in a way we get to see.
 *
 * Removed from the `exit` hook, which runs for process.exit and for a clean
 * end of the loop - every exit except the ones worth reporting.
 */
export function markRunning(port: number): void {
  try {
    ensureDir();
    const m: Marker = {
      pid: process.pid,
      port,
      started: new Date().toISOString(),
      version: VERSION,
    };
    const path = markerPath(process.pid);
    writeFileSync(path, JSON.stringify(m), "utf8");
    process.on("exit", () => {
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch {
        // Leaves a marker behind, which reads as a crash next time. Better
        // than throwing from an exit hook.
      }
    });
  } catch {
    // No marker, no report if this engine dies. Everything else still works.
  }
}

/**
 * Turns markers left by engines that are gone into reports.
 *
 * `alive` asks whether anything still answers on a port - a marker on some
 * other port may belong to a dev engine that is very much running. One on
 * our own port cannot be: we just bound it.
 */
export async function reportStaleMarkers(
  ourPort: number,
  alive: (port: number) => Promise<boolean>,
): Promise<void> {
  const dir = crashDir();
  if (!existsSync(dir)) return;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(MARKER_PREFIX) || !name.endsWith(".txt")) continue;
    const path = join(dir, name);
    if (path === markerPath(process.pid)) continue;
    let m: Marker | null = null;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Marker;
      m = { pid: parsed.pid, port: parsed.port, started: parsed.started, version: parsed.version };
    } catch {
      m = null;
    }
    if (m !== null && m.port !== ourPort && (await alive(m.port))) continue;
    try {
      unlinkSync(path);
    } catch {
      continue;
    }
    if (m === null) continue;
    writeReport(
      new Date().toISOString(),
      m.version,
      "stopped",
      "gitc stopped without shutting down",
      "The engine started at " + m.started + " (process " + String(m.pid) + ", port " +
        String(m.port) + ") ended without exiting normally: it crashed, or it was killed. " +
        "Its own error message went to a console nobody could see.",
    );
  }
}
