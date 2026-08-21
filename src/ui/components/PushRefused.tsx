import { useEffect } from "react";
import type { PushRefusal } from "../types";
import s from "./PushRefused.module.scss";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * What to do about a push the remote would not take.
 *
 * git says "non-fast-forward" and suggests pulling. That advice is right when
 * somebody else has pushed and actively wrong after a rebase, where pulling
 * merges the superseded copies of your own commits back into the branch you
 * just tidied. Since the two situations produce the same message, gitc works
 * out which one this is and says so, rather than leaving a person to guess -
 * and the guess that gets made under time pressure is `--force`, which is the
 * one that destroys somebody's work.
 *
 * Both actions stay available in both cases. The recommendation is a
 * recommendation, not a lock: whoever is here may know something gitc does
 * not.
 */
export function PushRefused({
  refusal,
  onForce,
  onPull,
  onCancel,
}: {
  refusal: PushRefusal;
  onForce: () => void;
  onPull: (mode: "rebase" | "merge" | "ff") => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const rewrite = refusal.kind === "rewrite";
  const behind = refusal.kind === "behind";

  return (
    <div className={s.veil} onClick={onCancel}>
      <div className={s.box} onClick={(e) => e.stopPropagation()}>
        <div className={s.title}>
          {behind
            ? "This branch is behind the remote"
            : rewrite
              ? "This branch was rewritten"
              : "The remote has work you do not"}
        </div>

        <p className={s.body}>
          {behind ? (
            <>
              <code>{refusal.upstream}</code> has {plural(refusal.behind, "commit")} that this
              branch does not, and this branch has nothing of its own to publish. Pulling brings
              you level - there is nothing to reconcile.
            </>
          ) : rewrite ? (
            <>
              <code>{refusal.upstream}</code> still holds the older version of{" "}
              {plural(refusal.behind, "commit")} you have since rebased, amended or squashed.
              Nothing there is missing from this branch.
            </>
          ) : (
            <>
              <code>{refusal.upstream}</code> has {plural(refusal.theirs, "commit")} that this
              branch does not. Pushing over it would delete{" "}
              {refusal.theirs === 1 ? "it" : "them"}.
            </>
          )}
        </p>

        <div className={s.counts}>
          <span>
            <strong>{refusal.ahead}</strong> here, not on the remote
          </span>
          <span className={s.sep}>·</span>
          <span>
            <strong>{refusal.behind}</strong> on the remote, not here
          </span>
        </div>

        {/* Named, not counted. "3 commits would be lost" is a number; a
            person's name next to their commit message is a consequence. Red
            only when forcing would actually destroy them - when this branch is
            merely behind, the same list is just what is about to arrive. */}
        {!rewrite && refusal.theirCommits.length > 0 && (
          <ul className={behind ? s.incoming : s.theirs}>
            {refusal.theirCommits.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
            {refusal.theirs > refusal.theirCommits.length && (
              <li className={s.more}>
                and {refusal.theirs - refusal.theirCommits.length} more
              </li>
            )}
          </ul>
        )}

        <div className={s.actions}>
          {behind ? (
            <button className={s.primary} onClick={() => onPull("ff")}>
              Pull
              <span className={s.hint}>
                git pull --ff-only. Moves this branch up to {refusal.upstream}; nothing here is
                changed or merged.
              </span>
            </button>
          ) : rewrite ? (
            <>
              <button className={s.primary} onClick={onForce}>
                Force push
                <span className={s.hint}>
                  Replaces {refusal.upstream} with this branch. Refused automatically if the
                  remote has moved since gitc last looked.
                </span>
              </button>
              <button className={s.secondary} onClick={() => onPull("merge")}>
                Pull first
                <span className={s.hint}>
                  Brings the superseded commits back and merges them, undoing the tidying. Rarely
                  what you want here.
                </span>
              </button>
            </>
          ) : (
            <>
              <button className={s.primary} onClick={() => onPull("rebase")}>
                Pull, then replay mine on top
                <span className={s.hint}>
                  git pull --rebase. Keeps history linear; may raise conflicts to resolve.
                </span>
              </button>
              <button className={s.secondary} onClick={() => onPull("merge")}>
                Pull and merge
                <span className={s.hint}>
                  git pull --no-rebase. Keeps both histories and adds a merge commit.
                </span>
              </button>
              <button className={s.danger} onClick={onForce}>
                Force push anyway
                <span className={s.hint}>
                  Deletes {plural(refusal.theirs, "commit")} from {refusal.upstream}. Only if you
                  know that work is not wanted.
                </span>
              </button>
            </>
          )}
          <button className={s.cancel} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
