import { useEffect, useState } from "react";

/**
 * Author avatars for the commit graph and the detail panel.
 *
 * Candidates are tried in order and the first that loads wins:
 *
 *  1. A local override — an image the user dropped into gitc's avatars
 *     directory. This exists because plenty of identities have no avatar
 *     anywhere: bots, agents, and internal addresses. It also means gitc does
 *     not have to ship anyone else's logo to give them a face.
 *  2. GitHub, when the address is one of its noreply forms — those encode the
 *     account, so no hashing and no third party beyond the one the code came
 *     from.
 *  3. Gravatar, keyed on a hash of the address. `d=404` is deliberate: an
 *     unknown address should return nothing so we fall through to initials,
 *     rather than a generated geometric blob that means nothing.
 *  4. The author's initials.
 *
 * Step 4 is the common outcome, not the exception - most commit authors have
 * no Gravatar. Verified: MD5 and SHA-256 lookups behave identically, so the
 * hash choice is not what decides whether a face appears.
 *
 * PRIVACY: step 3 sends a hash of the author's email to gravatar.com, and
 * steps 2-3 tell a remote host you are looking at this repository. Set
 * `gitc.avatars` to "0" in localStorage to use overrides and initials only.
 */

const SIZE = 64;

/** email -> the remote candidate, once known. */
const remoteCache = new Map<string, string | null>();
/** Hooks waiting on an in-flight hash. */
const waiting = new Map<string, Set<() => void>>();

export function avatarsEnabled(): boolean {
  return localStorage.getItem("gitc.avatars") !== "0";
}

/**
 * Whether a remote candidate is worth offering at all.
 *
 * With no network, an `<img>` pointed at gravatar does not fail - it waits,
 * for as long as the browser is willing to keep trying, and the fallback to
 * initials is driven by `onError`. So every face in the graph sat empty for
 * however long that took, on the one occasion the initials were certain to
 * be the answer.
 *
 * `navigator.onLine` is famously weak evidence that a network works, but it
 * is strong evidence when it says there is none - a false "offline" is rare
 * and costs only initials, which is where most authors end up anyway.
 */
function networkLikely(): boolean {
  return typeof navigator === "undefined" || navigator.onLine;
}

// One pair of listeners for the whole application, not one per face: a graph
// of four hundred commits would otherwise register eight hundred of them.
let online = networkLikely();
const onlineSubs = new Set<() => void>();

if (typeof window !== "undefined") {
  const announce = (state: boolean) => () => {
    online = state;
    for (const fn of onlineSubs) fn();
  };
  window.addEventListener("online", announce(true));
  window.addEventListener("offline", announce(false));
}

/** Re-renders the caller when the network comes or goes. */
function useOnline(): boolean {
  const [, bump] = useState(0);
  useEffect(() => {
    const fn = () => bump((n) => n + 1);
    onlineSubs.add(fn);
    return () => {
      onlineSubs.delete(fn);
    };
  }, []);
  return online;
}

/** The synchronous case: GitHub's noreply addresses name the account. */
function githubUrl(email: string): string | null {
  const lower = email.trim().toLowerCase();
  if (!lower.endsWith("@users.noreply.github.com")) return null;

  const local = lower.substring(0, lower.indexOf("@"));
  // Modern form: 12345678+octocat@users.noreply.github.com
  const plus = local.indexOf("+");
  if (plus > 0) {
    const id = local.substring(0, plus);
    if (/^\d+$/.test(id)) return `https://avatars.githubusercontent.com/u/${id}?s=${SIZE}`;
  }
  // Older form: octocat@users.noreply.github.com
  if (local.length > 0) return `https://github.com/${local}.png?size=${SIZE}`;
  return null;
}

async function gravatarUrl(email: string): Promise<string> {
  const normalised = email.trim().toLowerCase();
  const bytes = new TextEncoder().encode(normalised);
  // Gravatar accepts SHA-256, which the platform provides; MD5 would mean
  // shipping an implementation of a hash we have no other use for, and the
  // two resolve the same addresses.
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `https://gravatar.com/avatar/${hex}?d=404&s=${SIZE}`;
}

/**
 * Ordered avatar candidates for an email.
 *
 * The local override is always first and always present - the request is
 * cheap and 404s immediately when there is no override, which is the case the
 * caller then falls through from.
 */
export function useAvatarCandidates(email: string): string[] {
  const [, bump] = useState(0);
  const connected = useOnline();
  const trimmed = email.trim();

  useEffect(() => {
    if (!avatarsEnabled() || !connected || trimmed.length === 0) return;
    if (remoteCache.has(trimmed)) return;

    const direct = githubUrl(trimmed);
    if (direct !== null) {
      remoteCache.set(trimmed, direct);
      bump((n) => n + 1);
      return;
    }

    // Mark in-flight so a hundred rows by one author hash once.
    remoteCache.set(trimmed, null);
    const listeners = waiting.get(trimmed) ?? new Set<() => void>();
    waiting.set(trimmed, listeners);

    let live = true;
    void gravatarUrl(trimmed).then((url) => {
      remoteCache.set(trimmed, url);
      if (live) bump((n) => n + 1);
      for (const fn of listeners) fn();
      listeners.clear();
    });

    return () => {
      live = false;
    };
  }, [trimmed, connected]);

  // Subscribe to a lookup another row already started.
  useEffect(() => {
    if (remoteCache.get(trimmed) != null) return;
    const listeners = waiting.get(trimmed);
    if (listeners === undefined) return;
    const fn = () => bump((n) => n + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, [trimmed]);

  if (trimmed.length === 0) return [];

  const out = [`/api/avatar?email=${encodeURIComponent(trimmed)}`];
  if (avatarsEnabled() && connected) {
    const remote = remoteCache.get(trimmed);
    if (remote != null) out.push(remote);
  }
  return out;
}

/**
 * A colour of one's own, for anyone with no picture anywhere.
 *
 * Initials on the same grey for everybody is a face nobody has: a column of
 * them tells you a commit has an author and nothing else. Derived from the
 * address, the colour becomes the thing you actually recognise while scanning
 * - the same trick GitLab's identicons play, and for the same reason.
 *
 * Keyed on the email rather than the name because the email is the identity
 * git records: the same person committing as "Adri" and "Adrien" should keep
 * one colour, and two different people who happen to share a first name
 * should not.
 *
 * Hue only. Saturation and lightness are fixed so every one of them is legible
 * under the same white text and none can come out as a bright block in the
 * middle of the graph - which is what picking three random channels would do
 * eventually. FNV-1a for the hash: small, stable, and only ever compared with
 * itself. The same one the engine's fingerprint uses.
 */
export function avatarTint(email: string, name: string): string {
  const key = (email.trim().length > 0 ? email : name).trim().toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return `hsl(${h % 360}, 42%, 34%)`;
}

/** Two letters from a display name, for when nothing resolves. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
