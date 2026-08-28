import { useEffect, useState } from "react";
import type { Session, SshHost } from "../types";
import { api } from "../api";
import { RepoPicker } from "./RepoPicker";
import { Icon } from "./Icon";
import s from "./Welcome.module.scss";

export function Welcome({
  session,
  onOpen,
  error,
}: {
  session: Session;
  onOpen: (path: string, host?: string) => void;
  error: string | null;
}) {
  const [search, setSearch] = useState("");
  const [hosts, setHosts] = useState<SshHost[]>([]);
  /** The host being opened on, or null while the choice is this machine. */
  const [host, setHost] = useState<SshHost | null>(null);
  const [remotePath, setRemotePath] = useState("");
  /** Connecting is slow enough to need saying so: install, then a tunnel. */
  const [connecting, setConnecting] = useState(false);

  // A host added to ~/.ssh/config a minute ago is exactly the one somebody is
  // trying to reach, so this is read on arrival rather than cached.
  useEffect(() => {
    let live = true;
    api
      .hosts()
      .then((h) => live && setHosts(h))
      .catch(() => live && setHosts([]));
    return () => {
      live = false;
    };
  }, []);

  const f = search.trim().toLowerCase();
  const recents = session.recents.filter(
    (r) => f === "" || r.name.toLowerCase().includes(f) || r.path.toLowerCase().includes(f),
  );

  return (
    <div className={s.wrap}>
      <div className={s.columns}>
      <div className={s.main}>
        <h1>Repositories</h1>

        {/* A chromeless browser window has no native folder dialog, so gitc
            brings its own: a completing path field over a directory listing
            that marks repositories before you enter them. */}
        <RepoPicker onOpen={onOpen} />

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

      {hosts.length > 0 && (
        <div className={`${s.aside} ${s.remote}`}>
          <h2>On another machine</h2>
          {host === null ? (
            <div className={s.hosts}>
              {hosts.map((h) => (
                <button key={h.alias} className={s.host} onClick={() => setHost(h)}>
                  <Icon name="repo" size={13} />
                  <span className={s.hostAlias}>{h.alias}</span>
                  <span className={s.hostWhere}>
                    {h.user === null ? "" : h.user + "@"}
                    {h.hostName ?? h.alias}
                    {h.port === null ? "" : ":" + String(h.port)}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className={s.remoteOpen}>
              <div className={s.remoteHost}>
                <Icon name="repo" size={13} />
                <span className={s.hostAlias}>{host.alias}</span>
                <button className={s.change} onClick={() => setHost(null)} disabled={connecting}>
                  Change
                </button>
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const path = remotePath.trim();
                  if (path.length === 0 || connecting) return;
                  setConnecting(true);
                  onOpen(path, host.alias);
                }}
              >
                <input
                  className={s.search}
                  placeholder={"Path on " + host.alias + ", e.g. /srv/app"}
                  value={remotePath}
                  onChange={(e) => setRemotePath(e.target.value)}
                  disabled={connecting}
                  autoFocus
                />
              </form>
              {connecting && (
                <div className={s.connecting}>
                  Connecting to {host.alias} - installing gitc there if it is not already, then
                  opening a tunnel. This takes a moment the first time.
                </div>
              )}
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  );
}
