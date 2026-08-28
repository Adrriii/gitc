import { useEffect, useMemo, useState } from "react";
import type { WorkingFile } from "../types";
import { api } from "../api";
import { stagedFiles, unstagedFiles } from "../staging";
import { Confirm } from "./Confirm";
import { Icon } from "./Icon";
import s from "./StagingPanel.module.scss";

/** git's own soft limit for a subject line, and what the reference counts to. */
const SUMMARY_LIMIT = 72;

function FileRow({
  file,
  onOpen,
  active,
  onStage,
  onUnstage,
  onDiscard,
  staged,
}: {
  file: WorkingFile;
  onOpen: () => void;
  active: boolean;
  onStage?: () => void;
  onUnstage?: () => void;
  onDiscard?: () => void;
  staged: boolean;
}) {
  const cut = file.path.lastIndexOf("/");
  const dir = cut === -1 ? "" : file.path.substring(0, cut + 1);
  const base = cut === -1 ? file.path : file.path.substring(cut + 1);
  const code = staged ? file.index : file.untracked ? "?" : file.worktree;
  const icon = code === "A" || code === "?" ? "added" : code === "D" ? "removed" : "edit";
  const kind = code === "A" || code === "?" ? s.add : code === "D" ? s.del : s.mod;

  return (
    // The click is on the ROW, not on the text inside it. The row is what
    // lights up on hover, so the row is what the pointer is aiming at - and
    // with the handler on the label instead, the padding, the status icon and
    // most of the row's height were dead. A hover that promises a click has
    // to deliver one everywhere it reaches.
    <div
      className={`${s.file} ${active ? s.fileActive : ""}`}
      title={file.path}
      onClick={onOpen}
    >
      <span className={`${s.st} ${kind}`}>
        <Icon name={icon} size={12} />
      </span>
      <span className={s.name}>
        {dir && <span className={s.dir}>{dir}</span>}
        <span className={s.base}>{base}</span>
      </span>
      <span className={s.rowActions}>
        {onDiscard && (
          <button className={`${s.iconBtn} ${s.btnDanger}`} onClick={(e) => {
              // The row opens the file; these do their own thing instead.
              e.stopPropagation();
              onDiscard();
            }}
            title="Discard changes"
          >
            <Icon name="trash" size={13} />
          </button>
        )}
        {onStage && (
          <button className={`${s.iconBtn} ${s.btnGood}`} onClick={(e) => {
              e.stopPropagation();
              onStage();
            }}
            title="Stage this file"
          >
            <Icon name="added" size={13} />
          </button>
        )}
        {onUnstage && (
          <button className={s.iconBtn} onClick={(e) => {
              e.stopPropagation();
              onUnstage();
            }}
            title="Unstage this file"
          >
            <Icon name="removed" size={13} />
          </button>
        )}
      </span>
    </div>
  );
}

export function StagingPanel({
  tabId,
  status,
  branch,
  onOpenFile,
  openPath,
  onChanged,
  onCommitted,
}: {
  tabId: string;
  status: WorkingFile[];
  branch: string;
  onOpenFile: (path: string, staged: boolean, untracked: boolean) => void;
  openPath: string | null;
  /** Called after any mutation, so the graph and status can be refreshed. */
  onChanged: () => void;
  /** After a commit lands, so the view can get out of the way of the graph. */
  onCommitted: () => void;
}) {
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ tracked: string[]; untracked: string[] } | null>(null);

  // This panel is not remounted when the repository changes - it is handed a
  // new tabId and keeps its state - so a discard left waiting for an answer
  // would be answered against whichever repository arrived in the meantime,
  // because onConfirm reads tabId when it runs. A question about files in one
  // repository does not survive the move to another. Same rule as the
  // application's own confirms, enforced there by ConfirmState.tabId.
  useEffect(() => {
    setConfirm(null);
  }, [tabId]);

  // Shared with the application, which follows the same lists to decide what
  // to show once a file leaves one of them.
  const unstaged = useMemo(() => unstagedFiles(status), [status]);
  const staged = useMemo(() => stagedFiles(status), [status]);

  // Amending starts from the existing message, which is what makes it an edit
  // rather than a retype. Only prefill when the box is empty, so a message
  // already being written is never clobbered.
  useEffect(() => {
    if (!amend) return;
    let live = true;
    api
      .headMessage(tabId)
      .then((m) => {
        if (!live) return;
        setSummary((prev) => (prev.trim() === "" ? m.summary : prev));
        setDescription((prev) => (prev.trim() === "" ? m.description : prev));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [amend, tabId]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const askDiscard = (files: WorkingFile[]) => {
    setConfirm({
      tracked: files.filter((f) => !f.untracked).map((f) => f.path),
      untracked: files.filter((f) => f.untracked).map((f) => f.path),
    });
  };

  const canCommit = (staged.length > 0 || amend) && summary.trim().length > 0;
  const commitLabel =
    staged.length === 0 && !amend
      ? "Stage Changes to Commit"
      : summary.trim().length === 0
        ? "Type a Message to Commit"
        : amend
          ? "Amend Previous Commit"
          : `Commit ${staged.length} file${staged.length === 1 ? "" : "s"}`;

  return (
    <div className={s.panel}>
      <div className={s.head}>
        <button
          className={`${s.iconBtn} ${s.btnDanger}`}
          title="Discard all changes"
          disabled={busy || status.length === 0}
          onClick={() => askDiscard(status)}
        >
          <Icon name="trash" size={13} />
        </button>
        <span>
          {status.length} file change{status.length === 1 ? "" : "s"} on
        </span>
        <span className={s.branchChip}>{branch}</span>
      </div>

      {error !== null && <div className={s.error}>{error}</div>}

      {/* The two lists split the space in half and each scrolls on its own;
          the commit box below is pinned, so the message and the commit button
          stay reachable however many files are changed. Headers are flex:none
          siblings of the lists rather than wrappers around them, which is what
          keeps the split exact. */}
      <div className={s.lists}>
        <div className={s.section}>
          <span className={s.sectionName}>
              <Icon name="chevronDown" size={11} className={s.caret} />
              Unstaged Files ({unstaged.length})
            </span>
          <button
            className={s.stageAll}
            disabled={busy || unstaged.length === 0}
            onClick={() => run(() => api.stage(tabId, []))}
          >
            Stage All Changes
          </button>
        </div>
        <div className={s.fileList}>
          {unstaged.length === 0 && <div className={s.emptyList}>Nothing unstaged</div>}
          {unstaged.map((f) => (
            <FileRow
              key={f.path}
              file={f}
              staged={false}
              active={openPath === f.path}
              onOpen={() => onOpenFile(f.path, false, f.untracked)}
              onStage={() => run(() => api.stage(tabId, [f.path]))}
              onDiscard={() => askDiscard([f])}
            />
          ))}
        </div>

        <div className={s.section}>
          <span className={s.sectionName}>
              <Icon name="chevronDown" size={11} className={s.caret} />
              Staged Files ({staged.length})
            </span>
          <button
            className={s.unstageAll}
            disabled={busy || staged.length === 0}
            onClick={() => run(() => api.unstage(tabId, []))}
          >
            Unstage All Changes
          </button>
        </div>
        <div className={s.fileList}>
          {staged.length === 0 && <div className={s.emptyList}>Nothing staged</div>}
          {staged.map((f) => (
            <FileRow
              key={f.path}
              file={f}
              staged
              active={openPath === f.path}
              onOpen={() => onOpenFile(f.path, true, false)}
              onUnstage={() => run(() => api.unstage(tabId, [f.path]))}
            />
          ))}
        </div>
      </div>

      <div className={s.commitBox}>
        <label className={s.amend}>
          <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} />
          Amend previous commit
        </label>

        <div className={s.summaryRow}>
          <input
            className={s.summary}
            placeholder="Commit summary"
            value={summary}
            maxLength={200}
            onChange={(e) => setSummary(e.target.value)}
            onKeyDown={(e) => {
              // Ctrl+Enter commits, the convention everywhere else.
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && canCommit) {
                void run(async () => {
                  await api.commit(tabId, summary, description, amend);
                  setSummary("");
                  setDescription("");
                  setAmend(false);
                  onCommitted();
                });
              }
            }}
          />
          <span
            className={`${s.counter} ${summary.length > SUMMARY_LIMIT ? s.over : ""}`}
            title={`git's soft limit for a subject line is ${SUMMARY_LIMIT}`}
          >
            {SUMMARY_LIMIT - summary.length}
          </span>
        </div>

        <textarea
          className={s.description}
          placeholder="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />

        <button
          className={s.commitBtn}
          disabled={!canCommit || busy}
          onClick={() =>
            run(async () => {
              await api.commit(tabId, summary, description, amend);
              setSummary("");
              setDescription("");
              setAmend(false);
              onCommitted();
            })
          }
        >
          {commitLabel}
        </button>
      </div>

      {confirm !== null && (
        <Confirm
          title="Discard changes?"
          body={
            <>
              <p>
                {confirm.tracked.length + confirm.untracked.length} file
                {confirm.tracked.length + confirm.untracked.length === 1 ? "" : "s"} will be
                changed. This cannot be undone by gitc.
              </p>
              {confirm.tracked.length > 0 && (
                <p className={s.confirmLine}>
                  <b>{confirm.tracked.length}</b> tracked file
                  {confirm.tracked.length === 1 ? "" : "s"} reverted to the last commit.
                </p>
              )}
              {confirm.untracked.length > 0 && (
                <p className={s.confirmLine}>
                  <b>{confirm.untracked.length}</b> untracked file
                  {confirm.untracked.length === 1 ? "" : "s"} deleted from disk.
                </p>
              )}
            </>
          }
          confirmLabel="Discard"
          destructive
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const c = confirm;
            setConfirm(null);
            void run(() => api.discard(tabId, c.tracked, c.untracked));
          }}
        />
      )}
    </div>
  );
}
