import { useEffect, useRef, useState } from "react";
import s from "./Form.module.scss";

export interface Field {
  key: string;
  label: string;
  placeholder?: string;
  initial?: string;
  /** Returns an error message, or null when acceptable. */
  validate?: (value: string) => string | null;
  /** Blank allowed. Defaults to required. */
  optional?: boolean;
}

/**
 * A small multi-field dialog.
 *
 * Prompt covers the one-value cases; this is for the handful that genuinely
 * need two, like editing a remote's name and URL together. Asking for them in
 * two consecutive prompts would make a single edit feel like two decisions.
 */
export function Form({
  title,
  body,
  fields,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  body?: string;
  fields: Field[];
  confirmLabel: string;
  onConfirm: (values: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of fields) init[f.key] = f.initial ?? "";
    return init;
  });
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    first.current?.focus();
    first.current?.select();
  }, []);

  const errors: Record<string, string | null> = {};
  let ok = true;
  for (const f of fields) {
    const v = values[f.key] ?? "";
    const missing = !f.optional && v.trim().length === 0;
    const err = f.validate ? f.validate(v) : null;
    errors[f.key] = err;
    if (missing || err !== null) ok = false;
  }

  const submit = () => {
    if (!ok) return;
    const trimmed: Record<string, string> = {};
    for (const f of fields) trimmed[f.key] = (values[f.key] ?? "").trim();
    onConfirm(trimmed);
  };

  return (
    <div className={s.backdrop} onClick={onCancel}>
      <div className={s.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={s.title}>{title}</div>
        {body && <div className={s.body}>{body}</div>}
        {fields.map((f, i) => (
          <div key={f.key} className={s.field}>
            <label className={s.label}>{f.label}</label>
            <input
              ref={i === 0 ? first : undefined}
              className={s.input}
              value={values[f.key] ?? ""}
              placeholder={f.placeholder}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
                if (e.key === "Escape") onCancel();
              }}
            />
            {errors[f.key] !== null && <div className={s.error}>{errors[f.key]}</div>}
          </div>
        ))}
        <div className={s.actions}>
          <button className={s.cancel} onClick={onCancel}>
            Cancel
          </button>
          <button className={s.confirm} disabled={!ok} onClick={submit}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
