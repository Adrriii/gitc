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
  kind: "branch" | "tag" | "stash";
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
  actionKind: "local" | "remote" | "tag" | "stash";
  actionName: string;
}

/**
 * Groups the `kind:name` labels the API sends for a commit.
 *
 * Ordering is deliberate: HEAD first so the branch you are on is the one that
 * always survives the collapse, then local branches, then remote-only ones,
 * then tags.
 */
export function groupRefs(
  labels: string[],
  headBranch: string | null,
  /** Stash selector to display name; see the stash branch below. */
  stashNames?: Map<string, string>,
): RefGroup[] {
  const byKey = new Map<string, RefGroup>();

  for (const label of labels) {
    const sep = label.indexOf(":");
    if (sep === -1) continue;
    const kind = label.substring(0, sep);
    const short = label.substring(sep + 1);

    // A stash is not a ref anyone can group with anything: nothing else can
    // point at a stash commit. The label carries its selector, which is the
    // only string git accepts, so that stays as the thing to act on - but
    // what gets DISPLAYED is the message, since "stash@{0}" says nothing
    // about what is in it and stops being true the moment one is dropped.
    if (kind === "stash") {
      byKey.set("stash:" + short, {
        name: stashNames?.get(short) ?? short,
        kind: "stash",
        local: false,
        remotes: [],
        isHead: false,
        actionKind: "stash",
        actionName: short,
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
      });
      continue;
    }

    if (kind === "local") {
      existing.local = true;
      if (name === headBranch) existing.isHead = true;
      // A local branch outranks a remote one as the thing to act on.
      existing.actionKind = "local";
      existing.actionName = name;
    } else if (remote !== null && !existing.remotes.includes(remote)) {
      existing.remotes.push(remote);
    }
  }

  const groups = [...byKey.values()];
  groups.sort((a, b) => {
    if (a.isHead !== b.isHead) return a.isHead ? -1 : 1;
    // Branches, then tags, then stashes - a stash is the least likely thing
    // you are looking for on a row that has anything else on it.
    const rank = (k: string) => (k === "branch" ? 0 : k === "tag" ? 1 : 2);
    if (a.kind !== b.kind) return rank(a.kind) - rank(b.kind);
    if (a.local !== b.local) return a.local ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return groups;
}
