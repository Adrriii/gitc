import { useMemo, useState } from "react";
import type { GraphPayload, Ref } from "../types";
import { buildTree, collectRefs, countRefs, type TreeNode } from "../branchTree";
import { Icon } from "./Icon";
import s from "./Sidebar.module.scss";

/** Indent per nesting level. Small: the sidebar is only ~208px wide. */
const INDENT = 11;

interface SectionProps {
  name: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  /** Shown in place of the count on hover - the reference's own pattern. */
  onAdd?: () => void;
  addTitle?: string;
  children?: React.ReactNode;
}

function Section({ name, count, open, onToggle, onAdd, addTitle, children }: SectionProps) {
  return (
    <>
      <div className={s.head} onClick={onToggle}>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} className={s.arrow} />
        <span className={s.name}>{name}</span>
        {/* The count and the add button share one slot: hovering swaps one for
            the other, which is how the reference does it and costs no width. */}
        <span className={s.slot}>
          <span className={s.count}>{count}</span>
          {onAdd && (
            <button
              className={s.add}
              title={addTitle}
              onClick={(e) => {
                e.stopPropagation();
                onAdd();
              }}
            >
              <Icon name="plus" size={12} />
            </button>
          )}
        </span>
      </div>
      {open && children}
    </>
  );
}

/**
 * The controls every tree row carries: an eye on the left, a kebab on the right.
 *
 * Both are revealed by hovering the row, which is what the reference does - at
 * 208px wide there is no room to show them on forty rows at once. The one
 * exception is a hidden ref, whose eye stays lit: if the only way back were to
 * hover the row you just dimmed, hiding something would feel irreversible.
 */
function RowControls({
  hidden,
  onMenu,
}: {
  hidden: boolean;
  onMenu: (x: number, y: number) => void;
}) {
  return (
    <button
      className={`${s.kebab} ${hidden ? s.pinned : ""}`}
      title="More"
      onClick={(e) => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        onMenu(Math.round(r.right), Math.round(r.bottom));
      }}
    >
      <Icon name="kebab" size={12} />
    </button>
  );
}

function Eye({ hidden, onClick }: { hidden: boolean; onClick: () => void }) {
  return (
    <button
      className={`${s.eye} ${hidden ? s.pinned : ""}`}
      title={hidden ? "Show in the graph" : "Hide in the graph"}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <Icon name={hidden ? "eyeOff" : "eye"} size={13} />
    </button>
  );
}

interface TreeProps {
  nodes: TreeNode[];
  depth: number;
  /**
   * Namespaces the collapse state.
   *
   * Without it `adri` under LOCAL and `adri` under origin share a key, and
   * collapsing one collapses the other - they are different rows that happen
   * to spell the same path.
   */
  scope: string;
  headBranch: string | null;
  hidden: Set<string>;
  isOpen: (key: string) => boolean;
  onToggleFolder: (key: string) => void;
  onCheckout: (ref: string) => void;
  onContext: (ref: Ref, x: number, y: number) => void;
  onFolderContext: (label: string, refs: string[], x: number, y: number) => void;
  onSetHidden: (refs: string[], hide: boolean) => void;
}

/**
 * Renders one level of the branch tree.
 *
 * A node can be a folder and a branch at the same time, so the two halves are
 * rendered independently rather than as an either/or. git will not actually
 * produce that shape - `feature` and `feature/login` collide in refs/heads -
 * but rendering it costs nothing and loses no branch if one ever appears.
 */
function Tree(p: TreeProps) {
  return (
    <>
      {p.nodes.map((node) => {
        const folder = node.children.length > 0;
        const key = p.scope + "|" + node.path;
        const open = folder && p.isOpen(key);
        const under = collectRefs(node.children);
        // A folder reads as hidden only when everything inside it is, so the
        // eye tells you what clicking will do rather than what some child is.
        const allHidden = under.length > 0 && under.every((r) => p.hidden.has(r.short));

        return (
          <div key={key}>
            {folder && (
              <div
                className={`${s.folder} ${allHidden ? s.dim : ""}`}
                style={{ paddingLeft: 4 + p.depth * INDENT }}
                title={node.path}
                onClick={() => p.onToggleFolder(key)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  p.onFolderContext(
                    node.path,
                    under.map((r) => r.short),
                    e.clientX,
                    e.clientY,
                  );
                }}
              >
                <Eye
                  hidden={allHidden}
                  onClick={() =>
                    p.onSetHidden(
                      under.map((r) => r.short),
                      !allHidden,
                    )
                  }
                />
                <Icon name="folder" size={12} className={s.refIco} />
                <span className={s.refName}>{node.name}</span>
                <span className={s.folderCount}>{countRefs(node.children)}</span>
                <RowControls
                  hidden={allHidden}
                  onMenu={(x, y) =>
                    p.onFolderContext(
                      node.path,
                      under.map((r) => r.short),
                      x,
                      y,
                    )
                  }
                />
              </div>
            )}

            {node.ref !== null && (
              <RefRow
                r={node.ref}
                label={node.name}
                // A name that is also a folder sits at its folder's own depth,
                // so its row indents one more step to read as being inside it.
                depth={folder ? p.depth + 1 : p.depth}
                headBranch={p.headBranch}
                hidden={p.hidden.has(node.ref.short)}
                onCheckout={p.onCheckout}
                onContext={p.onContext}
                onSetHidden={p.onSetHidden}
              />
            )}

            {open && (
              <Tree
                {...p}
                nodes={node.children}
                depth={p.depth + 1}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

function RefRow({
  r,
  label,
  depth,
  headBranch,
  hidden,
  onCheckout,
  onContext,
  onSetHidden,
}: {
  r: Ref;
  label: string;
  depth: number;
  headBranch: string | null;
  hidden: boolean;
  onCheckout: (ref: string) => void;
  onContext: (ref: Ref, x: number, y: number) => void;
  onSetHidden: (refs: string[], hide: boolean) => void;
}) {
  const current = r.kind === "local" && r.short === headBranch;
  return (
    <div
      className={`${s.ref} ${current ? s.current : ""} ${hidden ? s.dim : ""}`}
      style={{ paddingLeft: 4 + depth * INDENT }}
      title={`${r.short} — double-click to check out, right-click for more`}
      onDoubleClick={() => onCheckout(r.short)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContext(r, e.clientX, e.clientY);
      }}
    >
      <Eye hidden={hidden} onClick={() => onSetHidden([r.short], !hidden)} />
      <Icon name={current ? "check" : "branch"} size={12} className={s.refIco} />
      <span className={s.refName}>{label}</span>
      <RowControls hidden={hidden} onMenu={(x, y) => onContext(r, x, y)} />
    </div>
  );
}

export function Sidebar({
  data,
  onContext,
  onCheckout,
  onRemoteContext,
  onFolderContext,
  onAddRemote,
  onNewBranch,
  onSetHidden,
}: {
  data: GraphPayload;
  onContext: (ref: Ref, x: number, y: number) => void;
  onCheckout: (ref: string) => void;
  /** Right-click on a remote's own row, not one of its branches. */
  onRemoteContext: (remote: string, refs: string[], x: number, y: number) => void;
  onFolderContext: (label: string, refs: string[], x: number, y: number) => void;
  onAddRemote: () => void;
  onNewBranch: () => void;
  onSetHidden: (refs: string[], hide: boolean) => void;
}) {
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({
    LOCAL: true,
    REMOTE: true,
    TAGS: false,
  });
  // Folders start expanded, so nesting reorganises the list without hiding
  // anything. Only the keys actually collapsed are remembered.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  const toggleFolder = (key: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const filtering = filter.trim().length > 0;
  // While filtering, every folder reads as open: a match three levels down is
  // useless if the folder holding it is collapsed.
  const isOpen = (key: string) => filtering || !collapsed.has(key);

  const hidden = useMemo(() => new Set(data.hidden ?? []), [data.hidden]);

  const { localTree, localCount, remoteTrees, remoteCount, tags } = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const match = (r: Ref) => f === "" || r.short.toLowerCase().includes(f);

    const locals = data.refs.filter((r) => r.kind === "local" && match(r));
    const tags = data.refs.filter((r) => r.kind === "tag" && match(r));

    const localTree = buildTree(locals, (r) => r.short);

    // Remote branches nest under their remote's row, so the remote's own name
    // is stripped before the tree is built - otherwise every remote's branches
    // would sit inside a redundant folder repeating that name.
    const byRemote = new Map<string, Ref[]>();
    let remoteCount = 0;
    for (const r of data.refs) {
      if (r.kind !== "remote" || !match(r)) continue;
      remoteCount += 1;
      const key = r.remote ?? "origin";
      const list = byRemote.get(key);
      if (list) list.push(r);
      else byRemote.set(key, [r]);
    }

    const remoteTrees = new Map<string, TreeNode[]>();
    for (const [remote, refs] of byRemote) {
      remoteTrees.set(
        remote,
        buildTree(refs, (r) => r.short.substring(remote.length + 1)),
      );
    }

    return { localTree, localCount: locals.length, remoteTrees, remoteCount, tags };
  }, [data.refs, filter]);

  // Every configured remote, including one never fetched and so owning no refs
  // - it still exists, and hiding it would make "add a remote" look like it
  // did nothing at all.
  const allRemotes = useMemo(() => {
    const names = (data.remoteDetail ?? []).map((r) => r.name);
    for (const key of remoteTrees.keys()) if (!names.includes(key)) names.push(key);
    return names;
  }, [data.remoteDetail, remoteTrees]);

  const treeProps = {
    headBranch: data.head.branch,
    hidden,
    isOpen,
    onToggleFolder: toggleFolder,
    onCheckout,
    onContext,
    onFolderContext,
    onSetHidden,
  };

  return (
    <div className={s.side}>
      <div className={s.top}>
        <input
          className={s.filter}
          placeholder="Filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className={s.scroll}>
        <Section
          name="LOCAL"
          count={localCount}
          open={open.LOCAL}
          onToggle={() => toggle("LOCAL")}
          onAdd={onNewBranch}
          addTitle="Create a branch"
        >
          <Tree {...treeProps} nodes={localTree} depth={0} scope="local" />
        </Section>

        <Section
          name="REMOTE"
          count={remoteCount}
          open={open.REMOTE}
          onToggle={() => toggle("REMOTE")}
          onAdd={onAddRemote}
          addTitle="Add a remote"
        >
          {allRemotes.map((remote) => {
            const nodes = remoteTrees.get(remote) ?? [];
            const key = "remote|" + remote;
            const shown = isOpen(key);
            const under = collectRefs(nodes);
            const allHidden = under.length > 0 && under.every((r) => hidden.has(r.short));
            const shorts = under.map((r) => r.short);
            return (
              <div key={remote}>
                <div
                  className={`${s.group} ${allHidden ? s.dim : ""}`}
                  title={`${remote} — right-click to fetch, edit or remove`}
                  onClick={() => toggleFolder(key)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onRemoteContext(remote, shorts, e.clientX, e.clientY);
                  }}
                >
                  <Eye hidden={allHidden} onClick={() => onSetHidden(shorts, !allHidden)} />
                  <Icon name="cloud" size={12} className={s.refIco} />
                  <span className={s.refName}>{remote}</span>
                  {nodes.length === 0 && <span className={s.emptyHint}>no branches</span>}
                  <RowControls
                    hidden={allHidden}
                    onMenu={(x, y) => onRemoteContext(remote, shorts, x, y)}
                  />
                </div>
                {shown && (
                  <Tree {...treeProps} nodes={nodes} depth={1} scope={"remote:" + remote} />
                )}
              </div>
            );
          })}
        </Section>

        <Section name="TAGS" count={tags.length} open={open.TAGS} onToggle={() => toggle("TAGS")}>
          {tags.map((r) => (
            <div
              key={r.name}
              className={`${s.ref} ${hidden.has(r.short) ? s.dim : ""}`}
              style={{ paddingLeft: 4 }}
              title={`${r.short} — right-click for more`}
              onContextMenu={(e) => {
                e.preventDefault();
                onContext(r, e.clientX, e.clientY);
              }}
            >
              <Eye
                hidden={hidden.has(r.short)}
                onClick={() => onSetHidden([r.short], !hidden.has(r.short))}
              />
              <Icon name="tag" size={12} className={s.refIco} />
              <span className={s.refName}>{r.short}</span>
              <RowControls hidden={hidden.has(r.short)} onMenu={(x, y) => onContext(r, x, y)} />
            </div>
          ))}
        </Section>
      </div>
    </div>
  );
}
