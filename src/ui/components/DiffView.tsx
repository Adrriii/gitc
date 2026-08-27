import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { DiffLine, FileDiff, Hunk } from "../types";
import { canApplyHunks, hunkPatch } from "../patch";
import { api } from "../api";
import { languageFor, highlightLines, MAX_HIGHLIGHT_CHARS } from "../highlight";
import { wordDiff, pairRuns, type Span } from "../wordDiff";
import { markHtml } from "../markHtml";
import { useDiffWrap, useTabSize } from "../settings";
import { Icon } from "./Icon";
import s from "./DiffView.module.scss";

export type DiffTarget =
  | { kind: "commit"; sha: string }
  | { kind: "range"; from: string; to: string }
  | { kind: "wip"; staged: boolean; untracked: boolean };

type Mode = "unified" | "inline" | "split";

/**
 * Pairs a hunk's lines into two columns for Split view.
 *
 * Deletions and additions arrive as separate runs, not interleaved, so they
 * have to be zipped: the nth deletion of a run sits opposite the nth addition
 * of the run that follows it. Whichever run is shorter gets filler rows, which
 * render as the hatched blocks in the reference.
 */
function splitRows(lines: DiffLine[]): { left: DiffLine | null; right: DiffLine | null }[] {
  const rows: { left: DiffLine | null; right: DiffLine | null }[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];

  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      rows.push({ left: dels[i] ?? null, right: adds[i] ?? null });
    }
    dels = [];
    adds = [];
  };

  for (const line of lines) {
    if (line.kind === "del") {
      dels.push(line);
    } else if (line.kind === "add") {
      adds.push(line);
    } else {
      flush();
      rows.push({ left: line, right: line });
    }
  }
  flush();
  return rows;
}

/**
 * Renders tabs and trailing spaces visibly, for the ¶ toggle.
 *
 * The arrow is padded out to the configured tab width, so text still lands
 * where the tab stop would have put it. Fixed at four, turning whitespace on
 * shifted every tabbed line sideways.
 */
function showWhitespace(text: string, tabSize: number): string {
  const tab = "→" + " ".repeat(Math.max(0, tabSize - 1));
  return text.replace(/\t/g, tab).replace(/ +$/g, (m) => "·".repeat(m.length));
}

function Gutter({ n }: { n: number | null }) {
  return <span className={s.num}>{n ?? ""}</span>;
}

/**
 * How many diff lines are rendered before the view stops and asks.
 *
 * Nothing here is virtualised: every line becomes DOM nodes, and the whole-file
 * modes ask the engine for the entire file. A 40,000-line file therefore laid
 * out 40,000 rows - two panes' worth in Split - which froze the window for long
 * enough that the engine concluded it had died and shut the app down.
 *
 * 4,000 rows is far more than anyone reads at once and lays out in well under
 * a second, and the rest is one click away.
 */
const MAX_ROWS = 4000;

/** Cuts a hunk list down to a line budget, reporting what it left out. */
function withinBudget(hunks: Hunk[], budget: number): { hunks: Hunk[]; shown: number; total: number } {
  let total = 0;
  for (const h of hunks) total += h.lines.length;
  if (total <= budget) return { hunks, shown: total, total };

  const kept: Hunk[] = [];
  let shown = 0;
  for (const h of hunks) {
    if (shown >= budget) break;
    const room = budget - shown;
    if (h.lines.length <= room) {
      kept.push(h);
      shown += h.lines.length;
    } else {
      // Keep the head of the hunk rather than dropping it whole: the first
      // lines of a huge file are the ones worth seeing.
      kept.push({ ...h, lines: h.lines.slice(0, room) });
      shown += room;
    }
  }
  return { hunks: kept, shown, total };
}

export function DiffView({
  tabId,
  target,
  path,
  contextLabel,
  onClose,
  onChanged,
  version,
}: {
  tabId: string;
  target: DiffTarget;
  path: string;
  /** What the file is being compared against - a commit, a run, or the tree. */
  contextLabel: string;
  onClose: () => void;
  /** Called after a hunk is staged, unstaged or discarded. */
  onChanged?: () => void;
  /**
   * Bumped by the application whenever the repository changes - an operation
   * here, an edit in another program, a commit from a terminal. What is on
   * screen is re-read when it moves, because a diff that silently describes
   * the file as it was ten seconds ago is worse than no diff.
   */
  version?: number;
}) {
  const [mode, setMode] = useState<Mode>("unified");
  const [showAll, setShowAll] = useState(false);
  // Set in Preferences; used here to pad the whitespace view to match.
  const { size: tabSize } = useTabSize();
  // Reported inline rather than through the app's status bar: the reason a
  // file will not open - it is not in the working tree - is about the file on
  // screen, so it belongs next to the button that tried.
  const [editError, setEditError] = useState<string | null>(null);

  /**
   * Opens the working-tree copy of this file in the user's editor.
   *
   * The working-tree copy, not the revision on screen: editing a file you are
   * looking at in a commit means editing it now, and gitc has nowhere to put
   * an edited historical blob anyway.
   */
  const openInEditor = async () => {
    setEditError(null);
    try {
      const r = await api.op(tabId, { op: "editFile", path });
      if (!r.ok) setEditError(r.note);
    } catch (e) {
      setEditError((e as Error).message);
    }
  };
  /**
   * Stages, unstages or discards a single hunk.
   *
   * The patch is rebuilt from the hunk on screen, so what git applies is
   * exactly what was being looked at - context lines included, which is what
   * makes it land in the right place.
   */
  const [applying, setApplying] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState<number | null>(null);

  const applyHunk = async (hunk: Hunk, mode: "stage" | "unstage" | "discard") => {
    if (diff === null || applying) return;
    setEditError(null);
    setApplying(true);
    try {
      const r = await api.op(tabId, { op: "applyPatch", mode, patch: hunkPatch(diff, hunk) });
      if (!r.ok) setEditError(r.note);
      else {
        setConfirmDiscard(null);
        setReloadToken((n) => n + 1);
        if (onChanged) onChanged();
      }
    } catch (e) {
      setEditError((e as Error).message);
    } finally {
      setApplying(false);
    }
  };

  const [fileView, setFileView] = useState(false);
  const [ws, setWs] = useState(false);
  // Long lines are a setting, not a per-view guess: wrap (the default) or
  // scroll horizontally. It persists, because it is a reading preference
  // rather than something to re-choose for every file.
  const { wrap, set: setWrap } = useDiffWrap();
  const [diff, setDiff] = useState<FileDiff | null>(null);
  /** Bumped after a hunk is applied, to re-read what is left. */
  const [reloadToken, setReloadToken] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const body = useRef<HTMLDivElement>(null);

  // Unified shows only the changed neighbourhood; every other view needs the
  // whole file, so the fetch depends on the mode.
  const whole = mode !== "unified" || fileView;

  /** What is being shown. A change here is a different thing to look at. */
  const identity = tabId + "|" + path + "|" + (whole ? "1" : "0") + "|" + JSON.stringify(target);
  const shown = useRef<string | null>(null);

  useEffect(() => {
    let live = true;

    // Opening something different starts over: the spinner, the line budget,
    // the top of the view. The SAME thing arriving again is a refresh, and a
    // refresh must not announce itself - blanking the pane for "Loading diff…"
    // would throw away the scroll position of whoever is reading it.
    const opened = shown.current !== identity;
    shown.current = identity;
    if (opened) {
      setLoading(true);
      // "Show all" was a decision about the file you were looking at, not a
      // preference to carry to the next one.
      setShowAll(false);
    }
    setError(null);

    api
      .diff(tabId, target, path, whole)
      .then((d) => {
        if (live) setDiff(d);
      })
      .catch((e: Error) => {
        if (live) {
          setDiff(null);
          setError(e.message);
        }
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [identity, version, reloadToken]);

  const cut = path.lastIndexOf("/");
  const dir = cut === -1 ? "" : path.substring(0, cut + 1);
  const base = cut === -1 ? path : path.substring(cut + 1);

  // Jump between changed regions with the up/down arrows.
  const stepChange = (dir: 1 | -1) => {
    const el = body.current;
    if (!el) return;
    const marks = [...el.querySelectorAll(`.${s.changed}`)] as HTMLElement[];
    if (marks.length === 0) return;
    const top = el.scrollTop;
    const targets = marks.map((m) => m.offsetTop);
    const next =
      dir === 1
        ? targets.find((t) => t > top + 4)
        : [...targets].reverse().find((t) => t < top - 4);
    if (next !== undefined) el.scrollTo({ top: next - 40, behavior: "smooth" });
  };

  const language = useMemo(() => languageFor(path), [path]);

  /**
   * Per-line highlighted HTML, keyed by the DiffLine itself.
   *
   * Old and new are highlighted as separate documents (see highlight.ts) and
   * then mapped back onto the rows, so an edit never corrupts the tokens
   * around it. Showing whitespace turns highlighting off: the two want to
   * rewrite the same text and the markers would end up inside the tokens.
   */
  const highlighted = useMemo(() => {
    const map = new Map<DiffLine, string>();
    if (diff === null || language === null || ws) return map;

    let total = 0;
    for (const h of diff.hunks) for (const l of h.lines) total += l.text.length + 1;
    if (total > MAX_HIGHLIGHT_CHARS) return map;

    for (const hunk of diff.hunks) {
      const oldLines = hunk.lines.filter((l) => l.kind !== "add");
      const newLines = hunk.lines.filter((l) => l.kind !== "del");
      const oldHtml = highlightLines(oldLines.map((l) => l.text).join(String.fromCharCode(10)), language);
      const newHtml = highlightLines(newLines.map((l) => l.text).join(String.fromCharCode(10)), language);
      oldLines.forEach((l, i) => {
        const html = oldHtml[i];
        if (html !== undefined) map.set(l, html);
      });
      // Context lines appear in both; the new side wins, which is identical
      // text but keeps a context run consistent with the additions near it.
      newLines.forEach((l, i) => {
        const html = newHtml[i];
        if (html !== undefined) map.set(l, html);
      });
    }
    return map;
  }, [diff, language, ws]);

  /**
   * The characters that actually changed, per line.
   *
   * A unified diff says a line became another line and leaves finding the
   * difference to the reader - which on a long line with one renamed variable
   * is most of the work of reading the diff.
   *
   * Skipped while whitespace markers are on, for the same reason highlighting
   * is: that mode rewrites the text, and spans measured against the original
   * would land in the wrong places.
   */
  const changed = useMemo(() => {
    const map = new Map<DiffLine, Span[]>();
    if (diff === null || ws) return map;
    for (const hunk of diff.hunks) {
      const pairs = pairRuns(hunk.lines);
      for (const line of hunk.lines) {
        if (line.kind !== "del" && line.kind !== "add") continue;
        const other = pairs.get(line);
        if (other === undefined) continue;
        const d =
          line.kind === "del"
            ? wordDiff(line.text, other.text).before
            : wordDiff(other.text, line.text).after;
        if (d.length > 0) map.set(line, d);
      }
    }
    return map;
  }, [diff, ws]);

  const text = (line: DiffLine) => (ws ? showWhitespace(line.text, tabSize) : line.text);

  /** A line's content: highlighted when we have it, plain text otherwise. */
  const Content = ({ line }: { line: DiffLine }) => {
    const html = highlighted.get(line);
    const cls = wrap ? s.textWrap : s.text;
    const spans = changed.get(line);
    const mark = line.kind === "del" ? s.wordDel : s.wordAdd;

    if (html !== undefined) {
      const marked = spans === undefined ? html : markHtml(html, spans, mark);
      return <span className={cls} dangerouslySetInnerHTML={{ __html: marked }} />;
    }

    // No highlighting to preserve, so the pieces go straight into the DOM as
    // text - no markup is built and nothing needs escaping.
    if (spans === undefined) return <span className={cls}>{text(line)}</span>;
    const raw = line.text;
    const parts: React.ReactNode[] = [];
    let at = 0;
    spans.forEach((span, i) => {
      if (span.start > at) parts.push(raw.substring(at, span.start));
      parts.push(
        <mark key={i} className={mark}>
          {raw.substring(span.start, span.end)}
        </mark>,
      );
      at = span.end;
    });
    if (at < raw.length) parts.push(raw.substring(at));
    return <span className={cls}>{parts}</span>;
  };

  // Recomputed per diff, so opening a new file starts bounded again.
  const budget = useMemo(
    () => withinBudget(diff?.hunks ?? [], showAll ? Number.MAX_SAFE_INTEGER : MAX_ROWS),
    [diff, showAll],
  );

  const renderLinear = (hunks: Hunk[], showHeaders: boolean) => (
    <>
      {hunks.map((h, hi) => (
        <div key={hi} className={s.hunk}>
          {showHeaders && (
            <div className={s.hunkHead}>
              <span className={s.hunkRange}>
                @@ -{h.oldStart},{h.oldCount} +{h.newStart},{h.newCount} @@
              </span>
              {h.heading && <span className={s.hunkHeading}>{h.heading}</span>}

              {/*
                Only where a hunk is a real hunk and there is an index to move
                it to or from: a commit's diff has nothing to stage, and a
                whole-file view is one hunk covering everything, where "stage
                this hunk" would quietly mean "stage the file".
              */}
              {canApplyHunks(diff) && target.kind === "wip" && (
                <span className={s.hunkActions}>
                  {target.staged ? (
                    <button
                      className={s.hunkAct}
                      disabled={applying}
                      onClick={() => void applyHunk(h, "unstage")}
                      title="Take this hunk back out of the index"
                    >
                      Unstage hunk
                    </button>
                  ) : (
                    <>
                      <button
                        className={s.hunkAct}
                        disabled={applying}
                        onClick={() => void applyHunk(h, "stage")}
                        title="Stage only this hunk"
                      >
                        Stage hunk
                      </button>
                      {/* Two clicks, because this one cannot be undone. */}
                      <button
                        className={`${s.hunkAct} ${confirmDiscard === hi ? s.hunkDanger : ""}`}
                        disabled={applying}
                        onClick={() => {
                          if (confirmDiscard === hi) void applyHunk(h, "discard");
                          else setConfirmDiscard(hi);
                        }}
                        onBlur={() => setConfirmDiscard((c) => (c === hi ? null : c))}
                        title="Throw this hunk away - there is no undo"
                      >
                        {confirmDiscard === hi ? "Discard for good?" : "Discard hunk"}
                      </button>
                    </>
                  )}
                </span>
              )}
            </div>
          )}
          {h.lines
            .filter((l) => (fileView ? l.kind !== "del" : true))
            .map((l, li) => (
              <div
                key={li}
                className={[
                  s.line,
                  l.kind === "add" ? s.add : l.kind === "del" ? s.del : "",
                  !fileView && l.kind !== "context" ? s.changed : "",
                ].join(" ")}
              >
                <Gutter n={l.oldNo} />
                <Gutter n={l.newNo} />
                <span className={s.marker}>
                  {fileView ? "" : l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}
                </span>
                <Content line={l} />
              </div>
            ))}
        </div>
      ))}
    </>
  );

  // Split is a real table rather than flex rows. With `table-layout: auto`
  // the browser sizes each column to its widest cell across every row, which
  // is exactly the alignment two code columns need - and it lets the table
  // grow past the viewport so the pane can scroll horizontally when wrapping
  // is off. Flex rows can do one or the other, not both.
  const renderSplit = (hunks: Hunk[]) => (
    <table className={`${s.splitTable} ${wrap ? s.fixed : s.natural}`}>
      <tbody>
        {hunks.map((h, hi) => (
          <Fragment key={hi}>
            {diff !== null && !diff.whole && (
              <tr>
                <td className={s.hunkHeadCell} colSpan={2}>
                  <span className={s.hunkRange}>
                    @@ -{h.oldStart},{h.oldCount} +{h.newStart},{h.newCount} @@
                  </span>
                  {h.heading && <span className={s.hunkHeading}>{h.heading}</span>}
                </td>
              </tr>
            )}
            {splitRows(h.lines).map((row, ri) => {
              const changed = row.left?.kind === "del" || row.right?.kind === "add";
              return (
                <tr key={ri} className={changed ? s.changed : ""}>
                  <td
                    className={[
                      s.cell,
                      row.left === null ? s.filler : row.left.kind === "del" ? s.del : "",
                    ].join(" ")}
                  >
                    {row.left !== null && (
                      <span className={s.cellInner}>
                        <Gutter n={row.left.oldNo} />
                        <Content line={row.left} />
                      </span>
                    )}
                  </td>
                  <td
                    className={[
                      s.cell,
                      row.right === null ? s.filler : row.right.kind === "add" ? s.add : "",
                    ].join(" ")}
                  >
                    {row.right !== null && (
                      <span className={s.cellInner}>
                        <Gutter n={row.right.newNo} />
                        <Content line={row.right} />
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </Fragment>
        ))}
      </tbody>
    </table>
  );

  return (
    <div className={s.wrap}>
      <div className={s.pathBar}>
        <Icon name="file" size={13} className={s.pathIco} />
        <span className={s.pathDir}>{dir}</span>
        <span className={s.pathBase}>{base}</span>
        <span className={s.context}>in {contextLabel}</span>
        <span className={s.spacer} />
        <span className={s.enc}>UTF-8</span>
        <button className={s.close} onClick={onClose} title="Close diff (Esc)">
          <Icon name="close" size={12} />
        </button>
      </div>

      <div className={s.toolbar}>
        <button
          className={s.btn}
          onClick={() => void openInEditor()}
          title="Open this file in your editor"
        >
          &#9998; Edit This File
        </button>
        {editError !== null && <span className={s.editError}>{editError}</span>}
        <span className={s.spacer} />

        <div className={s.group}>
          <button className={fileView ? s.on : ""} onClick={() => setFileView(true)}>
            File View
          </button>
          <button className={!fileView ? s.on : ""} onClick={() => setFileView(false)}>
            Diff View
          </button>
        </div>

        <div className={s.group}>
          <button disabled title="Not wired yet">Blame</button>
          <button disabled title="Not wired yet">History</button>
        </div>

        <div className={s.group}>
          <button onClick={() => stepChange(-1)} title="Previous change">
            <Icon name="arrowUp" size={14} />
          </button>
          <button onClick={() => stepChange(1)} title="Next change">
            <Icon name="arrowDown" size={14} />
          </button>
        </div>

        <div className={s.group}>
          <button
            className={mode === "unified" ? s.on : ""}
            onClick={() => setMode("unified")}
            title="Unified View — changed hunks only"
          >
            <Icon name="unified" size={14} />
          </button>
          <button
            className={mode === "inline" ? s.on : ""}
            onClick={() => setMode("inline")}
            title="Inline View — whole file, changes in place"
          >
            <Icon name="inline" size={14} />
          </button>
          <button
            className={mode === "split" ? s.on : ""}
            onClick={() => setMode("split")}
            title="Split View — old and new side by side"
          >
            <Icon name="split" size={14} />
          </button>
        </div>

        <div className={s.group}>
          <button
            className={ws ? s.on : ""}
            onClick={() => setWs(!ws)}
            title="Show whitespace (turns off syntax highlighting)"
          >
            <Icon name="pilcrow" size={14} />
          </button>
          <button
            className={wrap ? s.on : ""}
            onClick={() => setWrap(!wrap)}
            title={wrap ? "Wrapping long lines — click to scroll instead" : "Scrolling long lines — click to wrap"}
          >
            <Icon name="wrap" size={14} />
          </button>
        </div>
      </div>

      <div className={s.body} ref={body}>
        {loading && <div className={s.note}>Loading diff…</div>}
        {error !== null && <div className={s.note}>{error}</div>}
        {!loading && error === null && diff !== null && budget.shown < budget.total && (
          <div className={s.capped}>
            Showing the first {budget.shown.toLocaleString()} of{" "}
            {budget.total.toLocaleString()} lines.
            <button className={s.cappedBtn} onClick={() => setShowAll(true)}>
              Show the whole file
            </button>
            <span className={s.cappedWhy}>large files can take a moment to lay out</span>
          </div>
        )}
        {!loading && error === null && diff !== null && (
          <>
            {diff.tooLarge ? (
              <div className={s.note}>File is too large to display.</div>
            ) : diff.binary ? (
              <div className={s.note}>Binary file — no textual diff.</div>
            ) : diff.hunks.length === 0 ? (
              <div className={s.note}>No changes to this file in the selection.</div>
            ) : mode === "split" && !fileView ? (
              renderSplit(budget.hunks)
            ) : (
              renderLinear(budget.hunks, mode === "unified" && !fileView)
            )}
          </>
        )}
      </div>
    </div>
  );
}
