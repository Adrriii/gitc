// File contents as bytes, for previewing images and videos in the diff view.
//
// A binary file used to get one line - "Binary file, no textual diff" - which
// for a changed icon or a screenshot is the least useful thing that could be
// said about it. The window shows the two versions instead, and this is where
// it gets them.
//
// Safety is split between the two sides on purpose:
//
//   here    the bytes go out as application/octet-stream, never as the type
//           their name suggests, with nosniff and a sandboxing CSP - so even
//           a page navigated straight at the endpoint renders nothing active
//   window  it decides the type from the extension, wraps the bytes in a
//           Blob, and only ever puts that in an <img>, <video> or <audio> -
//           none of which run script, whatever the file really contains
//
// Neither side trusts the file's contents to say what it is.

import { existsSync, readFileSync, statSync } from "node:fs";

import { gitBytes, gitOrNull } from "./git.ts";
import { inRepo, safeArgument } from "./paths.ts";

/**
 * The largest file previewed, in bytes.
 *
 * It is read into memory whole, on this engine and again on the local one
 * when the tab is remote. A video larger than this is better watched in a
 * player than in a diff.
 */
export const MAX_MEDIA_BYTES = 64 * 1024 * 1024;

/** Which revisions a preview compares - the same shapes /api/diff takes. */
export interface MediaTarget {
  sha: string;
  from: string;
  to: string;
  /** "wip", "staged", or "" for a commit or a range. */
  mode: string;
}

export interface MediaRead {
  /** An HTTP status: 200, or why there is nothing to show. */
  status: number;
  bytes: Buffer;
  error: string;
}

function refusal(status: number, error: string): MediaRead {
  return { status, bytes: Buffer.alloc(0), error };
}

/**
 * The git object name for one side of a comparison, or null when that side
 * is the working tree rather than anything git holds.
 *
 * The old side is always the first parent, as the diff itself is: a commit's
 * diff is `git show --first-parent`, and a range's starts from its oldest
 * commit's parent.
 */
function revisionFor(t: MediaTarget, side: string): string | null {
  const old = side === "old";
  if (t.mode === "wip") return old ? "" : null;
  if (t.mode === "staged") return old ? "HEAD" : "";
  if (t.from.length > 0 && t.to.length > 0) {
    return old ? safeArgument(t.from, "commit") + "^" : safeArgument(t.to, "commit");
  }
  const sha = safeArgument(t.sha, "commit");
  return old ? sha + "^" : sha;
}

/**
 * Reads one side of a file for preview.
 *
 * `path` is the file as it is now; `oldPath` is its name before a rename, and
 * only the old side reads it. An empty revision means the index, which is
 * git's own spelling: ":path".
 */
export async function readMedia(
  repo: string,
  t: MediaTarget,
  path: string,
  oldPath: string,
  side: string,
): Promise<MediaRead> {
  if (side !== "old" && side !== "new") return refusal(400, "no such side");
  const file = side === "old" && oldPath.length > 0 ? oldPath : path;

  // Containment first, for both kinds of read. git would refuse a
  // "rev:../x" on its own, but the working-tree read below would not.
  const full = inRepo(repo, file);
  if (full === null) return refusal(400, "not a path in this repository");

  const rev = revisionFor(t, side);
  if (rev === null) {
    if (!existsSync(full)) return refusal(404, "not in the working tree");
    const stat = statSync(full);
    if (!stat.isFile()) return refusal(404, "not a file");
    if (stat.size > MAX_MEDIA_BYTES) return refusal(413, "too large to preview");
    return { status: 200, bytes: readFileSync(full), error: "" };
  }

  // Forward slashes whatever the platform: this is a name inside git's tree,
  // not a path on this disk.
  const spec = rev + ":" + file.replace(/\\/g, "/");

  // Sized before it is read, so a 2 GB asset is refused rather than loaded.
  // A failure here is also the ordinary "this side does not exist" - the old
  // side of an added file, the new side of a deleted one.
  const size = await gitOrNull(repo, ["cat-file", "-s", spec]);
  if (size === null) return refusal(404, "not in that revision");
  if (parseInt(size.trim(), 10) > MAX_MEDIA_BYTES) return refusal(413, "too large to preview");

  const bytes = await gitBytes(repo, ["cat-file", "blob", spec]);
  if (bytes === null) return refusal(404, "not in that revision");
  return { status: 200, bytes, error: "" };
}
