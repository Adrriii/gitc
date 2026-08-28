// Talking to a gitc that is already running.
//
// `gitc .` should do the obvious thing whether or not gitc is open: add the
// repository and bring the window forward. Starting a second copy would fight
// over the port and the session file, so a second invocation hands its
// argument to the first and gets out of the way.

import { request } from "node:http";

/**
 * One loopback request.
 *
 * node:http rather than fetch: fetch drags in the TLS and compression stack,
 * and linking that here fails looking for a system zlib. Nothing on this path
 * ever leaves 127.0.0.1, so plain HTTP is all it needs.
 */
function ask(
  port: number,
  path: string,
  method: string,
  body: string | null,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
    // Marks every request on this path as coming from a launcher rather than
    // from the window. The engine treats any request as proof its window is
    // alive - which is right for the window's own traffic and wrong for ours:
    // without this, probing "has your window gone?" resets the very clock
    // being asked about, and the answer is always "no". Worse, the probe
    // cleared a pending goodbye, so asking the question kept a dead engine
    // alive for another minute.
    headers["x-gitc-launcher"] = "1";
    if (body !== null) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(body.length);
    }

    const req = request(
      {
        // Spelled out rather than shorthand: the compiler asks for it here.
        hostname: "127.0.0.1",
        port: port,
        path: path,
        method: method,
        headers: headers,
        timeout: 2000,
      },
      (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => {
          text += chunk.toString();
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    // Any failure here means "not running", which is a normal answer.
    req.on("error", () => resolve({ status: 0, text: "" }));
    if (body !== null) req.write(body);
    req.end();
  });
}

/** Is a gitc already serving on this port? */
export async function running(port: number): Promise<boolean> {
  const res = await ask(port, "/api/ping", "GET", null);
  return res.status === 200 && res.text.includes("\"ok\"");
}

/** What one probe of a running instance told us. */
export interface Probe {
  /**
   * Whether that engine believes its window is gone - it has been told
   * goodbye, or nothing has spoken to it in WINDOW_DEAD_MS. Null from an
   * engine too old to report it, which means "assume a window is there",
   * exactly what gitc always assumed before.
   *
   * The engine decides this, not the launcher: only it knows about a goodbye
   * that arrived a second ago, and a launcher comparing timestamps would miss
   * precisely the case that hurts - closing gitc and starting it again
   * straight away.
   */
  windowGone: boolean | null;
}

/**
 * Asks a running instance for its liveness AND its window state in ONE call.
 *
 * One call, because a second one would measure only the gap between our own
 * two requests. Null means nothing is listening at all.
 *
 * A running engine is not the same thing as a running application: when the
 * window closes on a machine where Chromium was already running, the process
 * gitc spawned exited long before and the browser-exit hook never fires, so
 * the engine outlives its window. A launcher that only asks "is the port
 * answering?" hands over to that and quits, which looks like gitc refusing to
 * start.
 */
export async function probe(port: number): Promise<Probe | null> {
  const res = await ask(port, "/api/ping", "GET", null);
  if (res.status !== 200 || !res.text.includes("\"ok\"")) return null;
  if (res.text.includes("\"windowGone\":true")) return { windowGone: true };
  if (res.text.includes("\"windowGone\":false")) return { windowGone: false };
  return { windowGone: null };
}

/**
 * Asks the running instance to stop, so this one can take the port.
 *
 * Best effort: the answer that matters is whether the port goes quiet
 * afterwards, which the caller waits for, not what this returns. An engine
 * already on its way out may never reply at all.
 */
export async function quitOther(port: number): Promise<boolean> {
  const res = await ask(port, "/api/quit", "POST", "{}");
  return res.status === 200;
}

/** Asks the running instance to open a repository and focus that tab. */
export async function handOff(port: number, repo: string): Promise<boolean> {
  const res = await ask(port, "/api/open", "POST", JSON.stringify({ path: repo }));
  return res.status === 200;
}
