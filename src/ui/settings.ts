import { useCallback, useEffect, useState } from "react";

/**
 * The settings that live in the preferences screen.
 *
 * They are kept here rather than inside the view that happens to use them,
 * because two places now read each one: the view, and the preferences pane
 * that sets it. A change has to reach both immediately - a setting you have to
 * reopen a file to see is a setting that looks broken.
 *
 * localStorage is the store, and a window event is the notification. The
 * browser's own `storage` event only fires in OTHER tabs, which is exactly the
 * case that never happens here, so it cannot be used for this.
 */

const CHANGED = "gitc:settings";

function announce(): void {
  window.dispatchEvent(new Event(CHANGED));
}

function useStored<T>(
  key: string,
  fallback: T,
  parse: (raw: string) => T | null,
  // Explicit, because String(true) is "true" while the stored form for a
  // boolean here is "1" - and a mismatch between writing and reading shows up
  // as a setting that silently resets.
  serialize: (value: T) => string = String,
) {
  const read = useCallback((): T => {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(key);
    if (raw === null) return fallback;
    const value = parse(raw);
    return value === null ? fallback : value;
  }, [key, fallback, parse]);

  const [value, setValue] = useState<T>(read);

  useEffect(() => {
    const sync = () => setValue(read());
    window.addEventListener(CHANGED, sync);
    return () => window.removeEventListener(CHANGED, sync);
  }, [read]);

  const set = useCallback(
    (next: T) => {
      localStorage.setItem(key, serialize(next));
      setValue(next);
      announce();
    },
    [key, serialize],
  );

  return [value, set] as const;
}

// --- tab width ---------------------------------------------------------------

/** The widths worth offering. Anything else is a rounding error on taste. */
export const TAB_SIZES = [2, 4, 8];

const TAB_KEY = "gitc.tabSize";

function parseTab(raw: string): number | null {
  const n = Number(raw);
  return TAB_SIZES.includes(n) ? n : null;
}

/**
 * How wide a tab renders, in characters.
 *
 * A setting rather than a constant because it is a property of the code being
 * read, not of gitc: Go and Makefiles want 8, most everything else 2 or 4. The
 * default is 4 - the browser's own default is 8, which is what made tabbed
 * files look absurdly deeply indented.
 *
 * It is published as a CSS custom property on the document, so every view that
 * renders code picks it up from one place: the diff, the file view and the
 * conflict editor cannot drift apart.
 */
export function useTabSize() {
  const [size, set] = useStored<number>(TAB_KEY, 4, parseTab);

  useEffect(() => {
    document.documentElement.style.setProperty("--tab-size", String(size));
  }, [size]);

  const cycle = useCallback(() => {
    const i = TAB_SIZES.indexOf(size);
    set(TAB_SIZES[(i + 1) % TAB_SIZES.length]);
  }, [size, set]);

  return { size, set, cycle };
}

// --- long lines --------------------------------------------------------------

const WRAP_KEY = "gitc.diffWrap";

function parseWrap(raw: string): boolean | null {
  if (raw === "1") return true;
  if (raw === "0") return false;
  return null;
}

/** Whether long lines wrap in the diff, or scroll horizontally. */
export function useDiffWrap() {
  // Stored as 1/0, which is what the diff view wrote before this moved here -
  // so an existing preference keeps working.
  const [wrap, set] = useStored<boolean>(WRAP_KEY, true, parseWrap, (v) => (v ? "1" : "0"));
  return { wrap, set };
}

// --- automatic fetching ------------------------------------------------------

/** Minutes between background fetches. 0 turns it off. */
export const FETCH_INTERVALS = [0, 1, 5, 15];

const FETCH_KEY = "gitc.fetchMinutes";

function parseFetch(raw: string): number | null {
  const n = Number(raw);
  return FETCH_INTERVALS.includes(n) ? n : null;
}

/**
 * How often gitc fetches the active repository by itself.
 *
 * Only the repository you are looking at, and only while the window has focus:
 * a git client quietly fetching forty repositories in the background is how
 * you end up throttled by a forge, and nobody is reading the other tabs.
 */
export function useFetchInterval() {
  const [minutes, set] = useStored<number>(FETCH_KEY, 5, parseFetch);
  return { minutes, set };
}
