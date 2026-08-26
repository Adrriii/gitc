import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
  const box = useRef<HTMLDivElement>(null);
  // Held in a ref so the effect below does not re-subscribe on every render of
  // the application. It is passed as an inline arrow, so its identity changes
  // constantly - and re-subscribing would re-stamp `openedAt` mid-gesture,
  // which is the one thing that must not happen (see below).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const openedAt = performance.now();

    /**
     * Anything that means "not interested in this menu any more".
     *
     * Two things it has to get right, and they pull in opposite directions:
     *
     * The event that OPENED this menu is still propagating toward window when
     * React mounts us, so an unguarded listener catches it and closes the menu
     * in the same gesture - a real right-click then looks like nothing
     * happened. (A MouseEvent dispatched from page script does not reproduce
     * it, which is what let it survive testing once already.) Events older
     * than the menu are not outside clicks; they are its own cause.
     *
     * And it has to be reachable. Fifteen handlers in this UI call
     * stopPropagation on click - dialogs, the WIP input, the sidebar's eye and
     * kebab, which appear under the pointer on hover - so a listener that
     * waits for the event to bubble all the way to window simply never hears
     * about a click on any of them, and the menu stays open. Capture runs
     * before every one of them and cannot be cancelled, at the cost of having
     * to recognise our own clicks by hand.
     */
    const close = (e: Event) => {
      if (e.timeStamp <= openedAt) return;
      const target = e.target;
      // A click on an item is not an outside click - and closing here would
      // unmount the item before its own handler ever ran.
      if (target instanceof Node && box.current?.contains(target)) return;
      closeRef.current();
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };

    // Scrolling moves what the menu is pointing at out from under it - the
    // menu is placed in viewport coordinates and does not follow.
    const onScroll = () => closeRef.current();

    window.addEventListener("click", close, true);
    window.addEventListener("contextmenu", close, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("click", close, true);
      window.removeEventListener("contextmenu", close, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
    // Keyed on the menu itself, not on `onClose`: a new menu restamps
    // `openedAt`, an unrelated re-render must not.
  }, [x, y, items]);

  /**
   * Keeping the menu inside the window.
   *
   * Measured rather than estimated. The guesses this replaces were a fixed
   * 250px of width and 27px per item, and both are wrong the moment a branch
   * has a long name: "Rebase main onto feature/a-very-long-name" makes a menu
   * far wider than 250, and a label that wraps makes a row taller than 27. A
   * menu that then opens near an edge hangs off it.
   *
   * Laid out at the requested point first and corrected before paint, so
   * there is no visible jump.
   */
  const [at, setAt] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = box.current;
    if (el === null) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4));
    const top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4));
    setAt((cur) => (cur.left === left && cur.top === top ? cur : { left, top }));
  }, [x, y, items]);

  return (
    <div className={s.menu} style={at} ref={box}>
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className={s.sep} />
        ) : (
          <div
            key={i}
            className={`${s.item} ${it.action ? "" : s.disabled} ${it.danger ? s.danger : ""}`}
            onClick={() => {
              if (!it.action) return;
              // The action first, then dismiss. Clicks inside the menu are
              // exempt from the outside-click listener - they have to be, or
              // the item would be unmounted before its own handler ran - so
              // choosing an item is the one dismissal it has to do itself.
              it.action();
              closeRef.current();
            }}
          >
            {it.label}
            {it.hint && <div className={s.hint}>{it.hint}</div>}
          </div>
        ),
      )}
    </div>
  );
}
