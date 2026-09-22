/**
 * Which files the diff view previews instead of calling them binary, and as
 * what type.
 *
 * Decided by the name and never by the contents. The engine sends every file
 * as application/octet-stream (engine/media.ts), and the type given here is
 * what the Blob is labelled with - so a "picture" that is really an HTML page
 * is handed to an <img> as image/png, fails to decode, and that is the end of
 * it. Nothing a file contains can promote it to something that runs.
 *
 * SVG is deliberately absent. It is text, so git diffs it as text and the
 * view already shows that; and it is the one image format that can carry
 * script, which is a poor thing to add for a preview nobody asked for.
 */

export type MediaKind = "image" | "video" | "audio";

const TYPES = new Map<string, { kind: MediaKind; type: string }>([
  ["png", { kind: "image", type: "image/png" }],
  ["jpg", { kind: "image", type: "image/jpeg" }],
  ["jpeg", { kind: "image", type: "image/jpeg" }],
  ["gif", { kind: "image", type: "image/gif" }],
  ["webp", { kind: "image", type: "image/webp" }],
  ["avif", { kind: "image", type: "image/avif" }],
  ["bmp", { kind: "image", type: "image/bmp" }],
  ["ico", { kind: "image", type: "image/x-icon" }],
  ["mp4", { kind: "video", type: "video/mp4" }],
  ["m4v", { kind: "video", type: "video/mp4" }],
  ["mov", { kind: "video", type: "video/mp4" }],
  ["webm", { kind: "video", type: "video/webm" }],
  ["ogv", { kind: "video", type: "video/ogg" }],
  ["mp3", { kind: "audio", type: "audio/mpeg" }],
  ["wav", { kind: "audio", type: "audio/wav" }],
  ["ogg", { kind: "audio", type: "audio/ogg" }],
  ["oga", { kind: "audio", type: "audio/ogg" }],
  ["opus", { kind: "audio", type: "audio/ogg" }],
  ["flac", { kind: "audio", type: "audio/flac" }],
  ["m4a", { kind: "audio", type: "audio/mp4" }],
  ["aac", { kind: "audio", type: "audio/aac" }],
]);

/** What a file previews as, or null when it is not something we preview. */
export function mediaFor(path: string): { kind: MediaKind; type: string } | null {
  const slash = path.lastIndexOf("/");
  const name = path.substring(slash + 1);
  const dot = name.lastIndexOf(".");
  // A leading dot is a hidden file with no extension, not a file called "".
  if (dot <= 0) return null;
  return TYPES.get(name.substring(dot + 1).toLowerCase()) ?? null;
}

/** A byte count as somebody would say it. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Which sides of a change there are to show.
 *
 * An added file has no before, a deleted one no after. Everything else - a
 * modification, a rename, a mode change - has both, and shows them side by
 * side.
 */
export function mediaSides(status: string): ("old" | "new")[] {
  if (status === "A") return ["new"];
  if (status === "D") return ["old"];
  return ["old", "new"];
}

/**
 * The absolute path of a repository file, spelled the way the repository's
 * own path is: backslashes if the tab's path has them, so it pastes straight
 * into Explorer or a Windows shell.
 */
export function absolutePath(repo: string, file: string): string {
  const windows = repo.includes("\\");
  const sep = windows ? "\\" : "/";
  const root = repo.endsWith("/") || repo.endsWith("\\") ? repo.slice(0, -1) : repo;
  return root + sep + (windows ? file.replace(/\//g, "\\") : file);
}
