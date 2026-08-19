/**
 * Turning slash-separated branch names into a tree.
 *
 * Branch names are conventionally paths - `adri/feature1/login`,
 * `release/2.1` - and a flat list of them is unreadable once a team has more
 * than a handful: every entry restates the same prefix, and the sidebar is
 * only ~208px wide, so the part that distinguishes one branch from another is
 * the part that gets truncated.
 *
 * Nesting them fixes both problems at once. It is also what the reference
 * does.
 */

import type { Ref } from "./types";

export interface TreeNode {
  /** The single path segment this node shows. */
  name: string;
  /** The full path from the root, used as a stable key and open-state id. */
  path: string;
  /**
   * The branch living exactly here, if any.
   *
   * A node can carry both a ref and children. git itself forbids the case -
   * `feature` and `feature/login` collide, since one is a file and the other
   * a directory under refs/heads - but the tree does not depend on that being
   * true, and degrades into a row that is both rather than losing a branch.
   */
  ref: Ref | null;
  children: TreeNode[];
}

function emptyNode(name: string, path: string): TreeNode {
  return { name, path, ref: null, children: [] };
}

/**
 * Builds the tree.
 *
 * `displayName` strips whatever prefix the caller does not want to nest under
 * - remote branches arrive as `origin/adri/x` but nest under the remote's own
 * row, so only `adri/x` should form the tree.
 */
export function buildTree(refs: Ref[], displayName: (r: Ref) => string): TreeNode[] {
  const roots: TreeNode[] = [];
  const index = new Map<string, TreeNode>();

  for (const ref of refs) {
    const full = displayName(ref);
    // A trailing or doubled slash cannot occur in a valid ref, but a filter
    // that produced an empty name would otherwise create a nameless node.
    const segments = full.split("/").filter((p) => p.length > 0);
    if (segments.length === 0) continue;

    let prefix = "";
    let siblings = roots;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      prefix = prefix === "" ? segment : prefix + "/" + segment;

      let node = index.get(prefix);
      if (node === undefined) {
        node = emptyNode(segment, prefix);
        index.set(prefix, node);
        siblings.push(node);
      }

      if (i === segments.length - 1) node.ref = ref;
      siblings = node.children;
    }
  }

  sortTree(roots);
  return roots;
}

/**
 * Folders first, then branches, each alphabetically.
 *
 * Grouping the folders keeps the expandable rows together instead of
 * scattering them through the leaves, which makes the list scannable.
 */
function sortTree(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    const aFolder = a.children.length > 0;
    const bFolder = b.children.length > 0;
    if (aFolder !== bFolder) return aFolder ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) sortTree(node.children);
}

/** Every folder path in the tree - what "expand all" needs to open. */
export function folderPaths(nodes: TreeNode[]): string[] {
  const out: string[] = [];
  const walk = (list: TreeNode[]) => {
    for (const node of list) {
      if (node.children.length > 0) {
        out.push(node.path);
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return out;
}

/**
 * Every ref at or below these nodes.
 *
 * What a folder-level or remote-level action operates on: hiding `adri` means
 * hiding the branches inside it, since the folder is a display device and not
 * something git knows about.
 */
export function collectRefs(nodes: TreeNode[]): Ref[] {
  const out: Ref[] = [];
  const walk = (list: TreeNode[]) => {
    for (const node of list) {
      if (node.ref !== null) out.push(node.ref);
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/** How many actual branches sit at or below a node. */
export function countRefs(nodes: TreeNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.ref !== null) n += 1;
    n += countRefs(node.children);
  }
  return n;
}
