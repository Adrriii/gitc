// Bounds-safe array access.
//
// scriptc bounds-checks array reads and throws a RangeError on an
// out-of-range index, where Node quietly returns undefined. That difference
// passes the type checker and only shows up at runtime, which makes it the
// easiest way to ship a crash in this project (it already cost us one - see
// docs/toolchain.md).
//
// So indexing is funnelled through here. `at()` restores the Node behaviour
// for the common case; `SafeList` wraps a whole array when a structure is
// indexed repeatedly and the checks would otherwise be noise.

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

/**
 * An array wrapper whose reads can never throw.
 *
 * Prefer plain arrays with `at()` for local work. This is for values that get
 * passed around and indexed in several places, where wrapping once is safer
 * than remembering to guard at every call site.
 */
export class SafeList<T> {
  private readonly items: T[];

  constructor(items: T[]) {
    this.items = items;
  }

  get length(): number {
    return this.items.length;
  }

  /** Never throws; undefined when out of range. */
  get(i: number): T | undefined {
    return at(this.items, i);
  }

  getOr(i: number, fallback: T): T {
    return atOr(this.items, i, fallback);
  }

  /** Writes are unchecked in scriptc, so this needs no bounds guard. */
  set(i: number, value: T): void {
    this.items[i] = value;
  }

  push(value: T): void {
    this.items.push(value);
  }

  /** The underlying array, for iteration and for handing to JSON. */
  raw(): T[] {
    return this.items;
  }
}
