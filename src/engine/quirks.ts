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
//  1. raiseWindow() does nothing on Windows.        - in this file
//  2. PowerShell flashes a console on Windows.      - in this file
//  3. There is no reachable native dialog.          - in this file
//  4. The browser-exit hook cannot see every close. - main.ts, useHeartbeat.ts
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

/**
 * Brings the existing gitc window to the front, where the platform allows it.
 *
 * On Windows it does nothing, and there is currently no way to make it do
 * anything. Three routes were tried:
 *
 *  - SetForegroundWindow directly. scriptc has no user-facing FFI and no
 *    windowing (docs/toolchain.md), so native calls are not reachable.
 *  - PowerShell, which can reach it through Add-Type. This worked and was
 *    what gitc shipped, but see powershell() below: it flashes a console
 *    window every time, which on an app that has just failed to appear looks
 *    exactly like something going wrong.
 *  - Letting the page raise itself with window.focus(). Chromium ignores it
 *    without a user gesture. Measured on an --app window with CDP:
 *    document.hasFocus() stays false across the call.
 *
 * So a second launch opens a window when there isn't one, and otherwise does
 * nothing visible. Not raising a window that is already on screen is a
 * smaller failure than a console flash on every start.
 *
 * SWAP WHEN: scriptc gains FFI, or gitc stops borrowing a browser for its
 * window. Either makes this a real raise on Windows.
 *
 * Linux is unaffected and keeps its raise - wmctrl matches the WM_CLASS gitc
 * sets with --class=gitc, xdotool is the fallback, and neither can allocate a
 * console because there are none to allocate.
 */
export function raiseWindow(): void {
  if (process.platform === "win32") return;

  const wm = spawnSync("wmctrl", ["-x", "-a", "gitc"], { stdio: "ignore" });
  if (wm.status === 0) return;
  spawnSync("xdotool", ["search", "--class", "gitc", "windowactivate"], { stdio: "ignore" });
}

/**
 * Runs a PowerShell script, accepting that it flashes a console window.
 *
 * Every PowerShell call gitc makes goes through here, so that the day the
 * flash can be suppressed it is suppressed in one place.
 *
 * Why it flashes: gitc is linked as a GUI-subsystem binary so that launching
 * it from a shortcut opens no console. A GUI process has no console, so when
 * it starts a CONSOLE program - powershell.exe is one - Windows allocates a
 * fresh, visible one for it. `stdio: "ignore"` does not prevent that; it only
 * discards the output that console would have shown.
 *
 * Node's answer is the `windowsHide` option, which sets CREATE_NO_WINDOW.
 * scriptc accepts that option, type-checks it, compiles it, and discards it -
 * "accepted-but-inert" in its own frontend/types.js, "a POSIX no-op,
 * evaluated for side effects" in lower-builtins.js. It is passed below
 * anyway: it costs nothing, it documents the intent, and it starts working
 * for free if scriptc ever lowers it.
 *
 * That is why the window-raising path above no longer uses this at all. What
 * remains are the install-time calls, which need COM (a shortcut with an
 * AppUserModelID) and the user's environment block (PATH) - neither reachable
 * any other way without FFI. Those run once, when a freshly downloaded binary
 * installs itself, rather than on every start.
 *
 * SWAP WHEN: scriptc lowers windowsHide - then this is already correct and
 * the comment is all that needs deleting. Failing that, a GUI-subsystem
 * helper would avoid the console entirely, but the ones Windows ships for
 * this (wscript, mshta) are deprecated and are exactly the shapes malware
 * uses, which is not a trade gitc should make to hide a one-time install.
 */
export function powershell(args: string[]): boolean {
  const r = spawnSync("powershell", args, {
    stdio: "ignore",
    // Currently inert under scriptc. See above - kept so this starts working
    // on its own if that changes.
    windowsHide: true,
  });
  return r.status === 0;
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
    // port, which is precisely the thing that is already taken. Composed read
    // of address().port, which is the only form scriptc lowers.
    server.listen(0, () => {
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
