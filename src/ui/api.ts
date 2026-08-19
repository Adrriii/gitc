import type {
  GraphPayload,
  Session,
  FileChange,
  FileDiff,
  WorkingFile,
  OpArgs,
  OpResult,
  ConflictState,
  ConflictVersions,
} from "./types";
import type { DiffTarget } from "./components/DiffView";

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
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
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export const api = {
  session: () => json<Session>("/api/session"),

  open: (path: string) => post<{ tab: unknown; session: Session }>("/api/open", { path }),

  close: (id: string) => post<Session>("/api/close", { id }),

  activate: (id: string) => post<Session>("/api/activate", { id }),

  graph: (id: string, limit = 2000) =>
    json<GraphPayload>(`/api/graph?id=${encodeURIComponent(id)}&limit=${limit}`),

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

  /** Replaces the hidden-ref set and returns the graph rebuilt without them. */
  setHidden: (id: string, hidden: string[]) =>
    post<GraphPayload>("/api/hidden", { id, hidden }),

  /** A value that changes whenever the repository changes on disk. */
  watch: (id: string) =>
    json<{ version: string }>(`/api/watch?id=${encodeURIComponent(id)}`),

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
