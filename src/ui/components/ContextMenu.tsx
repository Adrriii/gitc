import { useEffect } from "react";
import s from "./ContextMenu.module.scss";

export interface MenuItem {
  /** Absent for a separator, which is the only item with nothing to say. */
  label?: string;
  action?: () => void;
  separator?: boolean;
  /** A quiet second line, for an item whose effect is not obvious. */
  hint?: string;
  /** Destructive: shown in red, because the menu is the last warning. */
  danger?: boolean;
}

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  useEffect(() => {
    const openedAt = performance.now();
    // The event that opened this menu is STILL PROPAGATING toward window when
    // React mounts us, so an unguarded listener catches it and closes the menu
    // in the same gesture - a real right-click then looks like nothing
    // happened at all. (A MouseEvent dispatched from page script does not
    // reproduce it, which is what made this survive testing.) Events that
    // predate the menu are not "outside clicks"; they are its own cause.
    const close = (e: Event) => {
      if (e.timeStamp <= openedAt) return;
      onClose();
    };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
  }, [onClose]);

  // Keep the menu inside the window when opened near an edge.
  const style: React.CSSProperties = {
    left: Math.min(x, window.innerWidth - 250),
    top: Math.min(y, window.innerHeight - items.length * 27 - 12),
  };

  return (
    <div className={s.menu} style={style}>
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className={s.sep} />
        ) : (
          <div
            key={i}
            className={`${s.item} ${it.action ? "" : s.disabled} ${it.danger ? s.danger : ""}`}
            onClick={() => it.action?.()}
          >
            {it.label}
            {it.hint && <div className={s.hint}>{it.hint}</div>}
          </div>
        ),
      )}
    </div>
  );
}
