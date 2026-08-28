import { useState } from "react";
import type { Toast } from "../useToasts";
import { Icon } from "./Icon";
import { CloseButton } from "./CloseButton";
import s from "./Toasts.module.scss";

const ICON: Record<Toast["kind"], "check" | "warning" | "close"> = {
  ok: "check",
  warn: "warning",
  error: "warning",
};

/**
 * What just happened, where it will be seen.
 *
 * These used to be a line of text in the status bar, which is 21 pixels of
 * grey at the bottom of the window: easy to miss entirely, and too narrow for
 * anything git actually says - a refused push filled it with a URL and hid
 * the reason behind an ellipsis.
 *
 * Bottom left, because that is the corner nearest the actions that cause
 * them. Each new one arrives at the bottom and lifts the earlier ones, so the
 * newest is always in the same spot and the stack reads top-to-bottom in the
 * order things happened. Failures stay until dismissed; the rest leave on
 * their own.
 */
export function Toasts({
  toasts,
  onDismiss,
  onHold,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
  onHold: (id: number) => void;
}) {
  const [opened, setOpened] = useState<number[]>([]);

  if (toasts.length === 0) return null;

  const toggle = (t: Toast) => {
    if (t.detail.length === 0) return;
    // Reading it means it should not vanish mid-sentence.
    onHold(t.id);
    setOpened((prev) => (prev.includes(t.id) ? prev.filter((i) => i !== t.id) : [...prev, t.id]));
  };

  return (
    <div className={s.stack}>
      {toasts.map((t) => {
        const isOpen = opened.includes(t.id);
        return (
          <div key={t.id} className={`${s.toast} ${s[t.kind]}`}>
            <Icon name={ICON[t.kind]} size={13} className={s.ico} />

            <div className={s.text}>
              <button
                className={`${s.title} ${t.detail.length > 0 ? s.expandable : ""}`}
                onClick={() => toggle(t)}
                title={t.detail.length > 0 ? "Show everything git said" : undefined}
              >
                {t.title}
                {t.detail.length > 0 && (
                  <span className={s.chevron}>
                    <Icon name={isOpen ? "chevronDown" : "chevronRight"} size={11} />
                  </span>
                )}
              </button>
              {isOpen && <pre className={s.detail}>{t.detail}</pre>}
            </div>

            <CloseButton onClick={() => onDismiss(t.id)} title="Dismiss" size={11} />
          </div>
        );
      })}
    </div>
  );
}
