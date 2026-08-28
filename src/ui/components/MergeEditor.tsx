import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConflictVersions } from "../types";
import { api } from "../api";
import {
  parseConflicts,
  emptySelection,
  isDecided,
  compose,
  countConflicts,
} from "../conflictParse";
import type { Segment, Selection } from "../conflictParse";
import { languageFor, highlightLines } from "../highlight";
import { Icon } from "./Icon";
import { CloseButton } from "./CloseButton";
import s from "./MergeEditor.module.scss";

/** One rendered line, on one side. */
interface Row {
  kind: "stable" | "conflict" | "filler";
  /** Line number on this side, null for filler. */
  no: number | null;
  html: string | null;
  text: string;
  /** Conflict index this row belongs to, for conflict and filler rows. */
  conflict: number | null;
  /** Position within that side's conflict lines, for the tick. */
  lineIndex: number | null;
}

/**
 * The three-pane conflict editor: each side on top, the result below.
 *
 * Three ways to resolve, because conflicts are not all the same shape: take a
 * whole side when one is simply right, tick individual lines when the answer
 * is a mixture, or type in the output when neither side is right.
 *
 * The two sides are rendered ROW ALIGNED. Where one side has more lines than
 * the other inside a conflict, the shorter one is padded, so the same conflict
 * always sits at the same height in both panes and can be compared by looking
 * straight across. Laying each side out independently makes them drift apart
 * by however many lines the conflict differs by, which is exactly when you
 * most need them level.
 */
export function MergeEditor({
  tabId,
  path,
  oursLabel,
  theirsLabel,
  onResolved,
  onClose,
}: {
  tabId: string;
  path: string;
  oursLabel: string;
  theirsLabel: string;
  onResolved: () => void;
  onClose: () => void;
}) {
  const [versions, setVersions] = useState<ConflictVersions | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [selections, setSelections] = useState<Selection[]>([]);
  const [manual, setManual] = useState<string | null>(null);
  const [current, setCurrent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const regionRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const outputRef = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);

  useEffect(() => {
    let live = true;
    setError(null);
    api
      .conflictVersions(tabId, path)
      .then((v) => {
        if (!live) return;
        setVersions(v);
        const segs = parseConflicts(v.merged);
        setSegments(segs);
        setSelections(emptySelection(segs));
        setManual(null);
        setCurrent(0);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [tabId, path]);

  const language = useMemo(() => languageFor(path), [path]);
  const total = useMemo(() => countConflicts(segments), [segments]);
  const derived = useMemo(() => compose(segments, selections), [segments, selections]);
  const output = manual ?? derived;
  const decided = selections.map(isDecided);
  const undecided = decided.filter((d) => !d).length;

  /**
   * Rows for both sides, aligned.
   *
   * Each side is highlighted as one document first - a block comment or a
   * template literal only tokenises correctly if the highlighter sees the
   * whole file - and the result is then dealt out line by line.
   */
  const { left, right } = useMemo(() => {
    const oursText: string[] = [];
    const theirsText: string[] = [];
    for (const seg of segments) {
      if (seg.kind === "stable") {
        for (const l of seg.lines) {
          oursText.push(l);
          theirsText.push(l);
        }
      } else {
        for (const l of seg.region.ours) oursText.push(l);
        for (const l of seg.region.theirs) theirsText.push(l);
      }
    }

    const LF = String.fromCharCode(10);
    const oursHtml =
      language !== null ? highlightLines(oursText.join(LF), language) : null;
    const theirsHtml =
      language !== null ? highlightLines(theirsText.join(LF), language) : null;

    const left: Row[] = [];
    const right: Row[] = [];
    let oursNo = 0;
    let theirsNo = 0;
    let conflict = -1;

    for (const seg of segments) {
      if (seg.kind === "stable") {
        for (const line of seg.lines) {
          left.push({
            kind: "stable",
            no: ++oursNo,
            html: oursHtml?.[oursNo - 1] ?? null,
            text: line,
            conflict: null,
            lineIndex: null,
          });
          right.push({
            kind: "stable",
            no: ++theirsNo,
            html: theirsHtml?.[theirsNo - 1] ?? null,
            text: line,
            conflict: null,
            lineIndex: null,
          });
        }
        continue;
      }

      conflict += 1;
      const { ours, theirs } = seg.region;
      const height = Math.max(ours.length, theirs.length);

      for (let i = 0; i < height; i++) {
        if (i < ours.length) {
          left.push({
            kind: "conflict",
            no: ++oursNo,
            html: oursHtml?.[oursNo - 1] ?? null,
            text: ours[i],
            conflict,
            lineIndex: i,
          });
        } else {
          left.push({ kind: "filler", no: null, html: null, text: "", conflict, lineIndex: null });
        }

        if (i < theirs.length) {
          right.push({
            kind: "conflict",
            no: ++theirsNo,
            html: theirsHtml?.[theirsNo - 1] ?? null,
            text: theirs[i],
            conflict,
            lineIndex: i,
          });
        } else {
          right.push({ kind: "filler", no: null, html: null, text: "", conflict, lineIndex: null });
        }
      }
    }

    return { left, right };
  }, [segments, language]);

  const outputHtml = useMemo(() => {
    if (language === null) return null;
    return highlightLines(output, language);
  }, [output, language]);

  const setSel = useCallback(
    (conflict: number, side: "ours" | "theirs", line: number, on: boolean) => {
      setSelections((prev) =>
        prev.map((sel, i) => {
          if (i !== conflict) return sel;
          const next = { ours: [...sel.ours], theirs: [...sel.theirs] };
          next[side][line] = on;
          return next;
        }),
      );
    },
    [],
  );

  const takeSide = useCallback(
    (conflict: number, side: "ours" | "theirs" | "both" | "none") => {
      setSelections((prev) =>
        prev.map((sel, i) => {
          if (i !== conflict) return sel;
          return {
            ours: sel.ours.map(() => side === "ours" || side === "both"),
            theirs: sel.theirs.map(() => side === "theirs" || side === "both"),
          };
        }),
      );
    },
    [],
  );

  /** Ticking anything after a hand edit would throw that edit away. */
  const guardManual = useCallback(
    (act: () => void) => {
      if (manual === null) {
        act();
        return;
      }
      const ok = window.confirm(
        "You have edited the output by hand. Changing the selections rebuilds it and discards those edits.\n\nRebuild from the selections?",
      );
      if (ok) {
        setManual(null);
        act();
      }
    },
    [manual],
  );

  const jump = useCallback(
    (delta: number) => {
      if (total === 0) return;
      const next = (current + delta + total) % total;
      setCurrent(next);
      regionRefs.current.get(next)?.scrollIntoView({ block: "center", behavior: "smooth" });
    },
    [current, total],
  );

  // The panes are aligned, so they must also scroll together.
  const syncFrom = useCallback((from: "left" | "right") => {
    if (syncing.current) return;
    const a = from === "left" ? leftRef.current : rightRef.current;
    const b = from === "left" ? rightRef.current : leftRef.current;
    if (!a || !b) return;
    syncing.current = true;
    b.scrollTop = a.scrollTop;
    b.scrollLeft = a.scrollLeft;
    requestAnimationFrame(() => {
      syncing.current = false;
    });
  }, []);

  const syncOutput = useCallback(() => {
    const ta = outputRef.current;
    if (!ta) return;
    if (overlayRef.current) {
      overlayRef.current.scrollTop = ta.scrollTop;
      overlayRef.current.scrollLeft = ta.scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop;
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const LF = String.fromCharCode(10);
      const text = output.endsWith(LF) ? output : output + LF;
      await api.resolveContent(tabId, path, text);
      onResolved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [output, tabId, path, onResolved]);

  const stillMarked = output.includes("<<<<<<<") || output.includes(">>>>>>>");
  const blocked = stillMarked || (manual === null && undecided > 0);

  const renderPane = (rows: Row[], side: "ours" | "theirs") => {
    const out: React.ReactNode[] = [];
    let i = 0;

    while (i < rows.length) {
      const row = rows[i];

      if (row.kind === "stable") {
        out.push(
          <div key={`s${side}${i}`} className={s.line}>
            <span className={s.num}>{row.no}</span>
            <span className={s.tick} />
            <Text row={row} />
          </div>,
        );
        i += 1;
        continue;
      }

      // Gather the whole conflict block, which spans equal rows on both sides.
      const idx = row.conflict as number;
      const block: Row[] = [];
      while (i < rows.length && rows[i].conflict === idx) {
        block.push(rows[i]);
        i += 1;
      }

      const sel = selections[idx];
      const chosen = side === "ours" ? sel?.ours ?? [] : sel?.theirs ?? [];
      const realLines = block.filter((r) => r.kind === "conflict").length;
      const allOn = realLines > 0 && chosen.every(Boolean);
      const isDone = decided[idx];

      out.push(
        <div
          key={`h${side}${idx}`}
          className={[
            s.hunk,
            side === "ours" ? s.hunkOurs : s.hunkTheirs,
            idx === current ? s.hunkCurrent : "",
            isDone ? s.hunkDone : "",
          ].join(" ")}
          ref={(el) => {
            if (side === "ours" && el) regionRefs.current.set(idx, el);
          }}
          onClick={() => setCurrent(idx)}
        >
          <div className={s.hunkHead}>
            <span className={s.hunkNo}>conflict {idx + 1}</span>
            <button
              className={`${s.takeBtn} ${allOn ? s.takeBtnOn : ""}`}
              onClick={() =>
                guardManual(() => takeSide(idx, allOn ? "none" : side))
              }
              title={
                allOn
                  ? "Drop this side again"
                  : `Take all ${realLines} line${realLines === 1 ? "" : "s"} from this side`
              }
            >
              {allOn ? "taken" : `take all ${realLines}`}
            </button>
            {side === "ours" && (
              <button
                className={s.takeBtn}
                onClick={() => guardManual(() => takeSide(idx, "both"))}
                title="Take both sides, A first"
              >
                take both
              </button>
            )}
            {side === "theirs" && (
              <span className={isDone ? s.doneTag : s.todoTag}>
                {isDone ? "resolved" : "not resolved"}
              </span>
            )}
          </div>

          {block.map((r, j) =>
            r.kind === "filler" ? (
              <div key={j} className={`${s.line} ${s.filler}`}>
                <span className={s.num} />
                <span className={s.tick} />
                <span className={s.text} />
              </div>
            ) : (
              <div
                key={j}
                className={`${s.line} ${chosen[r.lineIndex as number] ? s.linePicked : ""}`}
              >
                <span className={s.num}>{r.no}</span>
                <span className={s.tick}>
                  <label className={s.box}>
                    <input
                      type="checkbox"
                      checked={chosen[r.lineIndex as number] ?? false}
                      onChange={(e) => {
                        const v = e.target.checked;
                        guardManual(() => setSel(idx, side, r.lineIndex as number, v));
                      }}
                    />
                    <span className={s.boxMark} />
                  </label>
                </span>
                <Text row={r} />
              </div>
            ),
          )}
        </div>,
      );
    }
    return out;
  };

  if (error !== null && versions === null) {
    return (
      <div className={s.wrap}>
        <div className={s.note}>{error}</div>
      </div>
    );
  }
  if (versions === null) {
    return (
      <div className={s.wrap}>
        <div className={s.note}>Loading conflict…</div>
      </div>
    );
  }
  if (versions.binary) {
    return (
      <div className={s.wrap}>
        <div className={s.pathBar}>
          <Icon name="warning" size={13} className={s.warn} />
          <span className={s.pathBase}>{path}</span>
          <span className={s.spacer} />
          <CloseButton onClick={onClose} title="Close (Esc)" />
        </div>
        <div className={s.note}>
          Binary file — there are no lines to merge. Take one side from the panel.
        </div>
      </div>
    );
  }

  const outputLines = output.split(String.fromCharCode(10));

  return (
    <div className={s.wrap}>
      <div className={s.pathBar}>
        <Icon name="warning" size={13} className={s.warn} />
        <span className={s.pathBase}>{path}</span>
        <span className={undecided > 0 ? s.countTodo : s.countDone}>
          {undecided > 0
            ? `${undecided} of ${total} still to decide`
            : `all ${total} resolved`}
        </span>
        <span className={s.spacer} />
        <span className={s.nav}>
          conflict {total === 0 ? 0 : current + 1} of {total}
        </span>
        <button className={s.navBtn} onClick={() => jump(-1)} title="Previous conflict">
          <Icon name="arrowUp" size={13} />
        </button>
        <button className={s.navBtn} onClick={() => jump(1)} title="Next conflict">
          <Icon name="arrowDown" size={13} />
        </button>
        <button
          className={s.save}
          disabled={saving || blocked}
          onClick={() => void save()}
          title={
            stillMarked
              ? "The output still contains conflict markers"
              : blocked
                ? "Decide every conflict first, or edit the output by hand"
                : "Write the output and mark the file resolved"
          }
        >
          {saving ? "Saving…" : "Save & mark resolved"}
        </button>
        <CloseButton onClick={onClose} title="Close (Esc)" />
      </div>

      {error !== null && <div className={s.error}>{error}</div>}

      <div className={s.sides}>
        <div className={s.side}>
          <div className={s.sideHead}>
            <span className={s.sideTag}>A</span>
            <span className={s.sideName}>{oursLabel}</span>
            <span className={s.sideHint}>the branch you are moving onto</span>
          </div>
          <div className={s.sideBody} ref={leftRef} onScroll={() => syncFrom("left")}>
            {renderPane(left, "ours")}
          </div>
        </div>
        <div className={s.side}>
          <div className={s.sideHead}>
            <span className={`${s.sideTag} ${s.sideTagB}`}>B</span>
            <span className={s.sideName}>{theirsLabel}</span>
            <span className={s.sideHint}>the change being applied</span>
          </div>
          <div className={s.sideBody} ref={rightRef} onScroll={() => syncFrom("right")}>
            {renderPane(right, "theirs")}
          </div>
        </div>
      </div>

      <div className={s.outputPane}>
        <div className={s.outputHead}>
          <span className={s.outputTitle}>Output</span>
          {manual !== null && (
            <span className={s.manualTag}>
              edited by hand
              <button
                className={s.resetBtn}
                onClick={() => setManual(null)}
                title="Rebuild the output from the selections"
              >
                rebuild from selections
              </button>
            </span>
          )}
          {stillMarked && <span className={s.warnTag}>conflict markers still present</span>}
          <span className={s.spacer} />
          <span className={s.outputHint}>editable — type here for anything neither side has</span>
        </div>
        <div className={s.outputBody}>
          <div className={s.outputGutter} ref={gutterRef}>
            {outputLines.map((_, i) => (
              <div key={i} className={s.outNum}>
                {i + 1}
              </div>
            ))}
          </div>
          <div className={s.outputStack}>
            {/* A highlighted copy sits under a transparent textarea: a
                textarea cannot render colour itself, and this keeps the real
                caret and selection behaviour rather than faking an editor. */}
            <pre className={s.outputOverlay} ref={overlayRef} aria-hidden="true">
              {outputHtml === null
                ? output
                : outputHtml.map((html, i) => (
                    <div key={i} dangerouslySetInnerHTML={{ __html: html || "​" }} />
                  ))}
            </pre>
            <textarea
              ref={outputRef}
              className={s.outputText}
              value={output}
              spellCheck={false}
              onScroll={syncOutput}
              onChange={(e) => setManual(e.target.value)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function Text({ row }: { row: Row }) {
  if (row.html === null) return <span className={s.text}>{row.text}</span>;
  return <span className={s.text} dangerouslySetInnerHTML={{ __html: row.html }} />;
}
