import { useState } from "react";
import type { Session } from "../types";
import s from "./Welcome.module.scss";

export function Welcome({
  session,
  onOpen,
  error,
}: {
  session: Session;
  onOpen: (path: string) => void;
  error: string | null;
}) {
  const [search, setSearch] = useState("");
  const [manual, setManual] = useState("");

  const f = search.trim().toLowerCase();
  const recents = session.recents.filter(
    (r) => f === "" || r.name.toLowerCase().includes(f) || r.path.toLowerCase().includes(f),
  );

  return (
    <div className={s.wrap}>
      <div className={s.main}>
        <h1>Repositories</h1>

        {/* A chromeless browser window has no native folder picker, so the
            path is typed or pasted. A real picker needs a host-side dialog. */}
        <div className={s.openRow}>
          <input
            className={s.pathInput}
            placeholder="C:\Code\my-project"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && manual.trim()) onOpen(manual.trim());
            }}
          />
          <button className={s.btn} onClick={() => manual.trim() && onOpen(manual.trim())}>
            Open
          </button>
          <button className={s.btn} disabled>
            Clone
          </button>
          <button className={s.btn} disabled>
            Create
          </button>
        </div>

        {error && <div className={s.error}>{error}</div>}

        <input
          className={s.search}
          placeholder="Search repositories"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <div className={s.recentLabel}>Recent</div>
        {recents.length === 0 && <div className={s.none}>No repositories yet.</div>}
        {recents.map((r) => (
          <div key={r.path} className={s.row} onClick={() => onOpen(r.path)}>
            <span className={s.name}>{r.name}</span>
            <span className={s.path}>{r.path}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
