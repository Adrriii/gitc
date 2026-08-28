// Shapes returned by the gitc engine's HTTP API. These mirror the interfaces
// in src/engine - kept as a separate declaration because the UI is bundled by
// Vite while the engine is compiled by scriptc.

export interface Tab {
  id: string;
  name: string;
  /** The repository's path ON THE MACHINE THAT HOLDS IT - remote or not. */
  path: string;
  /**
   * The ssh destination this repository lives on, or null for this machine.
   *
   * A remote tab is served by a gitc running over there; everything the window
   * asks about it is answered by that engine and passed through this one. The
   * id is deliberately the SAME on both sides - see openRepo - so nothing has
   * to be rewritten in transit.
   */
  host: string | null;
}

/** A host offered by ~/.ssh/config. */
export interface SshHost {
  alias: string;
  hostName: string | null;
  user: string | null;
  port: number | null;
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

export interface DirEntry {
  name: string;
  dir: boolean;
  /** A git repository - marked before you walk into it. */
  repo: boolean;
}

export interface Listing {
  path: string;
  repo: boolean;
  parent: string | null;
  /** What was typed after the last separator, when it was a partial name. */
  prefix: string;
  entries: DirEntry[];
  truncated: boolean;
  sep: string;
  home: string;
}

/** "pending" means the live state has not been fetched yet - see api.submodules. */
export type SubmoduleState =
  | "uninitialized"
  | "current"
  | "moved"
  | "conflicted"
  | "dirty"
  | "pending";

export interface Submodule {
  name: string;
  path: string;
  /** Absolute, so it can be opened as its own repository tab. */
  absolute: string;
  url: string;
  state: SubmoduleState;
  sha: string;
  label: string;
}

export interface GitCall {
  /** Stable for the entry's whole life. */
  id: number;
  /** Bumped on every change; what the poll asks against. */
  seq: number;
  /** Milliseconds since the epoch. */
  at: number;
  /** The command as typed, without the leading "git". */
  args: string;
  repo: string;
  ms: number;
  ok: boolean;
  /** How many times this command ran in a row. */
  count: number;
  /** Still running - `ms` means nothing yet. */
  running: boolean;
}

export interface UpdateProgress {
  phase: "idle" | "checking" | "downloading" | "verifying" | "installing" | "restarting" | "failed";
  /** Bytes fetched so far, and the total when the server declared one. */
  received: number;
  total: number;
  message: string;
}

export interface UpdateInfo {
  current: string;
  latest: string;
  available: boolean;
  page: string;
  error: string;
}

export interface UpdateResult {
  ok: boolean;
  message: string;
  restarting: boolean;
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
  /** Repository-relative file path, for operations that act on one. */
  path?: string;
  /** A unified diff, for operations that apply one. */
  patch?: string;
}

/**
 * Why a push was refused. `kind` is "none" when nothing was.
 *
 * "rewrite"  the remote holds older versions of our own commits (a rebase,
 *            an amend, a squash) - forcing loses nothing.
 * "diverged" the remote holds work that is not ours - forcing destroys it.
 */
export interface PushRefusal {
  kind: string;
  upstream: string;
  ahead: number;
  behind: number;
  theirs: number;
  theirCommits: string[];
}

export interface OpResult {
  ok: boolean;
  note: string;
  pending: string;
  refusal: PushRefusal;
  /** It worked, but not the way it was probably meant to - amber, not green. */
  warn: boolean;
  /** A question; answering yes re-runs the same operation with force. */
  confirm: string;
}

/** A stash entry, as the sidebar lists it. */
export interface StashRef {
  /** "stash@{0}" - positional, and shifts whenever any stash is added or dropped. */
  selector: string;
  subject: string;
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
  submodules: Submodule[];
  /** Newest first, the order `git stash list` gives them. */
  stashes: StashRef[];
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
