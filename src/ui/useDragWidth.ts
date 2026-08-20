import { useCallback, useState } from "react";

/**
 * A width you can drag, remembered across sessions.
 *
 * Panel widths are a per-person preference - how wide a branch name gets to be
 * before it truncates, how much of the diff you want on screen - so they are
 * dragged rather than chosen for the user, and persisted so the choice is made
 * once.
 *
 * `edge` says which side the handle is on. A handle on the LEFT of the thing
 * it resizes (the right-hand panel) grows it when the pointer moves left, so
 * the delta is inverted; a handle on the right grows it moving right.
 *
 * The listeners live on `window`, not the handle: the pointer routinely leaves
 * a 7px strip mid-drag, and a handle-bound listener drops the drag the moment
 * it does.
 */
export function useDragWidth(
  key: string,
  initial: number,
  min: number,
  max: number,
  edge: "left" | "right" = "right",
): [number, (e: React.MouseEvent) => void] {
  const [width, setWidth] = useState<number>(() => {
    const saved = typeof localStorage === "undefined" ? null : localStorage.getItem(key);
    if (saved === null) return initial;
    const n = Number(saved);
    // A hand-edited or stale value must not be able to hide a panel entirely.
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : initial;
  });

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = width;
      const sign = edge === "left" ? -1 : 1;

      const onMove = (ev: MouseEvent) => {
        const next = startW + sign * (ev.clientX - startX);
        setWidth(Math.max(min, Math.min(max, next)));
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        setWidth((w) => {
          localStorage.setItem(key, String(w));
          return w;
        });
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [width, key, min, max, edge],
  );

  return [width, onMouseDown];
}
