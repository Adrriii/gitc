// Compiles the engine to a native binary with scriptc.
//
// scriptc's CLI is a native executable since 0.2, so the build needs no
// particular Node - only the linker scriptc drives: zig on Windows and for
// any cross-compiled target (SCRIPTC_TARGET), clang for a native Linux or
// macOS build.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const windows = process.platform === "win32";

const entry = process.argv[2] ?? "src/main.ts";
const out = process.argv[3] ?? join("dist", windows ? "gitc.exe" : "gitc");

// --- the linker -------------------------------------------------------------

// Release builds set SCRIPTC_TARGET=x86_64-linux-musl to produce a static
// binary that does not depend on the build machine's glibc - a binary built
// against glibc 2.39 refuses to start on anything older, which is most
// systems. That target links through zig and needs
// @scriptc/runtime-linux-x64-musl, pinned to the compiler's version.
const target = process.env.SCRIPTC_TARGET ?? "";

if (windows || target.length > 0) {
  const zig = spawnSync("zig", ["version"], { encoding: "utf8" });
  if (zig.status !== 0) {
    console.error(
      "zig is required to build " + (target.length > 0 ? "for " + target : "on Windows") + " but is not on PATH.\n" +
        "Install it from https://ziglang.org/download/ (or `scoop install zig`,\n" +
        "`winget install zig.zig`) and run the build again.",
    );
    process.exit(1);
  }
  if (target.length > 0) console.log(`building for ${target}`);
} else {
  // Checking here turns a confusing failure deep inside the compiler into one
  // line up front.
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

// --- native helpers ---------------------------------------------------------

// native/gitc.c is what the engine calls through --ffi native/ffi.json. It is
// compiled for the same target the binary links for, and always with an
// explicit triple: `zig cc` without one compiles for the build machine's own
// CPU, and a release built on an AVX-512 runner once died on start on most
// PCs.
const triple = target.length > 0 ? target : windows ? "x86_64-windows-gnu" : "";
mkdirSync(join(root, "build", "native"), { recursive: true });
const cc = triple.length > 0 ? ["zig", ["cc", "-target", triple]] : ["clang", []];
const native = spawnSync(
  cc[0],
  [...cc[1], "-O2", "-c", join("native", "gitc.c"), "-o", join("build", "native", "gitc.o")],
  { cwd: root, stdio: "inherit" },
);
if (native.status !== 0) {
  console.error("failed to compile native/gitc.c");
  process.exit(1);
}

// --- run it -----------------------------------------------------------------

// The installed binary rather than the npm shim: spawning a .cmd needs
// shell:true on Windows, and going through a shell mangles argument quoting.
// npm installs it as scriptc.exe on every platform.
const scriptc = join(root, "node_modules", "scriptc", "bin", "scriptc.exe");
if (!existsSync(scriptc)) {
  console.error("scriptc is not installed - run: npm install");
  process.exit(1);
}

// --strip drops debug info nothing reads from a release: about 12% of the
// Windows binary, and over half of the Linux one.
//
// --windows-subsystem gui: a console-subsystem binary gets a console window
// from Windows whenever it is started without one - from a shortcut, the
// Start menu, or Explorer - so gitc opened with a black cmd window beside it.
// The command line still works: Windows never allocates a console for a GUI
// binary, but it inherits its parent's handles, so `gitc --version` from a
// shell still prints. Only for a Windows binary, not a cross-build from here.
const args = ["build", entry, "-o", out, "--strip", "--ffi", join("native", "ffi.json")];
if (windows && (target === "" || target.includes("windows"))) args.push("--windows-subsystem", "gui");

const r = spawnSync(scriptc, args, {
  cwd: root,
  stdio: "inherit",
});

if (r.error) {
  console.error("failed to launch scriptc:", r.error.message);
  process.exit(1);
}
if (r.status !== 0) process.exit(r.status ?? 1);
