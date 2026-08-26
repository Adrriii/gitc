import { useEffect, useState } from "react";
import type { Freshness as Signals } from "../useRepoWatch";
import { ago, since } from "../ago";
import { Icon } from "./Icon";
import s from "./Freshness.module.scss";

function when(at: number): string {
  return new Date(at).toLocaleString();
}

/**
 * How current the two things on screen are.
 *
 * They go stale for unrelated reasons and are worth separating:
 *
 *   local  - whether the view still matches the working tree. The watch poll
 *            answers this every 1.5s while the window is focused, so it reads
 *            "now" almost always; it climbing means the poll stopped, which
 *            happens when the window is in the background.
 *   remote - whether the remote-tracking branches are worth believing. Only a
 *            fetch moves this, and nothing on the machine can make it happen
 *            by itself, so it is the one that quietly gets old.
 *
 * Both are also the button for fixing themselves.
 */
export function Freshness({
  signals,
  staleMinutes,
  hasRemote,
  onRefresh,
  onFetch,
}: {
  signals: Signals;
  staleMinutes: number;
  hasRemote: boolean;
  onRefresh: () => void;
  onFetch: () => void;
}) {
  // Its own clock, so a ticking display costs a re-render of these two spans
  // rather than of the graph.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  const now = Date.now();
  const checked = signals.checked.current;
  const fetched = signals.fetched.current;

  const localAge = checked === 0 ? -1 : now - checked;
  const remoteAge = fetched === 0 ? -1 : now - fetched;

  // 4 seconds is a missed poll rather than a slow one, at a 1.5s interval.
  const localStale = localAge < 0 || localAge > 4000;
  const remoteStale = remoteAge < 0 || remoteAge > staleMinutes * 60 * 1000;

  return (
    <span className={s.wrap}>
      <button
        className={`${s.pill} ${localStale ? s.stale : ""}`}
        onClick={onRefresh}
        title={
          localAge < 0
            ? "The view has not been checked against the working tree yet - click to read it now"
            : `The view matched the working tree ${since(localAge)} (${when(checked)}).` +
              " Click to re-read it now."
        }
      >
        <Icon name="monitor" size={11} />
        <span className={s.label}>local</span>
        <span className={s.age}>{localAge < 0 ? "—" : ago(localAge)}</span>
      </button>

      {/*
        Nothing to be stale about in a repository with no remote, and a
        permanent "never" would be a warning about a situation that is fine.
      */}
      {hasRemote && (
        <button
          className={`${s.pill} ${remoteStale ? s.stale : ""}`}
          onClick={onFetch}
          title={
            remoteAge < 0
              ? "This repository has never fetched - click to fetch now"
              : `Remote data last fetched ${since(remoteAge)} (${when(fetched)}).` +
                " Click to fetch now."
          }
        >
          <Icon name="cloud" size={11} />
          <span className={s.label}>remote</span>
          <span className={s.age}>{remoteAge < 0 ? "never" : ago(remoteAge)}</span>
        </button>
      )}
    </span>
  );
}
