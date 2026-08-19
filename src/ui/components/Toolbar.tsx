import { Icon } from "./Icon";
import type { IconName } from "./Icon";
import s from "./Toolbar.module.scss";

export function Toolbar({
  repo,
  branch,
  busy,
  onFetch,
  onPull,
  onPush,
  onBranch,
  onStash,
  onPop,
}: {
  repo: string;
  branch: string;
  busy: boolean;
  onFetch: () => void;
  onPull: () => void;
  onPush: () => void;
  onBranch: () => void;
  onStash: () => void;
  onPop: () => void;
}) {
  const actions: { label: string; icon: IconName; run: () => void; hint: string }[] = [
    { label: "Fetch", icon: "fetch", run: onFetch, hint: "Fetch all remotes and prune" },
    { label: "Pull", icon: "pull", run: onPull, hint: "Pull (fast-forward only)" },
    { label: "Push", icon: "push", run: onPush, hint: "Push the current branch" },
    { label: "Branch", icon: "branch", run: onBranch, hint: "Create a branch here" },
    { label: "Stash", icon: "stash", run: onStash, hint: "Stash changes, including untracked" },
    { label: "Pop", icon: "pop", run: onPop, hint: "Pop the latest stash" },
  ];

  return (
    <div className={s.bar}>
      {/* Left and right are equal-weight flex children with the actions fixed
          between them, so the action group sits at the centre of the window
          rather than drifting with the length of the repo name. */}
      <div className={s.side}>
        <div className={s.field}>
          <div className={s.label}>repository</div>
          <div className={s.value} title={repo}>
            {repo}
          </div>
        </div>
        <div className={s.field}>
          <div className={s.label}>branch</div>
          <div className={s.value} title={branch}>
            {branch}
          </div>
        </div>
      </div>

      <div className={s.actions}>
        {actions.map((a) => (
          <button key={a.label} className={s.btn} disabled={busy} title={a.hint} onClick={a.run}>
            <span className={s.btnLabel}>{a.label}</span>
            <Icon name={a.icon} size={17} className={s.btnIcon} />
          </button>
        ))}
      </div>

      <div className={`${s.side} ${s.right}`} />
    </div>
  );
}
