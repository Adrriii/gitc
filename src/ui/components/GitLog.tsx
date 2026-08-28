import { useEffect, useRef, useState } from "react";
import type { GitCall } from "../types";
import { commandType } from "../settings";
import { Icon } from "./Icon";
import { CloseButton } from "./CloseButton";
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
  hiddenCount,
  onHide,
  onClose,
  onClear,
}: {
  /** Already filtered: what this shows is what is not hidden. */
  calls: GitCall[];
  hiddenCount: number;
  onHide: (type: string) => void;
  onClose: () => void;
  onClear: () => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Rows are one line each, and a click opens one out in full. Keyed by the
  // command rather than by id: a repeat collapses into the row above it and
  // arrives with a fresh id, which would otherwise close a row someone had
  // just opened, over and over, while a poll ran.
  const [open, setOpen] = useState<string[]>([]);
  const keyOf = (repo: string, args: string) => repo + String.fromCharCode(0) + args;
  const toggle = (key: string) =>
    setOpen((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

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
        <span className={s.blurb}>
          {hiddenCount > 0
            ? "oldest first - hidden types are listed in Preferences"
            : "everything gitc has run, oldest first"}
        </span>
        {/*
          Said plainly rather than left to be noticed. A log quietly missing
          things is worse than no log, and this is the only clue that the
          hiding happened at all once the row is gone.
        */}
        {hiddenCount > 0 && (
          <span className={s.hiddenNote}>
            {hiddenCount} hidden
          </span>
        )}
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
        <CloseButton onClick={onClose} title="Close (Esc)" />
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
          <div className={s.empty}>
            {hiddenCount > 0
              ? `Everything run so far is of a kind you have hidden (${hiddenCount} command${hiddenCount === 1 ? "" : "s"}). Preferences › Command log brings them back.`
              : "Nothing yet. Any action here runs git, and shows up below."}
          </div>
        ) : (
          calls.map((call) => {
            const key = keyOf(call.repo, call.args);
            const expanded = open.includes(key);
            return (
              <div
                key={call.id}
                className={`${s.row} ${call.ok ? "" : s.failed} ${expanded ? s.expanded : ""}`}
                onClick={() => toggle(key)}
                title={expanded ? "Click to collapse" : "Click to see the whole command"}
              >
                <span className={s.time}>{clock(call.at)}</span>
                <span className={s.cmd}>
                  <span className={s.git}>git</span> {call.args}
                  {call.count > 1 && <span className={s.repeat}>×{call.count}</span>}
                </span>
                {/*
                  The same gesture as hiding a branch, in the same shape: an
                  eye that appears on the row you are pointing at.
                */}
                <button
                  className={s.hide}
                  title={`Hide every "git ${commandType(call.args)}" from this log`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onHide(commandType(call.args));
                  }}
                >
                  <Icon name="eyeOff" size={12} />
                </button>
                <span className={`${s.ms} ${call.running ? s.pending : ""}`}>
                  {call.running ? "running" : `${call.ms}ms`}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
