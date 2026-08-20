import { useEffect, useRef, type RefObject } from "react";
import { api } from "./api";

/** How often to ask, while the window is focused. */
const INTERVAL_MS = 1500;

/** How current each half of the view is, for whatever wants to show it. */
export interface Freshness {
  /** When the view was last confirmed to match the working tree, or 0. */
  checked: RefObject<number>;
  /** When the repository last fetched, or 0 for never. */
  fetched: RefObject<number>;
}

/**
 * Notices when the repository changes underneath gitc.
 *
 * You edit in an editor, commit from a terminal, a build writes output — none
 * of which gitc would otherwise see, because it only refreshes after its own
 * actions. That was the complaint: changes appeared only when you switched
 * repositories, which happened to force a reload.
 *
 * Polling is deliberately confined:
 *
 *  - only the active repository is asked about
 *  - only while the window is focused, since nobody is looking otherwise
 *  - regaining focus checks immediately, which covers the usual pattern of
 *    editing elsewhere and coming back
 *
 * The check is ~230ms of `git status` on a large repository, so an unfocused
 * window sitting on a 1.5s timer would be a real waste of somebody's laptop.
 */
export function useRepoWatch(tabId: string | null, onChange: () => void): Freshness {
  const version = useRef<string | null>(null);
  const changed = useRef(onChange);
  changed.current = onChange;

  // Refs, not state: this updates on every poll, and putting it in state
  // would re-render the whole application - graph included - every 1.5
  // seconds to move a clock in the corner. Whatever displays it re-renders
  // itself instead.
  const checked = useRef(0);
  const fetched = useRef(0);

  useEffect(() => {
    version.current = null;
    checked.current = 0;
    fetched.current = 0;
  }, [tabId]);

  useEffect(() => {
    if (tabId === null) return;
    let stopped = false;
    let timer: number | null = null;

    const check = async () => {
      if (stopped || document.hidden || !document.hasFocus()) return;
      try {
        const r = await api.watch(tabId);
        if (stopped) return;
        if (version.current !== null && version.current !== r.version) {
          changed.current();
        }
        version.current = r.version;
        // Only a successful check counts. A failed one leaves the previous
        // time standing, so the display ages - which is the truth.
        checked.current = Date.now();
        fetched.current = r.fetched;
      } catch {
        // A failed check is not worth reporting: the heartbeat already
        // handles the engine going away, and a transient error here would
        // only produce noise.
      }
    };

    const schedule = () => {
      timer = window.setInterval(() => void check(), INTERVAL_MS);
    };

    // On regaining focus, ask at once rather than waiting out the interval.
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);

    void check();
    schedule();

    return () => {
      stopped = true;
      if (timer !== null) window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [tabId]);

  return { checked, fetched };
}
