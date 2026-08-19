import type { Pending } from "../types";
import { Icon } from "./Icon";
import s from "./PendingBanner.module.scss";

/**
 * The bar that appears while git is part-way through an operation.
 *
 * A conflicted merge or rebase leaves the repository in a state where almost
 * nothing else will work. Without saying so, the user sees one error message
 * and is then stuck in a state gitc never mentions again - so this stays on
 * screen until the operation is finished or abandoned.
 */
export function PendingBanner({
  pending,
  conflictCount,
  busy,
  onContinue,
  onSkip,
  onAbort,
}: {
  pending: Pending;
  conflictCount: number;
  busy: boolean;
  onContinue: () => void;
  onSkip: () => void;
  onAbort: () => void;
}) {
  if (pending.kind.length === 0) return null;

  const canSkip =
    pending.kind === "rebase" || pending.kind === "cherry-pick" || pending.kind === "revert";

  return (
    <div className={`${s.bar} ${pending.conflicted ? s.conflicted : ""}`}>
      <Icon name={pending.conflicted ? "warning" : "fetch"} size={14} className={s.icon} />
      <span className={s.text}>
        <b>{pending.kind}</b> in progress
        {pending.conflicted && conflictCount > 0 && (
          <>
            {" — "}
            {conflictCount} conflicted file{conflictCount === 1 ? "" : "s"} to resolve
          </>
        )}
      </span>
      <span className={s.spacer} />
      <button
        className={s.action}
        disabled={busy || pending.conflicted}
        onClick={onContinue}
        title={
          pending.conflicted
            ? "Resolve the conflicts and stage them first"
            : "Carry on with the operation"
        }
      >
        Continue
      </button>
      {canSkip && (
        <button className={s.action} disabled={busy} onClick={onSkip} title="Skip this commit">
          Skip
        </button>
      )}
      <button className={s.abort} disabled={busy} onClick={onAbort}>
        Abort
      </button>
    </div>
  );
}
