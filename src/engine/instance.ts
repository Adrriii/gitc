// Talking to a gitc that is already running.
//
// `gitc .` should do the obvious thing whether or not gitc is open: add the
// repository and bring the window forward. Starting a second copy would fight
// over the port and the session file, so a second invocation hands its
// argument to the first and gets out of the way.

import { request } from "node:http";
import { spawnSync } from "node:child_process";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * One loopback request.
 *
 * node:http rather than fetch: fetch drags in the TLS and compression stack,
 * and linking that here fails looking for a system zlib. Nothing on this path
 * ever leaves 127.0.0.1, so plain HTTP is all it needs.
 */
function ask(
  port: number,
  path: string,
  method: string,
  body: string | null,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
    if (body !== null) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(body.length);
    }

    const req = request(
      {
        // Spelled out rather than shorthand: the compiler asks for it here.
        hostname: "127.0.0.1",
        port: port,
        path: path,
        method: method,
        headers: headers,
        timeout: 2000,
      },
      (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => {
          text += chunk.toString();
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    // Any failure here means "not running", which is a normal answer.
    req.on("error", () => resolve({ status: 0, text: "" }));
    if (body !== null) req.write(body);
    req.end();
  });
}

/** Is a gitc already serving on this port? */
export async function running(port: number): Promise<boolean> {
  const res = await ask(port, "/api/ping", "GET", null);
  return res.status === 200 && res.text.includes("\"ok\"");
}

/** Asks the running instance to open a repository and focus that tab. */
export async function handOff(port: number, repo: string): Promise<boolean> {
  const res = await ask(port, "/api/open", "POST", JSON.stringify({ path: repo }));
  return res.status === 200;
}

/**
 * Brings the existing gitc window to the front.
 *
 * Best effort, and deliberately quiet when it fails: the repository has been
 * opened by this point, so a window that did not come forward is a small
 * annoyance rather than a failure worth an error.
 *
 * The window belongs to a browser process, not to gitc, so there is no handle
 * to raise - it has to be found by title, which is what these do.
 */
export function focusWindow(): void {
  if (process.platform === "win32") {
    focusOnWindows();
    return;
  }
  // wmctrl matches the WM_CLASS gitc sets with --class=gitc; xdotool is the
  // fallback. Neither is guaranteed to be installed, and that is fine.
  const wm = spawnSync("wmctrl", ["-x", "-a", "gitc"], { stdio: "ignore" });
  if (wm.status === 0) return;
  spawnSync("xdotool", ["search", "--class", "gitc", "windowactivate"], { stdio: "ignore" });
}

function focusOnWindows(): void {
  // Through a temporary script: the interop needs a here-string, and a
  // here-string cannot reliably terminate inside a -Command argument.
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "using System.Text;",
    "public static class GitcFocus {",
    "  [DllImport(\"user32.dll\")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);",
    "  public delegate bool EnumProc(IntPtr h, IntPtr l);",
    "  [DllImport(\"user32.dll\")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);",
    "  [DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr h);",
    "  [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h);",
    "  [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h, int cmd);",
    "  public static void Raise() {",
    "    EnumWindows(delegate(IntPtr h, IntPtr l) {",
    "      if (!IsWindowVisible(h)) return true;",
    "      var sb = new StringBuilder(256);",
    "      GetWindowText(h, sb, 256);",
    "      if (sb.ToString() == \"gitc\") {",
    "        ShowWindow(h, 9);   // SW_RESTORE, in case it is minimised",
    "        SetForegroundWindow(h);",
    "        return false;",
    "      }",
    "      return true;",
    "    }, IntPtr.Zero);",
    "  }",
    "}",
    "'@",
    "[GitcFocus]::Raise()",
    "",
  ].join(String.fromCharCode(10));

  const file = join(tmpdir(), "gitc-focus.ps1");
  writeFileSync(file, script, "utf8");
  spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
    { stdio: "ignore" },
  );
  try {
    if (existsSync(file)) rmSync(file, { force: true });
  } catch {
    // A leftover script in the temp directory is not worth reporting.
  }
}
