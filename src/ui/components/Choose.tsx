import { useEffect } from "react";
import s from "./Choose.module.scss";

/**
 * Picks one of a handful of options.
 *
 * Used when an action has more than one possible destination and guessing
 * would be wrong - pushing a new branch to the wrong remote publishes it
 * somewhere you cannot quietly take it back from.
 */
export function Choose({
  title,
  body,
  options,
  onPick,
  onCancel,
}: {
  title: string;
  body?: string;
  options: { value: string; label: string; hint?: string }[];
  onPick: (value: string) => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className={s.backdrop} onClick={onCancel}>
      <div className={s.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={s.title}>{title}</div>
        {body && <div className={s.body}>{body}</div>}
        <div className={s.options}>
          {options.map((o, i) => (
            <button
              key={o.value}
              className={s.option}
              autoFocus={i === 0}
              onClick={() => onPick(o.value)}
            >
              <span className={s.optLabel}>{o.label}</span>
              {o.hint && <span className={s.optHint}>{o.hint}</span>}
            </button>
          ))}
        </div>
        <div className={s.actions}>
          <button className={s.cancel} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
