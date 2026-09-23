/**
 * Grouping the refs that point at one commit.
 *
 * `main` and `origin/main` are the same branch in two places, not two
 * branches, and a row that shows them as separate chips runs out of width
 * immediately - a commit that is on a local branch, two remotes and a tag
 * would need four chips in a 128px column.
 *
 * So refs are grouped by name and each group records WHERE that name exists.
 * The row then shows one chip with small badges, and everything past the
 * first collapses into a "+N" that opens a list.
 */

export interface RefGroup {
  /** Display name with any remote prefix stripped: "main", not "origin/main". */
  name: string;
  kind: "branch" | "tag" | "worktree";
  /** A local branch of this name exists. */
  local: boolean;
  /** Remotes carrying this name, in the order encountered. */
  remotes: string[];
  /** This is the checked-out branch. */
  isHead: boolean;
  /**
   * The ref to act on when the group is clicked: the local branch when there
   * is one, otherwise the first remote. Acting on a local branch is almost
   * always what is meant, and it is the safe default - checking out a remote
   * ref detaches HEAD.
   */
  actionKind: "local" | "remote" | "tag" | "worktree";
  actionName: string;
  /**
   * The other worktree this branch is checked out in, by label, or "" when
   * none is. For a "worktree" group - a detached checkout with no branch to
   * hang on - the worktree it stands for.
   */
  elsewhere: string;
}

/** How a chip learns about other worktrees: their labels, by branch and by name. */
export interface WorktreeLabels {
  byBranch: Map<string, string>;
  byName: Map<string, string>;
}

const NO_WORKTREES: WorktreeLabels = { byBranch: new Map(), byName: new Map() };

/**
 * Groups the `kind:name` labels the API sends for a commit.
 *
 * Ordering is deliberate: HEAD first so the branch you are on is the one that
 * always survives the collapse, then local branches, then remote-only ones,
 * then tags.
 */
/** Branches, then the worktrees standing where no branch does, then tags. */
const KIND_ORDER = ["branch", "worktree", "tag"];

export function groupRefs(
  labels: string[],
  headBranch: string | null,
  worktrees: WorktreeLabels = NO_WORKTREES,
): RefGroup[] {
  const byKey = new Map<string, RefGroup>();

  for (const label of labels) {
    const sep = label.indexOf(":");
    if (sep === -1) continue;
    const kind = label.substring(0, sep);
    const short = label.substring(sep + 1);

    // A stash is deliberately NOT a chip. It is drawn as its own node - a
    // dotted square, unlike any commit - and the row already carries its
    // message in the subject column, so a chip repeating the same thing in a
    // 128px column would cost the branch names width to say nothing new.
    // The label still reaches the row, which is how the row knows to draw the
    // square and which stash to act on.
    if (kind === "stash") continue;

    // Another worktree's HEAD, detached and clean - the engine only sends
    // one then, since a branch or a WIP row would otherwise say it.
    if (kind === "worktree") {
      const label = worktrees.byName.get(short) ?? short;
      byKey.set("worktree:" + short, {
        name: label,
        kind: "worktree",
        local: false,
        remotes: [],
        isHead: false,
        actionKind: "worktree",
        actionName: short,
        elsewhere: label,
      });
      continue;
    }

    if (kind === "tag") {
      byKey.set("tag:" + short, {
        name: short,
        kind: "tag",
        local: false,
        remotes: [],
        isHead: false,
        actionKind: "tag",
        actionName: short,
        elsewhere: "",
      });
      continue;
    }

    let name = short;
    let remote: string | null = null;
    if (kind === "remote") {
      const slash = short.indexOf("/");
      if (slash !== -1) {
        remote = short.substring(0, slash);
        name = short.substring(slash + 1);
      }
    }

    const key = "branch:" + name;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        name,
        kind: "branch",
        local: kind === "local",
        remotes: remote === null ? [] : [remote],
        isHead: kind === "local" && name === headBranch,
        actionKind: kind === "local" ? "local" : "remote",
        actionName: kind === "local" ? name : short,
        elsewhere: kind === "local" ? (worktrees.byBranch.get(name) ?? "") : "",
      });
      continue;
    }

    if (kind === "local") {
      existing.local = true;
      if (name === headBranch) existing.isHead = true;
      // A local branch outranks a remote one as the thing to act on.
      existing.actionKind = "local";
      existing.actionName = name;
      existing.elsewhere = worktrees.byBranch.get(name) ?? "";
    } else if (remote !== null && !existing.remotes.includes(remote)) {
      existing.remotes.push(remote);
    }
  }

  const groups = [...byKey.values()];
  groups.sort((a, b) => {
    if (a.isHead !== b.isHead) return a.isHead ? -1 : 1;
    if (a.kind !== b.kind) return KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
    if (a.local !== b.local) return a.local ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return groups;
}
