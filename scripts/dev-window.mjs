// Opens the chromeless gitc window against the Vite dev server.
//
// Same flags as the real app window, so what you are watching looks exactly
// like the shipped thing - it just happens to hot-reload as the UI changes.
//
// Paths use forward slashes deliberately: Node accepts them on Windows, and
// they survive being passed through shells and heredocs without a backslash
// quietly turning into an escape sequence.

import { findBrowser, noBrowserMessage } from "./browser.mjs";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";



const url = process.argv[2] ?? "http://127.0.0.1:5173/";
const browser = findBrowser();

if (!browser) {
  console.error(noBrowserMessage());
  process.exit(1);
}

const child = spawn(
  browser,
  [
    `--app=${url}`,
    "--window-size=1600,1000",
    `--user-data-dir=${join(tmpdir(), "gitc-window")}`,
    // Matches what the shipped binary passes, so the dev window gets the same
    // WM_CLASS - and so the .desktop entry applies to it too.
    ...(process.platform === "linux" ? ["--class=gitc"] : []),
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
