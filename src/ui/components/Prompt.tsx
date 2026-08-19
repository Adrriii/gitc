import { useEffect, useRef, useState } from "react";
import s from "./Prompt.module.scss";

/**
 * A single-field modal, for the operations that need a name.
 *
 * Creating a branch or a tag needs one string and a confirmation. A whole
 * form would be heavier than the task; a browser prompt() would look nothing
 * like the rest of the app and cannot be styled or validated.
 */
export function Prompt({
  title,
  label,
  placeholder,
  initial,
  confirmLabel,
  hint,
  validate,
  onConfirm,
  onCancel,
}: {
  title: string;
  label: string;
  placeholder?: string;
  initial?: string;
  confirmLabel: string;
  hint?: string;
  /** Returns an error message, or null when the value is acceptable. */
  validate?: (value: string) => string | null;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial ?? "");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const error = validate ? validate(value) : null;
  const canConfirm = value.trim().length > 0 && error === null;

  const submit = () => {
    if (canConfirm) onConfirm(value.trim());
  };

  return (
    <div className={s.backdrop} onClick={onCancel}>
      <div className={s.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={s.title}>{title}</div>
        <label className={s.label}>{label}</label>
        <input
          ref={input}
          className={s.input}
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") onCancel();
          }}
        />
        {error !== null && <div className={s.error}>{error}</div>}
        {error === null && hint && <div className={s.hint}>{hint}</div>}
        <div className={s.actions}>
          <button className={s.cancel} onClick={onCancel}>
            Cancel
          </button>
          <button className={s.confirm} disabled={!canConfirm} onClick={submit}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
