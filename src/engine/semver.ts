/**
 * Ordering two gitc versions, prereleases included.
 *
 * Separate from update.ts, which is where this used to live, for one practical
 * reason: update.ts reaches install.ts and from there `generated/icons.ts`,
 * which does not exist until `npm run embed` has run. `npm test` runs before
 * embed, so a test importing update.ts passes on a machine that has built
 * before and fails on a clean checkout - which is how it failed on CI and not
 * here. Nothing in this file imports anything but `safe.ts`.
 */

import { at, atOr } from "./safe.ts";

/** A version carrying a prerelease part, like 0.5.0-rc.1. */
export function isPrerelease(version: string): boolean {
  return version.includes("-");
}

/**
 * Orders two versions. Returns >0 when `a` is newer.
 *
 * Splitting on "." and parseInt-ing was enough while every version was
 * X.Y.Z: it read 0.5.0-rc.1 as 0.5.0, which is safe - nobody is offered a
 * downgrade - but makes rc.1 and rc.2 and the final 0.5.0 all equal, so a
 * tester is never offered any of them.
 *
 * Semver's rule: compare the numbers first, and when they tie, a version WITH
 * a prerelease is older than the same one without. 0.5.0-rc.1 < 0.5.0-rc.2 <
 * 0.5.0.
 */
export function compare(a: string, b: string): number {
  const [an, ap] = splitVersion(a);
  const [bn, bp] = splitVersion(b);

  for (let i = 0; i < 3; i++) {
    const l = atOr(an, i, 0);
    const r = atOr(bn, i, 0);
    if (l !== r) return l - r;
  }

  // A release beats its own prereleases; two releases are equal.
  if (ap.length === 0 && bp.length === 0) return 0;
  if (ap.length === 0) return 1;
  if (bp.length === 0) return -1;
  return comparePre(ap, bp);
}

/** "0.5.0-rc.1" into [0,5,0] and ["rc","1"]. */
function splitVersion(v: string): [number[], string[]] {
  const dash = v.indexOf("-");
  const head = dash === -1 ? v : v.substring(0, dash);
  const tail = dash === -1 ? "" : v.substring(dash + 1);
  const nums: number[] = [];
  for (const piece of head.split(".")) {
    const n = parseInt(piece, 10);
    nums.push(isNaN(n) ? 0 : n);
  }
  return [nums, tail.length === 0 ? [] : tail.split(".")];
}

/**
 * Dot-separated prerelease identifiers, semver's way: numbers order
 * numerically so rc.9 comes before rc.10, and a shorter run of equal
 * identifiers is the older one.
 */
function comparePre(a: string[], b: string[]): number {
  const len = a.length > b.length ? a.length : b.length;
  for (let i = 0; i < len; i++) {
    const l = at(a, i);
    const r = at(b, i);
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ln = parseInt(l, 10);
    const rn = parseInt(r, 10);
    const lNum = !isNaN(ln) && String(ln) === l;
    const rNum = !isNaN(rn) && String(rn) === r;
    if (lNum && rNum) {
      if (ln !== rn) return ln - rn;
      continue;
    }
    // Numeric identifiers always rank below alphanumeric ones.
    if (lNum !== rNum) return lNum ? -1 : 1;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}
