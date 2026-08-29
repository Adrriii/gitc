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
  const bin = kind.binPath === null ? "~/.local/bin/gitc" : kind.binPath;
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
  | { ok: false; error: string };

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
 */
export async function ensureRemote(host: string): Promise<InstallOutcome> {
  const kind = await detectRemote(host);
  if (kind.refusal !== null) return { ok: false, error: kind.refusal };
  const bin = kind.binPath === null ? "~/.local/bin/gitc" : kind.binPath;

  const have = await remoteVersion(host, bin);
  if (have === VERSION) return { ok: true, how: "already" };

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
  /** Ends the tunnel and, with it, the remote engine. */
  close: () => void;
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
): Promise<{ status: number; text: string }> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
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

/** Is the tunnel carrying a live gitc yet? */
function answering(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      {
        // Spelled out rather than shorthand: the compiler asks for it here.
        hostname: "127.0.0.1",
        port: port,
        path: "/api/ping",
        method: "GET",
        timeout: 2000,
      },
      (res) => resolve(res.statusCode === 200),
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => resolve(false));
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
export async function connect(host: string, bin: string): Promise<Connection> {
  const port = await freePort();
  const forward = String(port) + ":127.0.0.1:" + String(REMOTE_PORT);
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

  // Distinguishes the two ways a tunnel ends. "We closed it" is ordinary -
  // a swept idle host, a closed tab, gitc exiting. Anything else is the
  // tunnel failing underneath us, and only that needs explaining.
  let closedHere = false;
  const close = () => {
    closedHere = true;
    try {
      child.kill();
    } catch {
      // Already gone, which is the state we wanted.
    }
  };

  child.on("exit", (code: number | null) => {
    if (closedHere) return;
    const why = stderr.trim();
    console.log(
      "[tunnel] " + host + " ended on its own, code " + String(code) +
        (why.length > 0 ? ": " + why : " (ssh said nothing)"),
    );
  });

  const started = Date.now();
  while (Date.now() - started < CONNECT_TIMEOUT_MS) {
    if (await answering(port)) return { host, port, usedAt: Date.now(), close };
    await new Promise((r) => setTimeout(r, 300));
  }

  close();
  const why = stderr.trim();
  throw new Error(
    why.length > 0 ? why : "the remote engine did not answer within 30 seconds",
  );
}
