// Who is allowed to talk to the engine.
//
// Loopback used to be the whole of the boundary, and a browser walks through
// it two ways - so these are the checks that put it back. A desktop engine
// has nothing else in front of it; an engine started with --serve also
// demands a token, which is a different question answered in main.ts.
//
// Kept out of main.ts so they can be tested without starting a server.

/**
 * Whether a request may be answered at all.
 *
 * What these guard is worth stating plainly: whatever reaches this engine gets
 * the filesystem through /api/ls and /api/diff, and every mutating operation
 * through /api/op, as the user running gitc. Before these checks existed,
 * loopback was the only thing in the way, and a browser punches straight
 * through it in two different ways.
 *
 * A page on any website can POST here. It cannot READ the answer without CORS
 * - which is never sent - but it does not need to: adding a remote, checking
 * out a branch, discarding a file and committing are all writes, and the
 * request alone is the attack. A body of "text/plain" is a CORS-simple
 * request, so there is not even a preflight to decline, and the handlers
 * JSON.parse the body without ever looking at its type. Verified against a
 * running engine: `Origin: https://evil.example` with a text/plain body added
 * a remote and ran it.
 *
 * And a name under the attacker's control that resolves to 127.0.0.1 - DNS
 * rebinding - makes their page same-origin with this server, at which point
 * the answers are readable too and the whole repository leaves the machine.
 *
 * So both are checked, and both are cheap:
 *
 *   Origin, when present, must be a loopback origin. A page served from
 *   anywhere else never gets one past this, whatever its content type.
 *
 *   Host must name loopback by address. This is the rebinding defence: the
 *   attacker's DNS points their NAME at 127.0.0.1, and the browser sends that
 *   name in Host. A real client of this engine has 127.0.0.1 in the URL bar.
 *
 * Sec-Fetch-Site covers the gap between them - a form POST carries no Origin
 * in some browsers, but every browser that ships Fetch Metadata sends this.
 * Absent means a non-browser client, which Host has already vouched for.
 */
export function allowedRequest(
  req: import("node:http").IncomingMessage,
  port: number,
  /** True for a headless engine, which is the dev loop - see isLoopbackOrigin. */
  dev: boolean,
): boolean {
  const host = req.headers["host"];
  if (host !== undefined && !isLoopbackHost(host)) return false;

  // A literal "null" origin is refused rather than waved through.
  //
  // It is what a sandboxed iframe sends, and what some redirects and
  // file:// pages send. None of those is ever a gitc window - the window is
  // an ordinary http page and sends its real origin - so the only thing the
  // exemption did was hand back the hole this check exists to close. A
  // non-browser client sends no Origin at all, which is a different case and
  // still allowed.
  const origin = req.headers["origin"];
  if (origin !== undefined && origin.length > 0) {
    if (!isLoopbackOrigin(origin, port, dev)) return false;
  }

  // "same-origin" is the window; "none" is a URL the user opened directly.
  // "cross-site" and "same-site" are somebody else's page reaching in.
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site !== "same-origin" && site !== "none") return false;

  // A third layer, for a browser too old to send either of the two above.
  //
  // The set of content types a cross-site request can send without a
  // preflight is fixed by CORS: text/plain, multipart/form-data and
  // application/x-www-form-urlencoded. Anything else - "application/json",
  // which is what the window actually sends - forces a preflight, and a
  // preflight is a request this server answers with no CORS headers at all,
  // so the browser never sends the real one.
  //
  // That makes the content type a second, independent gate on every write,
  // and it is exactly what the exploit had to sidestep: the proof of concept
  // worked precisely because a "text/plain" body was parsed as JSON without
  // anybody checking.
  const method = req.method === undefined ? "GET" : req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && !exemptFromContentType(req.url)) {
    const type = req.headers["content-type"];
    if (typeof type !== "string" || !type.toLowerCase().startsWith("application/json")) {
      return false;
    }
  }

  return true;
}

/**
 * The writes that legitimately arrive without a JSON content type.
 *
 * /api/bye is sent with navigator.sendBeacon while the page is being torn
 * down, because a fetch at that moment is cancelled - and sendBeacon does not
 * let the caller choose a content type. It carries no body and no parameters:
 * the whole of its effect is "the window said goodbye", which the engine
 * already treats as a hint rather than an instruction, since the heartbeat
 * timeout has to cover a window that never got to send it.
 */
function exemptFromContentType(url: string | undefined): boolean {
  if (url === undefined) return false;
  const q = url.indexOf("?");
  const path = q === -1 ? url : url.substring(0, q);
  return path === "/api/bye";
}

/**
 * Whether a Host header names this engine on loopback.
 *
 * By address, plus "localhost" - which gitc never puts in a URL itself, but a
 * person typing one will. Any other name is refused, and that is what stops a
 * rebound domain: the attacker's page reaches this engine under the name they
 * control, and the name is what arrives here.
 *
 * The server binds 127.0.0.1 and nothing else, so every request that gets this
 * far already arrived over loopback. This check is not about where the packet
 * came from; it is about what the browser believes it is talking to, which is
 * the only thing that decides whether it will hand over the answers.
 */
export function isLoopbackHost(header: string): boolean {
  let value = header.trim().toLowerCase();

  // IPv6 literals are bracketed, and the brackets are part of the syntax
  // rather than part of the address.
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close === -1) return false;
    const address = value.substring(1, close);
    return address === "::1" || address === "0:0:0:0:0:0:0:1";
  }

  // The port is deliberately not compared against the one this engine bound.
  //
  // It adds nothing: rebinding turns on the attacker's NAME resolving to
  // 127.0.0.1, and the name is the only part that distinguishes their page
  // from the real window - a rebound host on the right port is still rebound,
  // and a legitimate client on an unexpected port is still legitimate.
  //
  // It also breaks the dev loop outright. Vite proxies /api here with
  // changeOrigin false, so what arrives is "127.0.0.1:5173" - loopback by
  // address, and not this engine's port.
  const colon = value.lastIndexOf(":");
  if (colon !== -1) value = value.substring(0, colon);

  if (value === "localhost") return true;
  // The whole of 127.0.0.0/8 is loopback (RFC 1122), not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
}

/** Vite, in the dev loop. Fixed by vite.config.ts, and strictPort keeps it so. */
const VITE_PORT = 5173;

/**
 * Whether an Origin is this engine's own window.
 *
 * "Somewhere on loopback" is not good enough, and this is the second version
 * of this function for that reason. Any other web server on 127.0.0.1 is a
 * different application with a different author and its own bugs; one
 * reflected XSS in a development server, a local dashboard, a docs preview -
 * anything the user happens to be running - would otherwise be a page that
 * can drive gitc with full rights. The window's origin is known exactly, so
 * it is checked exactly.
 *
 * The one exception is the dev loop, where Vite serves the UI on 5173 and
 * proxies /api here, so the window's origin genuinely is not this server's.
 * That is allowed only for a headless engine - the shape `npm run dev` runs -
 * and never for the engine behind somebody's window or on somebody's server.
 */
export function isLoopbackOrigin(origin: string, port: number, dev: boolean): boolean {
  const value = origin.trim().toLowerCase();
  if (!value.startsWith("http://") && !value.startsWith("https://")) return false;
  const rest = value.substring(value.indexOf("//") + 2);
  const slash = rest.indexOf("/");
  const authority = slash === -1 ? rest : rest.substring(0, slash);

  let name: string;
  let given: string;
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close === -1) return false;
    name = authority.substring(1, close);
    const after = authority.substring(close + 1);
    given = after.startsWith(":") ? after.substring(1) : "";
    if (name !== "::1" && name !== "0:0:0:0:0:0:0:1") return false;
  } else {
    const colon = authority.lastIndexOf(":");
    name = colon === -1 ? authority : authority.substring(0, colon);
    given = colon === -1 ? "" : authority.substring(colon + 1);
    if (name !== "localhost" && !/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)) return false;
  }

  // An origin with no port means the scheme's default. Compared against the
  // port this engine actually bound rather than assumed to be wrong: gitc
  // takes --port, so somebody running it on 80 is unusual but not impossible,
  // and the comparison below is what decides either way.
  const number = given.length === 0 ? (value.startsWith("https://") ? 443 : 80) : parseInt(given, 10);
  if (isNaN(number)) return false;
  if (number === port) return true;
  return dev && number === VITE_PORT;
}
