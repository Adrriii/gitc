import { useEffect, useRef } from "react";

/**
 * The application's keyboard shortcuts, in one place.
 *
 * One listener on `window`, not a handler per component. Shortcuts that live
 * next to the thing they act on only fire while that thing has focus, which is
 * wrong for anything addressing the application itself: switching repository
 * should work whether the caret is in the commit box, the graph or nowhere at
 * all. Components keep the bindings that are genuinely local - Ctrl+Enter to
 * commit belongs to the commit box - and everything app-wide belongs here.
 *
 * The handlers are held in a ref so the listener is attached once rather than
 * on every render. Callers pass fresh closures each time; a dependency array
 * on the object itself would tear the listener down and rebuild it constantly,
 * and leaving the object out of the deps would leave the listener calling last
 * render's handlers.
 */
export interface Keybinds {
  /** Ctrl+Tab: the repository after this one, wrapping at the end. */
  nextRepo: () => void;
  /** Ctrl+Shift+Tab: the repository before this one, wrapping at the start. */
  prevRepo: () => void;
  /** Ctrl+W: close the current repository tab. */
  closeRepo: () => void;
}

export function useKeybinds(binds: Keybinds): void {
  const ref = useRef(binds);
  ref.current = binds;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ctrl on Windows and Linux, Command on macOS. A chord carrying Alt
      // belongs to something else.
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;

      if (e.key === "Tab") {
        e.preventDefault();
        if (e.shiftKey) ref.current.prevRepo();
        else ref.current.nextRepo();
        return;
      }

      // Compared case-insensitively: with Shift held, `key` is "W".
      if (e.key.toLowerCase() === "w" && !e.shiftKey) {
        // Ctrl+W is the browser's own "close the window", and gitc's window is
        // a browser window - which is exactly the reported bug, the whole app
        // going away when the user meant to close one repository.
        // preventDefault is what stops it, and it works here only because an
        // --app window hands the key to the page first; a normal tab would
        // treat it as a reserved accelerator and close regardless. Verified by
        // sending the real keystroke to the real window: the window stayed and
        // the tab went.
        e.preventDefault();
        ref.current.closeRepo();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
