import { useCallback, useEffect, useState } from "react";
import type { RemotePlan, Session, SshHost } from "../types";
import { api } from "../api";
import { RepoPicker } from "./RepoPicker";
import { Confirm } from "./Confirm";
import { Icon } from "./Icon";
import s from "./Welcome.module.scss";

/** What to do once an install has been agreed to, or found not to be needed. */
type Go = () => void | Promise<void>;

export function Welcome({
  session,
  onOpen,
  error,
}: {
  session: Session;
  /**
   * Returns when the attempt is over, so a failed one can be recovered from.
   * Opening a remote repository can fail - host unreachable, path gone - and
   * App turns that into an error message rather than a rejection, so this
   * settling is the only signal Welcome gets.
   */
  onOpen: (path: string, host?: string) => Promise<void>;
  error: string | null;
}) {
  const [search, setSearch] = useState("");
  const [hosts, setHosts] = useState<SshHost[]>([]);
  /** The host being opened on, or null while the choice is this machine. */
  const [host, setHost] = useState<SshHost | null>(null);
  /** Connecting is slow enough to need saying so: install, then a tunnel. */
  const [connecting, setConnecting] = useState(false);
  /**
   * The recent being opened.
   *
   * A remote one takes seconds to connect, and until the tab appears nothing
   * on screen changed - which reads as the click not having registered, and
   * is what made people click again and open it twice.
   */
  const [opening, setOpening] = useState<string | null>(null);
  /**
   * The install being agreed to, and what to do once it is.
   *
   * A remote tab is a gitc running on that machine, which gitc puts there
   * itself - so reaching a host for the first time writes a binary into
   * somebody's home directory. That is asked for here rather than done on the
   * first directory listing, and the engine refuses to install without the
   * answer, so this dialog is the only way past it.
   */
  const [ask, setAsk] = useState<{ plan: RemotePlan; go: Go } | null>(null);
  /**
   * The machine being asked about, while it is being asked.
   *
   * Two ssh round trips, on a host that may be slow or asleep - long enough
   * that a list which looked idle got clicked twice.
   */
  const [checking, setChecking] = useState<string | null>(null);

  /**
   * Runs `go`, first asking about an install if one is coming.
   *
   * Anything the plan cannot answer - an engine that did not reply, a machine
   * gitc refuses outright - goes the ordinary way and reports itself through
   * the error line. Only an install that would actually happen stops here.
   *
   * `go` is awaited rather than fired, so a caller marking its row busy can
   * clear it on this promise: it settles when the open does, and immediately
   * when the question is put instead - which is the moment the row has to
   * become clickable again, because the dialog is now the thing to answer.
   */
  const beforeInstalling = useCallback(async (host: string, go: Go) => {
    try {
      const plan = await api.remotePlan(host);
      if (!plan.approved && (plan.action === "install" || plan.action === "replace")) {
        setAsk({ plan, go });
        return;
      }
    } catch {
      // The question is a courtesy; the refusal is the engine's, and it still
      // stands whatever this call did.
    }
    await go();
  }, []);

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

  /**
   * How a remote recent is labelled: the resolved destination when the alias
   * is still in ~/.ssh/config, and the alias itself when it is not.
   *
   * "server" says nothing about which machine that was six months later, and
   * the same path exists on several of them.
   */
  const where = (host: string): string => {
    const known = hosts.find((h) => h.alias === host);
    if (known === undefined) return host;
    const user = known.user === null ? "" : known.user + "@";
    return user + (known.hostName ?? known.alias);
  };

  const f = search.trim().toLowerCase();
  const recents = session.recents.filter(
    (r) =>
      f === "" ||
      r.name.toLowerCase().includes(f) ||
      r.path.toLowerCase().includes(f) ||
      // Findable by machine too: "which repositories were on the build box?"
      (r.host !== null && where(r.host).toLowerCase().includes(f)),
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
          // Keyed by host and path: the same path on two machines is two
          // different repositories.
          <div
            key={(r.host ?? "") + r.path}
            className={`${s.row} ${opening !== null ? s.rowBusy : ""}`}
            // Reopened on the machine it came from. Without the host this
            // asked the local filesystem for a path that only exists on a
            // server, and failed in a way that looked like the repository had
            // been deleted.
            onClick={() => {
              if (opening !== null) return;
              const key = (r.host ?? "") + r.path;
              // Cleared however it ends. On success this screen is replaced by
              // the tab, so the reset is invisible; on failure it is the only
              // thing that lets the list be clicked again. Without it one
              // unreachable host left every row inert until gitc restarted.
              const open = () => {
                setOpening(key);
                return onOpen(r.path, r.host ?? undefined).finally(() => setOpening(null));
              };
              if (r.host === null) {
                void open();
                return;
              }
              // A recent on a machine gitc has never installed on is the same
              // first install as picking that machine from the list - the same
              // question, asked in the same words. Marked busy for the check
              // as well as the open: it is two ssh round trips, and a row that
              // looks idle for them is a row that gets clicked twice.
              setOpening(key);
              void beforeInstalling(r.host, open).finally(() => setOpening(null));
            }}
          >
            <span className={s.name}>{r.name}</span>
            {r.host !== null && (
              <span className={s.rowHost} title={"On " + where(r.host)}>
                <Icon name="repo" size={11} />
                {where(r.host)}
              </span>
            )}
            <span className={s.path}>{r.path}</span>
            {opening === (r.host ?? "") + r.path && (
              <span className={s.opening}>Opening...</span>
            )}
          </div>
        ))}
      </div>

      {hosts.length > 0 && (
        <div className={`${s.aside} ${s.remote}`}>
          <h2>On another machine</h2>
          {host === null ? (
            <div className={s.hosts}>
              {hosts.map((h) => (
                <button
                  key={h.alias}
                  className={s.host}
                  disabled={checking !== null}
                  onClick={() => {
                    if (checking !== null) return;
                    setChecking(h.alias);
                    void beforeInstalling(h.alias, () => setHost(h)).finally(() =>
                      setChecking(null),
                    );
                  }}
                >
                  <Icon name="repo" size={13} />
                  <span className={s.hostAlias}>{h.alias}</span>
                  <span className={s.hostWhere}>
                    {h.user === null ? "" : h.user + "@"}
                    {h.hostName ?? h.alias}
                    {h.port === null ? "" : ":" + String(h.port)}
                  </span>
                </button>
              ))}
              {checking !== null && (
                <div className={s.connecting}>Checking {checking}...</div>
              )}
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
              {/* The same picker as the local one, browsing that machine.
                  The first listing is slow - it installs gitc there and opens
                  the tunnel - and every one after it is down the same tunnel. */}
              <RepoPicker
                host={host.alias}
                onOpen={(path) => {
                  setConnecting(true);
                  // Same reason as the recents: a directory that is not a
                  // repository, or a host that refuses, otherwise leaves this
                  // true for ever - and Change is disabled while it is, so
                  // there was no way back to the host list or the local picker.
                  void onOpen(path, host.alias).finally(() => setConnecting(false));
                }}
              />
              {connecting && (
                <div className={s.connecting}>
                  Opening {host.alias}...
                </div>
              )}
            </div>
          )}
        </div>
      )}
      </div>

      {ask !== null && (
        <Confirm
          title={
            (ask.plan.action === "install" ? "Install gitc on " : "Replace gitc on ") +
            ask.plan.host +
            "?"
          }
          body={
            <>
              <p>
                A repository on another machine is opened by a gitc running{" "}
                <i>on that machine</i>, and gitc puts it there itself.
              </p>
              {ask.plan.action === "install" ? (
                <p>
                  gitc <b>{ask.plan.want}</b> will be written to <b>{ask.plan.path}</b> on{" "}
                  <b>{ask.plan.host}</b> - downloaded there from the release page, or sent from
                  here if that machine has no route to the internet. Nothing else on it is
                  touched, and none of it needs root.
                </p>
              ) : (
                <p>
                  <b>{ask.plan.host}</b> has gitc <b>{ask.plan.have}</b> and this one is{" "}
                  <b>{ask.plan.want}</b>. The two halves of gitc talk to each other across the
                  connection, so they have to be the same version - <b>{ask.plan.path}</b> will be
                  replaced.
                </p>
              )}
              <p>gitc will not ask again for this machine.</p>
            </>
          }
          confirmLabel={ask.plan.action === "install" ? "Install gitc" : "Replace it"}
          onConfirm={() => {
            const { plan, go } = ask;
            setAsk(null);
            // The approval is what the engine reads; going ahead before it is
            // written would be refused by the gate it exists to open.
            void api
              .approveRemote(plan.host)
              .then(go)
              // An approval that could not be saved is not a reason to lose
              // the click: the open goes ahead and reports the refusal itself.
              .catch(go);
          }}
          onCancel={() => setAsk(null)}
        />
      )}
    </div>
  );
}
