import s from "./Loading.module.scss";

/**
 * A repository being read.
 *
 * Deliberately says which one. The case this exists for is switching tabs,
 * where the only question worth answering is "is this the repo I asked for,
 * or the one I left?" - and the old graph sitting there while the new one
 * loads answers it wrongly.
 *
 * An indeterminate bar rather than a percentage: nothing here knows how far
 * along it is, and inventing a number that jumps is worse than a shape that
 * only claims to be working.
 */
export function Loading({ name, error }: { name: string; error: string | null }) {
  return (
    <div className={s.wrap}>
      <div className={s.name}>{name}</div>
      {error === null || error.length === 0 ? (
        <>
          <div className={s.bar}>
            <div className={s.sweep} />
          </div>
          <div className={s.hint}>Reading the repository…</div>
        </>
      ) : (
        // A load that failed is not a load still running, and leaving the bar
        // sweeping under an error would say it is still trying.
        <div className={s.error}>{error}</div>
      )}
    </div>
  );
}
