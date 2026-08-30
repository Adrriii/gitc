import { allowedRequest, isLoopbackHost, isLoopbackOrigin } from "../origin.ts";

let pass = 0;
let fail = 0;

function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  console.log(
    `${ok ? "  ok  " : " FAIL "} ${label}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`,
  );
}

const PORT = 7893;

/** Just enough of an IncomingMessage for the guard to read. */
function req(headers: Record<string, string>) {
  return { headers } as unknown as import("node:http").IncomingMessage;
}

// --- Host: the DNS rebinding defence --------------------------------------
//
// The attacker points their own name at 127.0.0.1. The browser then treats
// their page as same-origin with this server and can read every answer. Their
// name is what arrives in Host, and it is the only place the two cases differ.

eq("loopback by address", isLoopbackHost("127.0.0.1:7893"), true);
eq("loopback, no port", isLoopbackHost("127.0.0.1"), true);
eq("elsewhere in 127/8", isLoopbackHost("127.7.7.7:7893"), true);
eq("localhost", isLoopbackHost("localhost:7893"), true);
eq("ipv6 loopback", isLoopbackHost("[::1]:7893"), true);
eq("ipv6 loopback long form", isLoopbackHost("[0:0:0:0:0:0:0:1]:7893"), true);
eq("case", isLoopbackHost("LOCALHOST:7893"), true);

eq("a rebound name", isLoopbackHost("gitc.evil.example:7893"), false);
eq("a rebound name, no port", isLoopbackHost("evil.example"), false);
eq("a name that merely contains 127.0.0.1", isLoopbackHost("127.0.0.1.evil.example"), false);
eq("another machine", isLoopbackHost("192.168.1.10:7893"), false);
// The port is not compared: rebinding is about the NAME, and Vite's dev
// proxy legitimately forwards "127.0.0.1:5173".
eq("another port on loopback", isLoopbackHost("127.0.0.1:9999"), true);
eq("the vite dev proxy", isLoopbackHost("127.0.0.1:5173"), true);
eq("an unclosed bracket", isLoopbackHost("[::1:7893"), false);
eq("a non-loopback ipv6", isLoopbackHost("[::2]:7893"), false);

// --- Origin: the CSRF defence ---------------------------------------------
//
// A page anywhere on the web can POST here. It cannot read the answer, but a
// write does not need to be read: adding a remote was remote code execution.
// A "text/plain" body is CORS-simple, so there is no preflight to decline -
// Origin is what separates the window from somebody else's page.

eq("the window", isLoopbackOrigin("http://127.0.0.1:7893", PORT, false), true);
// Another local web server is NOT the window. One XSS in any of them would
// otherwise be a page that can drive gitc.
eq("another local server", isLoopbackOrigin("http://127.0.0.1:3000", PORT, false), false);
eq("vite, but not in dev", isLoopbackOrigin("http://127.0.0.1:5173", PORT, false), false);
eq("vite in the dev loop", isLoopbackOrigin("http://127.0.0.1:5173", PORT, true), true);
eq("no port means 80", isLoopbackOrigin("http://127.0.0.1", PORT, false), false);
eq("localhost", isLoopbackOrigin("http://localhost:7893", PORT, false), true);
eq("ipv6", isLoopbackOrigin("http://[::1]:7893", PORT, false), true);

eq("a website", isLoopbackOrigin("https://evil.example", PORT, false), false);
eq("a website on a port", isLoopbackOrigin("https://evil.example:7893", PORT, false), false);
eq("a lookalike host", isLoopbackOrigin("https://127.0.0.1.evil.example", PORT, false), false);
eq("a lookalike in the path", isLoopbackOrigin("https://evil.example/127.0.0.1", PORT, false), false);
eq("a file page", isLoopbackOrigin("file://", PORT, false), false);

// --- the guard as a whole -------------------------------------------------

eq(
  "the window's own request",
  allowedRequest(req({ host: "127.0.0.1:7893", origin: "http://127.0.0.1:7893", "sec-fetch-site": "same-origin" }), PORT, false),
  true,
);
eq(
  "a non-browser client, no Origin",
  allowedRequest(req({ host: "127.0.0.1:7893" }), PORT, false),
  true,
);
eq(
  "the address bar",
  allowedRequest(req({ host: "127.0.0.1:7893", "sec-fetch-site": "none" }), PORT, false),
  true,
);

// This exact request added a remote and ran a command, measured, before the
// guard existed.
eq(
  "a cross-site POST",
  allowedRequest(req({
      host: "127.0.0.1:7893",
      origin: "https://evil.example",
      "content-type": "text/plain;charset=UTF-8",
    }), PORT, false),
  false,
);
eq(
  "a cross-site form with no Origin",
  allowedRequest(req({ host: "127.0.0.1:7893", "sec-fetch-site": "cross-site" }), PORT, false),
  false,
);
eq(
  "a same-site subdomain",
  allowedRequest(req({ host: "127.0.0.1:7893", "sec-fetch-site": "same-site" }), PORT, false),
  false,
);
eq(
  "a rebound name",
  allowedRequest(req({ host: "gitc.evil.example:7893" }), PORT, false),
  false,
);

// A sandboxed iframe sends this, and so do some redirects and file:// pages.
// None of them is ever a gitc window, so the literal string is refused rather
// than treated as "no origin" - which is what it used to be.
eq(
  "an origin of literally null",
  allowedRequest(req({ host: "127.0.0.1:7893", origin: "null" }), PORT, false),
  false,
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
