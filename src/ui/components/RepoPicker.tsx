import { useCallback, useEffect, useRef, useState } from "react";
import type { DirEntry, Listing } from "../types";
import { api } from "../api";
import { Icon } from "./Icon";
import s from "./RepoPicker.module.scss";

/**
 * Finding a repository on disk.
 *
 * Typing an absolute path from memory, with no completion and no way to look
 * around, is the worst possible way to open a project - so this is both a
 * completing path field and a small file browser over the same listing.
 *
 * Two things it does that a plain input cannot: it marks which folders are git
 * repositories BEFORE you walk into them, and it appends the separator when
 * you accept a directory, so a path is walked one keystroke per level rather
 * than typed out.
 *
 * It starts at the home directory. There is no placeholder path, because any
 * example is wrong on somebody's machine.
 */
export function RepoPicker({
  onOpen,
  host,
}: {
  onOpen: (path: string) => void;
  /** Browse this machine instead of the local one. */
  host?: string;
}) {
  const [value, setValue] = useState("");
  const [listing, setListing] = useState<Listing | null>(null);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Only the newest response may land: directory listings return out of order
  // when one directory is slow and the next keystroke's is not.
  const request = useRef(0);

  const load = useCallback(
    async (path: string) => {
    const id = ++request.current;
    setLoading(true);
    try {
      const r = await api.ls(path, host);
      if (request.current !== id) return;
      setListing(r);
      setActive(0);
      // The first listing seeds the field, which is how it starts at home
      // without hardcoding what home looks like on this platform.
      setValue((v) => (v.length === 0 ? r.path + r.sep : v));
    } catch {
      if (request.current === id) setListing(null);
    } finally {
      if (request.current === id) setLoading(false);
    }
    },
    // Changing machine re-lists from scratch: the previous listing is another
    // filesystem's, and its paths mean nothing here.
    [host],
  );

  useEffect(() => {
    // Cleared first, so the seeding in load() takes. A path typed for one
    // machine is meaningless on another, and a Windows path left in the box
    // while listing a Linux server is worse than meaningless.
    setValue("");
    setListing(null);
    void load("");
    input.current?.focus();
  }, [load]);

  // Debounced: typing a path should not spawn a listing per character.
  useEffect(() => {
    if (value.length === 0) return;
    const t = setTimeout(() => void load(value), 120);
    return () => clearTimeout(t);
  }, [value, load]);

  const sep = listing?.sep ?? "/";
  const prefix = listing?.prefix ?? "";
  const matches = (listing?.entries ?? []).filter((e) =>
    prefix.length === 0 ? true : e.name.toLowerCase().startsWith(prefix.toLowerCase()),
  );

  /** Walks into a directory: fills the field and lists it. */
  const enter = useCallback(
    (entry: DirEntry) => {
      if (listing === null) return;
      const next = listing.path.replace(/[\\/]+$/, "") + sep + entry.name + sep;
      setValue(next);
      void load(next);
      input.current?.focus();
    },
    [listing, sep, load],
  );

  const goUp = useCallback(() => {
    if (listing?.parent == null) return;
    const next = listing.parent + (listing.parent.endsWith(sep) ? "" : sep);
    setValue(next);
    void load(next);
    input.current?.focus();
  }, [listing, sep, load]);

  const openCurrent = useCallback(() => {
    const path = value.trim().replace(/[\\/]+$/, "");
    if (path.length > 0) onOpen(path);
  }, [value, onOpen]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(matches.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Tab") {
      // Tab completes without leaving the field - the shell behaviour.
      e.preventDefault();
      const hit = matches[active];
      if (hit) enter(hit);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = matches[active];
      // A highlighted repository opens; a highlighted plain folder is walked
      // into. With nothing highlighted, Enter opens whatever is typed.
      if (prefix.length > 0 && hit) {
        if (hit.repo) onOpen(listing!.path.replace(/[\\/]+$/, "") + sep + hit.name);
        else enter(hit);
      } else {
        openCurrent();
      }
    } else if (e.key === "Escape") {
      input.current?.blur();
    }
  };

  // Keep the highlighted row in view when arrowing through a long directory.
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const canOpen = listing !== null && listing.repo && prefix.length === 0;

  return (
    <div className={s.picker}>
      <div className={s.field}>
        <Icon name="search" size={13} className={s.fieldIco} />
        <input
          ref={input}
          className={s.input}
          value={value}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button className={s.open} disabled={!canOpen} onClick={openCurrent} title="Open this repository">
          Open
        </button>
      </div>

      {/* The path is already in the field above; repeating it here was just
          the same string twice. Only what the field cannot say goes here. */}
      {listing !== null && (listing.repo || loading) && (
        <div className={s.crumbs}>
          {listing.repo && <span className={s.badge}>git repository</span>}
          {loading && <span className={s.loading}>…</span>}
        </div>
      )}

      <div className={s.list} ref={listRef}>
        {listing?.parent != null && (
          <div className={s.row} onClick={goUp}>
            <Icon name="folder" size={13} className={s.rowIco} />
            <span className={s.name}>..</span>
          </div>
        )}

        {matches.map((entry, i) => (
          <div
            key={entry.name}
            data-idx={i}
            className={`${s.row} ${i === active ? s.active : ""} ${entry.repo ? s.repo : ""}`}
            onMouseEnter={() => setActive(i)}
            onClick={() => enter(entry)}
            onDoubleClick={() => {
              if (entry.repo && listing) {
                onOpen(listing.path.replace(/[\\/]+$/, "") + sep + entry.name);
              }
            }}
            title={entry.repo ? "Double-click to open this repository" : entry.name}
          >
            <Icon name={entry.repo ? "branch" : "folder"} size={13} className={s.rowIco} />
            <span className={s.name}>{entry.name}</span>
            {entry.repo && <span className={s.rowBadge}>repo</span>}
          </div>
        ))}

        {listing !== null && matches.length === 0 && (
          <div className={s.empty}>
            {listing.entries.length === 0 ? "No folders here" : "Nothing matches"}
          </div>
        )}
        {listing?.truncated && (
          <div className={s.empty}>Only the first 500 folders are listed.</div>
        )}
      </div>
    </div>
  );
}
