// Installing gitc, from gitc.
//
// gitc is one self-contained binary, so it can do this itself: copy where it
// belongs, put that directory on PATH, write the icon, and register the
// desktop entry that makes the window show gitc's own icon rather than the
// browser's. No package manager, no network, no toolchain - download one file
// and run it.
//
// Everything goes under the user's own directories. Nothing here needs
// administrator or root, and nothing touches a system path.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { fromBase64 } from "./base64.ts";
import { ICO_BASE64, PNG_BASE64 } from "../generated/icons.ts";
import { NAME, VERSION } from "../generated/version.ts";

const windows = process.platform === "win32";

export interface InstallReport {
  /** Lines to print. The installer explains itself rather than going quiet. */
  lines: string[];
  /** Where the binary ended up. */
  target: string;
  /** True when PATH already covered the install directory. */
  onPath: boolean;
}

/** Where the binary lives once installed. */
export function installDir(): string {
  if (windows) {
    const local = process.env["LOCALAPPDATA"];
    const base = local !== undefined && local.length > 0 ? local : join(homedir(), "AppData", "Local");
    return join(base, "Programs", "gitc");
  }
  // ~/.local/bin is the XDG-blessed spot for a user's own binaries, and is
  // already on PATH in most distributions' default profile.
  return join(homedir(), ".local", "bin");
}

export function installedBinary(): string {
  return join(installDir(), windows ? "gitc.exe" : "gitc");
}

/** True when gitc is running from where an install would have put it. */
export function isInstalled(): boolean {
  return existsSync(installedBinary());
}

export function runningFromInstall(): boolean {
  const self = process.execPath;
  return self.toLowerCase() === installedBinary().toLowerCase();
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function pathContains(dir: string): boolean {
  const raw = process.env["PATH"];
  if (raw === undefined) return false;
  const sep = windows ? ";" : ":";
  for (const entry of raw.split(sep)) {
    if (entry.trim().toLowerCase() === dir.toLowerCase()) return true;
  }
  return false;
}

/**
 * Adds the install directory to the user's PATH on Windows.
 *
 * Through PowerShell rather than `setx`: setx truncates the value at 1024
 * characters and writes it back whole, which is a good way to destroy
 * somebody's PATH. The .NET call edits the user's own environment key.
 */
function addToWindowsPath(dir: string): boolean {
  const script =
    "$d='" +
    dir.replace(/'/g, "''") +
    "'; $p=[Environment]::GetEnvironmentVariable('PATH','User'); " +
    "if ($p -split ';' -notcontains $d) { " +
    "[Environment]::SetEnvironmentVariable('PATH', ($p.TrimEnd(';') + ';' + $d), 'User') }";

  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    stdio: "ignore",
  });
  return r.status === 0;
}

/** The C# needed to stamp an AppUserModelID onto a shortcut. */
function windowsAumidSource(): string {
  return [
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class GitcLnk {",
    '  [ComImport, Guid("0000010b-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
    "  interface IPersistFile {",
    "    void GetClassID(out Guid id);",
    "    [PreserveSig] int IsDirty();",
    "    void Load([MarshalAs(UnmanagedType.LPWStr)] string f, uint mode);",
    "    void Save([MarshalAs(UnmanagedType.LPWStr)] string f, [MarshalAs(UnmanagedType.Bool)] bool remember);",
    "    void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string f);",
    "    void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string f);",
    "  }",
    '  [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
    "  interface IPropertyStore {",
    "    void GetCount(out uint c);",
    "    void GetAt(uint i, out PROPERTYKEY key);",
    "    void GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);",
    "    void SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);",
    "    void Commit();",
    "  }",
    '  [ComImport, Guid("00021401-0000-0000-C000-000000000046")] class ShellLink { }',
    "  [StructLayout(LayoutKind.Sequential, Pack = 4)]",
    "  public struct PROPERTYKEY { public Guid fmtid; public uint pid; }",
    "  [StructLayout(LayoutKind.Sequential)]",
    "  public struct PROPVARIANT { public ushort vt; public ushort r1, r2, r3; public IntPtr p; public IntPtr p2; }",
    '  [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT pv);',
    "  public static void SetId(string lnk, string id) {",
    "    var link = new ShellLink();",
    "    ((IPersistFile)link).Load(lnk, 2);",
    "    var store = (IPropertyStore)link;",
    "    var key = new PROPERTYKEY();",
    '    key.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");',
    "    key.pid = 5;",
    "    var pv = new PROPVARIANT();",
    "    pv.vt = 31;",
    "    pv.p = Marshal.StringToCoTaskMemUni(id);",
    "    try { store.SetValue(ref key, ref pv); store.Commit(); }",
    "    finally { PropVariantClear(ref pv); }",
    "    ((IPersistFile)link).Save(lnk, true);",
    "  }",
    "}",
  ].join(String.fromCharCode(10));
}

/**
 * Writes the Start Menu shortcut that gives the window its taskbar icon.
 *
 * Through a temporary .ps1 rather than `powershell -Command`: the interop
 * below needs a here-string, and a here-string's terminator has to start a
 * line - which it cannot reliably do inside a single command-line argument.
 * The first attempt at that failed silently and left the shortcut without its
 * id, which is the one part that actually fixes the icon.
 */
function writeWindowsShortcut(target: string, ico: string): boolean {
  const appData = process.env["APPDATA"];
  if (appData === undefined || appData.length === 0) return false;
  const link = join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "gitc.lnk");

  // The AUMID Chromium gives an --app window: brand, host and path, then the
  // --user-data-dir basename with non-alphanumerics stripped. Windows matches
  // the window to this shortcut by that id, and takes the icon from here.
  const aumid = "MSEdge.127.0.0.1_/.gitcwindow.Default";

  const q = (value: string) => "'" + value.replace(/'/g, "''") + "'";
  const script = [
    "$ErrorActionPreference='Stop'",
    "$link=" + q(link),
    "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($link)",
    "$s.TargetPath=" + q(target),
    "$s.IconLocation=" + q(ico + ",0"),
    "$s.Description='A fast, minimal git client'",
    "$s.WorkingDirectory=" + q(dirname(target)),
    "$s.Save()",
    "Add-Type -TypeDefinition @'",
    windowsAumidSource(),
    "'@",
    "[GitcLnk]::SetId($link," + q(aumid) + ")",
    "",
  ].join(String.fromCharCode(10));

  const file = join(tmpdir(), "gitc-shortcut.ps1");
  writeFileSync(file, script, "utf8");
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
    { stdio: "ignore" },
  );
  try {
    rmSync(file, { force: true });
  } catch {
    // A leftover script in the temp directory is not worth failing over.
  }
  return r.status === 0;
}

/** Writes the Linux icon theme entries and the .desktop file. */
function writeLinuxDesktop(target: string, lines: string[]): void {
  const dataHome = process.env["XDG_DATA_HOME"];
  const share =
    dataHome !== undefined && dataHome.length > 0 ? dataHome : join(homedir(), ".local", "share");

  for (const icon of PNG_BASE64) {
    const dir = join(share, "icons", "hicolor", `${icon.size}x${icon.size}`, "apps");
    ensureDir(dir);
    writeFileSync(join(dir, "gitc.png"), fromBase64(icon.data));
  }
  lines.push("  icons     " + join(share, "icons", "hicolor"));

  const apps = join(share, "applications");
  ensureDir(apps);
  const desktop = [
    "[Desktop Entry]",
    "Type=Application",
    "Name=gitc",
    "GenericName=Git Client",
    "Comment=A fast, minimal git client",
    "Exec=" + target + " %f",
    "Icon=gitc",
    "Terminal=false",
    "Categories=Development;RevisionControl;",
    "Keywords=git;vcs;version control;",
    "StartupNotify=true",
    // gitc launches its window with --class=gitc; this is what ties that
    // window to this entry, and so to the icon above.
    "StartupWMClass=gitc",
    "",
  ].join("\n");
  writeFileSync(join(apps, "gitc.desktop"), desktop, "utf8");
  lines.push("  desktop   " + join(apps, "gitc.desktop"));

  // Best effort: not every desktop ships these, and a stale cache only means
  // the icon appears a little later.
  spawnSync("update-desktop-database", [apps], { stdio: "ignore" });
  spawnSync("gtk-update-icon-cache", ["-f", "-t", join(share, "icons", "hicolor")], {
    stdio: "ignore",
  });
}

/**
 * Installs the running binary.
 *
 * Copying rather than moving: the file being run may be a download somebody
 * wants to keep, and on Windows it cannot move itself while it is running
 * anyway.
 */
export function install(): InstallReport {
  const dir = installDir();
  const target = installedBinary();
  const lines: string[] = [];

  lines.push(NAME + " " + VERSION);
  ensureDir(dir);

  if (process.execPath.toLowerCase() !== target.toLowerCase()) {
    try {
      copyFileSync(process.execPath, target);
      if (!windows) chmodSync(target, 0o755);
    } catch {
      // Windows will not let a running executable be overwritten, so this is
      // what happens when gitc is already open. The existing install is fine
      // to hand off to; there is nothing to fix.
      lines.push("  binary    already in use, kept the installed copy");
      return { lines, target, onPath: pathContains(dir) };
    }
  }
  lines.push("  binary    " + target);

  if (windows) {
    const ico = join(dir, "gitc.ico");
    writeFileSync(ico, fromBase64(ICO_BASE64));
    lines.push("  icon      " + ico);
    if (writeWindowsShortcut(target, ico)) {
      lines.push("  shortcut  Start Menu");
    }
  } else {
    writeLinuxDesktop(target, lines);
  }

  let onPath = pathContains(dir);
  if (!onPath) {
    if (windows) {
      if (addToWindowsPath(dir)) {
        lines.push("  path      added for your user - open a new terminal to pick it up");
        onPath = true;
      }
    } else {
      // Editing a shell profile behind someone's back is worse than telling
      // them: which file even applies depends on their shell.
      lines.push("  path      " + dir + " is not on PATH - add it to run `gitc` by name:");
      lines.push('              export PATH="' + dir + ':$PATH"');
    }
  } else {
    lines.push("  path      already on PATH");
  }

  return { lines, target, onPath };
}

/** Takes the install directory back off the user's PATH on Windows. */
function removeFromWindowsPath(dir: string): boolean {
  const script =
    "$d='" +
    dir.replace(/'/g, "''") +
    "'; $p=[Environment]::GetEnvironmentVariable('PATH','User'); " +
    "$kept=($p -split ';' | Where-Object { $_ -and $_ -ne $d }) -join ';'; " +
    "[Environment]::SetEnvironmentVariable('PATH', $kept, 'User')";
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    stdio: "ignore",
  });
  return r.status === 0;
}

/** Removes everything install() created, leaving repositories untouched. */
export function uninstall(): string[] {
  const lines: string[] = [];
  const dir = installDir();
  const target = installedBinary();

  // The binary cannot delete itself while running, and saying so is better
  // than failing silently.
  if (existsSync(target)) {
    if (process.execPath.toLowerCase() === target.toLowerCase()) {
      lines.push("  binary    still running - delete it yourself: " + target);
    } else {
      rmSync(target, { force: true });
      lines.push("  binary    removed " + target);
    }
  }

  if (windows) {
    const ico = join(dir, "gitc.ico");
    if (existsSync(ico)) rmSync(ico, { force: true });
    const appData = process.env["APPDATA"];
    if (appData !== undefined && appData.length > 0) {
      const link = join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "gitc.lnk");
      if (existsSync(link)) {
        rmSync(link, { force: true });
        lines.push("  shortcut  removed");
      }
    }
  } else {
    const dataHome = process.env["XDG_DATA_HOME"];
    const share =
      dataHome !== undefined && dataHome.length > 0 ? dataHome : join(homedir(), ".local", "share");
    const desktop = join(share, "applications", "gitc.desktop");
    if (existsSync(desktop)) {
      rmSync(desktop, { force: true });
      lines.push("  desktop   removed");
    }
    for (const icon of PNG_BASE64) {
      const png = join(share, "icons", "hicolor", `${icon.size}x${icon.size}`, "apps", "gitc.png");
      if (existsSync(png)) rmSync(png, { force: true });
    }
    lines.push("  icons     removed");
  }

  if (windows) {
    if (removeFromWindowsPath(dir)) lines.push("  path      removed from your PATH");
  }

  lines.push("  settings  kept in your config directory - delete it by hand if you want it gone");
  return lines;
}
