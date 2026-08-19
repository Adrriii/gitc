import { useEffect, useState } from "react";

const INTERVAL_MS = 2000;
const FAILURES_BEFORE_DEAD = 2;

/**
 * Keeps the window and the engine bound together as one application.
 *
 * Two directions, both needed:
 *  - the ping tells the engine we are still here, so it can exit when the
 *    window is closed (its browser-exit hook is primary; this is the backstop)
 *  - a failing ping means the engine is gone, so the window closes itself
 *    rather than sitting there showing a dead UI
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

    const tick = async () => {
      if (stopped) return;
      try {
        const res = await fetch("/api/ping", { cache: "no-store" });
        if (!res.ok) throw new Error("bad status");
        failures = 0;
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

    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, []);

  return dead;
}
