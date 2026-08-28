import { useState } from "react";
import type { RemoteState, Session } from "../types";
import { Icon } from "./Icon";
import { CloseButton } from "./CloseButton";
import s from "./TabBar.module.scss";

/** Green online, orange reaching for it, red not connected. */
function ledOf(remotes: RemoteState[], host: string): "Online" | "Connecting" | "Offline" {
  const found = remotes.find((r) => r.host === host);
  if (found === undefined) return "Offline";
  if (found.state === "online") return "Online";
  if (found.state === "connecting") return "Connecting";
  return "Offline";
}

function ledTitle(host: string, led: string): string {
  if (led === "Online") return host + " - connected";
  if (led === "Connecting") return host + " - connecting";
  return host + " - not connected; opening this tab will reconnect";
}

export function TabBar({
  session,
  remotes,
  onActivate,
  onClose,
  onNew,
  onPreferences,
  onReorder,
}: {
  session: Session;
  /** What each machine a tab lives on is doing, for the dot on its tab. */
  remotes: RemoteState[];
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onPreferences: () => void;
  /** The new left-to-right order after a drag. */
  onReorder: (order: string[]) => void;
}) {
  /** The tab being dragged, and where it would land. */
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);

  const drop = () => {
    if (dragging === null || over === null) {
      setDragging(null);
      setOver(null);
      return;
    }

    const ids = session.tabs.map((t) => t.id).filter((id) => id !== dragging);
    const at = ids.indexOf(over.id);
    if (at === -1) {
      setDragging(null);
      setOver(null);
      return;
    }
    ids.splice(over.after ? at + 1 : at, 0, dragging);

    setDragging(null);
    setOver(null);
    // Only tell the engine when the order actually changed - a drag that ends
    // where it started should not write the session file.
    const current = session.tabs.map((t) => t.id);
    if (ids.join(",") !== current.join(",")) onReorder(ids);
  };

  return (
    <div className={s.bar}>
      {session.tabs.map((t) => (
        <div
          key={t.id}
          className={[
            s.tab,
            t.id === session.activeId ? s.active : "",
            t.id === dragging ? s.dragging : "",
            over?.id === t.id ? (over.after ? s.dropAfter : s.dropBefore) : "",
          ].join(" ")}
          title={t.host === null ? t.path : t.host + ":" + t.path}
          draggable
          onClick={() => onActivate(t.id)}
          onDragStart={(e) => {
            setDragging(t.id);
            e.dataTransfer.effectAllowed = "move";
            // Firefox ignores a drag with no payload; the id is also the most
            // honest thing to carry.
            e.dataTransfer.setData("text/plain", t.id);
          }}
          onDragOver={(e) => {
            if (dragging === null || dragging === t.id) return;
            // Without this the drop is rejected and the tab springs back.
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            // Past the midpoint means "after this tab", which is what makes a
            // drag to the far end land at the far end.
            const box = e.currentTarget.getBoundingClientRect();
            setOver({ id: t.id, after: e.clientX > box.left + box.width / 2 });
          }}
          onDragLeave={() => setOver((cur) => (cur?.id === t.id ? null : cur))}
          onDrop={(e) => {
            e.preventDefault();
            drop();
          }}
          onDragEnd={drop}
        >
          <Icon name="repo" size={13} className={s.ico} />
          {t.host !== null && (
            <span
              className={`${s.led} ${s["led" + ledOf(remotes, t.host)]}`}
              title={ledTitle(t.host, ledOf(remotes, t.host))}
            />
          )}
          <span className={s.name}>{t.name}</span>
          <CloseButton
            className={s.x}
            size={11}
            title="Close repository"
            onClick={(e) => {
              e.stopPropagation();
              onClose(t.id);
            }}
          />
        </div>
      ))}
      <div className={s.add} onClick={onNew} title="Open a repository">
        <Icon name="plus" size={14} />
      </div>
      {/* Pushed to the far end, where the reference keeps it. */}
      <div className={s.spacer} />
      <div className={s.gear} onClick={onPreferences} title="Preferences">
        <Icon name="gear" size={14} />
      </div>
    </div>
  );
}
