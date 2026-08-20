// Finds a Chromium-family browser to host gitc's window.
//
// Shared by the dev window and the icon rasteriser so they cannot disagree
// about what counts as a browser, and so adding a location fixes both.
//
// Lookup order: an explicit GITC_BROWSER, then PATH, then the usual install
// locations. PATH matters most on Linux, where the binary's name is stable
// (`chromium`, `google-chrome`) but its path is not - distributions, Flatpak,
// snap and /usr/local all disagree.

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/** Command names to look for on PATH, most preferred first. */
const NAMES =
  process.platform === "win32"
    ? ["msedge.exe", "chrome.exe", "chromium.exe"]
    : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"];

/** Full paths worth trying when PATH has nothing. */
const WELL_KNOWN =
  process.platform === "win32"
    ? [
        "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
        "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      ]
    : process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ]
      : [
          "/usr/bin/google-chrome",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
          "/usr/bin/microsoft-edge",
          "/usr/local/bin/chromium",
          "/snap/bin/chromium",
          "/var/lib/flatpak/exports/bin/org.chromium.Chromium",
        ];

function onPath(name) {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    const full = join(dir, name);
    if (existsSync(full)) return full;
  }
  return null;
}

/** Returns a browser path, or null when there is none to be found. */
export function findBrowser() {
  const override = process.env.GITC_BROWSER;
  if (override) return existsSync(override) ? override : null;

  for (const name of NAMES) {
    const hit = onPath(name);
    if (hit !== null) return hit;
  }
  for (const path of WELL_KNOWN) {
    if (existsSync(path)) return path;
  }
  return null;
}

/** The message to print when there is none - the same advice in both callers. */
export function noBrowserMessage() {
  return (
    "No Chromium-based browser found.\n" +
    "gitc renders its window in one of Edge, Chrome or Chromium - install any\n" +
    "of them, or point GITC_BROWSER at the executable."
  );
}
