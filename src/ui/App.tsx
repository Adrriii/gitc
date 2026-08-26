import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ConflictState,
  GraphPayload,
  OpArgs,
  Ref,
  Session,
  Submodule,
  PushRefusal,
  UpdateInfo,
  UpdateProgress,
} from "./types";
import { api } from "./api";
import { VERSION } from "../generated/version";
import { TabBar } from "./components/TabBar";
import { Toolbar } from "./components/Toolbar";
import { Sidebar } from "./components/Sidebar";
import { Graph } from "./components/Graph";
import { DiffView } from "./components/DiffView";
import type { DiffTarget } from "./components/DiffView";
import { Panel } from "./components/Panel";
import { Welcome } from "./components/Welcome";
import { Preferences } from "./components/Preferences";
import { GitLog } from "./components/GitLog";
import { Freshness } from "./components/Freshness";
import { Updating } from "./components/Updating";
import { Toasts } from "./components/Toasts";
import { PushRefused } from "./components/PushRefused";
import { ContextMenu } from "./components/ContextMenu";
import type { MenuItem } from "./components/ContextMenu";
import { PendingBanner } from "./components/PendingBanner";
import { ConflictPanel } from "./components/ConflictPanel";
import { MergeEditor } from "./components/MergeEditor";
import { Prompt } from "./components/Prompt";
import { Confirm } from "./components/Confirm";
import { Choose } from "./components/Choose";
import { Form } from "./components/Form";
import type { Field } from "./components/Form";
import { useHeartbeat } from "./useHeartbeat";
import { useRepoWatch } from "./useRepoWatch";
import { useDragWidth } from "./useDragWidth";
import { useTheme } from "./theme";
import { useGitLog } from "./useGitLog";
import { useToasts } from "./useToasts";
import { commandType, useFetchInterval, useHiddenCommands, useUpdateCheck } from "./settings";
import { rangeSelect, toggleSelect } from "./selection";
import { nextAfter, stagedFiles, unstagedFiles } from "./staging";
import s from "./App.module.scss";

interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

interface PromptState {
  title: string;
  label: string;
  placeholder?: string;
  initial?: string;
  confirmLabel: string;
  validate?: (v: string) => string | null;
  onConfirm: (v: string) => void;
}

interface ChooseState {
  title: string;
  body?: string;
  options: { value: string; label: string; hint?: string }[];
  onPick: (value: string) => void;
}

interface FormState {
  title: string;
  body?: string;
  fields: Field[];
  confirmLabel: string;
  onConfirm: (values: Record<string, string>) => void;
}

interface ConfirmState {
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
}

/**
 * Enough of git's ref-name rules to catch a typo before git does.
 *
 * Not a full implementation of check-ref-format - just the mistakes someone
 * actually makes while typing a branch name into a box.
 */
function validateRefName(value: string): string | null {
  const v = value.trim();
  if (v.length === 0) return null;
  if (v.startsWith("-") || v.startsWith("/") || v.endsWith("/")) return "Cannot start with - or /";
  if (v.endsWith(".lock")) return "Cannot end with .lock";
  if (v.includes("..") || v.includes("//")) return "Cannot contain .. or //";
  if (/[\s~^:?*[\\]/.test(v)) return "Cannot contain spaces or ~ ^ : ? * [ \\";
  return null;
}

/**
 * Remote names live in the same namespace as ref path components, so they
 * follow the same rules - plus one of their own: a slash would make
 * `origin/main` ambiguous between the remote and a branch inside it.
 */
function validateRemoteName(value: string): string | null {
  const v = value.trim();
  if (v.length === 0) return null;
  if (v.includes("/")) return "A remote name cannot contain /";
  return validateRefName(v);
}

/** Rejects only what is certainly not a URL - git accepts a great deal. */
function validateRemoteUrl(value: string): string | null {
  const v = value.trim();
  if (v.length === 0) return null;
  if (/\s/.test(v)) return "A URL cannot contain spaces";
  return null;
}

export function App() {
  const dead = useHeartbeat();
  const [session, setSession] = useState<Session | null>(null);
  const [data, setData] = useState<GraphPayload | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<{
    path: string;
    target: DiffTarget;
    label: string;
  } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [choose, setChoose] = useState<ChooseState | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [error, setErrorState] = useState<string | null>(null);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updating, setUpdating] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null);
  /** Set when a push came back refused, and the user has to decide what to do. */
  const [pushRefusal, setPushRefusal] = useState<PushRefusal | null>(null);
  const { colors: themeColors } = useTheme();
  const { calls: gitCalls, clear: clearGitLog } = useGitLog();
  const { hidden: hiddenCommands, hide: hideCommand } = useHiddenCommands();
  const [logOpen, setLogOpen] = useState(false);
  const { minutes: fetchMinutes } = useFetchInterval();
  const { minutes: updateMinutes } = useUpdateCheck();
  // Both side panels are dragged rather than fixed. The handles are on the
  // inner edge of each, so the sidebar grows rightward and the panel leftward.
  const [sidebarW, dragSidebar] = useDragWidth("gitc.sidebarWidth", 208, 150, 480);
  const [panelW, dragPanel] = useDragWidth("gitc.panelWidth", 400, 260, 900, "left");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [conflicts, setConflicts] = useState<ConflictState | null>(null);
  /** The conflicted file open in the merge editor, if any. */
  const [mergeFile, setMergeFile] = useState<string | null>(null);

  const { toasts, push: pushToast, dismiss: dismissToast, hold: holdToast } = useToasts();

  /**
   * Reporting what happened.
   *
   * Both of these used to write a line into the status bar, which was too
   * quiet to notice and too narrow to read. They keep their names and their
   * call sites; what changed is where the message ends up. `error` is still
   * kept as state because the welcome screen shows it in place.
   */
  const setError = useCallback(
    (message: string | null) => {
      setErrorState(message);
      if (message !== null && message.length > 0) pushToast("error", message);
    },
    [pushToast],
  );

  const setNotice = useCallback((message: string) => pushToast("ok", message), [pushToast]);

  /** Something that stopped part-way and wants attention, but is not a failure. */
  const setWarning = useCallback((message: string) => pushToast("warn", message), [pushToast]);

  const refresh = useCallback(() => setReloadToken((n) => n + 1), []);

  // Lane colours come from the engine, but the theme is what decides them -
  // substituted here so the graph itself stays unaware that themes exist.
  const graphData = useMemo(() => {
    if (data === null) return null;
    const lanes: string[] = [];
    for (let i = 0; i < 9; i++) lanes.push(themeColors["lane-" + String(i)]);
    // One past the lanes, matching STASH_COLOR in the engine. Stashes are not
    // branches and do not take a lane colour, so the theme gives them their
    // own rather than spending one of the nine.
    lanes.push(themeColors["stash"]);
    return { ...data, colors: lanes };
  }, [data, themeColors]);

  useEffect(() => {
    api.session().then(setSession).catch((e: Error) => setError(e.message));
  }, []);

  /**
   * Asks whether a newer gitc exists.
   *
   * An automatic check is quiet: offline, or no releases yet, is not something
   * to interrupt anyone about, and it leaves whatever was known before in
   * place. A check someone asked for reports what happened, including the
   * failure, because they are waiting for an answer.
   */
  const checkUpdate = useCallback((manual: boolean) => {
    if (manual) setCheckingUpdate(true);
    api
      .checkUpdate()
      .then(setUpdate)
      .catch((e: Error) => {
        if (manual) {
          setUpdate({ current: VERSION, latest: "", available: false, page: "", error: e.message });
        }
      })
      .finally(() => {
        if (manual) setCheckingUpdate(false);
      });
  }, []);

  /**
   * Follows the update while it runs.
   *
   * The engine keeps answering during the download - that is the whole reason
   * it is fetched asynchronously there - so this is a plain poll. It stops on
   * its own when the update finishes, one way or the other.
   */
  useEffect(() => {
    if (!updating) return;
    let stopped = false;

    const id = window.setInterval(() => {
      api
        .updateProgress()
        .then((p) => {
          if (!stopped) setUpdateProgress(p);
        })
        .catch(() => {
          // The engine going away mid-update is the restart happening, and
          // the window is about to close with it.
        });
    }, 300);

    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [updating]);

  /**
   * As often as the preference says: never, at launch, or on an interval.
   *
   * Launch-only by default. An instance left open for a week will not notice
   * a release on its own under that setting, which is a fair trade for asking
   * once per run - and anyone who would rather hear sooner can pick an
   * interval, which checks at launch as well.
   */
  useEffect(() => {
    if (updateMinutes < 0) return;
    checkUpdate(false);
    if (updateMinutes === 0) return;

    const id = window.setInterval(() => checkUpdate(false), updateMinutes * 60 * 1000);
    return () => window.clearInterval(id);
  }, [checkUpdate, updateMinutes]);

  /** Installs the update and lets gitc restart itself. */
  const runUpdate = useCallback(() => {
    if (update === null || !update.available) return;
    setConfirm({
      title: `Update to gitc ${update.latest}?`,
      body: (
        <p>
          gitc will download {update.latest}, replace itself and restart. This window closes and a
          new one opens - nothing else is affected, and your repositories are untouched.
        </p>
      ),
      confirmLabel: `Update to ${update.latest}`,
      onConfirm: () => {
        setConfirm(null);
        setUpdating(true);
        setUpdateProgress({
          phase: "checking",
          received: 0,
          total: 0,
          message: "Starting the update",
        });
        api
          .applyUpdate()
          .then((r) => {
            if (r.ok) setNotice(r.message);
            else {
              // The overlay reports the failure itself and stays until it is
              // dismissed, so the update is not another message that vanishes
              // after four seconds.
              setUpdateProgress({
                phase: "failed",
                received: 0,
                total: 0,
                message: r.message,
              });
              setUpdating(false);
            }
          })
          .catch((e: Error) => {
            setUpdateProgress({ phase: "failed", received: 0, total: 0, message: e.message });
            setUpdating(false);
          });
      },
    });
  }, [update]);

  const activeId = session?.activeId ?? null;
  const activeTab = session?.tabs.find((t) => t.id === activeId) ?? null;

  useEffect(() => {
    if (!activeId) {
      setData(null);
      return;
    }
    let live = true;
    setLoading(true);
    api
      .graph(activeId)
      .then((d) => {
        if (!live) return;
        setData(d);
        // Keep the selection across a refresh where it still exists, so an
        // operation doesn't throw you back to the top of the graph.
        setSelected((prev) => {
          const stillValid = prev.filter((h) => h === "WIP" || d.commits.some((c) => c.hash === h));
          if (prev.includes("WIP") && d.status.length > 0) return ["WIP"];
          if (stillValid.length > 0) return stillValid;
          return d.status.length > 0 ? ["WIP"] : d.commits[0] ? [d.commits[0].hash] : [];
        });
        setError(null);
      })
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [activeId, reloadToken]);

  // Conflict detail is only fetched while something is actually pending, so
  // the common case costs nothing.
  const pendingKind = data?.pending.kind ?? "";
  useEffect(() => {
    if (!activeId || pendingKind.length === 0) {
      setConflicts(null);
      return;
    }
    let live = true;
    api
      .conflicts(activeId)
      .then((c) => live && setConflicts(c))
      .catch(() => live && setConflicts(null));
    return () => {
      live = false;
    };
  }, [activeId, pendingKind, reloadToken]);

  // The log with the hidden command types taken out. The ticker reads from
  // this too - hiding `status` is only worth doing if the poll stops being
  // the thing the status bar is always showing.
  const visibleGitCalls = useMemo(
    () =>
      hiddenCommands.length === 0
        ? gitCalls
        : gitCalls.filter((c) => !hiddenCommands.includes(commandType(c.args))),
    [gitCalls, hiddenCommands],
  );

  // Pick up changes made outside gitc - an editor, a terminal, a build. It
  // also reports how current each half of the view is, for the status bar.
  const freshness = useRepoWatch(activeId, refresh);

  /**
   * Keeps the active repository's remote data from going stale.
   *
   * Quiet by design: no spinner, no notice, and a failure - offline, no remote,
   * credentials wanted - is swallowed. An automatic action nobody asked for
   * should not be able to interrupt someone with an error, and the ticker
   * shows the command anyway for anyone who wants to see it happen.
   *
   * This is a *deadline*, not a metronome, and the difference is the whole
   * point. The first version was a `setInterval(fetchMinutes)` that skipped
   * its turn whenever the window was unfocused - so a window left in the
   * background all day never fetched once, and every skipped turn cost a
   * further full interval. With the setting on "1 minute" the remote could
   * still read dozens of hours old, which is what it did.
   *
   * So the timer is short and cheap - it compares two numbers - and the
   * decision is made from how old the remote data actually is. FETCH_HEAD's
   * mtime is the source (`freshness.fetched`), which means a fetch run in a
   * terminal counts too. Regaining focus checks immediately rather than
   * waiting out a tick, because that is exactly the moment somebody is about
   * to look.
   */
  const fetchedRef = freshness.fetched;
  const checkedRef = freshness.checked;
  useEffect(() => {
    if (activeId === null || fetchMinutes === 0) return;
    let stopped = false;
    // Guards the two ways this could pile up: a fetch slower than the poll,
    // and a remote that is refusing us - a failure leaves FETCH_HEAD alone,
    // so without remembering the attempt we would retry every few seconds
    // forever.
    let inFlight = false;
    let attempted = 0;

    const due = fetchMinutes * 60 * 1000;

    const check = async () => {
      if (stopped || inFlight || !document.hasFocus() || document.hidden) return;
      // No successful poll yet: `fetched` is still 0 because nobody has
      // asked, not because the repository has never fetched.
      if (checkedRef.current === 0) return;
      const now = Date.now();
      if (now - attempted < due) return;
      if (fetchedRef.current !== 0 && now - fetchedRef.current < due) return;

      inFlight = true;
      attempted = now;
      try {
        await api.op(activeId, { op: "fetch" });
        if (!stopped) refresh();
      } catch {
        // Left alone on purpose - see above.
      } finally {
        inFlight = false;
      }
    };

    // Short enough that "1 minute" means roughly a minute, cheap enough that
    // it does not matter: everything past the guards above is arithmetic.
    const id = window.setInterval(() => void check(), 5000);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    void check();

    return () => {
      stopped = true;
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [activeId, fetchMinutes, refresh, fetchedRef, checkedRef]);

  /** Runs a repository operation and folds the outcome back into the UI. */
  const runOp = useCallback(
    async (args: OpArgs) => {
      if (!activeTab) return;
      setBusy(true);
      setError(null);
      setMenu(null);
      try {
        const r = await api.op(activeTab.id, args);
        // A refused push is not an error either: it is a question, and the
        // whole point is that git's own message does not answer it.
        if (r.refusal.kind !== "none") {
          setPushRefusal(r.refusal);
          return;
        }
        // A conflict comes back ok:false with a next step rather than as an
        // error; the banner takes over from there, and amber says "your turn"
        // where red would say "something broke".
        if (!r.ok) {
          if (r.pending.length > 0) setWarning(r.note);
          else setError(r.note);
        } else if (r.note.length > 0) {
          // Succeeded-with-a-caveat: green would read as "your branch is up to
          // date" for the case that says precisely the opposite.
          if (r.warn) setWarning(r.note);
          else setNotice(r.note);
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
        refresh();
      }
    },
    [activeTab, refresh],
  );

  const open = useCallback(async (path: string) => {
    try {
      const r = await api.open(path);
      setSession(r.session);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const onSelect = useCallback(
    (hash: string, additive: boolean, range: boolean) => {
      if (!data) return;
      if (hash === "WIP") {
        setSelected(["WIP"]);
        setAnchor(null);
        return;
      }
      setSelected((prev) => {
        if (prev.includes("WIP")) {
          setAnchor(hash);
          return [hash];
        }
        if (range) {
          const from = anchor ?? (prev.length > 0 ? prev[0] : null);
          if (from !== null) return rangeSelect(data.commits, from, hash);
        }
        setAnchor(hash);
        return additive ? toggleSelect(data.commits, prev, hash) : [hash];
      });
    },
    [data, anchor],
  );

  /**
   * The list a file was opened from is the list the view follows.
   *
   * Staging a file - or its last remaining hunk - takes it out of Unstaged,
   * and staying on it leaves a diff of nothing on screen while the next piece
   * of work sits a click away. So when the file being viewed leaves its list,
   * whatever now holds its place is opened instead, and when the list empties
   * the view closes.
   *
   * Driven by the lists rather than by which button was pressed, so staging a
   * whole file, staging its last hunk and unstaging all behave the same way.
   */
  const viewedList = useRef<string[]>([]);

  useEffect(() => {
    if (data === null || openFile === null || openFile.target.kind !== "wip") {
      viewedList.current = [];
      return;
    }

    const staged = openFile.target.staged;
    const files = staged ? stagedFiles(data.status) : unstagedFiles(data.status);
    const paths = files.map((f) => f.path);

    if (paths.includes(openFile.path)) {
      viewedList.current = paths;
      return;
    }

    const next = nextAfter(viewedList.current, paths, openFile.path);
    viewedList.current = paths;
    if (next === null) {
      setOpenFile(null);
      return;
    }
    const file = files.find((f) => f.path === next);
    setOpenFile({
      path: next,
      target: { kind: "wip", staged, untracked: file !== undefined && file.untracked },
      label: staged ? "staged changes" : "the working tree",
    });
  }, [data, openFile]);

  const onOpenFile = useCallback(
    (path: string, staged: boolean, untracked: boolean) => {
      if (!data) return;
      let target: DiffTarget;
      let label: string;
      if (selected.includes("WIP")) {
        target = { kind: "wip", staged, untracked };
        label = staged ? "staged changes" : "the working tree";
      } else if (selected.length > 1) {
        const chosen = data.commits.filter((c) => selected.includes(c.hash));
        target = { kind: "range", from: chosen[chosen.length - 1].hash, to: chosen[0].hash };
        label = `${chosen.length} commits`;
      } else if (selected.length === 1) {
        target = { kind: "commit", sha: selected[0] };
        label = `commit ${selected[0].substring(0, 7)}`;
      } else {
        return;
      }
      setOpenFile({ path, target, label });
    },
    [data, selected],
  );

  useEffect(() => {
    if (openFile === null && mergeFile === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // The merge editor holds unsaved work, so it closes first and alone.
      if (mergeFile !== null) setMergeFile(null);
      else setOpenFile(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openFile, mergeFile]);

  useEffect(() => {
    setOpenFile(null);
  }, [selected.join(",")]);

  // Once the operation finishes there is nothing left to merge.
  useEffect(() => {
    if (pendingKind.length === 0) setMergeFile(null);
  }, [pendingKind]);

  const branch = data?.head.branch ?? null;

  // --- context menus --------------------------------------------------------

  const commitMenu = useCallback(
    (hash: string, x: number, y: number): void => {
      // Right-clicking outside the selection moves to that commit; inside it
      // keeps the run, so the menu can act on all of it.
      setSelected((prev) => {
        if (prev.includes(hash)) return prev;
        setAnchor(hash);
        return [hash];
      });

      const chosen = selected.includes(hash) ? selected.filter((h) => h !== "WIP") : [hash];
      const many = chosen.length > 1;
      const short = hash.substring(0, 7);
      const on = branch ?? "HEAD";

      setMenu({
        x,
        y,
        items: [
          {
            label: "Checkout this commit",
            action: () =>
              setConfirm({
                title: "Check out this commit?",
                body: (
                  <p>
                    This detaches HEAD at <b>{short}</b>. Commits made while detached belong to no
                    branch, so create one before moving away if you want to keep them.
                  </p>
                ),
                confirmLabel: "Checkout",
                onConfirm: () => {
                  setConfirm(null);
                  void runOp({ op: "checkoutCommit", shas: [hash] });
                },
              }),
          },
          { separator: true },
          {
            label: "Create branch here",
            action: () =>
              setPrompt({
                title: "Create branch",
                label: `Branch at ${short}`,
                placeholder: "feature/my-work",
                confirmLabel: "Create & checkout",
                validate: validateRefName,
                onConfirm: (name) => {
                  setPrompt(null);
                  void runOp({ op: "createBranch", name, shas: [hash], checkout: true });
                },
              }),
          },
          ...(many
            ? [
                {
                  label: `Squash ${chosen.length} commits into one`,
                  hint: "keeps the oldest commit's place in history",
                  action: () => {
                    // Prefilled with every message in the run, oldest first,
                    // so nothing is silently thrown away - editing it down is
                    // easier than remembering what was in the others.
                    const runs = data?.commits.filter((c) => chosen.includes(c.hash)) ?? [];
                    const initial = [...runs]
                      .reverse()
                      .map((c) => c.subject)
                      .join("\n");
                    setForm({
                      title: `Squash ${chosen.length} commits`,
                      body:
                        "They are replaced by a single commit in the oldest one's place. " +
                        "This rewrites history, so avoid it on commits you have pushed.",
                      fields: [
                        {
                          key: "message",
                          label: "Message for the squashed commit",
                          initial,
                        },
                      ],
                      confirmLabel: "Squash",
                      onConfirm: (v) => {
                        setForm(null);
                        void runOp({ op: "squash", shas: chosen, message: v.message });
                      },
                    });
                  },
                },
                { separator: true },
              ]
            : []),
          {
            label: many ? `Cherry pick ${chosen.length} commits` : "Cherry pick commit",
            action: () => void runOp({ op: "cherryPick", shas: chosen }),
          },
          {
            label: `Rebase ${on} onto this commit`,
            action: () =>
              setConfirm({
                title: `Rebase ${on} onto ${short}?`,
                body: (
                  <p>
                    This rewrites the commits on <b>{on}</b>. If they have already been pushed,
                    anyone else who has them will have to reconcile.
                  </p>
                ),
                confirmLabel: "Rebase",
                onConfirm: () => {
                  setConfirm(null);
                  void runOp({ op: "rebaseOnto", ref: hash });
                },
              }),
          },
          {
            label: many ? `Revert ${chosen.length} commits` : "Revert commit",
            action: () => void runOp({ op: "revert", shas: chosen }),
          },
          { separator: true },
          {
            label: `Reset ${on} here, keep changes`,
            action: () => void runOp({ op: "reset", shas: [hash], mode: "mixed" }),
          },
          {
            label: `Reset ${on} here, discard changes`,
            action: () =>
              setConfirm({
                title: "Discard everything after this commit?",
                body: (
                  <p>
                    <b>{on}</b> moves to <b>{short}</b> and the working tree is reset to match.
                    Uncommitted changes, and any commits after it, are lost.
                  </p>
                ),
                confirmLabel: "Reset hard",
                destructive: true,
                onConfirm: () => {
                  setConfirm(null);
                  void runOp({ op: "reset", shas: [hash], mode: "hard" });
                },
              }),
          },
          { separator: true },
          {
            label: "Create tag here",
            action: () =>
              setPrompt({
                title: "Create tag",
                label: `Tag at ${short}`,
                placeholder: "v1.0.0",
                confirmLabel: "Create tag",
                validate: validateRefName,
                onConfirm: (name) => {
                  setPrompt(null);
                  void runOp({ op: "createTag", name, shas: [hash] });
                },
              }),
          },
          {
            label: "Copy commit sha",
            action: () => {
              void navigator.clipboard.writeText(hash);
              setNotice("copied " + short);
              setMenu(null);
            },
          },
        ],
      });
    },
    [selected, branch, runOp],
  );

  /**
   * Hides or shows refs in the graph.
   *
   * The UI owns the set and posts the whole thing, rather than sending a
   * delta: a folder toggle touches a dozen refs at once, and reconciling a
   * dozen deltas against a set the engine also edits is a race for no gain.
   * The engine answers with the rebuilt graph, so one round trip covers it.
   */
  const setHidden = useCallback(
    async (refs: string[], hide: boolean) => {
      if (!activeTab || refs.length === 0) return;
      const next = new Set(data?.hidden ?? []);
      for (const r of refs) {
        if (hide) next.add(r);
        else next.delete(r);
      }
      setMenu(null);
      try {
        setData(await api.setHidden(activeTab.id, [...next]));
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [activeTab, data?.hidden],
  );

  /** The menu on a branch folder, which is a display device git knows nothing about. */
  const folderMenu = useCallback(
    (label: string, refs: string[], x: number, y: number) => {
      const hiddenSet = new Set(data?.hidden ?? []);
      const allHidden = refs.length > 0 && refs.every((r) => hiddenSet.has(r));
      const count = refs.length;
      setMenu({
        x,
        y,
        items: [
          {
            label: allHidden ? `Show ${label} in the graph` : `Hide ${label} in the graph`,
            hint: count === 1 ? "1 branch" : `${count} branches`,
            action: () => void setHidden(refs, !allHidden),
          },
        ],
      });
    },
    [data?.hidden, setHidden],
  );

  const refMenu = useCallback(
    (ref: Ref, x: number, y: number): void => {
      const isCurrent = ref.kind === "local" && ref.short === branch;
      const hiddenNow = (data?.hidden ?? []).includes(ref.short);
      const items: MenuItem[] = [];

      if (ref.kind === "tag") {
        items.push({
          label: `Checkout ${ref.short}`,
          action: () => void runOp({ op: "checkout", ref: ref.short }),
        });
        items.push({ separator: true });
        items.push({
          label: `Delete tag ${ref.short}`,
          action: () =>
            setConfirm({
              title: "Delete tag?",
              body: (
                <p>
                  Tag <b>{ref.short}</b> will be deleted locally.
                </p>
              ),
              confirmLabel: "Delete",
              destructive: true,
              onConfirm: () => {
                setConfirm(null);
                void runOp({ op: "deleteTag", ref: ref.short });
              },
            }),
        });
      } else {
        if (!isCurrent) {
          items.push({
            label: `Checkout ${ref.short}`,
            action: () => void runOp({ op: "checkout", ref: ref.short }),
          });
          items.push({
            label: `Merge ${ref.short} into ${branch ?? "HEAD"}`,
            action: () => void runOp({ op: "merge", ref: ref.short }),
          });
          items.push({
            label: `Fast-forward to ${ref.short}`,
            action: () => void runOp({ op: "fastForward", ref: ref.short }),
          });
          items.push({
            label: `Rebase ${branch ?? "HEAD"} onto ${ref.short}`,
            action: () => void runOp({ op: "rebaseOnto", ref: ref.short }),
          });
        }
        items.push({ separator: true });
        items.push({
          label: "Create branch here",
          action: () =>
            setPrompt({
              title: "Create branch",
              label: `Branch from ${ref.short}`,
              confirmLabel: "Create & checkout",
              validate: validateRefName,
              onConfirm: (name) => {
                setPrompt(null);
                void runOp({ op: "createBranch", name, ref: ref.short, checkout: true });
              },
            }),
        });

        if (ref.kind === "local") {
          items.push({
            label: "Rename branch",
            action: () =>
              setPrompt({
                title: "Rename branch",
                label: "New name",
                initial: ref.short,
                confirmLabel: "Rename",
                validate: validateRefName,
                onConfirm: (name) => {
                  setPrompt(null);
                  void runOp({ op: "renameBranch", ref: ref.short, name });
                },
              }),
          });
          items.push({
            // A branch cannot be deleted while it is checked out; saying so is
            // better than offering an action that always fails.
            label: isCurrent ? "Delete (checked out)" : `Delete ${ref.short}`,
            action: isCurrent
              ? undefined
              : () =>
                  setConfirm({
                    title: "Delete branch?",
                    body: (
                      <p>
                        <b>{ref.short}</b> will be deleted. If it holds commits that exist nowhere
                        else, git refuses — and gitc reports that rather than forcing it.
                      </p>
                    ),
                    confirmLabel: "Delete",
                    destructive: true,
                    onConfirm: () => {
                      setConfirm(null);
                      void runOp({ op: "deleteBranch", ref: ref.short });
                    },
                  }),
          });
        }

        if (ref.kind === "remote" && ref.remote !== null) {
          const remote = ref.remote;
          const bare = ref.short.substring(remote.length + 1);
          items.push({
            label: `Delete ${bare} on ${remote}`,
            action: () =>
              setConfirm({
                title: "Delete remote branch?",
                body: (
                  <p>
                    <b>{bare}</b> will be deleted on <b>{remote}</b>. This affects everyone using
                    that remote, not just you.
                  </p>
                ),
                confirmLabel: "Delete on remote",
                destructive: true,
                onConfirm: () => {
                  setConfirm(null);
                  void runOp({ op: "deleteRemoteBranch", ref: bare, remote });
                },
              }),
          });
        }

        items.push({ separator: true });
        items.push({
          label: hiddenNow
            ? `Show ${ref.short} in the graph`
            : `Hide ${ref.short} in the graph`,
          action: () => void setHidden([ref.short], !hiddenNow),
        });
        items.push({ separator: true });
        items.push({
          label: "Copy branch name",
          action: () => {
            void navigator.clipboard.writeText(ref.short);
            setNotice("copied " + ref.short);
            setMenu(null);
          },
        });
      }

      setMenu({ x, y, items });
    },
    [branch, data?.hidden, runOp, setHidden],
  );

  /**
   * Opens a submodule as its own tab.
   *
   * A tab rather than replacing the current repository: a submodule is a
   * separate repository with its own history, and the reason to open one is
   * almost always to compare it with the superproject you came from.
   */
  const openSubmodule = useCallback(
    async (sub: Submodule) => {
      if (sub.state === "uninitialized") {
        setError(sub.path + " is not checked out yet - update it first");
        return;
      }
      await open(sub.absolute);
    },
    [open],
  );

  const submoduleMenu = useCallback(
    (sub: Submodule, x: number, y: number) => {
      const items: MenuItem[] = [];

      if (sub.state === "uninitialized") {
        items.push({
          label: `Clone and check out ${sub.path}`,
          hint: "runs submodule update --init",
          action: () => void runOp({ op: "submoduleUpdate", path: sub.path }),
        });
      } else {
        items.push({
          label: `Open ${sub.path}`,
          action: () => void openSubmodule(sub),
        });
        items.push({ separator: true });
        items.push({
          label: "Update to the recorded commit",
          hint:
            sub.state === "moved"
              ? "this submodule has moved away from it"
              : "already there",
          action: () => void runOp({ op: "submoduleUpdate", path: sub.path }),
        });
        items.push({
          label: "Update to the latest remote commit",
          hint: "leaves a pointer change to commit here",
          action: () => void runOp({ op: "submoduleUpdateRemote", path: sub.path }),
        });
      }

      items.push({ separator: true });
      items.push({
        label: "Copy path",
        action: () => {
          void navigator.clipboard.writeText(sub.absolute);
          setNotice("copied " + sub.absolute);
          setMenu(null);
        },
      });
      if (sub.url.length > 0) {
        items.push({
          label: "Copy URL",
          action: () => {
            void navigator.clipboard.writeText(sub.url);
            setNotice("copied " + sub.url);
            setMenu(null);
          },
        });
      }

      setMenu({ x, y, items });
    },
    [openSubmodule, runOp],
  );

  const addRemote = useCallback(() => {
    setForm({
      title: "Add remote",
      body: "The remote is fetched as soon as it is added, so its branches appear right away.",
      fields: [
        {
          key: "name",
          label: "Name",
          placeholder: "origin",
          initial: "origin",
          validate: validateRemoteName,
        },
        {
          key: "url",
          label: "URL",
          placeholder: "https://github.com/you/repo.git",
          validate: validateRemoteUrl,
        },
      ],
      confirmLabel: "Add remote",
      onConfirm: (v) => {
        setForm(null);
        void runOp({ op: "addRemote", name: v.name, message: v.url });
      },
    });
  }, [runOp]);

  /**
   * The menu on a remote's own row.
   *
   * Modelled on the reference's, minus the two things gitc does not do: pull
   * requests are out of scope, and hide/solo belong to graph filtering, which
   * does not exist yet. Prune is split out because the reference folds it into
   * fetch, and it is occasionally wanted on its own.
   */
  const remoteMenu = useCallback(
    (remote: string, refs: string[], x: number, y: number) => {
      const detail = (data?.remoteDetail ?? []).find((r) => r.name === remote);
      const url = detail?.url ?? "";
      const hiddenSet = new Set(data?.hidden ?? []);
      const allHidden = refs.length > 0 && refs.every((r) => hiddenSet.has(r));

      const items: MenuItem[] = [
        { label: `Fetch ${remote}`, action: () => void runOp({ op: "fetchRemote", ref: remote }) },
        {
          label: `Prune ${remote}`,
          hint: "drop branches deleted on the remote",
          action: () => void runOp({ op: "pruneRemote", ref: remote }),
        },
        { separator: true },
        {
          label: allHidden ? `Show ${remote} in the graph` : `Hide ${remote} in the graph`,
          hint: refs.length === 1 ? "1 branch" : `${refs.length} branches`,
          action: () => void setHidden(refs, !allHidden),
        },
        { separator: true },
        {
          label: `Edit ${remote}`,
          action: () =>
            setForm({
              title: "Edit remote",
              fields: [
                {
                  key: "name",
                  label: "Name",
                  initial: remote,
                  validate: validateRemoteName,
                },
                { key: "url", label: "URL", initial: url, validate: validateRemoteUrl },
              ],
              confirmLabel: "Save",
              onConfirm: (v) => {
                setForm(null);
                // Two separate git commands, so only the halves that actually
                // changed are run - renaming a remote to its own name is an
                // error, not a no-op.
                if (v.url !== url) {
                  void runOp({ op: "setRemoteUrl", ref: remote, message: v.url });
                }
                if (v.name !== remote) {
                  void runOp({ op: "renameRemote", ref: remote, name: v.name });
                }
              },
            }),
        },
        {
          label: `Remove ${remote}`,
          danger: true,
          action: () =>
            setConfirm({
              title: "Remove remote?",
              body: (
                <p>
                  <b>{remote}</b> and its remote-tracking branches will be removed from this
                  repository. Nothing is deleted on the server, and you can add it back.
                </p>
              ),
              confirmLabel: "Remove remote",
              destructive: true,
              onConfirm: () => {
                setConfirm(null);
                void runOp({ op: "removeRemote", ref: remote });
              },
            }),
        },
      ];

      if (url.length > 0) {
        items.push({ separator: true });
        items.push({
          label: `Copy link to remote: ${remote}`,
          action: () => {
            void navigator.clipboard.writeText(url);
            setNotice("copied " + url);
            setMenu(null);
          },
        });
      }

      setMenu({ x, y, items });
    },
    [data?.remoteDetail, data?.hidden, runOp, setHidden],
  );

  /**
   * Right-click on a branch or tag chip in the graph.
   *
   * The chip carries only a kind and a name, so the matching Ref is looked up
   * and handed to the same menu the sidebar uses - one menu, one behaviour,
   * wherever a branch appears.
   */
  /**
   * The three things you can do with a stash.
   *
   * Apply and pop differ by one thing - whether the entry survives - and that
   * is the difference worth spelling out, because getting it wrong the other
   * way round loses work. Delete asks first for the same reason: a dropped
   * stash is the one git operation with nothing left to recover from.
   *
   * The selector is positional and shifts the moment any stash is added or
   * removed, so it is used immediately and never remembered.
   */
  const stashMenu = useCallback(
    (selector: string, x: number, y: number) => {
      setMenu({
        x,
        y,
        items: [
          {
            label: `Apply ${selector}`,
            hint: "keeps the stash",
            action: () => void runOp({ op: "stashApply", ref: selector }),
          },
          {
            label: `Pop ${selector}`,
            hint: "applies, then drops it",
            action: () => void runOp({ op: "stashPop", ref: selector }),
          },
          { separator: true },
          {
            label: `Delete ${selector}`,
            action: () =>
              setConfirm({
                title: "Delete stash?",
                body: (
                  <p>
                    <b>{selector}</b> will be dropped. The changes it holds are not on any
                    branch, so this cannot be undone.
                  </p>
                ),
                confirmLabel: "Delete",
                destructive: true,
                onConfirm: () => {
                  setConfirm(null);
                  void runOp({ op: "stashDrop", ref: selector });
                },
              }),
          },
        ],
      });
    },
    [runOp],
  );

  const chipMenu = useCallback(
    (kind: string, name: string, x: number, y: number) => {
      if (!data) return;
      // A stash is not in `data.refs` - it is not a ref, it is a reflog entry -
      // so it gets its own menu rather than being looked up and missed.
      if (kind === "stash") {
        stashMenu(name, x, y);
        return;
      }
      const ref = data.refs.find((r) => r.kind === kind && r.short === name);
      if (ref === undefined) return;
      refMenu(ref, x, y);
    },
    [data, refMenu, stashMenu],
  );

  // --- toolbar --------------------------------------------------------------

  const toolbar = useMemo(
    () => ({
      onFetch: () => void runOp({ op: "fetch" }),
      onPull: () => void runOp({ op: "pull" }),
      /**
       * Pushing a branch that has no upstream has to pick a destination. One
       * remote needs no question; several must not be guessed at, because
       * publishing to the wrong one is not something you can quietly undo.
       */
      onPush: () => {
        const remotes = data?.remotes ?? [];
        const hasUpstream = (data?.upstream ?? null) !== null;
        if (hasUpstream || remotes.length <= 1) {
          void runOp({ op: "push" });
          return;
        }
        setChoose({
          title: "Push to which remote?",
          body: `${branch ?? "This branch"} has no upstream yet. The remote you pick becomes its upstream.`,
          options: remotes.map((r) => ({ value: r, label: r })),
          onPick: (remote) => {
            setChoose(null);
            void runOp({ op: "push", remote });
          },
        });
      },
      onStash: () => void runOp({ op: "stash" }),
      onPop: () => void runOp({ op: "stashPop" }),
      onBranch: () =>
        setPrompt({
          title: "Create branch",
          label: `Branch from ${branch ?? "HEAD"}`,
          placeholder: "feature/my-work",
          confirmLabel: "Create & checkout",
          validate: validateRefName,
          onConfirm: (name) => {
            setPrompt(null);
            void runOp({ op: "createBranch", name, checkout: true });
          },
        }),
    }),
    [runOp, branch, data],
  );

  const conflictCount = useMemo(() => {
    if (!data) return 0;
    return data.status.filter(
      (f) => f.index === "U" || f.worktree === "U" || (f.index === "A" && f.worktree === "A"),
    ).length;
  }, [data]);

  if (dead) {
    return <div className={s.boot}>gitc has stopped. You can close this window.</div>;
  }
  if (!session) {
    return <div className={s.boot}>{error ?? "Starting gitc…"}</div>;
  }

  return (
    <div className={s.root}>
      <TabBar
        session={session}
        onActivate={(id) => api.activate(id).then(setSession)}
        onClose={(id) => api.close(id).then(setSession)}
        onNew={() => setSession({ ...session, activeId: null })}
        onPreferences={() => setPrefsOpen(true)}
        onReorder={(order) => {
          // Optimistic: the strip follows the pointer, and the engine only
          // confirms the order it already shows.
          setSession((cur) =>
            cur === null
              ? cur
              : { ...cur, tabs: order.map((id) => cur.tabs.find((t) => t.id === id)!).filter(Boolean) },
          );
          api.reorder(order).catch((e: Error) => setError(e.message));
        }}
      />

      {prefsOpen ? (
        <Preferences
          onClose={() => setPrefsOpen(false)}
          update={update}
          checking={checkingUpdate}
          updating={updating}
          onCheck={() => checkUpdate(true)}
          onUpdate={runUpdate}
        />
      ) : !activeTab || !data ? (
        <Welcome session={session} onOpen={open} error={error} />
      ) : (
        <div className={s.app}>
          <Toolbar
            repo={activeTab.name}
            branch={data.head.branch ?? "detached"}
            busy={busy}
            onFetch={toolbar.onFetch}
            onPull={toolbar.onPull}
            onPush={toolbar.onPush}
            onBranch={toolbar.onBranch}
            onStash={toolbar.onStash}
            onPop={toolbar.onPop}
          />

          <PendingBanner
            pending={data.pending}
            conflictCount={conflictCount}
            busy={busy}
            onContinue={() => void runOp({ op: "continue", ref: data.pending.kind })}
            onSkip={() => void runOp({ op: "skip", ref: data.pending.kind })}
            onAbort={() => void runOp({ op: "abort", ref: data.pending.kind })}
          />

          <div
            className={s.body}
            // The widths reach the stylesheets as the tokens they already use,
            // so nothing downstream has to know they became draggable.
            style={
              {
                "--sidebar-w": `${sidebarW}px`,
                "--panel-w": `${panelW}px`,
              } as React.CSSProperties
            }
          >
            <Sidebar
              data={data}
              onContext={refMenu}
              onCheckout={(ref) => void runOp({ op: "checkout", ref })}
              onRemoteContext={remoteMenu}
              onFolderContext={folderMenu}
              onSetHidden={(refs, hide) => void setHidden(refs, hide)}
              onOpenSubmodule={(sub) => void openSubmodule(sub)}
              onSubmoduleContext={submoduleMenu}
              onStashContext={stashMenu}
              onAddRemote={addRemote}
              onNewBranch={() =>
                setPrompt({
                  title: "Create branch",
                  label: `Branch from ${branch ?? "HEAD"}`,
                  placeholder: "feature/my-work",
                  confirmLabel: "Create & checkout",
                  validate: validateRefName,
                  onConfirm: (name) => {
                    setPrompt(null);
                    void runOp({ op: "createBranch", name, checkout: true });
                  },
                })
              }
            />
            <div
              className={s.vResizer}
              onMouseDown={dragSidebar}
              title="Drag to resize the sidebar"
            />
            {mergeFile !== null && conflicts !== null ? (
              <MergeEditor
                tabId={activeTab.id}
                path={mergeFile}
                oursLabel={
                  conflicts.progress !== null && (conflicts.progress.ontoName ?? "").length > 0
                    ? conflicts.progress.ontoName
                    : "current"
                }
                theirsLabel={
                  conflicts.progress !== null && (conflicts.progress.branch ?? "").length > 0
                    ? conflicts.progress.branch
                    : "incoming"
                }
                onResolved={() => {
                  setMergeFile(null);
                  refresh();
                }}
                onClose={() => setMergeFile(null)}
              />
            ) : openFile === null ? (
              <Graph
                data={graphData ?? data}
                selected={selected}
                onSelect={onSelect}
                onContext={commitMenu}
                onRefContext={chipMenu}
                onRefCheckout={(kind, name) =>
                  void runOp({ op: kind === "tag" ? "checkout" : "checkout", ref: name })
                }
                menuOpen={menu !== null}
                onQuickCommit={(summary) => {
                  if (!activeTab) return;
                  void api
                    .commit(activeTab.id, summary, "", false)
                    .then((r) => setNotice(`committed ${r.hash.substring(0, 7)}`))
                    .catch((e: Error) => setError(e.message))
                    .finally(refresh);
                }}
              />
            ) : (
              <DiffView
                tabId={activeTab.id}
                target={openFile.target}
                path={openFile.path}
                contextLabel={openFile.label}
                onClose={() => setOpenFile(null)}
                onChanged={refresh}
                version={reloadToken}
              />
            )}
            <div
              className={s.vResizer}
              onMouseDown={dragPanel}
              title="Drag to resize the panel"
            />
            {conflicts !== null && conflicts.operation.length > 0 ? (
              <ConflictPanel
                tabId={activeTab.id}
                state={conflicts}
                busy={busy}
                openPath={openFile?.path ?? null}
                onOpenConflict={(p) => {
                  setOpenFile(null);
                  setMergeFile(p);
                }}
                onChanged={refresh}
                onContinue={() => void runOp({ op: "continue", ref: conflicts.operation })}
                onSkip={() => void runOp({ op: "skip", ref: conflicts.operation })}
                onAbort={() => void runOp({ op: "abort", ref: conflicts.operation })}
              />
            ) : (
              <Panel
                data={data}
                tabId={activeTab.id}
                selected={selected}
                onOpenFile={onOpenFile}
                openPath={openFile?.path ?? null}
                onChanged={refresh}
                onCommitted={() => setOpenFile(null)}
              />
            )}
          </div>

          {logOpen && (
            <GitLog
              calls={visibleGitCalls}
              hiddenCount={gitCalls.length - visibleGitCalls.length}
              onHide={hideCommand}
              onClose={() => setLogOpen(false)}
              onClear={clearGitLog}
            />
          )}

          <div className={s.status}>
            <span>{loading ? "Loading…" : `Viewing ${data.commits.length} commits`}</span>
            {/* The ticker: whatever git ran last, and a way into the rest. */}
            <button
              className={`${s.ticker} ${logOpen ? s.tickerOn : ""}`}
              onClick={() => setLogOpen((v) => !v)}
              title="Every git command gitc has run - click to see them all"
            >
              <span className={s.tickerGit}>git</span>{" "}
              <span className={s.tickerArgs}>
                {visibleGitCalls.length === 0
                  ? "…"
                  : visibleGitCalls[visibleGitCalls.length - 1].args}
              </span>
            </button>
            <span className={s.spacer} />
            {/*
              How current the view is. The threshold for calling the remote
              stale follows the auto-fetch interval - three missed rounds -
              so turning fetching up does not leave a permanent warning, and
              turning it off falls back to half an hour.
            */}
            <Freshness
              signals={freshness}
              staleMinutes={fetchMinutes > 0 ? fetchMinutes * 3 : 30}
              hasRemote={data.remotes.length > 0}
              onRefresh={refresh}
              onFetch={() => void runOp({ op: "fetch" })}
            />
            <span className={s.path}>{activeTab.path}</span>
            {update !== null && update.available && (
              <button
                className={s.update}
                onClick={runUpdate}
                disabled={updating}
                title={`gitc ${update.latest} is available - you have ${update.current}`}
              >
                {updating ? "Updating…" : `Update to ${update.latest}`}
              </button>
            )}
            <span className={s.version} title={`gitc ${VERSION}`}>
              v{VERSION}
            </span>
          </div>
        </div>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
      {prompt && (
        <Prompt
          title={prompt.title}
          label={prompt.label}
          placeholder={prompt.placeholder}
          initial={prompt.initial}
          confirmLabel={prompt.confirmLabel}
          validate={prompt.validate}
          onConfirm={prompt.onConfirm}
          onCancel={() => setPrompt(null)}
        />
      )}
      {choose && (
        <Choose
          title={choose.title}
          body={choose.body}
          options={choose.options}
          onPick={choose.onPick}
          onCancel={() => setChoose(null)}
        />
      )}
      {form && (
        <Form
          title={form.title}
          body={form.body}
          fields={form.fields}
          confirmLabel={form.confirmLabel}
          onConfirm={form.onConfirm}
          onCancel={() => setForm(null)}
        />
      )}
      {confirm && (
        <Confirm
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.confirmLabel}
          destructive={confirm.destructive}
          onConfirm={confirm.onConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}

      {pushRefusal !== null && (
        <PushRefused
          refusal={pushRefusal}
          onForce={() => {
            setPushRefusal(null);
            void runOp({ op: "push", force: true });
          }}
          onPull={(mode) => {
            setPushRefusal(null);
            // "ff" is the engine's default pull, which takes no mode.
            void runOp({ op: "pull", mode: mode === "ff" ? "" : mode });
          }}
          onCancel={() => setPushRefusal(null)}
        />
      )}

      <Toasts toasts={toasts} onDismiss={dismissToast} onHold={holdToast} />

      {/* Last, and over everything: the window is about to be replaced. */}
      {(updating || updateProgress?.phase === "failed") && (
        <Updating progress={updateProgress} onDismiss={() => setUpdateProgress(null)} />
      )}
    </div>
  );
}
