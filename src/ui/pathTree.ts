/**
 * Turning slash-separated paths into a tree.
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

export interface TreeNode<T> {
  /** The single path segment this node shows. */
  name: string;
  /** The full path from the root, used as a stable key and open-state id. */
  path: string;
  /**
   * The item living exactly here, if any.
   *
   * A node can carry both an item and children. git forbids that for refs -
   * `feature` and `feature/login` collide in refs/heads - but a file tree has
   * no such rule to lean on, and either way the tree degrades into a row that
   * is both rather than losing an entry.
   */
  item: T | null;
  children: TreeNode<T>[];
}

function emptyNode<T>(name: string, path: string): TreeNode<T> {
  return { name, path, item: null, children: [] };
}

/**
 * Builds the tree.
 *
 * `displayName` strips whatever prefix the caller does not want to nest under
 * - remote branches arrive as `origin/adri/x` but nest under the remote's own
 * row, so only `adri/x` should form the tree.
 */
export function buildTree<T>(items: T[], pathOf: (item: T) => string): TreeNode<T>[] {
  const roots: TreeNode<T>[] = [];
  const index = new Map<string, TreeNode<T>>();

  for (const entry of items) {
    const full = pathOf(entry);
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
        node = emptyNode<T>(segment, prefix);
        index.set(prefix, node);
        siblings.push(node);
      }

      if (i === segments.length - 1) node.item = entry;
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
function sortTree<T>(nodes: TreeNode<T>[]): void {
  nodes.sort((a, b) => {
    const aFolder = a.children.length > 0;
    const bFolder = b.children.length > 0;
    if (aFolder !== bFolder) return aFolder ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) sortTree(node.children);
}

/** Every folder path in the tree - what "expand all" needs to open. */
export function folderPaths<T>(nodes: TreeNode<T>[]): string[] {
  const out: string[] = [];
  const walk = (list: TreeNode<T>[]) => {
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
 * Every item at or below these nodes.
 *
 * What a folder-level action operates on: hiding `adri` means hiding the
 * branches inside it, since the folder is a display device and not something
 * git knows about.
 */
export function collectItems<T>(nodes: TreeNode<T>[]): T[] {
  const out: T[] = [];
  const walk = (list: TreeNode<T>[]) => {
    for (const node of list) {
      if (node.item !== null) out.push(node.item);
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/** How many actual items sit at or below a node. */
export function countItems<T>(nodes: TreeNode<T>[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.item !== null) n += 1;
    n += countItems(node.children);
  }
  return n;
}
