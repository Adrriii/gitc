import { useMemo, useRef } from "react";
import { highlightLines, MAX_HIGHLIGHT_CHARS } from "../highlight";
import { lineDiff } from "../lineDiff";
import { markHtml } from "../markHtml";
import { wordDiff } from "../wordDiff";
import s from "./CodeEditor.module.scss";

export function CodeEditor({
  value,
  language,
  onChange,
  base,
  onKeyDown,
  autoFocus,
}: {
  value: string;
  language: string | null;
  onChange: (value: string) => void;
  /** The lines to mark changes against, live; none for no marks. */
  base?: string[];
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  autoFocus?: boolean;
}) {
  const overlayRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  const lines = useMemo(() => value.split(String.fromCharCode(10)), [value]);

  const html = useMemo(() => {
    if (language === null || value.length > MAX_HIGHLIGHT_CHARS) return lines.map(escape);
    return highlightLines(value, language);
  }, [value, lines, language]);

  const diff = useMemo(() => (base === undefined ? undefined : lineDiff(base, lines)), [base, lines]);

  const rowClass = (i: number) => {
    if (diff === undefined) return undefined;
    const mark = diff.marks[i];
    return [
      mark === "add" || mark === "mod" ? s.added : "",
      diff.removed.has(i) ? s.removedAbove : "",
      i === lines.length - 1 && diff.removed.has(lines.length) ? s.removedBelow : "",
    ].join(" ");
  };

  const rowHtml = (i: number) => {
    const line = html[i] ?? "";
    const old = diff?.was.get(i);
    if (old === undefined) return line;
    return markHtml(line, wordDiff(old, lines[i] ?? "").after, s.word);
  };

  const sync = (e: React.UIEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    if (overlayRef.current) {
      overlayRef.current.scrollTop = ta.scrollTop;
      overlayRef.current.scrollLeft = ta.scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop;
  };

  return (
    <div className={s.body}>
      <div className={s.gutter} ref={gutterRef}>
        {lines.map((_, i) => (
          <div key={i} className={`${s.num} ${rowClass(i) ?? ""}`}>
            {i + 1}
          </div>
        ))}
      </div>
      <div className={s.stack}>
        {/* A highlighted copy sits under a transparent textarea: a
            textarea cannot render colour itself, and this keeps the real
            caret and selection behaviour rather than faking an editor. */}
        <pre className={s.overlay} ref={overlayRef} aria-hidden="true">
          {lines.map((_, i) => (
            <div key={i} className={rowClass(i)} dangerouslySetInnerHTML={{ __html: rowHtml(i) || "​" }} />
          ))}
        </pre>
        <textarea
          className={s.text}
          value={value}
          spellCheck={false}
          autoFocus={autoFocus}
          onScroll={sync}
          onKeyDown={onKeyDown}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    </div>
  );
}

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
