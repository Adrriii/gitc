import { useCallback, useEffect, useRef, useState } from "react";
import type { GitCall } from "./types";
import { api } from "./api";

/** Matches the engine's own cap; the UI never holds more than it is sent. */
export const GIT_LOG_LIMIT = 2000;

const INTERVAL_MS = 1200;

/**
 * Tails the git commands the engine runs.
 *
 * gitc does all of its work by running git, and this is what makes that
 * visible. The intent is not diagnostics but teaching: every action shows the
 * command it actually ran, so using gitc leaves you knowing git rather than
 * knowing gitc.
 *
 * Only what the caller does not already hold is fetched - the poll carries the
 * highest id seen, so the common case answers with an empty list.
 */
export function useGitLog(): { calls: GitCall[]; clear: () => void } {
  const [calls, setCalls] = useState<GitCall[]>([]);
  const seen = useRef(0);

  useEffect(() => {
    let stopped = false;

    const tick = async () => {
      if (stopped || document.hidden) return;
      try {
        const fresh = await api.gitLog(seen.current);
        if (stopped || fresh.length === 0) return;
        seen.current = fresh[fresh.length - 1].id;
        setCalls((prev) => {
          const next = [...prev];
          for (const call of fresh) {
            // The engine collapses a repeated command into the previous entry
            // and re-sends it with a fresh id, so an arriving call that
            // matches the tail replaces it rather than adding a row.
            const last = next.length > 0 ? next[next.length - 1] : undefined;
            if (last !== undefined && last.args === call.args && last.repo === call.repo) {
              next[next.length - 1] = call;
            } else {
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
  }, []);

  // Clears the view, not the engine's record: the next poll resumes from
  // where it left off rather than replaying everything.
  const clear = useCallback(() => setCalls([]), []);

  return { calls, clear };
}
