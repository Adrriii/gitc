import { useMemo, useState } from "react";
import type { GraphPayload, Ref, Submodule } from "../types";
import { buildTree, flatTree, collectItems, countItems, type TreeNode } from "../pathTree";
import { useBranchFolders } from "../settings";
import { stashName } from "../stashes";
import { ago } from "../ago";
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

/**
 * One band of the sidebar.
 *
 * The sections are an accordion: exactly one body is open, and every header
 * stays on screen whatever the repository holds. Before this, a repo with
 * forty local branches pushed REMOTE and TAGS off the bottom, so the only way
 * to reach a tag was to scroll past every branch first.
 *
 * The open body takes the leftover height and scrolls inside itself, which is
 * what keeps the headers put.
 */
function Section({ name, count, open, onToggle, onAdd, addTitle, children }: SectionProps) {
  return (
    <div className={`${s.section} ${open ? s.sectionOpen : ""}`}>
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
      {open && <div className={s.body}>{children}</div>}
    </div>
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
  nodes: TreeNode<Ref>[];
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
  /** How long ago a ref last moved, formatted for the row. */
  ageOf: (r: Ref) => string;
  onSelectRef: (r: Ref) => void;
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
        const under = collectItems(node.children);
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
                <span className={s.folderCount}>{countItems(node.children)}</span>
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

            {node.item !== null && (
              <RefRow
                r={node.item}
                label={node.name}
                age={p.ageOf(node.item)}
                onSelect={p.onSelectRef}
                // A name that is also a folder sits at its folder's own depth,
                // so its row indents one more step to read as being inside it.
                depth={folder ? p.depth + 1 : p.depth}
                headBranch={p.headBranch}
                hidden={p.hidden.has(node.item.short)}
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
  age,
  onSelect,
  depth,
  headBranch,
  hidden,
  onCheckout,
  onContext,
  onSetHidden,
}: {
  r: Ref;
  label: string;
  /** How long ago this branch last moved, already formatted. "" if unknown. */
  age: string;
  depth: number;
  headBranch: string | null;
  hidden: boolean;
  onCheckout: (ref: string) => void;
  onContext: (ref: Ref, x: number, y: number) => void;
  onSetHidden: (refs: string[], hide: boolean) => void;
  /** Single click: take the graph to this branch tip. */
  onSelect: (r: Ref) => void;
}) {
  const current = r.kind === "local" && r.short === headBranch;
  return (
    <div
      className={`${s.ref} ${current ? s.current : ""} ${hidden ? s.dim : ""}`}
      style={{ paddingLeft: 4 + depth * INDENT }}
      title={`${r.short} — click to find it in the graph, double-click to check out`}
      onClick={() => onSelect(r)}
      onDoubleClick={() => onCheckout(r.short)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContext(r, e.clientX, e.clientY);
      }}
    >
      <Eye hidden={hidden} onClick={() => onSetHidden([r.short], !hidden)} />
      <Icon name={current ? "check" : "branch"} size={12} className={s.refIco} />
      <span className={s.refName}>{label}</span>
      {/* Sits between the name and the kebab, and is replaced by the kebab
          on hover - the same slot-sharing the section headers use, so the
          age costs no width when you are reaching for the menu. */}
      {age.length > 0 && <span className={s.refAge}>{age}</span>}
      <RowControls hidden={hidden} onMenu={(x, y) => onContext(r, x, y)} />
    </div>
  );
}

/** The badge text: short enough for a 208px sidebar. */
function shortState(sub: Submodule): string {
  // An ellipsis rather than a word: the state is a second away, and a row
  // that says "checking" in the same slot the answer lands in reads as a
  // state of its own.
  if (sub.state === "pending") return "…";
  if (sub.state === "uninitialized") return "not cloned";
  if (sub.state === "moved") return "moved";
  if (sub.state === "dirty") return "modified";
  if (sub.state === "conflicted") return "conflicts";
  return "";
}

function stateClass(sub: Submodule, styles: Record<string, string>): string {
  if (sub.state === "conflicted") return styles.subBad;
  if (sub.state === "moved" || sub.state === "dirty") return styles.subWarn;
  return styles.subDim;
}

/** The longer form, for the tooltip. */
function describeSubmodule(sub: Submodule): string {
  if (sub.state === "pending") return "reading its state";
  if (sub.state === "uninitialized") return "declared but not checked out";
  if (sub.state === "moved") return "at a different commit than this repository records";
  if (sub.state === "dirty")
    return "has uncommitted work inside it - nothing this repository can stage";
  if (sub.state === "conflicted") return "has merge conflicts";
  return "at the recorded commit" + (sub.label.length > 0 ? " (" + sub.label + ")" : "");
}

export function Sidebar({
  data,
  submodules,
  onContext,
  onCheckout,
  onRemoteContext,
  onFolderContext,
  onAddRemote,
  onNewBranch,
  onSetHidden,
  onOpenSubmodule,
  onSubmoduleContext,
  onStashContext,
  onSelectRef,
}: {
  data: GraphPayload;
  /**
   * The declared list from the graph payload, replaced by the live one once
   * it arrives. Entries read "pending" until then - see api.submodules.
   */
  submodules: Submodule[];
  onContext: (ref: Ref, x: number, y: number) => void;
  onCheckout: (ref: string) => void;
  /** Right-click on a remote's own row, not one of its branches. */
  onRemoteContext: (remote: string, refs: string[], x: number, y: number) => void;
  onFolderContext: (label: string, refs: string[], x: number, y: number) => void;
  onAddRemote: () => void;
  onNewBranch: () => void;
  onSetHidden: (refs: string[], hide: boolean) => void;
  /** Opens a submodule as its own repository tab. */
  onOpenSubmodule: (sub: Submodule) => void;
  onSubmoduleContext: (sub: Submodule, x: number, y: number) => void;
  onStashContext: (selector: string, x: number, y: number) => void;
  /** Single click on a ref row - select its commit and scroll to it. */
  onSelectRef: (r: Ref) => void;
}) {
  const [filter, setFilter] = useState("");
  // Which single section is expanded. Clicking the open one closes it, which
  // leaves three headers and nothing else - occasionally what you want.
  const [expanded, setExpanded] = useState("LOCAL");
  // Folders start expanded, so nesting reorganises the list without hiding
  // anything. Only the keys actually collapsed are remembered.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (k: string) => setExpanded((cur) => (cur === k ? "" : k));
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
  const stashes = data.stashes ?? [];

  const { folders, set: setFolders } = useBranchFolders();

  /**
   * When each branch last moved, from the commits already on screen.
   *
   * Deliberately not a `git for-each-ref` of its own: the graph payload
   * already carries every commit in the window with its date, and a branch
   * tip is by definition one of the walk's starting points, so it is in there.
   * A tip old enough to have fallen off the end of the window comes back 0 -
   * which sorts it last, and last is where a branch nobody has touched in two
   * thousand commits belongs anyway.
   */
  const dateOf = useMemo(() => {
    const byHash = new Map<string, number>();
    for (const c of data.commits) byHash.set(c.hash, c.date);
    return (r: Ref) => byHash.get(r.hash) ?? 0;
  }, [data.commits]);

  // The same number the ordering uses, shown on the row - otherwise the list
  // is in an order with no visible reason for it, and "why is this one first?"
  // has no answer on screen.
  const ageOf = useMemo(() => {
    const now = Date.now();
    return (r: Ref) => {
      const at = dateOf(r);
      return at === 0 ? "" : ago(now - at * 1000);
    };
  }, [dateOf]);

  const { localTree, localCount, remoteTrees, remoteCount, tags } = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const match = (r: Ref) => f === "" || r.short.toLowerCase().includes(f);

    const locals = data.refs.filter((r) => r.kind === "local" && match(r));
    const tags = data.refs.filter((r) => r.kind === "tag" && match(r));

    const arrange = (refs: Ref[], pathOf: (r: Ref) => string) =>
      folders ? buildTree(refs, pathOf, dateOf) : flatTree(refs, pathOf, dateOf);

    const localTree = arrange(locals, (r) => r.short);

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

    const remoteTrees = new Map<string, TreeNode<Ref>[]>();
    for (const [remote, refs] of byRemote) {
      remoteTrees.set(
        remote,
        arrange(refs, (r) => r.short.substring(remote.length + 1)),
      );
    }

    return { localTree, localCount: locals.length, remoteTrees, remoteCount, tags };
  }, [data.refs, filter, folders, dateOf]);

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
    ageOf,
    onSelectRef,
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
        {/* Beside the filter rather than in Preferences: this is a way of
            looking at the list, and you decide you want it while looking at
            the list. */}
        <button
          className={`${s.grouping} ${folders ? s.groupingOn : ""}`}
          onClick={() => setFolders(!folders)}
          title={
            folders
              ? "Grouping branches into folders by name. Click to flatten the list and show every branch by date."
              : "Showing every branch by date, most recent first. Click to group them into folders by name."
          }
        >
          <Icon name="folder" size={13} />
        </button>
      </div>
      <div className={s.scroll}>
        <Section
          name="LOCAL"
          count={localCount}
          open={expanded === "LOCAL"}
          onToggle={() => toggle("LOCAL")}
          onAdd={onNewBranch}
          addTitle="Create a branch"
        >
          <Tree {...treeProps} nodes={localTree} depth={0} scope="local" />
        </Section>

        <Section
          name="REMOTE"
          count={remoteCount}
          open={expanded === "REMOTE"}
          onToggle={() => toggle("REMOTE")}
          onAdd={onAddRemote}
          addTitle="Add a remote"
        >
          {allRemotes.map((remote) => {
            const nodes = remoteTrees.get(remote) ?? [];
            const key = "remote|" + remote;
            const shown = isOpen(key);
            const under = collectItems(nodes);
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

        <Section name="TAGS" count={tags.length} open={expanded === "TAGS"} onToggle={() => toggle("TAGS")}>
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

        {/* Like submodules: shown only when there are any. A permanent empty
            STASHES row would be a reminder of nothing in most repositories.
            No eye control - a stash is not a ref and cannot be hidden from
            the graph, because it is not reachable from one. */}
        {stashes.length > 0 && (
          <Section
            name="STASHES"
            count={stashes.length}
            open={expanded === "STASHES"}
            onToggle={() => toggle("STASHES")}
          >
            {stashes.map((st) => (
              <div
                key={st.selector}
                className={s.ref}
                style={{ paddingLeft: 4 }}
                title={`${st.selector} — ${st.subject}\nright-click to apply, pop or delete`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onStashContext(st.selector, e.clientX, e.clientY);
                }}
              >
                <Icon name="stash" size={12} className={s.refIco} />
                <span className={s.refName}>{stashName(st.subject)}</span>
                <RowControls
                  hidden={false}
                  onMenu={(x, y) => onStashContext(st.selector, x, y)}
                />
              </div>
            ))}
          </Section>
        )}

        {/* Only when the repository has any: an always-present empty section
            would be noise in the overwhelming majority of repositories. */}
        {submodules.length > 0 && (
          <Section
            name="SUBMODULES"
            count={submodules.length}
            open={expanded === "SUBMODULES"}
            onToggle={() => toggle("SUBMODULES")}
          >
            {submodules.map((sub) => (
              <div
                key={sub.path}
                className={`${s.ref} ${sub.state === "uninitialized" ? s.dim : ""}`}
                style={{ paddingLeft: 4 }}
                title={`${sub.path} — ${describeSubmodule(sub)}
double-click to open it as a tab, right-click for more`}
                onDoubleClick={() => onOpenSubmodule(sub)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onSubmoduleContext(sub, e.clientX, e.clientY);
                }}
              >
                <Icon name="repo" size={12} className={s.refIco} />
                <span className={s.refName}>{sub.path}</span>
                {sub.state !== "current" && (
                  <span className={`${s.subState} ${stateClass(sub, s)}`}>
                    {shortState(sub)}
                  </span>
                )}
              </div>
            ))}
          </Section>
        )}
      </div>
    </div>
  );
}
