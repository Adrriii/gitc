import { useEffect, useMemo, useState } from "react";
import type { Commit, FileChange, GraphPayload } from "../types";
import { buildTree, countItems, type TreeNode } from "../pathTree";
import { Icon } from "./Icon";
import { api } from "../api";
import { StagingPanel } from "./StagingPanel";
import { Avatar } from "./Avatar";
import s from "./Panel.module.scss";

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

export function Panel({
  data,
  tabId,
  selected,
  onOpenFile,
  openPath,
  onChanged,
  onCommitted,
}: {
  data: GraphPayload;
  tabId: string;
  selected: string[];
  onOpenFile: (path: string, staged: boolean, untracked: boolean) => void;
  openPath: string | null;
  onChanged: () => void;
  /** After a commit lands. */
  onCommitted: () => void;
}) {
  const [files, setFiles] = useState<FileChange[]>([]);
  const [filesError, setFilesError] = useState<string | null>(null);

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

      <div className={s.message}>
        <div className={s.subject}>{commit.subject}</div>
        {commit.body && <div className={s.body}>{commit.body}</div>}
      </div>

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
          body rather than leaving it as text nobody reads. */}
      {(commit.coAuthors ?? []).length > 0 && (
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
