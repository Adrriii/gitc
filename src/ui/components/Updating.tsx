import type { UpdateProgress } from "../types";
import s from "./Updating.module.scss";

const TITLES: Record<UpdateProgress["phase"], string> = {
  idle: "Updating gitc",
  checking: "Checking for the newest version",
  downloading: "Downloading gitc",
  verifying: "Verifying the download",
  installing: "Installing",
  restarting: "Restarting",
  failed: "The update did not finish",
};

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/**
 * What the update is doing, while it does it.
 *
 * Without this the window sat unchanged for as long as the download took and
 * then closed, which is what a crash looks like. The download is the only
 * phase that takes real time, and it is the one with a real measurement
 * behind it; the others go past too quickly to read and are there so the bar
 * never appears stuck.
 */
export function Updating({
  progress,
  onDismiss,
}: {
  progress: UpdateProgress | null;
  onDismiss: () => void;
}) {
  const phase = progress?.phase ?? "idle";
  const received = progress?.received ?? 0;
  const total = progress?.total ?? 0;
  const failed = phase === "failed";

  // A percentage only where one is known: the server does not always declare
  // a length, and a bar that invents one is worse than a bar that admits it
  // is only telling you something is happening.
  const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null;
  const determinate = phase === "downloading" && percent !== null;

  return (
    <div className={s.veil}>
      <div className={s.box}>
        <div className={s.title}>{TITLES[phase]}</div>
        <div className={s.message}>
          {failed
            ? "Nothing was changed - the version you have is still installed."
            : (progress?.message ?? "Starting")}
        </div>

        {!failed && (
          <>
            <div className={s.track}>
              {determinate ? (
                <div className={s.fill} style={{ width: `${percent}%` }} />
              ) : (
                <div className={s.sliding} />
              )}
            </div>
            <div className={s.figures}>
              <span>{determinate ? `${mb(received)} of ${mb(total)}` : ""}</span>
              <span>{determinate ? `${percent}%` : ""}</span>
            </div>
          </>
        )}

        {failed && (
          <>
            <div className={s.failed}>{progress?.message}</div>
            <button className={s.dismiss} onClick={onDismiss}>
              Close
            </button>
          </>
        )}

        {phase === "restarting" && (
          <div className={s.figures}>
            <span>This window closes and a new one opens.</span>
          </div>
        )}
      </div>
    </div>
  );
}
