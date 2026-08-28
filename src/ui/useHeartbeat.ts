import { useEffect, useState } from "react";

const INTERVAL_MS = 2000;
// Two misses is four seconds, which a restarting engine or a moment of load
// can cover - and the penalty for being wrong is closing the user's window
// out from under them. Ten seconds of silence is a real absence.
const FAILURES_BEFORE_DEAD = 5;

/**
 * Keeps the window and the engine bound together as one application.
 *
 * Three directions:
 *  - the ping tells the engine we are still here, so it can exit when the
 *    window is closed (its browser-exit hook is primary; this is the backstop)
 *  - a failing ping means the engine is gone, so the window closes itself
 *    rather than sitting there showing a dead UI
 *  - a ping answered by a DIFFERENT engine means this window has been handed
 *    to a new process, which is what an update is. The window reloads onto
 *    it: same window, new version, and none of the old state - which was
 *    stuck on the update dialog, since the update it was watching finished
 *    in a process that no longer exists.
 *
 * `window.close()` is permitted here because the page was opened as a
 * Chromium --app window. If a browser refuses it, the caller renders a
 * "disconnected" overlay instead of pretending everything is fine.
 */
export function useHeartbeat(): boolean {
  const [dead, setDead] = useState(false);

  useEffect(() => {
    let failures = 0;
    let stopped = false;
    let engine: string | null = null;

    const tick = async () => {
      if (stopped) return;
      try {
        const res = await fetch("/api/ping", { cache: "no-store" });
        if (!res.ok) throw new Error("bad status");
        failures = 0;

        const body = (await res.json()) as { instance?: string; quitting?: boolean };

        // This engine is handing over to a replacement that is about to take
        // the port. Close now: staying would mean reattaching to the new
        // engine below and leaving the user with two windows after they asked
        // to restart one. Checked before the instance comparison, which would
        // otherwise reload this window onto the replacement.
        if (body.quitting === true) {
          stopped = true;
          setDead(true);
          window.close();
          return;
        }

        const instance = body.instance ?? null;
        if (instance !== null) {
          if (engine === null) {
            engine = instance;
          } else if (engine !== instance) {
            // A different process is answering than the one this page was
            // loaded from. Reloading is what makes an update look like a
            // restart of the window rather than a second copy of the app.
            stopped = true;
            window.location.reload();
          }
        }
      } catch {
        failures += 1;
        if (failures >= FAILURES_BEFORE_DEAD) {
          stopped = true;
          setDead(true);
          window.close();
        }
      }
    };

    void tick();
    const id = window.setInterval(() => void tick(), INTERVAL_MS);

    // Tell the engine the window is going, so it can exit now rather than
    // waiting out its 60s heartbeat timeout. Without this gitc stayed alive
    // for a minute after the window closed, and relaunching inside that
    // minute handed over to an engine with nothing on screen and quit.
    //
    // sendBeacon rather than fetch: the page is being torn down and an
    // ordinary request is cancelled with it. pagehide rather than
    // beforeunload, which Chromium does not reliably fire for an --app window.
    //
    // This also fires on a reload, including the one an update does - which
    // is why the engine waits BYE_GRACE_MS and lets the reloaded page's first
    // ping cancel the exit, instead of taking the beacon as final.
    const bye = () => {
      navigator.sendBeacon("/api/bye");
    };
    window.addEventListener("pagehide", bye);

    return () => {
      stopped = true;
      window.clearInterval(id);
      window.removeEventListener("pagehide", bye);
    };
  }, []);

  return dead;
}
