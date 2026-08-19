// Runs the engine for development, and keeps it current.
//
// Two jobs beyond "start the binary":
//
//  1. It runs a COPY. `dist/gitc.exe --no-window` holds a lock on the very
//     file the next build wants to write, so the link step fails with
//     "Permission denied" partway through a rebuild.
//
//  2. It WATCHES dist/gitc.exe and restarts when it changes. Without this the
//     engine silently serves an older API than the UI expects - which looked
//     like three separate UI bugs before the cause was understood, each one a
//     crash on a field the running engine had never heard of.

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, watch } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const src = join(root, "dist", "gitc.exe");
const outDir = join(root, "build");
const dev = join(outDir, "gitc-dev.exe");
const extraArgs = process.argv.slice(2);

if (!existsSync(src)) {
  console.error("dist/gitc.exe missing - run: npm run build:engine");
  process.exit(1);
}
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

let child = null;
let restarting = false;

function stop() {
  if (child !== null) {
    child.removeAllListeners("exit");
    child.kill();
    child = null;
  }
  // The copy must be free before it can be overwritten.
  spawnSync("taskkill", ["/F", "/IM", "gitc-dev.exe"], { stdio: "ignore" });
}

function start() {
  copyFileSync(src, dev);
  child = spawn(dev, ["--no-window", ...extraArgs], { stdio: "inherit" });
  child.on("exit", (code) => {
    if (restarting) return;
    process.exit(code ?? 0);
  });
}

stop();
start();

// A rebuild writes the binary in several steps, so wait for it to settle
// rather than restarting onto a half-written file.
let timer = null;
watch(src, () => {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    console.log("\n[dev-engine] dist/gitc.exe changed - restarting the engine\n");
    restarting = true;
    stop();
    start();
    restarting = false;
  }, 600);
});

const shutdown = () => {
  restarting = true;
  stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
