import type {
  GitCall,
  Listing,
  UpdateInfo,
  UpdateProgress,
  UpdateResult,
  GraphPayload,
  Session,
  FileChange,
  FileDiff,
  WorkingFile,
  OpArgs,
  OpResult,
  ConflictState,
  ConflictVersions,
  Submodule,
  SshHost,
} from "./types";
import type { DiffTarget } from "./components/DiffView";

/**
 * Reads a JSON body that may not be valid UTF-8.
 *
 * Paths reach the engine as the operating system's raw bytes and leave it the
 * same way, so a Windows folder called "Café" arrives as a lone 0xe9 - correct
 * Windows-1252, invalid UTF-8. `res.json()` would turn every such byte into a
 * replacement character.
 *
 * The engine cannot fix this on its own: inspecting those bytes there means
 * charCodeAt, which re-reads the string as lenient UTF-8 and destroys them
 * before they can be re-encoded. The browser, on the other hand, has real
 * decoders. So the bytes are carried through untouched and decoded here:
 * strictly as UTF-8 first, which is what Linux and macOS give and what git
 * emits, and as Windows-1252 when that fails, which is what an ANSI name is.
 */
/**
 * The tab a request is about, taken from the request itself.
 *
 * The engine routes remote tabs on this header: a repository on another
 * machine is served by the gitc over there, and this is what tells the local
 * engine to pass the request through rather than answer it.
 *
 * Read off the URL and the body rather than passed in by every caller,
 * because a caller that forgets it does not fail loudly - it quietly asks the
 * wrong machine, and the answer looks plausible. Every repository call already
 * carries the id: in the query for reads, in the body for writes.
 *
 * Session-level calls carry an id too (close, activate) and will set the
 * header; the engine keeps a list of endpoints that never travel, so those are
 * answered locally regardless.
 */
function tabHeader(url: string, body?: unknown): Record<string, string> {
  const q = url.indexOf("?");
  if (q !== -1) {
    const id = new URLSearchParams(url.substring(q + 1)).get("id");
    if (id !== null && id.length > 0) return { "x-gitc-tab": id };
  }
  if (body !== null && typeof body === "object" && body !== undefined) {
    const id = (body as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0) return { "x-gitc-tab": id };
  }
  return {};
}

async function jsonBytes<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: tabHeader(url) });
  if (!res.ok) throw new Error(res.statusText);

  const buffer = await res.arrayBuffer();
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    text = new TextDecoder("windows-1252").decode(buffer);
  }
  return JSON.parse(text) as T;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { ...(init?.headers as Record<string, string>), ...tabHeader(url) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as {
      error?: string;
    };
    throw new Error(body.error ?? res.statusText);
  }
  return (await res.json()) as T;
}

function post<T>(url: string, body: unknown): Promise<T> {
  return json<T>(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...tabHeader(url, body) },
    body: JSON.stringify(body),
  });
}

export const api = {
  session: () => json<Session>("/api/session"),

  open: (path: string, host?: string) =>
    post<{ tab: unknown; session: Session }>("/api/open", { path, host: host ?? "" }),

  /** Hosts from ~/.ssh/config that a remote tab could be opened on. */
  hosts: () => json<{ hosts: SshHost[] }>("/api/hosts").then((r) => r.hosts),

  close: (id: string) => post<Session>("/api/close", { id }),

  activate: (id: string) => post<Session>("/api/activate", { id }),

  /** Persists the tab strip's left-to-right order after a drag. */
  reorder: (order: string[]) => post<Session>("/api/reorder", { order }),

  graph: (id: string, limit = 2000) =>
    json<GraphPayload>(`/api/graph?id=${encodeURIComponent(id)}&limit=${limit}`),

  /** Live submodule state, which the graph payload deliberately omits. */
  submodules: (id: string) =>
    json<{ submodules: Submodule[] }>(`/api/submodules?id=${encodeURIComponent(id)}`),

  rangeFiles: (id: string, from: string, to: string) =>
    json<{ files: FileChange[] }>(
      `/api/range?id=${encodeURIComponent(id)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ),

  diff: (id: string, target: DiffTarget, path: string, whole: boolean) => {
    const q = new URLSearchParams({ id, path, whole: whole ? "1" : "0" });
    if (target.kind === "commit") q.set("sha", target.sha);
    if (target.kind === "range") {
      q.set("from", target.from);
      q.set("to", target.to);
    }
    if (target.kind === "wip") {
      q.set("mode", target.staged ? "staged" : "wip");
      if (target.untracked) q.set("untracked", "1");
    }
    return json<FileDiff>(`/api/diff?${q.toString()}`);
  },

  /** The git commands run since `after`. Pass 0 for everything held. */
  gitLog: (after: number) =>
    json<{ calls: GitCall[] }>(`/api/gitlog?after=${after}`).then((r) => r.calls),

  /** Asks whether a newer gitc has been released. */
  checkUpdate: () => json<UpdateInfo>("/api/update"),

  /** How far along the running update is. */
  updateProgress: () => json<UpdateProgress>("/api/update/progress"),

  /** Downloads and installs it. gitc restarts itself when this succeeds. */
  applyUpdate: () => post<UpdateResult>("/api/update", {}),

  /** Lists a directory for the repository picker: completion and browsing. */
  ls: (path: string) => jsonBytes<Listing>(`/api/ls?path=${encodeURIComponent(path)}`),

  /** Replaces the hidden-ref set and returns the graph rebuilt without them. */
  setHidden: (id: string, hidden: string[]) =>
    post<GraphPayload>("/api/hidden", { id, hidden }),

  /** A value that changes whenever the repository changes on disk. */
  watch: (id: string) =>
    json<{ version: string; fetched: number }>(`/api/watch?id=${encodeURIComponent(id)}`),

  conflicts: (id: string) =>
    json<ConflictState>(`/api/conflicts?id=${encodeURIComponent(id)}`),

  conflictVersions: (id: string, path: string) =>
    json<ConflictVersions>(
      `/api/conflict?id=${encodeURIComponent(id)}&path=${encodeURIComponent(path)}`,
    ),

  /** Resolves by taking a whole side, or "delete" / "unresolve". */
  resolveSide: (id: string, path: string, side: string) =>
    post<ConflictState>("/api/resolve", { id, path, side, content: "", paths: [] }),

  /** Resolves by writing edited content. */
  resolveContent: (id: string, path: string, content: string) =>
    post<ConflictState>("/api/resolve", { id, path, side: "", content, paths: [] }),

  /** Stages every conflicted file as it stands. */
  resolveAll: (id: string, paths: string[]) =>
    post<ConflictState>("/api/resolve", { id, path: "", side: "", content: "", paths }),

  /**
   * Runs a repository operation.
   *
   * Every field is sent, blank when unused, so the engine never has to guess
   * whether an absent field means "empty" or "not supplied" - an empty string
   * is a real argument to git and fails in confusing ways.
   */
  op: (id: string, args: OpArgs) =>
    post<OpResult>("/api/op", {
      id,
      op: args.op,
      ref: args.ref ?? "",
      shas: args.shas ?? [],
      name: args.name ?? "",
      mode: args.mode ?? "",
      message: args.message ?? "",
      remote: args.remote ?? "",
      force: args.force ?? false,
      checkout: args.checkout ?? false,
      path: args.path ?? "",
      patch: args.patch ?? "",
    }),

  // --- mutations. Each returns the fresh status so the panel updates from
  // one round trip. `paths: []` means "everything".
  stage: (id: string, paths: string[]) =>
    post<{ status: WorkingFile[] }>("/api/stage", { id, paths }),

  unstage: (id: string, paths: string[]) =>
    post<{ status: WorkingFile[] }>("/api/unstage", { id, paths }),

  discard: (id: string, tracked: string[], untracked: string[]) =>
    post<{ status: WorkingFile[] }>("/api/discard", { id, tracked, untracked }),

  commit: (id: string, summary: string, description: string, amend: boolean) =>
    post<{ hash: string; summary: string }>("/api/commit", {
      id,
      summary,
      description,
      amend,
    }),

  headMessage: (id: string) =>
    json<{ summary: string; description: string }>(
      `/api/headmessage?id=${encodeURIComponent(id)}`,
    ),

  commitFiles: (id: string, sha: string) =>
    json<{ files: FileChange[] }>(
      `/api/commit?id=${encodeURIComponent(id)}&sha=${encodeURIComponent(sha)}`,
    ),
};
