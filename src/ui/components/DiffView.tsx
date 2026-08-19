import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { DiffLine, FileDiff, Hunk } from "../types";
import { api } from "../api";
import { languageFor, highlightLines, MAX_HIGHLIGHT_CHARS } from "../highlight";
import { Icon } from "./Icon";
import s from "./DiffView.module.scss";

export type DiffTarget =
  | { kind: "commit"; sha: string }
  | { kind: "range"; from: string; to: string }
  | { kind: "wip"; staged: boolean; untracked: boolean };

type Mode = "unified" | "inline" | "split";

const WRAP_KEY = "gitc.diffWrap";

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

/** Renders tabs and trailing spaces visibly, for the ¶ toggle. */
function showWhitespace(text: string): string {
  return text.replace(/\t/g, "→   ").replace(/ +$/g, (m) => "·".repeat(m.length));
}

function Gutter({ n }: { n: number | null }) {
  return <span className={s.num}>{n ?? ""}</span>;
}

export function DiffView({
  tabId,
  target,
  path,
  contextLabel,
  onClose,
}: {
  tabId: string;
  target: DiffTarget;
  path: string;
  /** What the file is being compared against - a commit, a run, or the tree. */
  contextLabel: string;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>("unified");
  const [fileView, setFileView] = useState(false);
  const [ws, setWs] = useState(false);
  // Long lines are a setting, not a per-view guess: wrap (the default) or
  // scroll horizontally. It persists, because it is a reading preference
  // rather than something to re-choose for every file.
  const [wrap, setWrap] = useState<boolean>(() => {
    const saved = localStorage.getItem(WRAP_KEY);
    return saved === null ? true : saved === "1";
  });
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const body = useRef<HTMLDivElement>(null);

  // Unified shows only the changed neighbourhood; every other view needs the
  // whole file, so the fetch depends on the mode.
  const whole = mode !== "unified" || fileView;

  useEffect(() => {
    let live = true;
    setLoading(true);
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
  }, [tabId, path, whole, JSON.stringify(target)]);

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

  const text = (line: DiffLine) => (ws ? showWhitespace(line.text) : line.text);

  /** A line's content: highlighted when we have it, plain text otherwise. */
  const Content = ({ line }: { line: DiffLine }) => {
    const html = highlighted.get(line);
    const cls = wrap ? s.textWrap : s.text;
    if (html === undefined) return <span className={cls}>{text(line)}</span>;
    return <span className={cls} dangerouslySetInnerHTML={{ __html: html }} />;
  };

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
              <button className={s.revert} disabled title="Not wired yet">
                Revert Hunk
              </button>
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
        <button className={s.btn} disabled title="Not wired yet">
          &#9998; Edit This File
        </button>
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
            onClick={() => {
              const next = !wrap;
              setWrap(next);
              localStorage.setItem(WRAP_KEY, next ? "1" : "0");
            }}
            title={wrap ? "Wrapping long lines — click to scroll instead" : "Scrolling long lines — click to wrap"}
          >
            <Icon name="wrap" size={14} />
          </button>
        </div>
      </div>

      <div className={s.body} ref={body}>
        {loading && <div className={s.note}>Loading diff…</div>}
        {error !== null && <div className={s.note}>{error}</div>}
        {!loading && error === null && diff !== null && (
          <>
            {diff.tooLarge ? (
              <div className={s.note}>File is too large to display.</div>
            ) : diff.binary ? (
              <div className={s.note}>Binary file — no textual diff.</div>
            ) : diff.hunks.length === 0 ? (
              <div className={s.note}>No changes to this file in the selection.</div>
            ) : mode === "split" && !fileView ? (
              renderSplit(diff.hunks)
            ) : (
              renderLinear(diff.hunks, mode === "unified" && !fileView)
            )}
          </>
        )}
      </div>
    </div>
  );
}
