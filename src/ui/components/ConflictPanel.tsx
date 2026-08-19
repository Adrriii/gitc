import { useCallback, useEffect, useState } from "react";
import type { ConflictFile, ConflictState } from "../types";
import { api } from "../api";
import { Icon } from "./Icon";
import s from "./ConflictPanel.module.scss";

/**
 * The panel that takes over while a merge or rebase is stuck.
 *
 * It replaces the commit detail entirely, because while an operation is
 * half-applied there is nothing else worth looking at - and leaving the normal
 * panel up would suggest the repository is in a state it is not.
 *
 * The hard part here is not the list, it is the labelling. During a REBASE
 * git's "ours" is the branch being rebased ONTO and "theirs" is the commit
 * being replayed, which is the opposite of what almost everyone assumes. So
 * nothing in this UI says ours or theirs: the buttons name the branches.
 */
function sideLabels(state: ConflictState): { ours: string; theirs: string } {
  const p = state.progress;
  if (state.operation === "rebase" && p !== null) {
    return {
      ours: (p.ontoName ?? "").length > 0 ? p.ontoName : (p.onto ?? "the base"),
      theirs: (p.branch ?? "").length > 0 ? p.branch : "the replayed commit",
    };
  }
  // For a merge, "ours" really is the branch you are on.
  return { ours: "current branch", theirs: "incoming" };
}

function describe(file: ConflictFile, labels: { ours: string; theirs: string }): string {
  switch (file.kind) {
    case "both-modified":
      return "changed on both sides";
    case "both-added":
      return "added on both sides";
    case "both-deleted":
      return "deleted on both sides";
    case "deleted-by-them":
      return `kept on ${labels.ours}, deleted on ${labels.theirs}`;
    case "deleted-by-us":
      return `deleted on ${labels.ours}, kept on ${labels.theirs}`;
    case "added-by-us":
      return `added on ${labels.ours} only`;
    case "added-by-them":
      return `added on ${labels.theirs} only`;
    default:
      return "conflicted";
  }
}

function FileName({ path }: { path: string }) {
  const cut = path.lastIndexOf("/");
  return (
    <span className={s.name} title={path}>
      {cut !== -1 && <span className={s.dir}>{path.substring(0, cut + 1)}</span>}
      <span className={s.base}>{cut === -1 ? path : path.substring(cut + 1)}</span>
    </span>
  );
}

export function ConflictPanel({
  tabId,
  state,
  busy,
  openPath,
  onOpenConflict,
  onChanged,
  onContinue,
  onSkip,
  onAbort,
}: {
  tabId: string;
  state: ConflictState;
  busy: boolean;
  openPath: string | null;
  onOpenConflict: (path: string) => void;
  onChanged: () => void;
  onContinue: () => void;
  onSkip: () => void;
  onAbort: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const labels = sideLabels(state);
  const p = state.progress;
  // A conflicted index with no operation behind it - what a clashing
  // `stash pop` leaves. There is nothing to continue or abort: resolving the
  // files is the whole job.
  const bare = state.operation === "unmerged";

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      setWorking(true);
      setError(null);
      try {
        await fn();
        onChanged();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setWorking(false);
      }
    },
    [onChanged],
  );

  const disabled = busy || working;
  const canContinue = state.conflicted.length === 0;

  return (
    <div className={s.panel}>
      <div className={s.head}>
        <Icon name="warning" size={14} className={s.warn} />
        <span className={s.headText}>
          {bare
            ? "Conflicts to resolve"
            : `${state.operation.charAt(0).toUpperCase()}${state.operation.slice(1)} conflicts detected`}
        </span>
      </div>

      {bare && (
        <div className={s.subject}>
          Your changes were restored onto this branch and clashed with it.
          Resolve the files below; there is no operation to finish.
          {state.stashes > 0 && (
            <div className={s.stashNote}>
              A copy is still held in the stash
              {state.stashes > 1 ? ` (${state.stashes} entries)` : ""} until you drop it.
            </div>
          )}
        </div>
      )}

      {state.operation === "rebase" && p !== null && (
        <div className={s.subject}>
          Rebasing <span className={s.chip}>{p.branch}</span> onto{" "}
          <span className={s.chip}>{(p.ontoName ?? "").length > 0 ? p.ontoName : p.onto}</span>
        </div>
      )}

      {error !== null && <div className={s.error}>{error}</div>}

      <div className={s.section}>
        <span className={s.sectionName}>
          <Icon name="chevronDown" size={11} className={s.caret} />
          Conflicted Files ({state.conflicted.length})
        </span>
        {state.conflicted.length > 0 && (
          <button
            className={s.markAll}
            disabled={disabled}
            title="Stage every conflicted file as it currently stands on disk"
            onClick={() =>
              run(() => api.resolveAll(tabId, state.conflicted.map((f) => f.path)))
            }
          >
            Mark All Resolved
          </button>
        )}
      </div>

      <div className={`${s.list} ${s.listMain}`}>
        {state.conflicted.length === 0 && (
          <div className={s.empty}>
            Everything resolved — continue the {state.operation}.
          </div>
        )}
        {state.conflicted.map((f) => (
          <div
            key={f.path}
            className={`${s.file} ${openPath === f.path ? s.fileActive : ""} ${
              f.deletion ? "" : s.fileClickable
            }`}
            // The whole row opens the editor - a file you have to resolve is
            // not a thing you should have to aim at a small button for.
            onClick={() => !f.deletion && onOpenConflict(f.path)}
            title={f.deletion ? f.path : `${f.path} — click to resolve`}
          >
            <span className={s.row1}>
              <Icon name="warning" size={12} className={s.warnSmall} />
              <FileName path={f.path} />
            </span>
            <span className={s.why}>{describe(f, labels)}</span>
            <span className={s.actions} onClick={(e) => e.stopPropagation()}>
              {/* A delete conflict has no lines to merge - the only answers
                  are keep the file or drop it - so it gets its own buttons. */}
              {f.deletion ? (
                <>
                  <button
                    className={s.act}
                    disabled={disabled}
                    onClick={() =>
                      run(() =>
                        api.resolveSide(tabId, f.path, f.kind === "deleted-by-them" ? "ours" : "theirs"),
                      )
                    }
                  >
                    Keep the file
                  </button>
                  <button
                    className={s.act}
                    disabled={disabled}
                    onClick={() => run(() => api.resolveSide(tabId, f.path, "delete"))}
                  >
                    Delete it
                  </button>
                </>
              ) : (
                <>
                  <button
                    className={s.act}
                    disabled={disabled}
                    title={`Take the version from ${labels.ours}`}
                    onClick={() => run(() => api.resolveSide(tabId, f.path, "ours"))}
                  >
                    Take {labels.ours}
                  </button>
                  <button
                    className={s.act}
                    disabled={disabled}
                    title={`Take the version from ${labels.theirs}`}
                    onClick={() => run(() => api.resolveSide(tabId, f.path, "theirs"))}
                  >
                    Take {labels.theirs}
                  </button>
                </>
              )}
            </span>
          </div>
        ))}
      </div>

      <div className={s.section}>
        <span className={s.sectionName}>
          <Icon name="chevronDown" size={11} className={s.caret} />
          Resolved Files ({state.resolved.length})
        </span>
      </div>
      <div className={s.list}>
        {state.resolved.length === 0 && <div className={s.empty}>Nothing resolved yet</div>}
        {state.resolved.map((f) => (
          <div key={f.path} className={s.resolvedRow}>
            <Icon name="check" size={12} className={s.ok} />
            <FileName path={f.path} />
            <button
              className={s.undo}
              disabled={disabled}
              title="Put this file back into conflict"
              onClick={() => run(() => api.resolveSide(tabId, f.path, "unresolve"))}
            >
              Undo
            </button>
          </div>
        ))}
      </div>

      <div className={s.footer}>
        {p !== null && p.total > 0 && (
          <div className={s.progress}>
            <div className={s.progressText}>
              Rebasing commit {p.current} of {p.total}
            </div>
            <div className={s.progressSubject}>{p.subject}</div>
            <div className={s.progressBar}>
              <div
                className={s.progressFill}
                style={{ width: `${Math.round((p.current / p.total) * 100)}%` }}
              />
            </div>
          </div>
        )}

        {bare ? (
          <div className={s.bareDone}>
            {canContinue
              ? "All resolved — the files are staged and ready to commit."
              : "Resolve the files above to finish."}
          </div>
        ) : (
        <div className={s.buttons}>
          <button
            className={s.continue}
            disabled={disabled || !canContinue}
            title={
              canContinue
                ? `Continue the ${state.operation}`
                : "Resolve the remaining conflicts first"
            }
            onClick={onContinue}
          >
            Continue {state.operation}
          </button>
          {(state.operation === "rebase" ||
            state.operation === "cherry-pick" ||
            state.operation === "revert") && (
            <button
              className={s.skip}
              disabled={disabled}
              title="Skip the commit being applied"
              onClick={onSkip}
            >
              Skip
            </button>
          )}
          <button className={s.abort} disabled={disabled} onClick={onAbort}>
            Abort {state.operation}
          </button>
        </div>
        )}
      </div>
    </div>
  );
}
