/**
 * Comparing two gitc versions, for deciding whether an update is worth
 * interrupting somebody about.
 *
 * Pure and separate from the settings that use it, because "which of these is
 * newer, and by how much" is the part that can actually be wrong: 0.10.0 is
 * newer than 0.9.0, and a string comparison says otherwise.
 */

export type Bump = "major" | "minor" | "patch";

/** Every level, loosest threshold first - the order the setting offers them. */
export const UPDATE_LEVELS: { level: Bump; label: string; hint: string }[] = [
  { level: "patch", label: "Any release", hint: "Patch or newer" },
  { level: "minor", label: "Features", hint: "Minor or newer" },
  { level: "major", label: "Major only", hint: "Major releases" },
];

/** "0.4.3" or "v0.4.3" to [0, 4, 3]; null if it is not a version at all. */
function parts(v: string): number[] | null {
  const trimmed = v.startsWith("v") ? v.substring(1) : v;
  if (trimmed.length === 0) return null;
  const out: number[] = [];
  for (const piece of trimmed.split(".")) {
    const n = Number(piece);
    // Number("") is 0 and Number("3-rc1") is NaN; neither is a version part.
    if (piece.length === 0 || !Number.isInteger(n) || n < 0) return null;
    out.push(n);
  }
  // Missing components read as zero, so "1" and "1.0" both mean 1.0.0.
  while (out.length < 3) out.push(0);
  return out.slice(0, 3);
}

/**
 * How big a step it is from `current` to `latest`, or null when `latest` is
 * not actually newer (or either is unparseable, which is not an update either).
 */
export function bump(current: string, latest: string): Bump | null {
  const a = parts(current);
  const b = parts(latest);
  if (a === null || b === null) return null;

  // Numeric, component by component: 0.10.0 beats 0.9.0, which is exactly
  // what comparing the strings gets wrong.
  for (let i = 0; i < 3; i++) {
    if (b[i] > a[i]) return i === 0 ? "major" : i === 1 ? "minor" : "patch";
    if (b[i] < a[i]) return null;
  }
  return null;
}

/**
 * Whether a step of `size` is big enough to bother someone whose threshold is
 * `threshold`. "patch" means everything, "major" means almost nothing.
 */
export function meets(size: Bump, threshold: Bump): boolean {
  const rank: Record<Bump, number> = { patch: 1, minor: 2, major: 3 };
  return rank[size] >= rank[threshold];
}

/** The whole question in one call: should this update interrupt the user? */
export function shouldPrompt(current: string, latest: string, threshold: Bump): boolean {
  const size = bump(current, latest);
  return size !== null && meets(size, threshold);
}
