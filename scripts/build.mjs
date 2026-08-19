// Builds a gitc binary with the toolchain scriptc needs on this machine.
//
// Two non-obvious requirements, both discovered the hard way (see
// docs/toolchain.md): scriptc needs Node >=24, and on Windows it must be
// driven through zigcc rather than a stock clang.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const entry = process.argv[2] ?? "src/main.ts";
const out = process.argv[3] ?? "dist/gitc.exe";

const node24 = join(root, "tools", "node24");
if (!existsSync(node24)) {
  console.error("missing tools/node24 - run: npm run setup");
  process.exit(1);
}

const scoop = join(process.env.USERPROFILE ?? "", "scoop", "shims");
const env = {
  ...process.env,
  // zigcc: stock clang targets the MSVC CRT, but scriptc's runtime assumes
  // mingw's. Without this the build dies on an undefined ssize_t.
  SCRIPTC_CC: "zigcc",
  PATH: [node24, scoop, process.env.PATH].join(";"),
};

// Invoke scriptc's JS entry with the Node 24 binary directly. Spawning the
// .cmd shim needs shell:true on Windows, and going through a shell mangles
// argument quoting - this sidesteps both.
const scriptc = join(root, "node_modules", "scriptc", "dist", "bootstrap.js");
const node = join(node24, "node.exe");

const r = spawnSync(node, [scriptc, "build", entry, "-o", out], {
  cwd: root,
  env,
  stdio: "inherit",
});

if (r.error) {
  console.error("failed to launch scriptc:", r.error.message);
  process.exit(1);
}
process.exit(r.status ?? 1);
