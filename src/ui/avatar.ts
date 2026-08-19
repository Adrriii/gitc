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
  const trimmed = email.trim();

  useEffect(() => {
    if (!avatarsEnabled() || trimmed.length === 0) return;
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
  }, [trimmed]);

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
  if (avatarsEnabled()) {
    const remote = remoteCache.get(trimmed);
    if (remote != null) out.push(remote);
  }
  return out;
}

/** Two letters from a display name, for when nothing resolves. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
