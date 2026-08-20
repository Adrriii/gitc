// gitc as its own rebase editor.
//
// An interactive rebase asks two things of an editor: rewrite the todo list,
// and accept the combined commit message. Both are normally a human in $EDITOR.
// gitc cannot pipe a todo list in - stdin to a child is a compile fence here -
// and there is no terminal to open an editor in anyway.
//
// So gitc points GIT_SEQUENCE_EDITOR and GIT_EDITOR at ITSELF. git appends the
// file it wants edited to the command, gitc rewrites that file and exits, and
// the rebase carries on. No shell quoting, no helper script, and it works the
// same on Windows and Linux.

import { readFileSync, writeFileSync } from "node:fs";

/**
 * Rewrites a rebase todo list, marking the given commits to be squashed.
 *
 * The spec file holds the hashes to fold, one per line - written by the caller
 * because the command line is not a good place for a list of unknown length.
 *
 * `squash` rather than `fixup`, because the two differ in exactly the way that
 * matters here: fixup keeps the first commit's message and never opens an
 * editor, so the message the user typed would be silently discarded. squash
 * asks the editor for a combined message, which is the invocation that lets
 * writeMessage() put the real one in.
 */
export function rewriteTodo(specPath: string, todoPath: string): void {
  const wanted = new Set<string>();
  for (const line of readFileSync(specPath, "utf8").split(String.fromCharCode(10))) {
    const hash = line.trim();
    if (hash.length > 0) wanted.add(hash);
  }

  const LF = String.fromCharCode(10);
  const out: string[] = [];
  /** Index of the last line turned into a squash, or -1. */
  let lastFold = -1;

  for (const line of readFileSync(todoPath, "utf8").split(LF)) {
    const trimmed = line.trim();
    // Comments and blank lines pass through: git's todo file explains itself
    // at the bottom, and mangling that helps nobody debugging a stuck rebase.
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      out.push(line);
      continue;
    }

    // Every todo line is "<command> <hash> <subject>".
    const parts = trimmed.split(" ");
    if (parts.length < 2) {
      out.push(line);
      continue;
    }
    const hash = parts[1];

    // A todo lists abbreviated hashes, so match on prefixes in either
    // direction rather than requiring equal lengths.
    let fold = false;
    for (const candidate of wanted) {
      if (candidate.startsWith(hash) || hash.startsWith(candidate)) {
        fold = true;
        break;
      }
    }

    if (fold) {
      out.push("squash " + parts.slice(1).join(" "));
      lastFold = out.length - 1;
    } else {
      out.push(line);
    }
  }

  // Redate the squashed commit to now.
  //
  // A squash keeps the oldest commit's author date, so a run of work from last
  // week collapses into a commit that still claims to be from last week -
  // which is not when this history came to exist. The committer date moves on
  // its own during a rebase; only the author date needs saying.
  //
  // It goes in as an `exec` immediately after the last fold rather than as an
  // amend afterwards, because the squashed commit is not necessarily HEAD when
  // the rebase finishes: anything that came after it is replayed on top.
  if (lastFold === -1) {
    writeFileSync(todoPath, out.join(LF), "utf8");
    return;
  }

  // Rebuilt rather than spliced: a three-argument splice has no lowering here.
  const final: string[] = [];
  for (let i = 0; i < out.length; i++) {
    final.push(out[i]);
    if (i === lastFold) final.push("exec git commit --amend --no-edit --date=now");
  }

  writeFileSync(todoPath, final.join(LF), "utf8");
}

/**
 * Replaces whatever message git is about to ask about with a prepared one.
 *
 * Used for the squashed commit's message, which the user typed in gitc before
 * the rebase started.
 */
export function writeMessage(messagePath: string, targetPath: string): void {
  writeFileSync(targetPath, readFileSync(messagePath, "utf8"), "utf8");
}
