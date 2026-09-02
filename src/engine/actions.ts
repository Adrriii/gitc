// Repository mutations.
//
// Everything here changes the repo, so everything here goes through git
// rather than touching .git ourselves - that was the whole point of the
// hybrid split. Reads can afford to be clever; writes cannot.

import { writeFileSync, existsSync, unlinkSync } from "node:fs";

import { git, gitOrNull } from "./git.ts";
import { safeArgument, tempFile } from "./paths.ts";

/**
 * Stages paths.
 *
 * `--` separates paths from revisions, without which a file named like a
 * branch would be read as one.
 */
export async function stagePaths(repo: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await git(repo, ["add", "--"].concat(paths));
}

export async function stageAll(repo: string): Promise<void> {
  await git(repo, ["add", "-A"]);
}

/**
 * Unstages paths, leaving the working tree untouched.
 *
 * `restore --staged` is the modern spelling, but it needs git 2.23+, and
 * `reset` does the same thing everywhere. On a repo with no commits yet
 * there is no HEAD to reset against, so that case falls back to `rm --cached`.
 */
export async function unstagePaths(repo: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const head = await gitOrNull(repo, ["rev-parse", "--verify", "HEAD"]);
  if (head === null) {
    await git(repo, ["rm", "--cached", "-r", "--"].concat(paths));
    return;
  }
  await git(repo, ["reset", "-q", "HEAD", "--"].concat(paths));
}

export async function unstageAll(repo: string): Promise<void> {
  const head = await gitOrNull(repo, ["rev-parse", "--verify", "HEAD"]);
  if (head === null) {
    await git(repo, ["rm", "--cached", "-r", "."]);
    return;
  }
  await git(repo, ["reset", "-q", "HEAD"]);
}

/**
 * Throws away changes. This is the one genuinely destructive action here.
 *
 * Tracked files are restored from the index; untracked files are deleted.
 * They need different commands, so the caller says which is which rather
 * than us guessing - a wrong guess here deletes someone's work.
 */
export async function discardPaths(
  repo: string,
  tracked: string[],
  untracked: string[],
): Promise<void> {
  if (tracked.length > 0) {
    // Restores both the index and the working tree copy.
    await git(repo, ["checkout", "HEAD", "--"].concat(tracked));
  }
  if (untracked.length > 0) {
    // -f to actually remove, -d for directories that only contain new files.
    await git(repo, ["clean", "-fdq", "--"].concat(untracked));
  }
}

function messageFile(summary: string, description: string): string {
  // tempDir() rather than a "gitc" directory in the shared temp directory:
  // that name is guessable, and whoever creates it first owns it - including
  // another account on a multi-user machine, who could then read every commit
  // message written here or point it somewhere by symlink.
  const path = tempFile("COMMIT_EDITMSG-" + String(process.pid));

  const LF = String.fromCharCode(10);
  // git's own convention: subject, blank line, body.
  const body =
    description.trim().length > 0
      ? summary.trim() + LF + LF + description.trim() + LF
      : summary.trim() + LF;

  writeFileSync(path, body, "utf8");
  return path;
}

export interface CommitResult {
  hash: string;
  summary: string;
}

/**
 * Commits the index.
 *
 * The message goes through a file rather than `-m` because a temp file keeps
 * multi-line bodies, quotes and non-ASCII intact without any shell quoting
 * questions - and piping to git's stdin is a compile fence in scriptc
 * (docs/toolchain.md), so that route is closed to us anyway.
 */
export async function commit(
  repo: string,
  summary: string,
  description: string,
  amend: boolean,
): Promise<CommitResult> {
  const path = messageFile(summary, description);
  try {
    const args = ["commit", "-F", path];
    if (amend) {
      args.push("--amend");
      // A commit carries two timestamps, and `--amend` moves only one of them:
      // the committer date becomes now, while the author date is preserved
      // from the original commit. That is right for applying someone else's
      // patch and wrong for revising your own work a day later, which is what
      // amending here always is - the graph would keep showing yesterday.
      //
      // --date sets the author date; the committer date follows automatically.
      args.push("--date=now");
    }
    await git(repo, args);
    const hash = (await git(repo, ["rev-parse", "HEAD"])).trim();
    return { hash, summary: summary.trim() };
  } finally {
    // The message can contain anything the user typed; don't leave it in temp.
    if (existsSync(path)) unlinkSync(path);
  }
}

/**
 * A commit's message exactly as it is stored.
 *
 * `%B` and not the parsed body the graph carries: that one has co-author
 * trailers lifted out of it for display, and editing a message that had them
 * removed and writing the result back would drop the people they credit.
 * Whoever is rewording a commit is editing the real message, trailers and all.
 */
export async function commitMessage(
  repo: string,
  rev: string,
): Promise<{ summary: string; description: string } | null> {
  safeArgument(rev, "commit");
  const raw = await gitOrNull(repo, ["log", "-1", "--format=%B", rev, "--"]);
  if (raw === null) return null;
  const LF = String.fromCharCode(10);
  const lines = raw.replace(/\r/g, "").split(LF);
  const summary = lines.length > 0 ? lines[0] : "";
  const description = lines.slice(1).join(LF).trim();
  return { summary, description };
}

/** The message of the current HEAD commit, to prefill an amend. */
export async function headMessage(
  repo: string,
): Promise<{ summary: string; description: string } | null> {
  return commitMessage(repo, "HEAD");
}
