import { useEffect, useRef } from "react";
import type { GitCall } from "../types";
import { Icon } from "./Icon";
import s from "./GitLog.module.scss";

function clock(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Every git command gitc has run, newest last.
 *
 * A drawer rather than a screen, because it is meant to be read alongside the
 * thing that just happened - you click an action, glance down, and see the
 * command it ran. Anything worth copying can be pasted straight into a
 * terminal, which is the whole point.
 */
export function GitLog({
  calls,
  onClose,
  onClear,
}: {
  calls: GitCall[];
  onClose: () => void;
  onClear: () => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Follows the tail while you are at the bottom, and stays put when you have
  // scrolled up to read something.
  useEffect(() => {
    const el = body.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [calls]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className={s.drawer}>
      <div className={s.head}>
        <span className={s.title}>git commands</span>
        <span className={s.count}>
          {calls.length} {calls.length === 1 ? "command" : "commands"}
        </span>
        <span className={s.blurb}>everything gitc has run, oldest first</span>
        <span className={s.spacer} />
        <button
          className={s.action}
          onClick={() => {
            void navigator.clipboard.writeText(
              calls.map((c) => "git " + c.args).join(String.fromCharCode(10)),
            );
          }}
          title="Copy every command as text"
        >
          Copy all
        </button>
        <button className={s.action} onClick={onClear} title="Clear this view">
          Clear
        </button>
        <button className={s.close} onClick={onClose} title="Close (Esc)">
          <Icon name="close" size={12} />
        </button>
      </div>

      <div
        className={s.body}
        ref={body}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {calls.length === 0 ? (
          <div className={s.empty}>Nothing yet. Any action here runs git, and shows up below.</div>
        ) : (
          calls.map((call) => (
            <div key={call.id} className={`${s.row} ${call.ok ? "" : s.failed}`}>
              <span className={s.time}>{clock(call.at)}</span>
              <span className={s.cmd}>
                <span className={s.git}>git</span> {call.args}
                {call.count > 1 && <span className={s.repeat}>×{call.count}</span>}
              </span>
              <span className={s.ms}>{call.ms}ms</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
