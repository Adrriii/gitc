import type { ReactNode } from "react";
import { useEffect } from "react";
import s from "./Confirm.module.scss";

/**
 * A modal for actions that cannot be undone.
 *
 * Destructive git operations deserve more than a browser confirm(): the user
 * should be told exactly what is about to happen — how many files, and
 * whether they are reverted or deleted — before agreeing to it.
 */
export function Confirm({
  title,
  body,
  confirmLabel,
  destructive,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onConfirm, onCancel]);

  return (
    <div className={s.backdrop} onClick={onCancel}>
      <div className={s.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={s.title}>{title}</div>
        <div className={s.body}>{body}</div>
        <div className={s.actions}>
          <button className={s.cancel} onClick={onCancel}>
            Cancel
          </button>
          <button
            className={destructive ? s.destructive : s.confirm}
            onClick={onConfirm}
            autoFocus
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
