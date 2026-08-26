/**
 * What to call a stash on screen.
 *
 * `stash@{0}` is a position, not a name. It tells you nothing about what is
 * in the stash, and it is not even stable - dropping one renumbers every
 * stash below it. It has to be used when running a command, because it is the
 * only thing git accepts, and it should be almost nowhere else.
 *
 * git's own label carries the message with a prefix saying where the stash
 * was taken: "On main: half the parser" for a named one, "WIP on main:
 * 1a2b3c the last commit's subject" for an unnamed one. In a 128px column the
 * prefix is most of the width and none of the information - every stash in
 * the list repeats it - so it is stripped for display and kept in the
 * tooltip, where there is room for it.
 */
const PREFIX = /^(?:WIP )?[Oo]n [^:]+: /;

export function stashName(subject: string): string {
  const text = subject.trim();
  const stripped = text.replace(PREFIX, "").trim();
  // A stash message that is only the prefix would otherwise display as
  // nothing at all; the original is a worse name but it is a name.
  return stripped.length > 0 ? stripped : text;
}
