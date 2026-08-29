import { useCallback, useEffect, useState } from "react";
import { UPDATE_LEVELS, type Bump } from "./version";
import { VERSION } from "../generated/version";

export { commandType } from "./gitCommand";

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

/**
 * The stored form of every boolean setting: "1" or "0", anything else being a
 * value this version does not understand, which `useStored` answers with the
 * default. One parser rather than one per setting - there were three of these,
 * byte for byte identical, and a fourth was about to borrow the name of an
 * unrelated one.
 */
function parseBool(raw: string): boolean | null {
  if (raw === "1") return true;
  if (raw === "0") return false;
  return null;
}

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


/** Whether long lines wrap in the diff, or scroll horizontally. */
export function useDiffWrap() {
  // Stored as 1/0, which is what the diff view wrote before this moved here -
  // so an existing preference keeps working.
  const [wrap, set] = useStored<boolean>(WRAP_KEY, true, parseBool, (v) => (v ? "1" : "0"));
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

const FETCH_ON_FOCUS_KEY = "gitc.fetchOnFocus";

/**
 * Whether coming back to gitc, or to a repository's tab, checks the remote
 * straight away instead of waiting for the interval to come round.
 *
 * On by default, because returning to the window is precisely the moment
 * somebody is about to look at it, and a view that updates a minute after you
 * started reading it is the one that misleads.
 *
 * It fetches; it does not ask the interval whether it is time. Those are
 * different questions - the interval keeps a repository you are sitting on
 * from going stale, this one answers "I have just arrived and I am about to
 * read it" - and routing the second through the first made it useless, since
 * an interval of five minutes meant a tab switch did nothing for five
 * minutes. A short cooldown, not the interval, is what stops a burst.
 *
 * Independent of the interval in both directions: with the interval Off and
 * this On, arriving still fetches.
 *
 * Off is for a metered or heavily rate-limited remote, where every fetch
 * should be one you asked for or one the clock earned.
 */
export function useFetchOnFocus() {
  const [onFocus, set] = useStored<boolean>(FETCH_ON_FOCUS_KEY, true, parseBool, (v) =>
    v ? "1" : "0",
  );
  return { onFocus, set };
}

// --- how the sidebar arranges branches ---------------------------------------

const FOLDERS_KEY = "gitc.branchFolders";


/**
 * Whether branch names are nested into folders in the sidebar.
 *
 * On by default, because `adri/feature/login` restating its prefix eleven
 * times is what the nesting exists to stop. Off is for the other question the
 * sidebar gets asked - "what was I working on?" - which folders actively
 * obstruct: the four branches you touched today are scattered across four
 * collapsed folders, in date order within each and no order at all between
 * them. Flattened, the list is simply the most recent first.
 *
 * Its control is in the sidebar rather than in Preferences: it is a way of
 * looking at the list you switch while looking at the list.
 */
export function useBranchFolders() {
  const [folders, set] = useStored<boolean>(FOLDERS_KEY, true, parseBool, (v) =>
    v ? "1" : "0",
  );
  return { folders, set };
}

// --- commands kept out of the log -------------------------------------------

const HIDDEN_COMMANDS_KEY = "gitc.hiddenCommands";

/** Hoisted: a fresh [] each render would re-subscribe the store on every one. */
const NONE: string[] = [];

const joinHidden = (list: string[]) => list.join(",");

function parseHidden(raw: string): string[] {
  const out: string[] = [];
  for (const name of raw.split(",")) {
    const trimmed = name.trim();
    if (trimmed.length > 0 && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * Command types left out of the log, by name: "status", "log".
 *
 * A view filter, not a recording one - the engine keeps everything it ran, so
 * showing a type again brings its history back rather than starting it from
 * empty. Nothing is hidden by default: the log exists to show what gitc does,
 * and deciding for someone which parts of that are beneath their notice would
 * defeat it. Hiding the polls once you have seen them is a different thing,
 * and that is theirs to choose.
 */
export function useHiddenCommands() {
  const [hidden, set] = useStored<string[]>(HIDDEN_COMMANDS_KEY, NONE, parseHidden, joinHidden);

  const hide = useCallback(
    (name: string) => {
      if (name.length === 0 || hidden.includes(name)) return;
      set([...hidden, name].sort());
    },
    [hidden, set],
  );

  const show = useCallback(
    (name: string) => set(hidden.filter((n) => n !== name)),
    [hidden, set],
  );

  const showAll = useCallback(() => set([]), [set]);

  return { hidden, hide, show, showAll };
}

// --- checking for a new version ----------------------------------------------

/**
 * How often gitc asks whether a newer version exists.
 *
 * -1 never, 0 at launch only, anything else is minutes between checks (which
 * also checks at launch). The default is launch only: it is one request when
 * the application starts, and someone who wants to hear about a release
 * sooner can say so.
 */
export const UPDATE_CHECKS = [
  { minutes: -1, label: "Never" },
  { minutes: 0, label: "On launch" },
  { minutes: 5, label: "Every 5 min" },
  { minutes: 60, label: "Every hour" },
  { minutes: 1440, label: "Every day" },
];

const UPDATE_KEY = "gitc.updateCheckMinutes";

function parseUpdateCheck(raw: string): number | null {
  const n = Number(raw);
  for (const choice of UPDATE_CHECKS) {
    if (choice.minutes === n) return n;
  }
  return null;
}

export function useUpdateCheck() {
  const [minutes, set] = useStored<number>(UPDATE_KEY, 0, parseUpdateCheck);
  return { minutes, set };
}

// --- how long a remote connection is kept ------------------------------------

/** Minutes to hold a tunnel to a host you are not looking at. 0 = forever. */
export const REMOTE_HOLDS = [
  { minutes: 1, label: "1 min" },
  { minutes: 10, label: "10 min" },
  { minutes: 60, label: "1 hour" },
  { minutes: 0, label: "Always" },
];

const REMOTE_HOLD_KEY = "gitc.remoteHoldMinutes";

function parseRemoteHold(raw: string): number | null {
  const n = Number(raw);
  for (const choice of REMOTE_HOLDS) {
    if (choice.minutes === n) return n;
  }
  return null;
}

/**
 * How long a connection to another machine is kept after you leave its tab.
 *
 * A tunnel is a gitc process running on somebody else's server, so holding
 * every one you have ever opened until gitc quits is not a neutral default -
 * it is a handful of idle processes on other people's machines. Ten minutes
 * covers going away to read something and coming back; longer is for a server
 * you are working on all day, where reconnecting is the annoyance.
 *
 * Dropping one costs nothing but time: tabbing back into a remote repository
 * reconnects on the first request. The tab you are looking at is never
 * dropped, whatever this says.
 */
export function useRemoteHold() {
  const [minutes, set] = useStored<number>(REMOTE_HOLD_KEY, 10, parseRemoteHold);
  return { minutes, set };
}

export const UPDATE_CHANNELS = [
  { channel: "stable", label: "Stable", hint: "Published releases" },
  { channel: "test", label: "Test builds", hint: "Release candidates, before they are everyone's" },
];

const UPDATE_CHANNEL_KEY = "gitc.updateChannel";

function parseChannel(raw: string): string | null {
  for (const c of UPDATE_CHANNELS) {
    if (c.channel === raw) return c.channel;
  }
  return null;
}

/**
 * Which releases gitc offers.
 *
 * Stable is every published release. Test adds the candidates that come
 * before them - builds meant to be tried and reported on, not relied upon.
 *
 * Choosing it here rather than by which binary you happen to have means
 * switching goes through the updater, which knows how to replace a running
 * gitc. Downloading a candidate by hand does not: Windows will not overwrite
 * a running executable, so the installer keeps the copy that is there and
 * hands off to it, and you would be told nothing and still be on the old
 * build.
 *
 * Defaults from the running version, so somebody who did install a candidate
 * by hand is on the stream that matches it rather than being offered a
 * silent trip backwards.
 */
export function useUpdateChannel() {
  const [channel, set] = useStored<string>(
    UPDATE_CHANNEL_KEY,
    VERSION.includes("-") ? "test" : "stable",
    parseChannel,
  );
  return { channel, set };
}

const UPDATE_LEVEL_KEY = "gitc.updateLevel";

function parseUpdateLevel(raw: string): Bump | null {
  for (const choice of UPDATE_LEVELS) {
    if (choice.level === raw) return choice.level;
  }
  return null;
}

/**
 * How big a new version has to be before gitc says so.
 *
 * "patch" by default - every release - because gitc is young enough that the
 * patches are where most of the fixes are, and staying quiet about them would
 * mostly mean staying quiet about the bug someone just hit.
 *
 * It gates the prompt, not the check. Preferences still reports the truth
 * about what is available: this decides when gitc speaks first, and answering
 * "is there an update?" honestly when asked is a different question.
 */
export function useUpdateLevel() {
  const [level, set] = useStored<Bump>(UPDATE_LEVEL_KEY, "patch", parseUpdateLevel);
  return { level, set };
}
