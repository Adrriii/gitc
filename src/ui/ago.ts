/**
 * A duration, at the coarsest unit that still says something useful.
 *
 * Deliberately tiny: these go in the status bar and in a 208px sidebar next
 * to a branch name, where the name is what matters and the age is a hint. "3d"
 * answers "is this current?" as well as "3 days ago" does, in a fifth of the
 * width, and the exact timestamp is a tooltip away wherever one is worth
 * having.
 */
export function ago(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 2) return "now";
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 365) return `${days}d`;
  return `${Math.floor(days / 365)}y`;
}

/** The same duration as prose, where "now ago" would not do. */
export function since(ms: number): string {
  return ms < 2000 ? "a moment ago" : `${ago(ms)} ago`;
}
