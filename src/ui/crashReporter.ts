import { api } from "./api";
import { VERSION } from "../generated/version";

/**
 * Sends the window's own errors to the engine, which keeps them as crash
 * reports (see engine/crashes.ts) for Preferences > Crash reports.
 *
 * Three ways an error reaches here: a render that threw (React hands it to
 * `onUncaughtError`), an exception nothing caught, and a promise that
 * rejected with nobody listening. The first is the one that blanks the
 * window, and the one somebody most needs a record of afterwards.
 */

/** Per page load. A render loop throws the same thing hundreds of times. */
const MAX_REPORTS = 10;
const sent = new Set<string>();

export function reportWindowError(error: unknown, where: string): void {
  const err = error instanceof Error ? error : new Error(String(error));
  const message = err.message.length > 0 ? err.message : err.name;
  const key = message + "|" + where;
  if (sent.has(key) || sent.size >= MAX_REPORTS) return;
  sent.add(key);

  const detail = [
    where,
    "",
    err.stack ?? err.name + ": " + message,
    "",
    "window " + VERSION + " - " + navigator.userAgent,
  ].join("\n");
  void api.reportCrash(message, detail);
}

/** Installs the global listeners. Once, before the first render. */
export function installCrashReporter(): void {
  window.addEventListener("error", (e) => {
    // A resource that failed to load (an avatar image) also arrives here, as
    // an event with no error attached. That is not a crash.
    if (e.error === undefined || e.error === null) return;
    reportWindowError(e.error, "uncaught exception");
  });
  window.addEventListener("unhandledrejection", (e) => {
    reportWindowError(e.reason, "unhandled promise rejection");
  });
}
