import type { DiffLine, FileDiff, Hunk } from "./types";

/**
 * Rebuilding a unified patch for ONE hunk.
 *
 * Staging part of a file means handing git a patch containing only the part
 * you meant, and letting `git apply` put it into the index. The hunk already
 * carries everything needed: git's own line numbers, and each line's kind.
 *
 * Reconstructed rather than kept as raw text because the parser has already
 * thrown the markers away - and rebuilding from the parsed form means what is
 * applied is exactly what was on screen, including the context lines that
 * make the hunk land in the right place.
 */

const LF = String.fromCharCode(10);

function marker(kind: DiffLine["kind"]): string {
  if (kind === "add") return "+";
  if (kind === "del") return "-";
  return " ";
}

/** git writes "12,3", and just "12" when the count is exactly one. */
function range(start: number, count: number): string {
  return count === 1 ? String(start) : String(start) + "," + String(count);
}

/**
 * True when a hunk can be applied on its own.
 *
 * An untracked file has no preimage to patch against - the whole file is the
 * change, so it is staged whole. Binary and over-size diffs were never line
 * data. And a diff fetched with whole-file context is one hunk covering
 * everything, where "stage this hunk" would silently mean "stage the file";
 * offering it there would be a lie.
 */
export function canApplyHunks(diff: FileDiff | null): boolean {
  if (diff === null) return false;
  if (diff.binary || diff.tooLarge || diff.whole) return false;
  if (diff.status === "A" && diff.oldPath === null && diff.hunks.length === 1) {
    // A file git considers newly added: its single hunk IS the file.
    return false;
  }
  return diff.hunks.length > 0;
}

/** The patch text for one hunk, ready for `git apply`. */
export function hunkPatch(diff: FileDiff, hunk: Hunk): string {
  const oldPath = diff.oldPath ?? diff.path;
  const newPath = diff.path;

  const lines: string[] = [
    "diff --git a/" + oldPath + " b/" + newPath,
    "--- a/" + oldPath,
    "+++ b/" + newPath,
    "@@ -" + range(hunk.oldStart, hunk.oldCount) + " +" + range(hunk.newStart, hunk.newCount) + " @@",
  ];

  for (const line of hunk.lines) {
    if (line.kind === "meta") continue;
    lines.push(marker(line.kind) + line.text);
    // The annotation belongs to the line before it, and dropping it would
    // silently add a trailing newline the file never had.
    if (line.noNewline) lines.push("\\ No newline at end of file");
  }

  // A patch must end with a newline or git rejects the last line as corrupt.
  return lines.join(LF) + LF;
}
