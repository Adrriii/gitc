import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Icon } from "./Icon";
import s from "./Explain.module.scss";

const explained = new Map<string, string>();

export function Explain({ tabId, shas }: { tabId: string; shas: string[] }) {
  const key = tabId + ":" + shas.join(",");
  const current = useRef(key);
  current.current = key;
  const [text, setText] = useState(explained.get(key));
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setText(explained.get(key));
    setError("");
  }, [key]);

  const explain = () => {
    const asked = key;
    setBusy(asked);
    setError("");
    api
      .explainCommits(tabId, shas)
      .then((r) => {
        explained.set(asked, r.text);
        if (current.current === asked) setText(r.text);
      })
      .catch((e: Error) => {
        if (current.current === asked) setError(e.message);
      })
      .finally(() => setBusy((b) => (b === asked ? "" : b)));
  };

  if (text !== undefined) {
    return (
      <div className={s.box}>
        <div className={s.title}>
          <Icon name="sparkle" size={12} />
          Explanation
        </div>
        <div className={s.text}>{text}</div>
      </div>
    );
  }

  return (
    <div className={s.bar}>
      <button className={s.button} disabled={busy === key} onClick={explain}>
        <Icon name="sparkle" size={12} className={busy === key ? s.spin : ""} />
        {busy === key ? "Explaining..." : shas.length > 1 ? `Explain these ${shas.length} commits` : "Explain this commit"}
      </button>
      {error.length > 0 && <span className={s.error}>{error}</span>}
    </div>
  );
}
