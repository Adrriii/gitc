// Opens the chromeless gitc window against the Vite dev server.
//
// Same flags as the real app window, so what you are watching looks exactly
// like the shipped thing - it just happens to hot-reload as the UI changes.
//
// Paths use forward slashes deliberately: Node accepts them on Windows, and
// they survive being passed through shells and heredocs without a backslash
// quietly turning into an escape sequence.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const BROWSERS = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/microsoft-edge",
];

const url = process.argv[2] ?? "http://127.0.0.1:5173/";
const browser = BROWSERS.find((b) => existsSync(b));

if (!browser) {
  console.error("no Chromium browser found; looked in:");
  for (const b of BROWSERS) console.error("  " + b);
  process.exit(1);
}

const child = spawn(
  browser,
  [
    `--app=${url}`,
    "--window-size=1600,1000",
    `--user-data-dir=${join(tmpdir(), "gitc-window")}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--no-service-autorun",
    "--disable-sync",
    "--disable-signin-promo",
    "--disable-search-engine-choice-screen",
    "--disable-features=msImplicitSignin,msIdentityFRE,msEdgeIdentityWebSignin," +
      "msSignInPromo,msEdgeShoppingAssistant,TranslateUI,MediaRouter," +
      "OptimizationHints,AcceptCHFrame",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--metrics-recording-only",
  ],
  { stdio: "ignore", detached: true },
);

// Detached: the window outlives this script, so it keeps running while I work.
child.unref();
console.log(`gitc dev window -> ${url}`);
console.log("edits to src/ui/** hot-reload in that window; close it when done.");
