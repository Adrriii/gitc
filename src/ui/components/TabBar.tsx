import type { Session } from "../types";
import { Icon } from "./Icon";
import s from "./TabBar.module.scss";

export function TabBar({
  session,
  onActivate,
  onClose,
  onNew,
}: {
  session: Session;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <div className={s.bar}>
      {session.tabs.map((t) => (
        <div
          key={t.id}
          className={`${s.tab} ${t.id === session.activeId ? s.active : ""}`}
          title={t.path}
          onClick={() => onActivate(t.id)}
        >
          <Icon name="repo" size={13} className={s.ico} />
          <span className={s.name}>{t.name}</span>
          <span
            className={s.x}
            onClick={(e) => {
              e.stopPropagation();
              onClose(t.id);
            }}
          >
            <Icon name="close" size={11} />
          </span>
        </div>
      ))}
      <div className={s.add} onClick={onNew} title="Open a repository">
        <Icon name="plus" size={14} />
      </div>
    </div>
  );
}
