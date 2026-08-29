import { useCallback, useEffect, useRef, useState } from "react";
import type { GitCall } from "./types";
import { api } from "./api";

/** Matches the engine's own cap; the UI never holds more than it is sent. */
export const GIT_LOG_LIMIT = 2000;

// Fast enough that a command appears to arrive as it is issued rather than in
// a batch afterwards. The poll is one small request that usually answers with
// an empty list.
const INTERVAL_MS = 350;

/**
 * Tails the git commands the engine runs.
 *
 * gitc does all of its work by running git, and this is what makes that
 * visible. The intent is not diagnostics but teaching: every action shows the
 * command it actually ran, so using gitc leaves you knowing git rather than
 * knowing gitc.
 *
 * Only what has changed is fetched - the poll carries the highest sequence
 * seen, so the common case answers with an empty list. A command is sent
 * twice: once as it starts, so it can be shown while it runs, and once when
 * it ends, carrying how long it took.
 */
export function useGitLog(
  tabId: string | null,
  /** The machine whose log this is - null for this one. */
  host: string | null,
): { calls: GitCall[]; clear: () => void } {
  const [calls, setCalls] = useState<GitCall[]>([]);
  const seen = useRef(0);
  const engine = useRef<string | null>(null);

  useEffect(() => {
    let stopped = false;
    // Reset when the MACHINE changes, not the tab. Sequence numbers are per
    // engine, so carrying one across would skip everything below it - but
    // /api/gitlog is per engine too, and resetting on every tab change undid
    // Clear, which deliberately leaves `seen` alone so the next poll resumes
    // instead of replaying. Clear the log, switch tabs and back, and
    // everything cleared came straight back.
    if (engine.current !== host) {
      engine.current = host;
      seen.current = 0;
      setCalls([]);
    }
    if (tabId === null) return;

    const tick = async () => {
      if (stopped || document.hidden) return;
      try {
        const fresh = await api.gitLog(tabId, seen.current);
        if (stopped || fresh.length === 0) return;

        // The highest sequence in the batch, not the last one in it: an entry
        // that finished after later ones started is re-sent in list order, so
        // the last element is not necessarily the newest change.
        for (const call of fresh) {
          if (call.seq > seen.current) seen.current = call.seq;
        }

        setCalls((prev) => {
          const next = [...prev];
          // By id: an entry arrives once when its command starts and again
          // when it ends, and the second arrival must update the row rather
          // than add one. Repeats are collapsed by the engine into an
          // existing entry, which keeps its id, so they land here too.
          const at = new Map<number, number>();
          for (let i = 0; i < next.length; i++) at.set(next[i].id, i);

          for (const call of fresh) {
            const index = at.get(call.id);
            if (index !== undefined) {
              next[index] = call;
            } else {
              at.set(call.id, next.length);
              next.push(call);
            }
          }
          // Trim from the front: the newest are the ones worth keeping.
          return next.length > GIT_LOG_LIMIT ? next.slice(next.length - GIT_LOG_LIMIT) : next;
        });
      } catch {
        // The engine going away is the heartbeat's business, not this poll's.
      }
    };

    void tick();
    const id = window.setInterval(() => void tick(), INTERVAL_MS);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [tabId, host]);

  // Clears the view, not the engine's record: the next poll resumes from
  // where it left off rather than replaying everything.
  const clear = useCallback(() => setCalls([]), []);

  return { calls, clear };
}
