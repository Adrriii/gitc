use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Tab {
    pub id: String,
    pub name: String,
    pub path: String,
    pub host: Option<String>,
    pub workspaces: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub active_id: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Session {
    pub tabs: Vec<Tab>,
    pub active_id: Option<String>,
    pub recents: Vec<Tab>,
    pub workspaces: Vec<Workspace>,
    pub workspace: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RemoteState {
    pub host: String,
    /// "online" | "connecting" | "offline"
    pub state: String,
    pub version: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Ping {
    pub version: String,
    pub remotes: Vec<RemoteState>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SshHost {
    pub alias: String,
    pub host_name: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RemotePlan {
    pub host: String,
    /// "ready" | "install" | "replace" | "refused"
    pub action: String,
    pub have: Option<String>,
    pub want: String,
    pub path: String,
    pub refusal: Option<String>,
    pub approved: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Head {
    pub branch: Option<String>,
    pub hash: Option<String>,
    pub detached: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DirEntry {
    pub name: String,
    pub dir: bool,
    pub repo: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Listing {
    pub path: String,
    pub repo: bool,
    pub parent: Option<String>,
    pub prefix: String,
    pub entries: Vec<DirEntry>,
    pub truncated: bool,
    pub sep: String,
    pub home: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Submodule {
    pub name: String,
    pub path: String,
    pub absolute: String,
    pub url: String,
    /// "uninitialized" | "current" | "moved" | "conflicted" | "dirty" | "pending"
    pub state: String,
    pub sha: String,
    pub label: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct GitCall {
    pub id: u64,
    pub seq: u64,
    pub at: u64,
    pub args: String,
    pub repo: String,
    pub ms: u64,
    pub ok: bool,
    pub count: u32,
    pub running: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct UpdateProgress {
    /// "idle" | "checking" | "downloading" | "verifying" | "installing" | "restarting" | "failed"
    pub phase: String,
    pub received: u64,
    pub total: u64,
    pub message: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct UpdateInfo {
    pub current: String,
    pub switching: bool,
    pub latest: String,
    pub available: bool,
    pub page: String,
    pub error: String,
    pub stream: String,
    pub streams: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CrashReport {
    pub id: String,
    pub time: String,
    pub version: String,
    pub platform: String,
    pub source: String,
    pub message: String,
    pub detail: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CrashList {
    pub dir: String,
    pub reports: Vec<CrashReport>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ReleaseNotes {
    pub version: String,
    pub notes: String,
    pub page: String,
    pub error: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct UpdateResult {
    pub ok: bool,
    pub message: String,
    pub restarting: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Remote {
    pub name: String,
    pub url: String,
    pub push_url: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Ref {
    pub name: String,
    pub short: String,
    pub hash: String,
    /// "local" | "remote" | "tag"
    pub kind: String,
    pub remote: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Person {
    pub name: String,
    pub email: String,
}

/// A commit as git gives it, before the graph places it.
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RawCommit {
    pub hash: String,
    pub parents: Vec<String>,
    pub subject: String,
    pub body: String,
    pub author: String,
    pub email: String,
    pub date: i64,
    pub co_authors: Vec<Person>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Commit {
    pub hash: String,
    pub parents: Vec<String>,
    pub subject: String,
    pub body: String,
    pub author: String,
    pub email: String,
    pub date: i64,
    pub lane: usize,
    pub color: usize,
    pub refs: Vec<String>,
    pub co_authors: Vec<Person>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Through {
    pub lane: usize,
    pub color: usize,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Link {
    pub from: usize,
    pub to: usize,
    pub color: usize,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct GraphRow {
    pub hash: String,
    pub lane: usize,
    pub color: usize,
    pub through: Vec<Through>,
    pub merges: Vec<Link>,
    pub forks: Vec<Link>,
    pub has_top: bool,
    pub has_bottom: bool,
    pub width: usize,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkingFile {
    pub path: String,
    pub index: String,
    pub worktree: String,
    pub staged: bool,
    pub untracked: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct FileChange {
    pub status: String,
    pub path: String,
    pub old_path: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct LineCounts {
    pub added: u64,
    pub removed: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct FileList {
    pub files: Vec<FileChange>,
    pub added: u64,
    pub removed: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct WorktreeChanges {
    pub files: u64,
    pub added: u64,
    pub removed: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Pending {
    /// merge | cherry-pick | revert | rebase | bisect | unmerged, or "" when idle.
    pub kind: String,
    pub conflicted: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct OpArgs {
    pub op: String,
    pub r#ref: String,
    pub shas: Vec<String>,
    pub name: String,
    pub mode: String,
    pub message: String,
    pub remote: String,
    pub force: bool,
    pub checkout: bool,
    pub path: String,
    pub patch: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PushRefusal {
    /// "none" | "rewrite" | "diverged"
    pub kind: String,
    pub upstream: String,
    pub ahead: u64,
    pub behind: u64,
    pub theirs: u64,
    pub their_commits: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct OpResult {
    pub ok: bool,
    pub note: String,
    pub pending: String,
    pub refusal: PushRefusal,
    pub warn: bool,
    pub confirm: String,
    pub push_to: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct StashRef {
    pub selector: String,
    pub subject: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Worktree {
    pub name: String,
    pub path: String,
    pub main: bool,
    pub current: bool,
    pub branch: Option<String>,
    pub hash: Option<String>,
    pub detached: bool,
    pub locked: bool,
    pub lock_reason: String,
    pub prunable: bool,
    pub pending: String,
    pub idle_ms: i64,
    pub status: Vec<WorkingFile>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct GraphPayload {
    pub head: Head,
    pub remotes: Vec<String>,
    pub remote_detail: Vec<Remote>,
    pub upstream: Option<String>,
    pub upstreams: BTreeMap<String, String>,
    pub refs: Vec<Ref>,
    pub commits: Vec<Commit>,
    pub rows: Vec<GraphRow>,
    pub status: Vec<WorkingFile>,
    pub pending: Pending,
    pub hidden: Vec<String>,
    pub submodules: Vec<Submodule>,
    pub stashes: Vec<StashRef>,
    pub worktrees: Vec<Worktree>,
    pub colors: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Watch {
    pub version: String,
    pub fetched: i64,
}

/// What a diff or a media read is about.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DiffTarget {
    Commit {
        sha: String,
    },
    Range {
        from: String,
        to: String,
    },
    Wip {
        staged: bool,
        untracked: bool,
        /// Another worktree's changes, by name; read-only.
        #[serde(default)]
        worktree: Option<String>,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DiffLine {
    /// "context" | "add" | "del" | "meta"
    pub kind: String,
    pub old_no: Option<u64>,
    pub new_no: Option<u64>,
    pub text: String,
    pub no_newline: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Hunk {
    pub old_start: u64,
    pub old_count: u64,
    pub new_start: u64,
    pub new_count: u64,
    pub heading: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub binary: bool,
    pub too_large: bool,
    pub status: String,
    pub hunks: Vec<Hunk>,
    pub whole: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Media {
    /// The bytes, base64-encoded so they travel over the remote protocol.
    pub data: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ConflictFile {
    pub path: String,
    /// both-modified | both-added | both-deleted | added-by-us | added-by-them | deleted-by-us | deleted-by-them
    pub kind: String,
    pub deletion: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ResolvedFile {
    pub path: String,
    pub status: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RebaseProgress {
    pub current: u64,
    pub total: u64,
    pub subject: String,
    pub branch: String,
    pub onto: String,
    pub onto_name: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ConflictState {
    pub operation: String,
    pub conflicted: Vec<ConflictFile>,
    pub resolved: Vec<ResolvedFile>,
    pub progress: Option<RebaseProgress>,
    pub message: String,
    pub stashes: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ConflictVersions {
    pub path: String,
    pub base: String,
    pub ours: String,
    pub theirs: String,
    pub merged: String,
    pub binary: bool,
    pub has_base: bool,
    pub has_ours: bool,
    pub has_theirs: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AiProvider {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub base_url: String,
    pub key: String,
    pub model: String,
    pub account: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AiRepoProvider {
    pub host: String,
    pub path: String,
    pub provider_id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AiConfig {
    pub enabled: bool,
    pub features: Vec<String>,
    pub providers: Vec<AiProvider>,
    pub default_id: String,
    pub repos: Vec<AiRepoProvider>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ClaudeStatus {
    pub installed: bool,
    pub logged_in: bool,
    pub plan: String,
    pub email: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AiModel {
    pub id: String,
    pub label: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AiConflictHunk {
    pub ours: Vec<String>,
    pub theirs: Vec<String>,
    pub base: Option<Vec<String>>,
    pub before: Vec<String>,
    pub after: Vec<String>,
}

/// `{ ours, theirs }` or `{ reason }`, as the TS engine sent it.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AiPick {
    pub ours: Option<Vec<usize>>,
    pub theirs: Option<Vec<usize>>,
    pub reason: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Message {
    pub summary: String,
    pub description: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CommitDone {
    pub hash: String,
    pub summary: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Opened {
    pub tab: Tab,
    pub session: Session,
}

/// What an AI task is given about the repository.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CommitContext {
    pub diff: String,
    pub numstat: String,
    pub recent: Vec<String>,
}
