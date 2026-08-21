/**
 * The one line of a git message worth leading with.
 *
 * git writes the destination first ("To https://...") and its advice last
 * ("hint: ..."), with the actual problem in the middle. Shown as it comes, a
 * refused push announces itself with a URL and hides the reason - which is
 * how one managed to look like nothing happening at all.
 *
 * Only ever used to pick what goes first. The full text is always kept and
 * shown alongside, because the hints are often the useful part once you know
 * what went wrong.
 */
export function errorLine(message: string): string {
  const lines = message
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const meaningful = lines.filter((l) => !l.startsWith("To ") && !l.startsWith("hint:"));
  const picked =
    meaningful.find(
      (l) => l.startsWith("error:") || l.startsWith("fatal:") || l.includes("[rejected]"),
    ) ??
    meaningful[0] ??
    lines[0] ??
    message;

  return picked.replace(/^(error|fatal):\s*/, "");
}

/** True when the full text says more than the summary already does. */
export function hasDetail(message: string): boolean {
  return errorLine(message).trim() !== message.trim();
}
