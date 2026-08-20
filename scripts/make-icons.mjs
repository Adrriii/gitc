// Rasterises icons/gitc.svg into the PNG sizes and the .ico Windows wants.
//
// The rasteriser is the headless Chromium gitc already depends on, driven over
// CDP - the same engine that will draw the icon in the window, and one less
// build dependency than ImageMagick or a node canvas binding.
//
// Run it when the SVG changes; the outputs are committed, so a normal build
// never needs a browser.
//
//   node scripts/make-icons.mjs

import { spawn } from "node:child_process";
import { findBrowser, noBrowserMessage } from "./browser.mjs";
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(root, "icons", "gitc.svg");
const OUT = join(root, "icons");

// Windows uses 16/32/48 in shell surfaces and 256 for large tiles; 64 and 128
// cover the intermediate DPI scalings.
const SIZES = [16, 24, 32, 48, 64, 128, 256];



const PORT = 9335;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = findBrowser();
if (!browser) {
  console.error(noBrowserMessage());
  process.exit(1);
}

const svg = readFileSync(SRC, "utf8");
// A throwaway profile is not optional: without one, launching the browser
// hands the request to the user's already-running instance, which never opens
// the debugging port and leaves this waiting forever.
const profile = mkdtempSync(join(tmpdir(), "gitc-icon-"));

const child = spawn(
  browser,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--no-default-browser-check",
    "--no-first-run",
    "--disable-gpu",
    "--hide-scrollbars",
    "about:blank",
  ],
  { stdio: "ignore" },
);

async function target() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch {
      // The browser is still starting; that is the normal path here.
    }
    await sleep(200);
  }
  throw new Error("browser did not expose a debugging target");
}

/** Builds an .ico containing PNG-encoded images, which Vista onward accepts. */
function buildIco(images) {
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(count, 4);

  const entries = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  images.forEach((img, i) => {
    const at = 16 * i;
    // 256 is stored as 0: the field is one byte and 256 does not fit.
    entries.writeUInt8(img.size >= 256 ? 0 : img.size, at + 0);
    entries.writeUInt8(img.size >= 256 ? 0 : img.size, at + 1);
    entries.writeUInt8(0, at + 2); // palette count
    entries.writeUInt8(0, at + 3); // reserved
    entries.writeUInt16LE(1, at + 4); // colour planes
    entries.writeUInt16LE(32, at + 6); // bits per pixel
    entries.writeUInt32LE(img.data.length, at + 8);
    entries.writeUInt32LE(offset, at + 12);
    offset += img.data.length;
  });

  return Buffer.concat([header, entries, ...images.map((i) => i.data)]);
}

async function main() {
  const page = await target();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.error) slot.reject(new Error(msg.error.message));
    else slot.resolve(msg.result);
  });

  await send("Page.enable");
  // Transparency comes from the CDP override, not the --default-background-color
  // flag: that flag starts the browser with no page target at all, so /json
  // returns an empty list and nothing can be driven.
  await send("Emulation.setDefaultBackgroundColorOverride", {
    color: { r: 0, g: 0, b: 0, a: 0 },
  });
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

  const images = [];
  for (const size of SIZES) {
    // A page that is exactly the icon, with no margin and no background of
    // its own, so the screenshot IS the icon.
    const html = `<!doctype html><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;background:transparent}
      svg{display:block;width:${size}px;height:${size}px}
    </style>${svg}`;

    await send("Emulation.setDeviceMetricsOverride", {
      width: size,
      height: size,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Page.navigate", { url: "data:text/html;base64," + Buffer.from(html).toString("base64") });
    await sleep(220);

    const shot = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    const data = Buffer.from(shot.data, "base64");
    writeFileSync(join(OUT, `gitc-${size}.png`), data);
    images.push({ size, data });
    console.log(`  ${size}x${size}`);
  }

  // The .ico carries only the sizes Windows actually asks for.
  const ico = buildIco(images.filter((i) => [16, 32, 48, 256].includes(i.size)));
  writeFileSync(join(OUT, "gitc.ico"), ico);
  console.log(`wrote icons/gitc.ico (${ico.length} bytes)`);

  writeIndexIcons(images);

  ws.close();
  child.kill();
}

/**
 * Writes the favicon links into src/ui/index.html as data URIs.
 *
 * Data URIs rather than served files because the engine bakes the UI into the
 * binary as TEXT, and a .png or .ico is not text - embedding them would mean a
 * binary asset path through the compiler for no gain. This way the icons are
 * part of the document in dev and in the packaged build alike.
 *
 * The large PNG is what fixes the taskbar: an app-mode Chromium window adopts
 * the page's icon, but only rasterised - given nothing but an SVG it falls
 * back to the browser's own icon.
 */
function writeIndexIcons(images) {
  const indexPath = join(root, "src", "ui", "index.html");
  const html = readFileSync(indexPath, "utf8");

  const uri = (size) => {
    const img = images.find((i) => i.size === size);
    return "data:image/png;base64," + img.data.toString("base64");
  };

  const links = [
    `    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}" />`,
    `    <link rel="icon" type="image/png" sizes="32x32" href="${uri(32)}" />`,
    `    <link rel="icon" type="image/png" sizes="48x48" href="${uri(48)}" />`,
    `    <link rel="icon" type="image/png" sizes="256x256" href="${uri(256)}" />`,
    `    <link rel="apple-touch-icon" href="${uri(128)}" />`,
  ].join("\n");

  const START = "    <!-- icons:start -->";
  const END = "    <!-- icons:end -->";
  const from = html.indexOf(START);
  const to = html.indexOf(END);
  if (from === -1 || to === -1) {
    console.error("index.html is missing the icons:start / icons:end markers");
    process.exit(1);
  }

  const next = html.slice(0, from + START.length) + "\n" + links + "\n" + html.slice(to);
  if (next !== html) {
    writeFileSync(indexPath, next, "utf8");
    console.log("wrote favicon links into src/ui/index.html");
  }
}

main().catch((e) => {
  console.error(e.message);
  child.kill();
  process.exit(1);
});
