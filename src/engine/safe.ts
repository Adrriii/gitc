// Bounds-safe array access.
//
// TypeScript types `arr[i]` as T even when i is out of range, so the checker
// never asks what happens past the end. Under scriptc 0.0.35 the answer was a
// RangeError, which shipped a crash; under 0.1.7 it is undefined, as in Node,
// which is quieter but no more checked. These return `T | undefined` so the
// caller has to say.

/** Reads `arr[i]`, or undefined when the index is out of range. */
export function at<T>(arr: T[], i: number): T | undefined {
  if (i < 0 || i >= arr.length) return undefined;
  return arr[i];
}

/** Reads `arr[i]`, falling back to `fallback` when out of range. */
export function atOr<T>(arr: T[], i: number, fallback: T): T {
  if (i < 0 || i >= arr.length) return fallback;
  return arr[i];
}

export function first<T>(arr: T[]): T | undefined {
  return at(arr, 0);
}

export function last<T>(arr: T[]): T | undefined {
  return at(arr, arr.length - 1);
}
