import { useEffect, useRef, useState } from "react";
import type { RemoteState, Session, Tab, WorktreeChanges } from "../types";
import { api } from "../api";
import { Icon } from "./Icon";
import { CloseButton } from "./CloseButton";
import { ContextMenu } from "./ContextMenu";
import type { MenuItem } from "./ContextMenu";
import { groupTabs } from "../worktrees";
import type { TabGroup } from "../worktrees";
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

/** How often every tab is asked, while the window is focused. */
const CHANGES_MS = 10000;

/**
 * Each tab's uncommitted changes, for the mark beside its name.
 *
 * Kept in here rather than in App so a poll re-renders the strip and nothing
 * else - the same reason useRepoWatch keeps its clock in refs.
 *
 * Local tabs are asked on a timer. A remote tab only while it is in front,
 * and it keeps what it last said when it is not: any request down a tunnel
 * counts as use, so asking on a timer would hold every connection open for
 * good and quietly overrule the hold set in Preferences.
 */
function useTabChanges(tabs: Tab[], activeId: string | null, refreshKey: unknown) {
  const [changes, setChanges] = useState<Map<string, WorktreeChanges>>(new Map());
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeRef = useRef(activeId);
  activeRef.current = activeId;

  const ask = async (id: string) => {
    try {
      const c = await api.changes(id);
      setChanges((cur) => {
        const was = cur.get(id);
        if (was && was.files === c.files && was.added === c.added && was.removed === c.removed) return cur;
        return new Map(cur).set(id, c);
      });
    } catch {
      // A tab whose repository has gone, or a tunnel mid-reconnect. The mark
      // keeps its last answer; the heartbeat reports a dead engine.
    }
  };

  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      if (document.hidden || !document.hasFocus()) return;
      // One at a time: each is two git calls, and twenty tabs at once would
      // be forty processes for a badge.
      for (const t of tabsRef.current) {
        if (stopped) return;
        if (t.host !== null && t.id !== activeRef.current) continue;
        await ask(t.id);
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), CHANGES_MS);
    const onFocus = () => void poll();
    window.addEventListener("focus", onFocus);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  // The tab in front reloads after a commit, a stage or an edit the watch
  // saw. Asked then, so it does not go on claiming changes for ten seconds.
  useEffect(() => {
    if (activeId !== null) void ask(activeId);
  }, [activeId, refreshKey]);

  return changes;
}

/**
 * Each tab's main working tree, which is what puts a worktree's tab under its
 * repository's. Asked once per tab: a checkout does not change repository.
 *
 * shortcut: a remote tab is asked only once it has been in front, for the same
 * reason useTabChanges leaves it alone; until then a remote worktree's tab
 * stands on its own. Have the engine keep it in the session if that matters.
 */
function useMainPaths(tabs: Tab[], activeId: string | null) {
  const [mains, setMains] = useState<Map<string, string>>(new Map());
  const asked = useRef(new Set<string>());

  useEffect(() => {
    for (const t of tabs) {
      if (asked.current.has(t.id)) continue;
      if (t.host !== null && t.id !== activeId) continue;
      asked.current.add(t.id);
      api
        .worktrees(t.id)
        .then((r) => {
          const main = r.worktrees.find((w) => w.main);
          if (main !== undefined) setMains((cur) => new Map(cur).set(t.id, main.path));
        })
        // Asked again on the next change to the strip.
        .catch(() => asked.current.delete(t.id));
    }
  }, [tabs, activeId]);

  return mains;
}

/** 1234 -> 1.2k: a tab is 150px and already truncating its name. */
function compact(n: number): string {
  if (n < 1000) return String(n);
  return n < 10000 ? (n / 1000).toFixed(1) + "k" : Math.round(n / 1000) + "k";
}

function changesTitle(c: WorktreeChanges): string {
  const files = c.files === 1 ? "1 changed file" : c.files + " changed files";
  return files + ", +" + c.added + " −" + c.removed + " lines";
}

export function TabBar({
  session,
  remotes,
  refreshKey,
  onActivate,
  onClose,
  onNew,
  onPreferences,
  onReorder,
  onWorkspaceMenu,
  onTabMenu,
}: {
  session: Session;
  /** What each machine a tab lives on is doing, for the dot on its tab. */
  remotes: RemoteState[];
  /** Changes whenever the active tab reloads, so its mark is asked again. */
  refreshKey: unknown;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onPreferences: () => void;
  /** The new left-to-right order after a drag. */
  onReorder: (order: string[]) => void;
  /** The workspace switcher was clicked; the menu opens at x, y. */
  onWorkspaceMenu: (x: number, y: number) => void;
  /** A tab was right-clicked. */
  onTabMenu: (id: string, x: number, y: number) => void;
}) {
  // Only the current workspace's tabs are on the strip; the rest stay open.
  const tabs = session.tabs.filter((t) => t.workspaces.includes(session.workspace));
  const workspace = session.workspaces.find((w) => w.id === session.workspace);
  /** The tab being dragged, and where it would land. */
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);
  const changes = useTabChanges(tabs, session.activeId, refreshKey);
  const mains = useMainPaths(tabs, session.activeId);
  const groups = groupTabs(tabs, mains);
  /** The worktree each repository's tab last showed, so coming back lands there. */
  const lastShown = useRef(new Map<string, string>());
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  const shownOf = (g: TabGroup): Tab => {
    const active = g.members.find((t) => t.id === session.activeId);
    if (active !== undefined) {
      lastShown.current.set(g.head.id, active.id);
      return active;
    }
    if (g.head.id === session.activeId) {
      lastShown.current.delete(g.head.id);
      return g.head;
    }
    return g.members.find((t) => t.id === lastShown.current.get(g.head.id)) ?? g.head;
  };

  const worktreeMenu = (g: TabGroup, x: number, y: number) => {
    const item = (t: Tab): MenuItem => {
      const c = changes.get(t.id);
      return {
        label: (t.id === session.activeId ? "● " : "") + t.name,
        hint: c === undefined || c.files === 0 ? undefined : changesTitle(c),
        action: () => {
          setMenu(null);
          onActivate(t.id);
        },
      };
    };
    setMenu({ x, y, items: [item(g.head), { separator: true }, ...g.members.map(item)] });
  };

  const drop = () => {
    if (dragging === null || over === null) {
      setDragging(null);
      setOver(null);
      return;
    }

    // Whole groups move: a repository's worktree tabs follow it.
    const heads = groups.filter((g) => g.head.id !== dragging);
    const moving = groups.find((g) => g.head.id === dragging);
    const at = heads.findIndex((g) => g.head.id === over.id);
    if (at === -1 || moving === undefined) {
      setDragging(null);
      setOver(null);
      return;
    }
    heads.splice(over.after ? at + 1 : at, 0, moving);
    const ids = heads.flatMap((g) => [g.head.id, ...g.members.map((t) => t.id)]);

    setDragging(null);
    setOver(null);
    // Only tell the engine when the order actually changed - a drag that ends
    // where it started should not write the session file.
    const current = tabs.map((t) => t.id);
    if (ids.join(",") !== current.join(",")) onReorder(ids);
  };

  return (
    <div className={s.bar}>
      <div
        className={s.workspace}
        title="Switch workspace"
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          onWorkspaceMenu(box.left, box.bottom);
        }}
      >
        <span className={s.name}>{workspace?.name ?? "Workspace"}</span>
        <Icon name="chevronDown" size={11} className={s.ico} />
      </div>
      {groups.map((g) => {
        // The group drags, drops and lights up as one, under its repository's
        // id; what it shows and closes is whichever checkout is in front.
        const t = g.head;
        const shown = shownOf(g);
        const onWorktree = shown.id !== t.id;
        return (
          <div
            key={t.id}
            className={[
              s.tab,
              onWorktree ? s.wide : "",
              shown.id === session.activeId ? s.active : "",
              t.id === dragging ? s.dragging : "",
              over?.id === t.id ? (over.after ? s.dropAfter : s.dropBefore) : "",
            ].join(" ")}
            title={shown.host === null ? shown.path : shown.host + ":" + shown.path}
            draggable
            onClick={() => onActivate(shown.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              onTabMenu(shown.id, e.clientX, e.clientY);
            }}
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
            <Icon name={onWorktree ? "worktree" : "repo"} size={13} className={s.ico} />
            {t.host !== null && (
              <span
                className={`${s.led} ${s["led" + ledOf(remotes, t.host)]}`}
                title={ledTitle(t.host, ledOf(remotes, t.host))}
              />
            )}
            <span className={s.name}>{t.name}</span>
            {/* In full: worktree names are long and alike, the tail is what tells them apart. */}
            {onWorktree && <span className={s.worktree}>/ {shown.name}</span>}
            {g.members.length > 0 && (
              <span
                className={s.more}
                title={`Worktrees open from ${t.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (menu !== null) {
                    setMenu(null);
                    return;
                  }
                  const box = e.currentTarget.getBoundingClientRect();
                  worktreeMenu(g, box.left, box.bottom);
                }}
              >
                {g.members.length}▾
              </span>
            )}
            <Dirty c={changes.get(shown.id)} />
            <CloseButton
              className={s.x}
              size={11}
              title={onWorktree ? "Close worktree" : "Close repository"}
              onClick={(e) => {
                e.stopPropagation();
                onClose(shown.id);
              }}
            />
          </div>
        );
      })}
      <div className={s.add} onClick={onNew} title="Open a repository">
        <Icon name="plus" size={14} />
      </div>
      {/* Pushed to the far end, where the reference keeps it. */}
      <div className={s.spacer} />
      <div className={s.gear} onClick={onPreferences} title="Preferences">
        <Icon name="gear" size={14} />
      </div>
      {menu !== null && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

/**
 * The mark on a tab whose working tree is not clean: lines added and removed,
 * or the file count when nothing has lines to count - untracked or binary
 * files only.
 */
function Dirty({ c }: { c: WorktreeChanges | undefined }) {
  if (c === undefined || c.files === 0) return null;
  return (
    <span className={s.dirty} title={changesTitle(c)}>
      {c.added === 0 && c.removed === 0 ? (
        <span className={s.files}>✎ {compact(c.files)}</span>
      ) : (
        <>
          {c.added > 0 && <span className={s.plus}>+{compact(c.added)}</span>}
          {c.removed > 0 && <span className={s.minus}>−{compact(c.removed)}</span>}
        </>
      )}
    </span>
  );
}
