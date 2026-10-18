// Workarounds for things outside gitc, gathered so each can be deleted the
// day the thing it works around improves.
//
// Nothing here is a design decision. Every function is shaped by a limit in
// the toolchain, the browser, or Windows itself, and each carries the exact
// condition that would let it go. They live together because they are
// otherwise invisible: a `return` on Windows and an option that does nothing
// both read as ordinary code, and the next person to touch them has no way to
// know they are load-bearing.
//
// The inventory, including the parts too entangled to move here:
//
//  1. Raising the window on Windows needs native code.  - in this file
//  2. PowerShell would flash a console on Windows.      - in this file
//  3. There is no reachable native dialog.              - in this file
//  4. The browser-exit hook cannot see every close.     - main.ts, useHeartbeat.ts
//
// (1) and (2) go through native/gitc.c, linked with scriptc's FFI.
//
// (4) is the one that is not contained, because the response to it - the
// goodbye beacon, the grace timer, the launcher's probe - is spread across
// the engine and the UI and has become how gitc's lifecycle works rather than
// a patch over it. Named here so the reason is findable: Chromium started
// with a --user-data-dir a browser is ALREADY using hands the window over and
// exits immediately, so the process gitc spawned is not the process that owns
// the window, and its exit says nothing about whether the window closed. If
// gitc ever owns its window directly, all of that can collapse back into "the
// window closed, so exit".

import { spawnSync } from "node:child_process";
import { createServer } from "node:http";

declare function gitcRaiseWindow(title: string): number;
declare function gitcRunHidden(commandLine: string): number;

/**
 * Brings the existing gitc window to the front.
 *
 * On Windows, native/gitc.c finds the Chromium window titled exactly "gitc"
 * and calls SetForegroundWindow. Windows grants that to a process the user
 * just started, which a second launch always is. Letting the page raise
 * itself with window.focus() does not work: Chromium ignores it without a
 * user gesture (document.hasFocus() stays false, measured over CDP).
 *
 * On Linux wmctrl matches the WM_CLASS gitc sets with --class=gitc, and
 * xdotool is the fallback.
 */
export function raiseWindow(): void {
  if (process.platform === "win32") {
    gitcRaiseWindow("gitc");
    return;
  }

  const wm = spawnSync("wmctrl", ["-x", "-a", "gitc"], { stdio: "ignore" });
  if (wm.status === 0) return;
  spawnSync("xdotool", ["search", "--class", "gitc", "windowactivate"], { stdio: "ignore" });
}

/**
 * Runs a PowerShell script without a console window.
 *
 * gitc is linked as a GUI-subsystem binary, so a CONSOLE program it starts -
 * powershell.exe is one - gets a fresh, visible console from Windows. Node's
 * `windowsHide` would set CREATE_NO_WINDOW, but scriptc parses it and ignores
 * it (scr_child.c, 0.3.6), so native/gitc.c calls CreateProcessW with that
 * flag itself. Only the install-time calls come through here: the shortcut
 * with its AppUserModelID, and the user's PATH.
 */
export function powershell(args: string[]): boolean {
  if (process.platform === "win32") return gitcRunHidden(windowsCommandLine(["powershell", ...args])) === 0;
  return spawnSync("powershell", args, { stdio: "ignore" }).status === 0;
}

/**
 * Asks the user whether to take over from a gitc that is already running.
 *
 * Resolves true to take over, false to leave the running instance alone.
 *
 * This draws its own window instead of using a native dialog, because there
 * is no native dialog gitc can reach. MessageBox needs FFI, which scriptc
 * does not have. The console helpers that could stand in for it - powershell
 * -Command with Add-Type, or a .NET shim - all flash a console window, which
 * is the exact thing this app has just finished removing from its startup
 * path. The GUI-subsystem helpers that would not flash, wscript and mshta,
 * are deprecated in current Windows and are the classic malware shape; a git
 * client should not be teaching a machine to trust them. And none of that
 * transfers to Linux, where the answer would be zenity or kdialog, neither of
 * which is guaranteed to be installed.
 *
 * A Chromium --app window is the one thing gitc already knows is present,
 * because the whole application is one. So the launcher serves two hundred
 * bytes of HTML on an ephemeral port, opens it the same way the main window
 * is opened, and waits for the answer to come back as a request. One code
 * path, both platforms, nothing deprecated, no console.
 *
 * SWAP WHEN: scriptc gains FFI (then MessageBox and its Linux equivalents
 * become reachable directly), or gitc stops borrowing a browser for its
 * window - a real toolkit would bring a real dialog with it.
 */
export function confirmTakeOver(
  launch: (url: string, size: string) => boolean,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    // When the page last said it was there. Dismissing the window with the X
    // is an answer too, and the safe reading of it is "leave things alone" -
    // without noticing it the launcher waits on a question nobody is looking
    // at any more and never exits, which is the exact shape of problem this
    // dialog exists to prevent.
    //
    // The page reports this itself rather than the process being watched,
    // because watching the process does not work: Chromium re-execs and the
    // process gitc spawned exits within a second whether the window lives or
    // not. That is the same fork that stops the browser-exit hook from seeing
    // the main window close (see the file header), showing up again.
    let lastSeen = 0;
    const startedAt = Date.now();

    const finish = (takeOver: boolean) => {
      if (settled) return;
      settled = true;
      clearInterval(watch);
      server.close();
      resolve(takeOver);
    };

    const watch = setInterval(() => {
      if (settled) return;
      // Armed only once the page has checked in at least once, so a window
      // that is merely slow to open is never mistaken for one that is gone.
      if (lastSeen !== 0 && Date.now() - lastSeen > DIALOG_GONE_MS) finish(false);
      // ...and a page that never checks in at all cannot hang us forever.
      if (lastSeen === 0 && Date.now() - startedAt > DIALOG_NO_SHOW_MS) finish(false);
    }, 1000);
    const server = createServer((req, res) => {
      const url = req.url === undefined ? "/" : req.url;

      if (url.startsWith("/alive")) {
        lastSeen = Date.now();
        res.writeHead(204);
        res.end();
        return;
      }

      if (url.startsWith("/choice")) {
        const takeOver = url.includes("c=restart");
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{\"ok\":true}");
        // Let the reply reach the page so it can close its own window before
        // the server under it goes away.
        if (!settled) setTimeout(() => finish(takeOver), 150);
        return;
      }

      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(DIALOG_HTML);
    });

    // Port 0 lets the OS pick a free one - the launcher cannot use gitc's own
    // port, which is precisely the thing that is already taken.
    server.listen(0, "127.0.0.1", () => {
      const url = "http://127.0.0.1:" + String(server.address().port) + "/";

      // No browser to ask with. Leaving the running instance alone is the
      // safe answer: it is the one that still has the user's session.
      if (!launch(url, DIALOG_SIZE)) finish(false);
    });
  });
}

/**
 * Outer window size for the confirm, chosen to sit close to a native Windows
 * MessageBox rather than to gitc's own windows - it is a dialog, and one line
 * of text does not need a quarter of the screen.
 *
 * Outer, not inner: the title bar and borders come out of this, and CSS pixels
 * shrink against it under display scaling, so the usable height at 125% is
 * appreciably less than the number suggests. The content needs about 107 CSS
 * pixels; this leaves room for it at the scalings people actually use rather
 * than fitting exactly at 100% and clipping the heading everywhere else.
 */
const DIALOG_SIZE = "400,190";

/** Silence from the dialog page that means its window has gone. */
const DIALOG_GONE_MS = 3500;
/** How long to wait for a window that never appears at all. */
const DIALOG_NO_SHOW_MS = 20000;

const DIALOG_HTML =
  "<!doctype html><html><head><meta charset=\"utf-8\"><title>gitc</title><style>" +
  "html,body{margin:0;height:100%;background:#131519;color:#c9ccd1;" +
  "font:13px/1.5 'Segoe UI',Inter,'Noto Sans','DejaVu Sans','Liberation Sans',Arial,sans-serif;" +
  "-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}" +
  "body{display:flex;flex-direction:column;justify-content:space-between;padding:14px 16px;box-sizing:border-box}" +
  "h1{margin:0 0 8px;font-size:14px;font-weight:600;color:#eceef1}" +
  "p{margin:0;color:#9aa0a8}" +
  ".row{display:flex;gap:8px;justify-content:flex-end}" +
  "button{font:inherit;padding:6px 14px;border-radius:5px;border:1px solid #2a2e36;" +
  "background:#171a20;color:#c9ccd1;cursor:pointer}" +
  "button:hover{background:#1c2027}" +
  "button.p{background:#16263f;border-color:#2f5fb0;color:#d5e3ff}" +
  "button.p:hover{background:#1b2f4d}" +
  "</style></head><body>" +
  "<div><h1>gitc is already running</h1>" +
  "<p>Close it and start a new one?</p></div>" +
  "<div class=\"row\">" +
  "<button id=\"c\" autofocus>Cancel</button>" +
  "<button id=\"r\" class=\"p\">Restart gitc</button>" +
  "</div><script>" +
  // No nested quotes anywhere in this script. An escaped quote inside these
  // TypeScript string literals does not survive into the emitted JS, and one
  // broken literal is a syntax error for the WHOLE block - which silently
  // took the buttons and the heartbeat with it.
  "function pick(c){fetch('/choice?c='+c).then(function(){window.close();" +
  "setTimeout(function(){document.body.textContent=" +
  "'You can close this window.'},400)})}" +
  "document.getElementById('c').onclick=function(){pick('cancel')};" +
  "document.getElementById('r').onclick=function(){pick('restart')};" +
  "addEventListener('keydown',function(e){" +
  "if(e.key==='Escape')pick('cancel');if(e.key==='Enter')pick('restart')});" +
  "var beat=function(){fetch('/alive').catch(function(){})};beat();" +
  "setInterval(beat,1000);" +
  "</script></body></html>";

/** Joins arguments into one Windows command line, quoted as libuv (and so Node and scriptc) quote them. */
export function windowsCommandLine(args: string[]): string {
  return args.map(quoteArg).join(" ");
}

function quoteArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[ \t"]/.test(arg)) return arg;
  if (!/["\\]/.test(arg)) return '"' + arg + '"';
  let out = "";
  let quoteHit = true;
  for (let i = arg.length - 1; i >= 0; i--) {
    const c = arg.charAt(i);
    out = c + out;
    if (quoteHit && c === "\\") {
      out = "\\" + out;
    } else if (c === '"') {
      quoteHit = true;
      out = "\\" + out;
    } else {
      quoteHit = false;
    }
  }
  return '"' + out + '"';
}
