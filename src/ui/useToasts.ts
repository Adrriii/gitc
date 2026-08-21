import { useCallback, useRef, useState } from "react";
import { errorLine, hasDetail } from "./gitMessage";

export type ToastKind = "ok" | "warn" | "error";

export interface Toast {
  id: number;
  kind: ToastKind;
  /** The line worth reading first. */
  title: string;
  /** Everything git said, when that is more than the title. */
  detail: string;
}

/**
 * How long each kind stays before it removes itself.
 *
 * A failure does not leave on its own. The complaint that started this was
 * that a message in the status bar is easy to miss, and a failure that
 * disappears after four seconds is the same problem wearing a brighter
 * colour - so errors wait to be dismissed, and the ones that merely report
 * success get out of the way.
 */
const LIFETIME: Record<ToastKind, number> = {
  ok: 5000,
  warn: 12000,
  error: 0,
};

/** More than this on screen and the oldest go, newest being the ones that matter. */
const MAX_VISIBLE = 4;

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const text = message.trim();
      if (text.length === 0) return;

      const id = nextId.current;
      nextId.current += 1;

      const toast: Toast = {
        id,
        kind,
        title: errorLine(text),
        detail: hasDetail(text) ? text : "",
      };

      setToasts((prev) => {
        const next = [...prev, toast];
        return next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next;
      });

      const life = LIFETIME[kind];
      if (life > 0) {
        timers.current.set(
          id,
          window.setTimeout(() => dismiss(id), life),
        );
      }
    },
    [dismiss],
  );

  /** Stops a toast expiring - used when someone opens it to read the detail. */
  const hold = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer === undefined) return;
    window.clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  return { toasts, push, dismiss, hold };
}
