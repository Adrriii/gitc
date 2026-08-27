// Compiles the engine to a native binary with scriptc.
//
// Two requirements, both discovered the hard way:
//
//   1. scriptc needs Node >= 24. Normally that is the Node you are already
//      running this with, and nothing else is needed.
//   2. On Windows scriptc must be driven through zig rather than a stock
//      clang: clang targets the MSVC CRT and scriptc's runtime assumes
//      mingw's, so the build dies on an undefined ssize_t. SCRIPTC_CC=zigcc
//      is a mode scriptc implements by calling `zig cc` - there is no zigcc
//      executable to install, only zig.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const windows = process.platform === "win32";

const entry = process.argv[2] ?? "src/main.ts";
const out = process.argv[3] ?? join("dist", windows ? "gitc.exe" : "gitc");

// --- the Node that will run scriptc -----------------------------------------

const REQUIRED_NODE = 24;

/**
 * Prefers the Node already running this script.
 *
 * `tools/node24` is only a fallback for a machine whose system Node is older
 * than scriptc needs - it is not part of a normal build, and it is not in the
 * repository. Requiring it unconditionally made this build work on exactly one
 * computer.
 */
function findNode() {
  const running = Number(process.versions.node.split(".")[0]);
  if (running >= REQUIRED_NODE) return process.execPath;

  // The exact file that has to exist, not the directory to "unpack into" -
  // an archive expands to node-v24.x-<platform>/, and whether that folder or
  // its contents belong at tools/node24 is not something anyone should guess.
  const vendored = join(root, "tools", "node24", windows ? "node.exe" : join("bin", "node"));
  if (existsSync(vendored)) return vendored;

  console.error(
    [
      `scriptc needs Node ${REQUIRED_NODE} or newer, and this is Node ${process.versions.node}.`,
      "",
      `Install a current Node from https://nodejs.org and build again.`,
      "",
      `Or, to keep a private copy just for this build, put a Node ${REQUIRED_NODE}+`,
      `build at exactly this path and it will be picked up automatically:`,
      "",
      `  ${vendored}`,
      "",
      `That is the contents of the downloaded archive, not the archive's own`,
      `folder: after unpacking, the file above must exist.`,
    ].join("\n"),
  );
  process.exit(1);
}

const node = findNode();

// --- the C driver -----------------------------------------------------------

const env = { ...process.env };

// An explicit choice wins. Release builds set SCRIPTC_CC=zigcc with
// SCRIPTC_TARGET=x86_64-linux-musl to produce a static binary that does not
// depend on the build machine's glibc - a binary built against glibc 2.39
// refuses to start on anything older, which is most systems.
const chosen = process.env.SCRIPTC_CC ?? "";
const target = process.env.SCRIPTC_TARGET ?? "";

if (chosen === "zigcc" || (windows && chosen === "")) {
  const zig = spawnSync("zig", ["version"], { encoding: "utf8", shell: true });
  if (zig.status !== 0) {
    console.error(
      "zig is required to build on Windows but is not on PATH.\n" +
        "Install it from https://ziglang.org/download/ (or `scoop install zig`,\n" +
        "`winget install zig.zig`) and run the build again.\n\n" +
        "Why: scriptc's runtime needs mingw's CRT, and a stock clang targets\n" +
        "MSVC's. scriptc reaches mingw by calling `zig cc` under SCRIPTC_CC=zigcc.",
    );
    process.exit(1);
  }
  env.SCRIPTC_CC = "zigcc";
  if (target.length > 0) console.log(`building for ${target}`);
} else {
  // Everywhere else scriptc drives clang directly. Checking here turns a
  // confusing failure deep inside the compiler into one line up front.
  const clang = spawnSync("clang", ["--version"], { encoding: "utf8" });
  if (clang.status !== 0) {
    console.error(
      [
        "clang is required to build but is not on PATH.",
        "  Debian/Ubuntu   sudo apt install clang",
        "  Fedora          sudo dnf install clang",
        "  Arch            sudo pacman -S clang",
        "  macOS           xcode-select --install",
      ].join("\n"),
    );
    process.exit(1);
  }
}

// --- run it -----------------------------------------------------------------

// Invoke scriptc's JS entry directly rather than the .cmd shim: spawning the
// shim needs shell:true on Windows, and going through a shell mangles argument
// quoting.
const scriptc = join(root, "node_modules", "scriptc", "dist", "bootstrap.js");
if (!existsSync(scriptc)) {
  console.error("scriptc is not installed - run: npm install");
  process.exit(1);
}

const r = spawnSync(node, [scriptc, "build", entry, "-o", out], {
  cwd: root,
  env,
  stdio: "inherit",
});

if (r.error) {
  console.error("failed to launch scriptc:", r.error.message);
  process.exit(1);
}
if (r.status !== 0) process.exit(r.status ?? 1);

// --- no console window ------------------------------------------------------

/**
 * Marks the executable as a Windows GUI application.
 *
 * A console-subsystem binary gets a console window from Windows whenever it is
 * started without one - from a shortcut, the Start menu, or Explorer - so gitc
 * opened its own window with a black cmd window sitting next to it. That is
 * the single field being changed here: subsystem 3 (console) to 2 (GUI), which
 * is exactly what `editbin /SUBSYSTEM:WINDOWS` does. scriptc exposes no linker
 * flags (only SCRIPTC_CC, SCRIPTC_TARGET, SCRIPTC_CACHE_DIR, SCRIPTC_NO_CACHE),
 * so it is done here rather than at the link.
 *
 * The command line still works, which is the part worth checking before
 * believing this is free. Windows never ALLOCATES a console for a GUI binary,
 * but it does inherit whatever handles its parent passes - so `gitc --version`
 * run from cmd.exe or a shell still prints, and cmd still waits for the exit
 * code. Measured both ways: console build +1 conhost process when launched
 * without a console, GUI build +0, and `--version` prints under both.
 *
 * The PE checksum is deliberately left alone. Windows does not verify it for
 * ordinary executables, and the patched binary runs.
 */
function markAsGuiApp(exe) {
  const buf = readFileSync(exe);
  const peOff = buf.readUInt32LE(0x3c);
  if (buf.toString("ascii", peOff, peOff + 4) !== "PE\0\0") {
    console.error(`${exe}: not a PE file, leaving the subsystem alone`);
    return;
  }
  // 4 bytes of signature, then the 20-byte COFF header, then 68 bytes into
  // the optional header that follows it.
  const at = peOff + 4 + 20 + 68;
  const CONSOLE = 3;
  const GUI = 2;
  const was = buf.readUInt16LE(at);
  if (was === GUI) return;
  if (was !== CONSOLE) {
    console.error(`${exe}: unexpected subsystem ${was}, leaving it alone`);
    return;
  }
  buf.writeUInt16LE(GUI, at);
  writeFileSync(exe, buf);
  console.log("marked as a GUI app - no console window when launched from a shortcut");
}

if (windows) markAsGuiApp(out);
