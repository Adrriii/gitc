// Shapes returned by the gitc engine's HTTP API. These mirror the interfaces
// in src/engine - kept as a separate declaration because the UI is bundled by
// Vite while the engine is compiled by scriptc.

export interface Tab {
  id: string;
  name: string;
  path: string;
}

export interface Session {
  tabs: Tab[];
  activeId: string | null;
  recents: Tab[];
}

export interface Head {
  branch: string | null;
  hash: string | null;
  detached: boolean;
}

export interface Remote {
  name: string;
  url: string;
  /** Push URL when it differs from the fetch URL, otherwise "". */
  pushUrl: string;
}

export interface Ref {
  name: string;
  short: string;
  hash: string;
  kind: "local" | "remote" | "tag";
  remote: string | null;
}

export interface Person {
  name: string;
  email: string;
}

export interface Commit {
  hash: string;
  parents: string[];
  subject: string;
  body: string;
  author: string;
  email: string;
  date: number;
  lane: number;
  color: number;
  refs: string[];
  /** People credited by Co-authored-by: trailers in the message. */
  coAuthors: Person[];
}

export interface Through {
  lane: number;
  color: number;
}

export interface Link {
  from: number;
  to: number;
  color: number;
}

export interface GraphRow {
  hash: string;
  lane: number;
  color: number;
  through: Through[];
  merges: Link[];
  forks: Link[];
  hasTop: boolean;
  hasBottom: boolean;
  width: number;
}

export interface WorkingFile {
  path: string;
  index: string;
  worktree: string;
  staged: boolean;
  untracked: boolean;
}

export interface FileChange {
  status: string;
  path: string;
  oldPath: string | null;
}

export interface Pending {
  /** merge | cherry-pick | revert | rebase | bisect, or "" when idle. */
  kind: string;
  conflicted: boolean;
}

/** What an operation can be asked to do. Unused fields are simply blank. */
export interface OpArgs {
  op: string;
  ref?: string;
  shas?: string[];
  name?: string;
  mode?: string;
  message?: string;
  remote?: string;
  force?: boolean;
  checkout?: boolean;
}

export interface OpResult {
  ok: boolean;
  note: string;
  pending: string;
}

export interface GraphPayload {
  head: Head;
  /** Remotes configured for this repository. */
  remotes: string[];
  /** The same remotes with their URLs. */
  remoteDetail: Remote[];
  /** Upstream of the checked-out branch, as "remote/branch". */
  upstream: string | null;
  refs: Ref[];
  commits: Commit[];
  rows: GraphRow[];
  status: WorkingFile[];
  pending: Pending;
  /** Ref display names hidden from the graph. */
  hidden: string[];
  colors: string[];
}

export type LineKind = "context" | "add" | "del" | "meta";

export interface DiffLine {
  kind: LineKind;
  oldNo: number | null;
  newNo: number | null;
  text: string;
  noNewline: boolean;
}

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  heading: string;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  oldPath: string | null;
  binary: boolean;
  tooLarge: boolean;
  status: string;
  hunks: Hunk[];
  whole: boolean;
}

export type ConflictKind =
  | "both-modified"
  | "both-added"
  | "both-deleted"
  | "added-by-us"
  | "added-by-them"
  | "deleted-by-us"
  | "deleted-by-them";

export interface ConflictFile {
  path: string;
  kind: ConflictKind;
  /** One side deleted the file: keep-or-drop rather than a line merge. */
  deletion: boolean;
}

export interface ResolvedFile {
  path: string;
  status: string;
}

export interface RebaseProgress {
  current: number;
  total: number;
  subject: string;
  branch: string;
  onto: string;
  ontoName: string;
}

export interface ConflictState {
  operation: string;
  conflicted: ConflictFile[];
  resolved: ResolvedFile[];
  progress: RebaseProgress | null;
  message: string;
  /** Stash entries held; a conflicted pop keeps its entry. */
  stashes: number;
}

export interface ConflictVersions {
  path: string;
  base: string;
  ours: string;
  theirs: string;
  merged: string;
  binary: boolean;
  hasBase: boolean;
  hasOurs: boolean;
  hasTheirs: boolean;
}
