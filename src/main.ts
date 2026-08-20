// gitc entry point.
//
// Serves the UI over loopback and opens a Chromium browser in --app mode,
// which gives a chromeless window without needing a GUI toolkit - see
// docs/toolchain.md for why that is the shape of this program.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";

import {
  readCommits,
  readStatus,
  readCommitFiles,
  readRangeFiles,
  isRepo,
  repoRoot,
} from "./engine/git.ts";
import { buildGraph, LANE_COLORS } from "./engine/graph.ts";
import { runOp } from "./engine/ops.ts";
import { fingerprint } from "./engine/watch.ts";
import {
  readConflictState,
  readConflictVersions,
  resolveWithContent,
  resolveWithSide,
  markAllResolved,
  unresolve,
} from "./engine/conflicts.ts";
import type { OpRequest } from "./engine/ops.ts";
import {
  stagePaths,
  stageAll,
  unstagePaths,
  unstageAll,
  discardPaths,
  commit,
  headMessage,
} from "./engine/actions.ts";
import {
  diffCommitFile,
  diffRangeFile,
  diffWorkingFile,
  FULL_CONTEXT,
} from "./engine/diff.ts";
import { readHead, readRefs, readPending, readRemotes } from "./engine/refs.ts";
import { loadHidden, saveHidden } from "./engine/visibility.ts";
import { NAME, VERSION } from "./generated/version.ts";
import { loadSession, saveSession, touchRecent } from "./state.ts";
import { at } from "./engine/safe.ts";
import type { Session, Tab } from "./state.ts";
import { bakedAsset } from "./generated/assets.ts";

const DEFAULT_PORT = 7893;
const DEFAULT_LIMIT = 2000;

let session: Session = loadSession();

// Liveness. The browser-exit hook above is the primary signal; this is the
// backstop for the cases it can't see - a killed renderer, a crashed tab, or
// a browser that forked in a way that detaches the process we spawned.
let lastPing = 0;
let sawFirstPing = false;
const PING_TIMEOUT_MS = 10000;
const HANDOFF_GRACE_MS = 3000;

// --------------------------------------------------------------- avatars

/** Where a user drops images to override an author's avatar. */
function avatarDir(): string {
  const appData = process.env["APPDATA"];
  if (appData !== undefined && appData.length > 0) return join(appData, "gitc", "avatars");
  const home = process.env["HOME"];
  if (home !== undefined && home.length > 0) return join(home, ".config", "gitc", "avatars");
  return join(".gitc", "avatars");
}

function avatarType(file: string): string {
  const lower = file.toLowerCase();
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/png";
}

/**
 * Finds an override image for an email.
 *
 * Two spellings are accepted so the file is easy to name by hand: the address
 * as-is, and the address with everything outside [a-z0-9.@_-] replaced by "_"
 * for filesystems that dislike the original.
 */
function findAvatarOverride(email: string): string | null {
  const lower = email.trim().toLowerCase();
  if (lower.length === 0) return null;

  const dir = avatarDir();
  if (!existsSync(dir)) return null;

  const safe = lower.replace(/[^a-z0-9.@_-]/g, "_");
  const stems = [lower, safe];
  const exts = [".png", ".jpg", ".jpeg", ".svg", ".gif", ".webp"];

  for (const stem of stems) {
    for (const ext of exts) {
      const candidate = join(dir, stem + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------- assets

/**
 * UI assets are compiled into the binary. In dev the on-disk copies win, so
 * editing the frontend doesn't need a recompile.
 */
function asset(name: string): string | null {
  const devPath = join(process.cwd(), "build", "ui", name);
  if (existsSync(devPath)) return readFileSync(devPath, "utf8");
  return bakedAsset(name);
}

function contentType(name: string): string {
  if (name.endsWith(".html")) return "text/html; charset=utf-8";
  if (name.endsWith(".css")) return "text/css; charset=utf-8";
  if (name.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "text/plain; charset=utf-8";
}

// ------------------------------------------------------------------ api

interface ApiPerson {
  name: string;
  email: string;
}

interface ApiCommit {
  hash: string;
  parents: string[];
  subject: string;
  body: string;
  author: string;
  email: string;
  date: number;
  lane: number;
  color: number;
  refs: string[];
  coAuthors: ApiPerson[];
}

function findTab(id: string): Tab | null {
  for (const t of session.tabs) {
    if (t.id === id) return t;
  }
  return null;
}

async function graphPayload(tab: Tab, limit: number): Promise<string> {
  const head = readHead(tab.path);
  const refs = readRefs(tab.path);

  // Hidden refs still LIST in the sidebar - you need somewhere to click to
  // bring them back - they just do not contribute commits to the walk.
  const hidden = loadHidden(tab.path);
  const revs: string[] = [];
  if (hidden.length > 0) {
    for (const ref of refs) {
      if (!hidden.includes(ref.short)) revs.push(ref.name);
    }
    // Everything hidden means an empty list, which readCommits would read as
    // "no filter at all". A ref that resolves to nothing keeps the walk empty
    // and leaves HEAD as the only thing on screen, which is the honest answer.
    if (revs.length === 0) revs.push("HEAD");
  }

  const commits = await readCommits(tab.path, limit, revs);
  const rows = buildGraph(commits);

  // Chips for the graph rows. Hidden refs are left out: dropping the commits
  // only they reach is not enough, because a hidden branch pointing at a
  // commit some visible branch also reaches would keep its chip on that row -
  // "hide in the graph" has to mean the label too, not just the commits.
  const byHash = new Map<string, string[]>();
  for (const ref of refs) {
    if (hidden.includes(ref.short)) continue;
    const list = byHash.get(ref.hash);
    if (list === undefined) byHash.set(ref.hash, [ref.kind + ":" + ref.short]);
    else list.push(ref.kind + ":" + ref.short);
  }

  const out: ApiCommit[] = [];
  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    const r = at(rows, i);
    if (r === undefined) continue;
    const chips = byHash.get(c.hash);
    out.push({
      hash: c.hash,
      parents: c.parents,
      subject: c.subject,
      body: c.body,
      author: c.author,
      email: c.email,
      date: c.date,
      lane: r.lane,
      color: r.color,
      refs: chips === undefined ? [] : chips,
      coAuthors: c.coAuthors,
    });
  }

  const status = await readStatus(tab.path);

  // Conflicted files mean the in-progress operation needs resolving before it
  // can continue; that is the difference between "continue" and "resolve".
  const pending = readPending(tab.path);
  for (const f of status) {
    if (f.index === "U" || f.worktree === "U" ||
        (f.index === "A" && f.worktree === "A") ||
        (f.index === "D" && f.worktree === "D")) {
      pending.conflicted = true;
    }
  }

  // A conflicted `stash pop` leaves unmerged entries and no marker file at
  // all. Without this the index is conflicted while gitc reports nothing
  // pending, and the user is left with a broken working tree and no UI.
  if (pending.conflicted && pending.kind.length === 0) pending.kind = "unmerged";

  const remoteInfo = readRemotes(tab.path);
  const upstream =
    head.branch === null ? null : (remoteInfo.upstreams.get(head.branch) ?? null);

  return JSON.stringify({
    head,
    remotes: remoteInfo.remotes,
    remoteDetail: remoteInfo.detail,
    upstream,
    refs,
    commits: out,
    rows,
    status,
    pending,
    hidden,
    colors: LANE_COLORS,
  });
}

function send(res: import("node:http").ServerResponse, code: number, type: string, body: string): void {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

function sendJson(res: import("node:http").ServerResponse, body: string): void {
  send(res, 200, "application/json; charset=utf-8", body);
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString();
    });
    req.on("end", () => resolve(data));
  });
}

interface OpenRequest {
  path: string;
}
interface PathsRequest {
  id: string;
  paths: string[];
}
interface DiscardRequest {
  id: string;
  tracked: string[];
  untracked: string[];
}
interface ResolveRequest {
  id: string;
  path: string;
  /** ours | theirs | delete, when taking a side wholesale. */
  side: string;
  /** Full file content, when resolving by editing. */
  content: string;
  /** Every conflicted path, for "mark all resolved". */
  paths: string[];
}
interface GitOpRequest {
  id: string;
  op: string;
  ref: string;
  shas: string[];
  name: string;
  mode: string;
  message: string;
  remote: string;
  force: boolean;
  checkout: boolean;
}
interface CommitRequest {
  id: string;
  summary: string;
  description: string;
  amend: boolean;
}
interface IdRequest {
  id: string;
}

interface HiddenRequest {
  id: string;
  /** The complete hidden set, not a delta - the UI owns the toggling. */
  hidden: string[];
}

let nextTabId = 1;
function makeId(): string {
  const id = "t" + nextTabId;
  nextTabId += 1;
  return id;
}

async function openRepo(path: string): Promise<Tab | null> {
  if (!(await isRepo(path))) return null;
  const root = await repoRoot(path);
  const resolved = root === null ? path : root;
  for (const t of session.tabs) {
    if (t.path !== resolved) continue;
    // Already open: focus it rather than silently doing nothing. Opening a
    // repo should always end with that repo in front.
    session.activeId = t.id;
    touchRecent(session, t);
    saveSession(session);
    return t;
  }
  const tab: Tab = { id: makeId(), name: basename(resolved), path: resolved };
  session.tabs.push(tab);
  session.activeId = tab.id;
  touchRecent(session, tab);
  saveSession(session);
  return tab;
}

async function handleApi(
  path: string,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<boolean> {
  // Local avatar overrides: drop <something>.png into %APPDATA%/gitc/avatars
  // and it wins over any remote lookup. This is how you give an identity a
  // face that Gravatar has never heard of - bots and agents mostly - without
  // gitc shipping anyone else's logo.
  if (path.startsWith("/api/avatar")) {
    const q = path.indexOf("?");
    const params = q === -1 ? "" : path.substring(q + 1);
    let email = "";
    for (const pair of params.split("&")) {
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      if (pair.substring(0, eq) === "email") email = decodeURIComponent(pair.substring(eq + 1));
    }
    const file = findAvatarOverride(email);
    if (file === null) {
      send(res, 404, "text/plain", "no override");
      return true;
    }
    res.writeHead(200, {
      "content-type": avatarType(file),
      "cache-control": "no-store",
    });
    res.end(readFileSync(file));
    return true;
  }

  // Polled by the UI while its window is focused. Returns a value that
  // changes whenever the repository does, so the UI can refresh on edits made
  // anywhere - an editor, a terminal, a build - not only its own actions.
  if (path.startsWith("/api/watch")) {
    const q = path.indexOf("?");
    const params = q === -1 ? "" : path.substring(q + 1);
    let id = "";
    for (const pair of params.split("&")) {
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      if (pair.substring(0, eq) === "id") id = pair.substring(eq + 1);
    }
    const tab = findTab(id);
    if (tab === null) {
      send(res, 404, "application/json", JSON.stringify({ error: "no such tab" }));
      return true;
    }
    lastPing = Date.now();
    sawFirstPing = true;
    try {
      sendJson(res, JSON.stringify({ version: await fingerprint(tab.path) }));
    } catch (e) {
      const err = e as Error;
      send(res, 500, "application/json", JSON.stringify({ error: err.message }));
    }
    return true;
  }

  if (path === "/api/ping") {
    lastPing = Date.now();
    sawFirstPing = true;
    sendJson(res, "{\"ok\":true}");
    return true;
  }

  if (path === "/api/session") {
    sendJson(res, JSON.stringify(session));
    return true;
  }

  if (path === "/api/open") {
    const body = JSON.parse(await readBody(req)) as OpenRequest;
    const tab = await openRepo(body.path);
    if (tab === null) {
      send(res, 400, "application/json", JSON.stringify({ error: "not a git repository" }));
      return true;
    }
    sendJson(res, JSON.stringify({ tab, session }));
    return true;
  }

  if (path === "/api/close") {
    const body = JSON.parse(await readBody(req)) as IdRequest;
    session.tabs = session.tabs.filter((t) => t.id !== body.id);
    if (session.activeId === body.id) {
      const head = at(session.tabs, 0);
      session.activeId = head === undefined ? null : head.id;
    }
    saveSession(session);
    sendJson(res, JSON.stringify(session));
    return true;
  }

  if (path === "/api/hidden") {
    const body = JSON.parse(await readBody(req)) as HiddenRequest;
    const tab = findTab(body.id);
    if (tab === null) {
      send(res, 404, "application/json", JSON.stringify({ error: "no such tab" }));
      return true;
    }
    saveHidden(tab.path, body.hidden);
    sendJson(res, await graphPayload(tab, DEFAULT_LIMIT));
    return true;
  }

  if (path === "/api/activate") {
    const body = JSON.parse(await readBody(req)) as IdRequest;
    session.activeId = body.id;
    const tab = findTab(body.id);
    if (tab !== null) touchRecent(session, tab);
    saveSession(session);
    sendJson(res, JSON.stringify(session));
    return true;
  }

  if (path.startsWith("/api/graph")) {
    const q = path.indexOf("?");
    const params = q === -1 ? "" : path.substring(q + 1);
    let id = "";
    let limit = DEFAULT_LIMIT;
    for (const pair of params.split("&")) {
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      const key = pair.substring(0, eq);
      const value = pair.substring(eq + 1);
      if (key === "id") id = value;
      if (key === "limit") limit = parseInt(value, 10);
    }
    const tab = findTab(id);
    if (tab === null) {
      send(res, 404, "application/json", JSON.stringify({ error: "no such tab" }));
      return true;
    }
    try {
      sendJson(res, await graphPayload(tab, limit));
    } catch (e) {
      const err = e as Error;
      send(res, 500, "application/json", JSON.stringify({ error: err.message }));
    }
    return true;
  }

  // --- mutations ----------------------------------------------------------
  //
  // Each returns the fresh working-tree status so the panel can update from
  // one round trip instead of a mutation followed by a re-read.

  if (path === "/api/stage" || path === "/api/unstage") {
    const body = JSON.parse(await readBody(req)) as PathsRequest;
    const tab = findTab(body.id);
    if (tab === null) {
      send(res, 404, "application/json", JSON.stringify({ error: "no such tab" }));
      return true;
    }
    try {
      const all = body.paths.length === 0;
      if (path === "/api/stage") {
        if (all) await stageAll(tab.path);
        else await stagePaths(tab.path, body.paths);
      } else {
        if (all) await unstageAll(tab.path);
        else await unstagePaths(tab.path, body.paths);
      }
      const status = await readStatus(tab.path);
      sendJson(res, JSON.stringify({ status }));
    } catch (e) {
      const err = e as Error;
      send(res, 500, "application/json", JSON.stringify({ error: err.message }));
    }
    return true;
  }

  if (path === "/api/discard") {
    const body = JSON.parse(await readBody(req)) as DiscardRequest;
    const tab = findTab(body.id);
    if (tab === null) {
      send(res, 404, "application/json", JSON.stringify({ error: "no such tab" }));
      return true;
    }
    try {
      await discardPaths(tab.path, body.tracked, body.untracked);
      const status = await readStatus(tab.path);
      sendJson(res, JSON.stringify({ status }));
    } catch (e) {
      const err = e as Error;
      send(res, 500, "application/json", JSON.stringify({ error: err.message }));
    }
    return true;
  }

  if (path.startsWith("/api/conflicts")) {
    const q = path.indexOf("?");
    const params = q === -1 ? "" : path.substring(q + 1);
    let id = "";
    for (const pair of params.split("&")) {
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      if (pair.substring(0, eq) === "id") id = pair.substring(eq + 1);
    }
    const tab = findTab(id);
    if (tab === null) {
      send(res, 404, "application/json", JSON.stringify({ error: "no such tab" }));
      return true;
    }
    try {
      const pending = readPending(tab.path);
      const state = await readConflictState(tab.path, pending.kind);
      sendJson(res, JSON.stringify(state));
    } catch (e) {
      const err = e as Error;
      send(res, 500, "application/json", JSON.stringify({ error: err.message }));
    }
    return true;
  }

  if (path.startsWith("/api/conflict?")) {
    const q = path.indexOf("?");
    const params = path.substring(q + 1);
    let id = "";
    let file = "";
    for (const pair of params.split("&")) {
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      const key = pair.substring(0, eq);
      const value = decodeURIComponent(pair.substring(eq + 1));
      if (key === "id") id = value;
      if (key === "path") file = value;
    }
    const tab = findTab(id);
    if (tab === null) {
      send(res, 404, "application/json", JSON.stringify({ error: "no such tab" }));
      return true;
    }
    try {
      sendJson(res, JSON.stringify(await readConflictVersions(tab.path, file)));
    } catch (e) {
      const err = e as Error;
      send(res, 500, "application/json", JSON.stringify({ error: err.message }));
    }
    return true;
  }

  if (path === "/api/resolve") {
    const body = JSON.parse(await readBody(req)) as ResolveRequest;
    const tab = findTab(body.id);
    if (tab === null) {
      send(res, 404, "application/json", JSON.stringify({ error: "no such tab" }));
      return true;
    }
    try {
      if (body.paths.length > 0) {
        await markAllResolved(tab.path, body.paths);
      } else if (body.side === "unresolve") {
        await unresolve(tab.path, body.path);
      } else if (body.side.length > 0) {
        await resolveWithSide(tab.path, body.path, body.side);
      } else {
        await resolveWithContent(tab.path, body.path, body.content);
      }
      const pending = readPending(tab.path);
      sendJson(res, JSON.stringify(await readConflictState(tab.path, pending.kind)));
    } catch (e) {
      const err = e as Error;
      send(res, 500, "application/json", JSON.stringify({ error: err.message }));
    }
    return true;
  }

  if (path === "/api/op") {
    const body = JSON.parse(await readBody(req)) as GitOpRequest;
    const tab = findTab(body.id);
    if (tab === null) {
      send(res, 404, "application/json", JSON.stringify({ error: "no such tab" }));
      return true;
    }
    const opReq: OpRequest = {
      op: body.op,
      ref: body.ref,
      shas: body.shas,
      name: body.name,
      mode: body.mode,
      message: body.message,
      remote: body.remote,
      force: body.force,
      checkout: body.checkout,
    };
    try {
      const result = await runOp(tab.path, opReq);
      sendJson(res, JSON.stringify(result));
    } catch (e) {
      const err = e as Error;
      send(res, 500, "application/json", JSON.stringify({ error: err.message }));
    }
    return true;
  }

  if (path === "/api/commit") {
    const body = JSON.parse(await readBody(req)) as CommitRequest;
    const tab = findTab(body.id);
    if (tab === null) {
      send(res, 404, "application/json", JSON.stringify({ error: "no such tab" }));
      return true;
    }
    try {
      const result = await commit(tab.path, body.summary, body.description, body.amend);
      sendJson(res, JSON.stringify(result));
    } catch (e) {
      const err = e as Error;
      send(res, 500, "application/json", JSON.stringify({ error: err.message }));
    }
    return true;
  }

  if (path.startsWith("/api/headmessage")) {
    const q = path.indexOf("?");
    const params = q === -1 ? "" : path.substring(q + 1);
    let id = "";
    for (const pair of params.split("&")) {
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      if (pair.substring(0, eq) === "id") id = pair.substring(eq + 1);
    }
    const tab = findTab(id);
    if (tab === null) {
      send(res, 404, "application/json", JSON.stringify({ error: "no such tab" }));
      return true;
    }
    const msg = await headMessage(tab.path);
    sendJson(res, JSON.stringify(msg === null ? { summary: "", description: "" } : msg));
    return true;
  }

  if (path.startsWith("/api/diff")) {
    const q = path.indexOf("?");
    const params = q === -1 ? "" : path.substring(q + 1);
    let id = "";
    let sha = "";
    let from = "";
    let to = "";
    let file = "";
    let mode = "";
    let whole = false;
    let untracked = false;
    for (const pair of params.split("&")) {
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      const key = pair.substring(0, eq);
      const value = decodeURIComponent(pair.substring(eq + 1));
      if (key === "id") id = value;
      if (key === "sha") sha = value;
      if (key === "from") from = value;
      if (key === "to") to = value;
      if (key === "path") file = value;
      if (key === "mode") mode = value;
      if (key === "whole") whole = value === "1";
      if (key === "untracked") untracked = value === "1";
    }
    const tab = findTab(id);
    if (tab === null) {
      send(res, 404, "application/json", JSON.stringify({ error: "no such tab" }));
      return true;
    }
    // Inline and Split need the entire file; Unified only wants the hunks.
    const context = whole ? FULL_CONTEXT : 3;
    try {
      if (mode === "wip" || mode === "staged") {
        const d = await diffWorkingFile(tab.path, file, mode === "staged", context, untracked);
        sendJson(res, JSON.stringify(d));
      } else if (from.length > 0 && to.length > 0) {
        const d = await diffRangeFile(tab.path, from, to, file, context);
        sendJson(res, JSON.stringify(d));
      } else {
        const d = await diffCommitFile(tab.path, sha, file, context);
        sendJson(res, JSON.stringify(d));
      }
    } catch (e) {
      const err = e as Error;
      send(res, 500, "application/json", JSON.stringify({ error: err.message }));
    }
    return true;
  }

  if (path.startsWith("/api/range")) {
    const q = path.indexOf("?");
    const params = q === -1 ? "" : path.substring(q + 1);
    let id = "";
    let from = "";
    let to = "";
    for (const pair of params.split("&")) {
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      const key = pair.substring(0, eq);
      const value = pair.substring(eq + 1);
      if (key === "id") id = value;
      if (key === "from") from = value;
      if (key === "to") to = value;
    }
    const tab = findTab(id);
    if (tab === null) {
      send(res, 404, "application/json", JSON.stringify({ error: "no such tab" }));
      return true;
    }
    try {
      const files = await readRangeFiles(tab.path, from, to);
      sendJson(res, JSON.stringify({ files }));
    } catch (e) {
      const err = e as Error;
      send(res, 500, "application/json", JSON.stringify({ error: err.message }));
    }
    return true;
  }

  if (path.startsWith("/api/commit")) {
    const q = path.indexOf("?");
    const params = q === -1 ? "" : path.substring(q + 1);
    let id = "";
    let sha = "";
    for (const pair of params.split("&")) {
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      const key = pair.substring(0, eq);
      const value = pair.substring(eq + 1);
      if (key === "id") id = value;
      if (key === "sha") sha = value;
    }
    const tab = findTab(id);
    if (tab === null) {
      send(res, 404, "application/json", JSON.stringify({ error: "no such tab" }));
      return true;
    }
    try {
      const files = await readCommitFiles(tab.path, sha);
      sendJson(res, JSON.stringify({ files }));
    } catch (e) {
      const err = e as Error;
      send(res, 500, "application/json", JSON.stringify({ error: err.message }));
    }
    return true;
  }

  return false;
}

// -------------------------------------------------------------- browser

function findBrowser(): string | null {
  // An explicit choice wins: distributions put Chromium in enough different
  // places - Flatpak, snap, /usr/local - that no fixed list is ever complete,
  // and this is the escape hatch that does not need a new release.
  const override = process.env["GITC_BROWSER"];
  if (override !== undefined && override.length > 0) {
    return existsSync(override) ? override : null;
  }

  const candidates = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
    "/usr/local/bin/chromium",
    "/usr/local/bin/google-chrome",
    "/snap/bin/chromium",
    "/var/lib/flatpak/exports/bin/org.chromium.Chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** Shuts the whole app down - called when the window goes away. */
function shutdown(): void {
  process.exit(0);
}

function openWindow(url: string): boolean {
  const browser = findBrowser();
  if (browser === null) return false;

  // A stable profile directory, deliberately. A per-launch directory looks
  // like a brand new browser install every time, which makes Edge show its
  // first-run sign-in and sync prompt on top of our window on every start.
  // Reusing one directory means the browser settles down after the first run.
  const profile = join(tmpdir(), "gitc-window");

  const child = spawn(
    browser,
    [
      "--app=" + url,
      "--window-size=1600,1000",
      "--user-data-dir=" + profile,

      // Stop the browser behaving like a browser. Without these the window
      // is interrupted by first-run flows, an implicit sign-in to the OS
      // account, and a search-engine chooser - none of which belong in a
      // git client.
      "--no-first-run",
      "--no-default-browser-check",
      "--no-service-autorun",
      "--disable-sync",
      "--disable-signin-promo",
      "--disable-search-engine-choice-screen",
      "--disable-features=msImplicitSignin,msIdentityFRE,msEdgeIdentityWebSignin," +
        "msSignInPromo,msEdgeShoppingAssistant,TranslateUI,MediaRouter," +
        "OptimizationHints,AcceptCHFrame",

      // Housekeeping we have no use for in a local app window.
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-breakpad",
      "--metrics-recording-only",
    ],
    { stdio: "ignore" },
  );

  const launchedAt = Date.now();

  child.on("exit", () => {
    // A Chromium that hands its window off to an already-running instance
    // sharing this profile exits almost immediately. That is not the user
    // closing the window, so don't treat it as one - the heartbeat watchdog
    // will notice if nothing is really there.
    if (Date.now() - launchedAt < HANDOFF_GRACE_MS) return;
    shutdown();
  });

  return true;
}

// ----------------------------------------------------------------- main

async function main(): Promise<void> {
  // Dev mode: serve the API only. `npm run dev` pairs this with Vite on 5173,
  // which proxies /api here - so the UI hot-reloads against a live engine
  // instead of needing the binary rebuilt for every style tweak.
  let headless = process.env["GITC_NO_WINDOW"] === "1";
  for (const arg of process.argv) {
    if (arg === "--no-window") headless = true;
    // Answered before anything else starts: a version check should not open a
    // window, restore tabs or touch a repository.
    if (arg === "--version" || arg === "-v") {
      console.log(NAME + " " + VERSION);
      process.exit(0);
    }
  }

  // Seed the id counter past anything the restored session already uses.
  // This has to happen BEFORE any repo is opened, or a newly opened tab is
  // handed an id that a restored tab already holds and the two become
  // indistinguishable to every /api call that takes an id.
  for (const t of session.tabs) {
    const n = parseInt(t.id.substring(1), 10);
    if (!isNaN(n) && n >= nextTabId) nextTabId = n + 1;
  }

  // A path argument opens that repo; otherwise the saved tabs come back.
  // at() rather than argv[2]: scriptc throws on out-of-range reads.
  const arg = at(process.argv, 2);
  if (arg !== undefined && arg.length > 0 && !arg.startsWith("--")) {
    await openRepo(arg);
  }
  if (session.activeId === null) {
    const head = at(session.tabs, 0);
    if (head !== undefined) session.activeId = head.id;
  }

  const server = createServer((req, res) => {
    const url = req.url === undefined ? "/" : req.url;
    const path = url === "/" ? "/index.html" : url;

    if (path.startsWith("/api/")) {
      handleApi(path, req, res)
        .then((handled) => {
          if (!handled) send(res, 404, "text/plain", "not found");
        })
        .catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          send(res, 500, "text/plain", msg);
        });
      return;
    }

    const name = path.substring(1);
    const body = asset(name);
    if (body === null) {
      send(res, 404, "text/plain", "not found");
      return;
    }
    send(res, 200, contentType(name), body);
  });

  const port = DEFAULT_PORT;
  // Once the UI has checked in at least once, silence means it is gone.
  // Headless dev servers stay up regardless: reloading the Vite page would
  // otherwise look like the window closing and take the engine down with it.
  if (!headless) {
    setInterval(() => {
      if (!sawFirstPing) return;
      if (Date.now() - lastPing > PING_TIMEOUT_MS) shutdown();
    }, 2000);
  }

  server.listen(port, "127.0.0.1", () => {
    const url = "http://127.0.0.1:" + port + "/";
    console.log("gitc serving " + url);
    if (headless) {
      console.log("--no-window: API only (pair with `npm run dev:ui` on 5173)");
      return;
    }
    if (!openWindow(url)) {
      console.log("no Chromium browser found - open the URL manually");
    }
  });
}

main();
