import { buildTree, collectItems, countItems, folderPaths } from "../pathTree.ts";
import type { Ref } from "../types.ts";

const ref = (short: string): Ref => ({
  name: "refs/heads/" + short,
  short,
  kind: "local",
  remote: null,
  hash: "0",
});

const name = (r: Ref) => r.short;

let pass = 0;
let fail = 0;

function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  console.log(
    `${ok ? "  ok  " : " FAIL "} ${label}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`,
  );
}

/** The shape of a tree, as nested `name` / `name(branch)` strings. */
function shape(nodes: ReturnType<typeof buildTree>): unknown[] {
  return nodes.map((n) => {
    const label = n.item === null ? n.name : n.name + "*";
    return n.children.length === 0 ? label : [label, shape(n.children)];
  });
}

eq("a flat name stays at the root", shape(buildTree([ref("main")], name)), ["main*"]);

eq(
  "one level of nesting per slash",
  shape(buildTree([ref("adri/feature1/login")], name)),
  [["adri", [["feature1", ["login*"]]]]],
);

eq(
  "siblings share their common prefix",
  shape(buildTree([ref("adri/one"), ref("adri/two")], name)),
  [["adri", ["one*", "two*"]]],
);

// git rejects this pair outright (refs/heads/feature cannot be both a file and
// a directory), so this only pins down that neither branch is dropped if some
// other ref source ever hands us the shape.
eq(
  "a name that is both a branch and a folder keeps both",
  shape(buildTree([ref("feature"), ref("feature/login")], name)),
  [["feature*", ["login*"]]],
);

eq(
  "the order they arrive in makes no difference",
  shape(buildTree([ref("feature/login"), ref("feature")], name)),
  [["feature*", ["login*"]]],
);

eq(
  "folders sort before branches, each alphabetically",
  shape(buildTree([ref("zeta"), ref("alpha"), ref("beta/x"), ref("aardvark/y")], name)),
  [["aardvark", ["y*"]], ["beta", ["x*"]], "alpha*", "zeta*"],
);

// Remote branches nest under their remote's own row, so the remote name is
// stripped before the tree is built.
const remoteRef: Ref = {
  name: "refs/remotes/origin/adri/x",
  short: "origin/adri/x",
  kind: "remote",
  remote: "origin",
  hash: "0",
};
eq(
  "the caller can strip a prefix it does not want to nest under",
  shape(buildTree([remoteRef], (r) => r.short.substring("origin/".length))),
  [["adri", ["x*"]]],
);

eq("an empty list gives an empty tree", buildTree([], name), []);

eq(
  "folderPaths lists every expandable node, nested ones included",
  folderPaths(buildTree([ref("a/b/c"), ref("d")], name)),
  ["a", "a/b"],
);

eq("countItems counts branches, not nodes", countItems(buildTree([ref("a/b/c"), ref("a/d"), ref("e")], name)), 3);

// Folder- and remote-level actions operate on whatever sits underneath, so
// this is the list that gets hidden when a folder's eye is clicked.
eq(
  "collectItems gathers every ref beneath, depth first",
  collectItems(buildTree([ref("a/b/c"), ref("a/d"), ref("e")], name)).map((r) => r.short),
  ["a/b/c", "a/d", "e"],
);

eq(
  "collectItems on a flat list returns all of them",
  collectItems(buildTree([ref("x"), ref("y")], name)).map((r) => r.short),
  ["x", "y"],
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
