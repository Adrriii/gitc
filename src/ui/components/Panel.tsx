import { useEffect, useMemo, useRef, useState } from "react";
import type { Commit, FileChange, GraphPayload, Person } from "../types";
import { buildTree, countItems, type TreeNode } from "../pathTree";
import { chainBetween } from "../selection";
import {
  buildMessage,
  contributors,
  formatPerson,
  matching,
  parsePerson,
  splitCoAuthors,
  type Contributor,
} from "../coAuthors";
import { Icon } from "./Icon";
import { api } from "../api";
import { StagingPanel } from "./StagingPanel";
import { Avatar } from "./Avatar";
import s from "./Panel.module.scss";

/** git's soft limit for a subject line. Same number as StagingPanel's. */
const SUMMARY_LIMIT = 72;

function when(unix: number): string {
  const d = new Date(unix * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} @ ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function FileRow({
  status,
  path,
  onOpen,
  active,
  depth = 0,
  baseOnly = false,
}: {
  status: string;
  path: string;
  onOpen?: (path: string) => void;
  active?: boolean;
  /** Nesting level in tree mode; ignored in path mode. */
  depth?: number;
  /** Tree mode shows only the file name - the folders are already rows. */
  baseOnly?: boolean;
}) {
  const cut = path.lastIndexOf("/");
  const dir = cut === -1 || baseOnly ? "" : path.substring(0, cut + 1);
  const base = cut === -1 ? path : path.substring(cut + 1);
  const glyph = status === "A" ? "+" : status === "D" ? "−" : status === "R" ? "→" : "✎";
  return (
    <div
      className={`${s.file} ${active ? s.fileActive : ""}`}
      style={depth > 0 ? { paddingLeft: 10 + depth * 12 } : undefined}
      title={path}
      onClick={() => onOpen?.(path)}
    >
      <span className={`${s.st} ${s["st" + status] ?? ""}`}>{glyph}</span>
      {dir && <span className={s.dir}>{dir}</span>}
      <span className={s.base}>{base}</span>
    </div>
  );
}

/**
 * The file list as a directory tree.
 *
 * The Tree button existed before this did: it set a mode nothing read, so the
 * list stayed flat whichever way it was toggled. Folders collapse, and a
 * folder with a single child collapses INTO it - `src/ui/components` is one
 * row rather than three, which is the difference between a tree that helps and
 * one that is mostly indentation.
 */
function FileTree({
  nodes,
  depth,
  collapsed,
  toggle,
  onOpen,
  activePath,
}: {
  nodes: TreeNode<FileChange>[];
  depth: number;
  collapsed: Set<string>;
  toggle: (path: string) => void;
  onOpen?: (path: string) => void;
  activePath?: string | null;
}) {
  return (
    <>
      {nodes.map((node) => {
        if (node.children.length === 0 && node.item !== null) {
          return (
            <FileRow
              key={node.path}
              status={node.item.status}
              path={node.item.path}
              onOpen={onOpen}
              active={activePath === node.item.path}
              depth={depth}
              baseOnly
            />
          );
        }

        // Fold a chain of single-child directories into one row.
        let label = node.name;
        let folder = node;
        while (folder.children.length === 1 && folder.item === null && folder.children[0].children.length > 0) {
          folder = folder.children[0];
          label += "/" + folder.name;
        }

        const open = !collapsed.has(folder.path);
        return (
          <div key={node.path}>
            <div
              className={s.folder}
              style={{ paddingLeft: 10 + depth * 12 }}
              onClick={() => toggle(folder.path)}
              title={folder.path}
            >
              <Icon
                name={open ? "chevronDown" : "chevronRight"}
                size={11}
                className={s.folderArrow}
              />
              <span className={s.folderName}>{label}</span>
              <span className={s.folderCount}>{countItems(folder.children)}</span>
            </div>
            {open && (
              <FileTree
                nodes={folder.children}
                depth={depth + 1}
                collapsed={collapsed}
                toggle={toggle}
                onOpen={onOpen}
                activePath={activePath}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

function Files({
  files,
  onOpen,
  activePath,
}: {
  files: FileChange[];
  onOpen?: (path: string) => void;
  activePath?: string | null;
}) {
  const [mode, setMode] = useState<"path" | "tree">("path");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const tree = useMemo(() => buildTree(files, (f) => f.path), [files]);
  const toggleFolder = (path: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const modified = files.filter((f) => f.status === "M").length;
  const added = files.filter((f) => f.status === "A").length;
  const deleted = files.filter((f) => f.status === "D").length;
  const renamed = files.filter((f) => f.status === "R").length;

  return (
    <>
      <div className={s.filesHead}>
        <span className={s.mod}>✎ {modified} modified</span>
        {added > 0 && <span className={s.add}>+ {added} added</span>}
        {deleted > 0 && <span className={s.del}>− {deleted} deleted</span>}
        {renamed > 0 && <span className={s.ren}>→ {renamed} renamed</span>}
        <div className={s.toggle}>
          <button className={mode === "path" ? s.on : ""} onClick={() => setMode("path")}>
            Path
          </button>
          <button className={mode === "tree" ? s.on : ""} onClick={() => setMode("tree")}>
            Tree
          </button>
        </div>
      </div>
      {mode === "tree" ? (
        <FileTree
          nodes={tree}
          depth={0}
          collapsed={collapsed}
          toggle={toggleFolder}
          onOpen={onOpen}
          activePath={activePath}
        />
      ) : (
        files.map((f) => (
          <FileRow
            key={f.path}
            status={f.status}
            path={f.path}
            onOpen={onOpen}
            active={activePath === f.path}
          />
        ))
      )}
    </>
  );
}

/**
 * What is being typed into the message editor, and which commit for.
 *
 * The hash is part of the state rather than read from the selection, so that
 * a graph refresh landing mid-edit cannot quietly move the edit onto another
 * commit - it closes the editor instead.
 */
interface Editing {
  hash: string;
  summary: string;
  /** The body with the co-author trailers taken out - they are edited below. */
  description: string;
  coAuthors: Person[];
  /** Blank until the real message has been read back from git. */
  loaded: boolean;
}

/**
 * Picks somebody to credit, from the people who already commit here.
 *
 * Typing filters the list and doubles as the way to name somebody who is not
 * on it - "Ada <ada@example.com>", or just a name - because the first
 * co-author from a new collaborator has to be typeable before they can ever
 * appear in a ranking of past commits.
 */
function CoAuthorPicker({
  people,
  onPick,
}: {
  people: Contributor[];
  onPick: (person: Person) => void;
}) {
  const [query, setQuery] = useState("");
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    field.current?.focus();
  }, []);

  const shown = matching(people, query).slice(0, 40);
  const typed = parsePerson(query);

  return (
    <div className={s.picker}>
      <input
        ref={field}
        className={s.pickerFilter}
        placeholder="Name <email>, or search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          const first = shown[0];
          if (first !== undefined) onPick(first.person);
          else if (typed !== null) onPick(typed);
        }}
      />
      <div className={s.pickerList}>
        {shown.map((c) => (
          <button
            key={c.person.email + c.person.name}
            className={s.pickerRow}
            onClick={() => onPick(c.person)}
          >
            <Avatar name={c.person.name} email={c.person.email} size={20} rounded />
            <span className={s.pickerName}>{c.person.name}</span>
            <span className={s.pickerEmail}>{c.person.email}</span>
            <span className={s.pickerCount}>{c.count}</span>
          </button>
        ))}
        {shown.length === 0 && typed !== null && (
          <button className={s.pickerRow} onClick={() => onPick(typed)}>
            <span className={s.pickerName}>Credit {formatPerson(typed)}</span>
          </button>
        )}
        {shown.length === 0 && typed === null && (
          <div className={s.pickerEmpty}>Nobody else has committed here yet - type a name.</div>
        )}
      </div>
    </div>
  );
}

export function Panel({
  data,
  tabId,
  selected,
  onOpenFile,
  openPath,
  onChanged,
  onCommitted,
  onReword,
}: {
  data: GraphPayload;
  tabId: string;
  selected: string[];
  onOpenFile: (path: string, staged: boolean, untracked: boolean) => void;
  openPath: string | null;
  onChanged: () => void;
  /** After a commit lands. */
  onCommitted: () => void;
  /** A new message for one commit, as git wants it: subject, blank line, body. */
  onReword: (hash: string, message: string) => void;
}) {
  const [files, setFiles] = useState<FileChange[]>([]);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  /** The "add a co-author" list is open. */
  const [picking, setPicking] = useState(false);
  const summaryRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  /** The toggle button and the picker together - see the region's comment. */
  const addArea = useRef<HTMLDivElement>(null);

  // Clicking away from the picker closes it. Capture, because half this UI
  // stops click propagation before it reaches window - the same reason
  // ContextMenu listens the way it does. Escape closes it too.
  useEffect(() => {
    if (!picking) return;
    const away = (e: MouseEvent) => {
      if (!addArea.current?.contains(e.target as Node)) setPicking(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Stopped here so Escape closes the picker and nothing else. Without
      // it the summary field's own Escape handler also fires and the whole
      // editor closes, losing what was typed.
      e.stopPropagation();
      setPicking(false);
    };
    document.addEventListener("mousedown", away, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", away, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [picking]);

  const single = selected.length === 1 ? selected[0] : null;
  const commit: Commit | undefined =
    single && single !== "WIP" ? data.commits.find((c) => c.hash === single) : undefined;

  // The selection is a contiguous run on one branch (see selection.ts), so
  // newest and oldest are just its ends in graph order.
  const chosen = useMemo(
    () => data.commits.filter((c) => selected.includes(c.hash)),
    [data.commits, selected],
  );
  const newest = chosen.length > 0 ? chosen[0].hash : null;
  const oldest = chosen.length > 0 ? chosen[chosen.length - 1].hash : null;
  const isRange = selected.length > 1 && newest !== null && oldest !== null;

  useEffect(() => {
    if (!commit && !isRange) {
      setFiles([]);
      return;
    }
    let live = true;
    setFilesError(null);
    // One commit shows its own files; a run shows the combined diff across
    // the whole run, so a file touched three times appears once.
    const request = isRange
      ? api.rangeFiles(tabId, oldest, newest)
      : api.commitFiles(tabId, commit!.hash);
    request
      .then((r) => {
        if (live) setFiles(r.files);
      })
      .catch((e: Error) => {
        if (!live) return;
        setFiles([]);
        setFilesError(e.message);
      });
    return () => {
      live = false;
    };
  }, [tabId, commit?.hash, isRange, oldest, newest]);

  /**
   * The commits a reword of this one would rewrite, or null if it cannot be.
   *
   * Changing a message changes the commit's hash, so every commit built on top
   * of it is rebuilt too - and only the ones on HEAD's own first-parent line
   * can be, because that is the line the rebase replays. A commit off on
   * another branch is not editable from here at all: the honest answer is to
   * check that branch out, not to rewrite whichever history HEAD happens to
   * be on.
   */
  const above = useMemo(() => {
    const head = data.head.hash;
    if (commit === undefined || head === null) return null;
    // HEAD is amended in place - no rebase, so no chain to walk and no merge
    // to worry about. It is also the only case that works with a dirty
    // working tree, which is where a just-noticed typo is usually found.
    if (commit.hash === head) return 0;
    const byHash = new Map<string, Commit>();
    for (const c of data.commits) byHash.set(c.hash, c);
    const chain = chainBetween(data.commits, byHash, head, commit.hash);
    if (chain === null) return null;
    // A merge anywhere in the replay is left out of git's todo list, so the
    // reword would land on nothing and flatten the merge on the way past.
    if (chain.some((h) => (byHash.get(h)?.parents.length ?? 0) > 1)) return null;
    // Inclusive of both ends, so the commits ABOVE this one are the rest.
    return chain.length - 1;
  }, [data.commits, data.head.hash, commit?.hash]);

  // A refresh that moves the selection, or history moving under an open
  // editor, closes it rather than applying what was typed somewhere else.
  useEffect(() => {
    setEditing((e) => (e === null || e.hash === commit?.hash ? e : null));
    setEditError(null);
  }, [commit?.hash]);

  const startEdit = (hash: string, focus: "summary" | "description") => {
    setEditError(null);
    setPicking(false);
    setEditing({ hash, summary: "", description: "", coAuthors: [], loaded: false });
    // The panel's own copy of the body has co-author trailers taken out of it
    // for display, so editing that and writing it back would drop them. The
    // message git actually holds comes from the engine - and the trailers come
    // straight back out of it again here, so the body being typed into is the
    // body and the people are edited as people.
    api
      .commitMessage(tabId, hash)
      .then((m) => {
        const split = splitCoAuthors(m.description);
        setEditing((e) =>
          e === null || e.hash !== hash
            ? e
            : {
                hash,
                summary: m.summary,
                description: split.body,
                coAuthors: split.coAuthors,
                loaded: true,
              },
        );
        const field = focus === "summary" ? summaryRef.current : descriptionRef.current;
        field?.focus();
        if (focus === "summary") summaryRef.current?.select();
      })
      .catch((err: Error) => {
        setEditing(null);
        setEditError(err.message);
      });
  };

  const saveEdit = () => {
    if (editing === null || !editing.loaded) return;
    if (editing.summary.trim().length === 0) return;
    const message = buildMessage(editing.summary, editing.description, editing.coAuthors);
    setEditing(null);
    setPicking(false);
    onReword(editing.hash, message);
  };

  /**
   * Who the picker offers: everyone who commits here, minus this commit's own
   * author and anyone already credited.
   *
   * The author is excluded because git's own trailer means "as well as the
   * author" - crediting somebody as a co-author of their own commit says
   * nothing, and forges show it as a duplicate.
   */
  const offer = useMemo(() => {
    if (editing === null || commit === undefined) return [];
    return contributors(data.commits, [
      { name: commit.author, email: commit.email },
      ...editing.coAuthors,
    ]);
  }, [data.commits, editing?.coAuthors, commit?.hash, commit?.email, commit?.author, editing !== null]);

  if (single === "WIP") {
    return (
      <div className={`${s.panel} ${s.panelFlush}`}>
        <StagingPanel
          tabId={tabId}
          status={data.status}
          branch={data.head.branch ?? "detached"}
          onOpenFile={onOpenFile}
          openPath={openPath}
          onCommitted={onCommitted}
          onChanged={onChanged}
        />
      </div>
    );
  }

  if (selected.length > 1) {
    return (
      <div className={s.panel}>
        <div className={s.head}>{selected.length} commits selected</div>
        <div className={s.multi}>Viewing merged diff of {selected.length} commits</div>
        <div className={s.mlist}>
          {chosen.map((c) => (
            <div key={c.hash} className={s.mrow}>
              <Avatar name={c.author} email={c.email} size={26} rounded />
              <span className={s.mtext}>
                <span className={s.msubject}>{c.subject}</span>
                <span className={s.mmeta}>
                  {when(c.date)} by {c.author}
                </span>
              </span>
              <span className={s.mhash}>{c.hash.substring(0, 6)}</span>
            </div>
          ))}
        </div>
        {filesError !== null ? (
          <div className={s.empty}>Could not read the combined diff: {filesError}</div>
        ) : (
          <Files files={files} onOpen={(p) => onOpenFile(p, false, false)} activePath={openPath} />
        )}
      </div>
    );
  }

  if (!commit) {
    return (
      <div className={s.panel}>
        <div className={s.empty}>Select a commit</div>
      </div>
    );
  }

  return (
    <div className={s.panel}>
      <div className={s.head}>
        <span>commit:</span>
        <span className={s.mono}>{commit.hash.substring(0, 6)}</span>
      </div>

      {editing !== null ? (
        <div className={`${s.message} ${s.messageEdit}`}>
          <div className={s.summaryRow}>
            <input
              ref={summaryRef}
              className={s.editSummary}
              placeholder="Commit summary"
              value={editing.summary}
              maxLength={200}
              disabled={!editing.loaded}
              onChange={(e) => setEditing({ ...editing, summary: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveEdit();
                if (e.key === "Escape") setEditing(null);
              }}
            />
            <span
              className={`${s.counter} ${editing.summary.length > SUMMARY_LIMIT ? s.over : ""}`}
              title={`git's soft limit for a subject line is ${SUMMARY_LIMIT}`}
            >
              {SUMMARY_LIMIT - editing.summary.length}
            </span>
          </div>
          <textarea
            ref={descriptionRef}
            className={s.editBody}
            placeholder="Description"
            value={editing.description}
            disabled={!editing.loaded}
            onChange={(e) => setEditing({ ...editing, description: e.target.value })}
            onKeyDown={(e) => {
              // Ctrl+Enter here, not plain Enter - a description is meant to
              // have line breaks in it.
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) saveEdit();
              if (e.key === "Escape") setEditing(null);
            }}
          />

          {/* git has no second author field, so co-authorship is a trailer -
              which means it is text in the message, and text in a message is
              one typo away from crediting nobody. Edited as people here, and
              turned back into trailers on save. */}
          <div className={s.coEdit}>
            <div className={s.coEditHead}>
              co-authors
              <span className={s.coEditCount}>
                {editing.coAuthors.length === 0 ? "none" : editing.coAuthors.length}
              </span>
            </div>

            {editing.coAuthors.map((person, i) => (
              <div key={i} className={s.coRow}>
                <Avatar name={person.name} email={person.email} size={22} rounded />
                <input
                  className={s.coNameField}
                  placeholder="Name"
                  value={person.name}
                  disabled={!editing.loaded}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      coAuthors: editing.coAuthors.map((p, j) =>
                        j === i ? { ...p, name: e.target.value } : p,
                      ),
                    })
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setEditing(null);
                  }}
                />
                <input
                  className={s.coEmailField}
                  placeholder="email"
                  value={person.email}
                  disabled={!editing.loaded}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      coAuthors: editing.coAuthors.map((p, j) =>
                        j === i ? { ...p, email: e.target.value } : p,
                      ),
                    })
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setEditing(null);
                  }}
                />
                <button
                  className={s.coDrop}
                  title={`Stop crediting ${person.name.length > 0 ? person.name : person.email}`}
                  onClick={() =>
                    setEditing({
                      ...editing,
                      coAuthors: editing.coAuthors.filter((_, j) => j !== i),
                    })
                  }
                >
                  ×
                </button>
              </div>
            ))}

            {/* The button and the list are one region as far as "did you
                click away?" is concerned. They were not, and the bug was
                exact: mousedown on Cancel closed the list from the outside
                click listener, React swapped the label back to "+ Add
                co-author", and the click that followed the SAME mousedown
                landed on it and reopened the list. Only dragging off the
                button before releasing avoided it. */}
            <div className={s.coAddArea} ref={addArea}>
              <button
                className={s.coAdd}
                disabled={!editing.loaded}
                onClick={() => setPicking((p) => !p)}
              >
                {picking ? "Cancel" : "+ Add co-author"}
              </button>
              {picking && (
                <CoAuthorPicker
                  people={offer}
                  onPick={(person) => {
                    setPicking(false);
                    setEditing({ ...editing, coAuthors: [...editing.coAuthors, person] });
                  }}
                />
              )}
            </div>
          </div>

          <div className={s.editActions}>
            <span className={s.editNote}>
              {above === 0
                ? "Amends this commit. Its hash changes, so push again if it was pushed."
                : above === 1
                  ? "Rewrites this commit and the 1 above it."
                  : `Rewrites this commit and the ${above ?? 0} above it.`}
            </span>
            <button className={s.editCancel} onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button
              className={s.editSave}
              disabled={!editing.loaded || editing.summary.trim().length === 0}
              onClick={saveEdit}
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <div
          className={`${s.message} ${above !== null ? s.messageEditable : ""}`}
          title={
            above !== null
              ? "Double-click to edit this commit's message"
              : "Only commits on the checked-out branch can be edited from here"
          }
        >
          <div
            className={s.subject}
            onDoubleClick={() => above !== null && startEdit(commit.hash, "summary")}
          >
            {commit.subject}
          </div>
          {commit.body ? (
            <div
              className={s.body}
              onDoubleClick={() => above !== null && startEdit(commit.hash, "description")}
            >
              {commit.body}
            </div>
          ) : (
            above !== null && (
              <div
                className={`${s.body} ${s.bodyEmpty}`}
                onDoubleClick={() => startEdit(commit.hash, "description")}
              >
                no description
              </div>
            )
          )}
          {editError !== null && <div className={s.editError}>{editError}</div>}
        </div>
      )}

      <div className={s.person}>
        <Avatar name={commit.author} email={commit.email} size={34} rounded />
        <span>
          <div className={s.who}>{commit.author}</div>
          <div className={s.pwhen}>authored {when(commit.date)}</div>
        </span>
        {commit.parents.length > 0 && (
          <span className={s.parents}>
            parent: {commit.parents.map((p) => p.substring(0, 6)).join(", ")}
          </span>
        )}
      </div>

      {/* git has no second author field; co-authorship is a message trailer.
          Crediting those people here is the point of parsing it out of the
          body rather than leaving it as text nobody reads.

          Hidden while the message is being edited: the editor has its own
          list, and two lists of the same people - one of them stale - is
          worse than one. */}
      {editing === null && (commit.coAuthors ?? []).length > 0 && (
        <div className={s.coAuthors}>
          <div className={s.coLabel}>
            co-authored with {(commit.coAuthors ?? []).length}{" "}
            {(commit.coAuthors ?? []).length === 1 ? "other" : "others"}
          </div>
          {(commit.coAuthors ?? []).map((p) => (
            <div key={p.email + p.name} className={s.coPerson}>
              <Avatar name={p.name} email={p.email} size={22} rounded />
              <span className={s.coName}>{p.name}</span>
              {p.email.length > 0 && <span className={s.coEmail}>{p.email}</span>}
            </div>
          ))}
        </div>
      )}

      {filesError !== null ? (
        <div className={s.empty}>Could not read changes: {filesError}</div>
      ) : (
        <Files files={files} onOpen={(p) => onOpenFile(p, false, false)} activePath={openPath} />
      )}
    </div>
  );
}
