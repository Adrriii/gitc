use std::any::{Any, TypeId};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::types::*;
use super::{
    actions, ai, ai_tasks, approvals, browse, conflicts, crashes, diff, git, media, ops, payload, refs, remote,
    session, ssh_config, submodules, update, visibility, watch, worktrees,
};

pub const DEFAULT_LIMIT: usize = 2000;

/// Everything the window can ask the engine.
///
/// The same enum travels to a remote gitc as one JSON line, so a request names
/// its tab by id and the engine decides which machine answers it.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "call", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Request {
    Ping,
    Session,
    Open {
        path: String,
        host: String,
        want_id: Option<String>,
    },
    SetRemoteHold {
        minutes: u64,
    },
    Hosts,
    RemotePlan {
        host: String,
    },
    ApproveRemote {
        host: String,
    },
    ApprovedRemotes,
    RevokeRemote {
        host: String,
    },
    Close {
        id: String,
        next: Option<String>,
        everywhere: bool,
    },
    Workspace {
        id: String,
    },
    AddWorkspace {
        name: String,
    },
    ReorderWorkspaces {
        order: Vec<String>,
    },
    RenameWorkspace {
        id: String,
        name: String,
    },
    RemoveWorkspace {
        id: String,
    },
    TabWorkspaces {
        id: String,
        workspaces: Vec<String>,
    },
    Activate {
        id: String,
    },
    Reorder {
        order: Vec<String>,
    },
    Graph {
        id: String,
        limit: usize,
    },
    Submodules {
        id: String,
    },
    Worktrees {
        id: String,
    },
    RangeFiles {
        id: String,
        from: String,
        to: String,
    },
    Media {
        id: String,
        target: DiffTarget,
        path: String,
        old_path: Option<String>,
        side: String,
    },
    Diff {
        id: String,
        target: DiffTarget,
        path: String,
        whole: bool,
    },
    GitLog {
        id: String,
        after: u64,
    },
    SetUpdateChannel {
        channel: String,
        stream: Option<String>,
    },
    Changelog,
    Crashes,
    ClearCrashes {
        id: String,
    },
    ReportCrash {
        message: String,
        detail: String,
    },
    CheckUpdate,
    UpdateProgress,
    ApplyUpdate,
    Ls {
        path: String,
        host: String,
    },
    SetHidden {
        id: String,
        hidden: Vec<String>,
    },
    Watch {
        id: String,
    },
    Conflicts {
        id: String,
    },
    ConflictVersions {
        id: String,
        path: String,
    },
    Resolve {
        id: String,
        path: String,
        side: String,
        content: String,
        paths: Vec<String>,
    },
    Op {
        id: String,
        args: OpArgs,
    },
    Stage {
        id: String,
        paths: Vec<String>,
    },
    Unstage {
        id: String,
        paths: Vec<String>,
    },
    Discard {
        id: String,
        tracked: Vec<String>,
        untracked: Vec<String>,
    },
    Commit {
        id: String,
        summary: String,
        description: String,
        amend: bool,
    },
    HeadMessage {
        id: String,
    },
    CommitMessage {
        id: String,
        sha: String,
    },
    CommitFiles {
        id: String,
        sha: String,
    },
    Changes {
        id: String,
    },
    AvatarOverride {
        email: String,
    },
    Ai,
    SaveAi {
        config: AiConfig,
    },
    ClaudeStatus {
        provider_id: String,
        account: String,
    },
    ClaudeLogin {
        provider_id: String,
        account: String,
    },
    ClaudeForget {
        provider_id: String,
    },
    AiModels {
        provider: AiProvider,
    },
    TestAi {
        provider_id: String,
    },
    WriteCommitMessage {
        id: String,
        hint: String,
        amend: bool,
    },
    ExplainCommits {
        id: String,
        shas: Vec<String>,
    },
    SuggestBranchName {
        id: String,
    },
    WriteSquashMessage {
        id: String,
        shas: Vec<String>,
    },
    SuggestPicks {
        id: String,
        path: String,
        hunks: Vec<AiConflictHunk>,
    },
    /// The repository side of an AI task; travels to the machine holding the tab.
    CommitContext {
        id: String,
        amend: bool,
    },
    RepoContext {
        id: String,
        kind: String,
        shas: Vec<String>,
    },
}

impl Request {
    /// The tab a repository request is about.
    pub fn tab_id(&self) -> Option<&str> {
        use Request::*;
        match self {
            Graph { id, .. }
            | Submodules { id }
            | Worktrees { id }
            | RangeFiles { id, .. }
            | Media { id, .. }
            | Diff { id, .. }
            | GitLog { id, .. }
            | SetHidden { id, .. }
            | Watch { id }
            | Conflicts { id }
            | ConflictVersions { id, .. }
            | Resolve { id, .. }
            | Op { id, .. }
            | Stage { id, .. }
            | Unstage { id, .. }
            | Discard { id, .. }
            | Commit { id, .. }
            | HeadMessage { id }
            | CommitMessage { id, .. }
            | CommitFiles { id, .. }
            | Changes { id }
            | CommitContext { id, .. }
            | RepoContext { id, .. } => Some(id),
            _ => None,
        }
    }
}

/// An answer that stays a typed value in-process and becomes JSON only to cross to another machine.
pub trait Out: Any + Send {
    fn json(&self) -> Result<Value, String>;
}

impl<T: Serialize + Any + Send> Out for T {
    fn json(&self) -> Result<Value, String> {
        serde_json::to_value(self).map_err(|e| e.to_string())
    }
}

pub type Answer = Box<dyn Out>;

/// Calls the engine and hands back the answer as the type the caller expects.
///
/// Local answers of that exact type move across untouched; anything else (a
/// remote answer, an ad-hoc json! object) goes through serde.
pub fn call<T: serde::de::DeserializeOwned + 'static>(req: Request) -> Result<T, String> {
    let answer = handle(req)?;
    if (&*answer as &dyn Any).type_id() == TypeId::of::<T>() {
        let any: Box<dyn Any> = answer;
        if let Ok(typed) = any.downcast::<T>() {
            return Ok(*typed);
        }
        return Err("answer changed type".into());
    }
    from(answer.json()?)
}

/// Answers one request, here or on the machine its tab lives on.
pub fn handle(req: Request) -> Result<Answer, String> {
    if let Some(id) = req.tab_id() {
        if let Some(tab) = session::find_tab(id) {
            if let Some(host) = tab.host.as_deref() {
                return Ok(Box::new(remote::forward(host, &req)?));
            }
        }
    }
    handle_local(req)
}

/// Answers a request on this machine. A remote gitc serving `--stdio` calls this directly.
pub fn handle_local(req: Request) -> Result<Answer, String> {
    use Request as R;
    match req {
        R::Ping => to(Ping { version: crate::VERSION.to_string(), remotes: remote::states() }),
        R::Session => to(session::snapshot()),
        R::Open { path, host, want_id } => {
            if !host.is_empty() {
                let tab = remote::open_remote_repo(&host, &path)?;
                return to(Opened { tab, session: session::snapshot() });
            }
            let Some(tab) = session::open_repo(&path, want_id.as_deref()) else {
                return Err("not a git repository".into());
            };
            to(Opened { tab, session: session::snapshot() })
        }
        R::SetRemoteHold { minutes } => {
            remote::set_hold(minutes);
            ok()
        }
        R::Hosts => to(json!({ "hosts": ssh_config::read_ssh_hosts() })),
        R::RemotePlan { host } => {
            let mut plan = remote::plan_remote(&host);
            plan.approved = approvals::is_approved_remote(&host);
            to(plan)
        }
        R::ApproveRemote { host } => {
            if !remote::is_safe_destination(&host) {
                return Err("not a usable ssh destination".into());
            }
            approvals::approve_remote(&host);
            ok()
        }
        R::ApprovedRemotes => to(json!({ "hosts": approvals::approved_remotes() })),
        R::RevokeRemote { host } => {
            approvals::revoke_remote(&host);
            to(json!({ "hosts": approvals::approved_remotes() }))
        }
        R::Close { id, next, everywhere } => {
            let closed = session::with(|s| session::close_tab(s, &id, next.as_deref(), everywhere));
            if let Some(host) = closed.and_then(|t| t.host) {
                remote::release_host(&host);
            }
            to(session::snapshot())
        }
        R::Workspace { id } => {
            session::with(|s| session::switch_workspace(s, &id));
            to(session::snapshot())
        }
        R::AddWorkspace { name } => {
            let name = name.trim().to_string();
            if !name.is_empty() {
                session::with(|s| session::add_workspace(s, &name));
            }
            to(session::snapshot())
        }
        R::RenameWorkspace { id, name } => {
            let name = name.trim().to_string();
            if !name.is_empty() {
                session::with(|s| session::rename_workspace(s, &id, &name));
            }
            to(session::snapshot())
        }
        R::ReorderWorkspaces { order } => {
            session::with(|s| session::reorder_workspaces(s, &order));
            to(session::snapshot())
        }
        R::RemoveWorkspace { id } => {
            let closed = session::with(|s| session::remove_workspace(s, &id)).unwrap_or_default();
            for host in closed.into_iter().filter_map(|t| t.host) {
                remote::release_host(&host);
            }
            to(session::snapshot())
        }
        R::TabWorkspaces { id, workspaces } => {
            session::with(|s| session::set_tab_workspaces(s, &id, &workspaces));
            to(session::snapshot())
        }
        R::Activate { id } => {
            session::with(|s| session::activate(s, &id));
            to(session::snapshot())
        }
        R::Reorder { order } => {
            session::with(|s| session::reorder_tabs(s, &order));
            to(session::snapshot())
        }
        R::Graph { id, limit } => {
            let tab = tab(&id)?;
            to(payload::graph_payload(&tab, if limit == 0 { DEFAULT_LIMIT } else { limit })?)
        }
        R::Submodules { id } => to(json!({ "submodules": submodules::read_submodules(&tab(&id)?.path) })),
        R::Worktrees { id } => to(json!({ "worktrees": worktrees::list_worktrees(&tab(&id)?.path) })),
        R::RangeFiles { id, from, to: until } => {
            let repo = tab(&id)?.path;
            let files = git::read_range_files(&repo, &from, &until)?;
            let lines = git::read_range_lines(&repo, &from, &until)?;
            to(FileList { files, added: lines.added, removed: lines.removed })
        }
        R::CommitFiles { id, sha } => {
            let repo = tab(&id)?.path;
            let files = git::read_commit_files(&repo, &sha)?;
            let lines = git::read_commit_lines(&repo, &sha)?;
            to(FileList { files, added: lines.added, removed: lines.removed })
        }
        R::Media { id, target, path, old_path, side } => {
            let tab = tab(&id)?;
            let (root, _) = worktree_root(&tab, &target)?;
            let bytes = media::read_media(&root, &target, &path, old_path.as_deref().unwrap_or(""), &side)?;
            to(Media { data: base64::engine::general_purpose::STANDARD.encode(bytes) })
        }
        R::Diff { id, target, path, whole } => {
            let tab = tab(&id)?;
            let context = if whole { diff::FULL_CONTEXT } else { 3 };
            match &target {
                DiffTarget::Wip { staged, untracked, .. } => {
                    let (root, quiet) = worktree_root(&tab, &target)?;
                    to(diff::diff_working_file(&root, &path, *staged, context, *untracked, quiet)?)
                }
                DiffTarget::Range { from, to: until } => {
                    to(diff::diff_range_file(&tab.path, from, until, &path, context)?)
                }
                DiffTarget::Commit { sha } => to(diff::diff_commit_file(&tab.path, sha, &path, context)?),
            }
        }
        R::GitLog { after, .. } => to(json!({ "calls": git::git_history(after) })),
        R::SetUpdateChannel { channel, stream } => {
            update::set_channel(&channel, stream.as_deref());
            ok()
        }
        R::Changelog => to(update::release_notes()),
        R::Crashes => to(crash_list()),
        R::ClearCrashes { id } => {
            crashes::clear_crashes(&id);
            to(crash_list())
        }
        R::ReportCrash { message, detail } => {
            crashes::record_crash("window", &clip(&message, 2000), &clip(&detail, 20000));
            ok()
        }
        R::CheckUpdate => to(update::check()),
        R::UpdateProgress => to(update::progress()),
        R::ApplyUpdate => to(update::apply()),
        R::Ls { path, host } => {
            if !host.is_empty() {
                return Ok(Box::new(remote::forward(&host, &R::Ls { path, host: String::new() })?));
            }
            to(browse::list_dir(&path))
        }
        R::SetHidden { id, hidden } => {
            let tab = tab(&id)?;
            visibility::save_hidden(&tab.path, &hidden);
            to(payload::graph_payload(&tab, DEFAULT_LIMIT)?)
        }
        R::Watch { id } => {
            let repo = tab(&id)?.path;
            to(Watch { version: watch::fingerprint(&repo)?, fetched: watch::last_fetch(&repo) })
        }
        R::Conflicts { id } => {
            let repo = tab(&id)?.path;
            to(conflicts::read_conflict_state(&repo, &refs::read_pending(&repo).kind)?)
        }
        R::ConflictVersions { id, path } => to(conflicts::read_conflict_versions(&tab(&id)?.path, &path)?),
        R::Resolve { id, path, side, content, paths } => {
            let repo = tab(&id)?.path;
            if !paths.is_empty() {
                conflicts::mark_all_resolved(&repo, &paths)?;
            } else if side == "unresolve" {
                conflicts::unresolve(&repo, &path)?;
            } else if !side.is_empty() {
                conflicts::resolve_with_side(&repo, &path, &side)?;
            } else {
                conflicts::resolve_with_content(&repo, &path, &content)?;
            }
            to(conflicts::read_conflict_state(&repo, &refs::read_pending(&repo).kind)?)
        }
        R::Op { id, args } => to(ops::run_op(&tab(&id)?.path, &args)?),
        R::Stage { id, paths } => {
            let repo = tab(&id)?.path;
            if paths.is_empty() {
                actions::stage_all(&repo)?
            } else {
                actions::stage_paths(&repo, &paths)?
            }
            to(json!({ "status": git::read_status(&repo)? }))
        }
        R::Unstage { id, paths } => {
            let repo = tab(&id)?.path;
            if paths.is_empty() {
                actions::unstage_all(&repo)?
            } else {
                actions::unstage_paths(&repo, &paths)?
            }
            to(json!({ "status": git::read_status(&repo)? }))
        }
        R::Discard { id, tracked, untracked } => {
            let repo = tab(&id)?.path;
            actions::discard_paths(&repo, &tracked, &untracked)?;
            to(json!({ "status": git::read_status(&repo)? }))
        }
        R::Commit { id, summary, description, amend } => {
            to(actions::commit(&tab(&id)?.path, &summary, &description, amend)?)
        }
        R::HeadMessage { id } => to(actions::head_message(&tab(&id)?.path).unwrap_or_default()),
        R::CommitMessage { id, sha } => {
            if sha.trim().is_empty() {
                return Err("no commit given".into());
            }
            to(actions::commit_message(&tab(&id)?.path, &sha).unwrap_or_default())
        }
        R::Changes { id } => to(git::worktree_changes(&tab(&id)?.path)?),
        R::AvatarOverride { email } => {
            let Some(bytes) = media::avatar_override(&email) else { return Err("no override".into()) };
            to(Media { data: base64::engine::general_purpose::STANDARD.encode(bytes) })
        }
        R::Ai => to(ai::masked(ai::load_ai())),
        R::SaveAi { config } => to(ai::masked(ai::save_ai(config))),
        R::ClaudeStatus { provider_id, account } => {
            let Some(home) = ai::claude_home(&provider_id, &account) else {
                return Err("not a usable provider id".into());
            };
            to(ai::claude_status(&home))
        }
        R::ClaudeLogin { provider_id, account } => {
            let Some(home) = ai::claude_home(&provider_id, &account) else {
                return Err("not a usable provider id".into());
            };
            to(json!({ "url": ai::start_claude_login(&home)? }))
        }
        R::ClaudeForget { provider_id } => {
            ai::forget_unsaved(&provider_id);
            ok()
        }
        R::AiModels { provider } => to(json!({ "models": ai::list_models(&ai::with_stored_key(provider))? })),
        R::TestAi { provider_id } => {
            let Some(provider) = ai::load_ai().providers.into_iter().find(|p| p.id == provider_id) else {
                return Err("no such provider".into());
            };
            to(json!({ "ms": ai::test_provider(&provider)? }))
        }
        R::WriteCommitMessage { id, hint, amend } => {
            let provider = ai_provider(&id)?;
            let context: CommitContext = call(R::CommitContext { id, amend })?;
            to(ai::write_commit_message(&provider, &context, &hint)?)
        }
        R::ExplainCommits { id, shas } => {
            let provider = ai_provider(&id)?;
            let context = repo_context(&id, "explain", shas)?;
            to(json!({ "text": ai_tasks::explain_commits(&provider, &context)? }))
        }
        R::SuggestBranchName { id } => {
            let provider = ai_provider(&id)?;
            let context = repo_context(&id, "branch", Vec::new())?;
            to(json!({ "name": ai_tasks::suggest_branch_name(&provider, &context)? }))
        }
        R::WriteSquashMessage { id, shas } => {
            let provider = ai_provider(&id)?;
            let context = repo_context(&id, "squash", shas)?;
            to(ai_tasks::write_squash_message(&provider, &context)?)
        }
        R::SuggestPicks { id, path, hunks } => {
            let provider = ai_provider(&id)?;
            to(json!({ "picks": ai_tasks::suggest_picks(&provider, &path, &hunks)? }))
        }
        R::CommitContext { id, amend } => to(ai::commit_context(&tab(&id)?.path, amend)?),
        R::RepoContext { id, kind, shas } => to(ai_tasks::task_context(&tab(&id)?.path, &kind, &shas)?),
    }
}

fn ai_provider(id: &str) -> Result<AiProvider, String> {
    let tab = tab(id)?;
    ai::provider_for(&ai::load_ai(), tab.host.as_deref().unwrap_or(""), &tab.path)
        .ok_or_else(|| "no AI provider is set up for this repository".to_string())
}

fn repo_context(id: &str, kind: &str, shas: Vec<String>) -> Result<CommitContext, String> {
    call(Request::RepoContext { id: id.to_string(), kind: kind.to_string(), shas })
}

fn crash_list() -> CrashList {
    CrashList { dir: crashes::crash_dir(), reports: crashes::list_crashes() }
}

/// Where a working-tree read runs, and whether it must avoid taking locks there.
fn worktree_root(tab: &Tab, target: &DiffTarget) -> Result<(String, bool), String> {
    let DiffTarget::Wip { worktree: Some(name), .. } = target else {
        return Ok((tab.path.clone(), false));
    };
    let Some(w) = worktrees::find_worktree(&tab.path, name) else {
        return Err("no such worktree".into());
    };
    Ok((w.path, !w.current))
}

fn tab(id: &str) -> Result<Tab, String> {
    session::find_tab(id).ok_or_else(|| "no such tab".to_string())
}

fn clip(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

fn ok() -> Result<Answer, String> {
    to(json!({ "ok": true }))
}

fn to<T: Serialize + Any + Send>(value: T) -> Result<Answer, String> {
    Ok(Box::new(value))
}

fn from<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|e| e.to_string())
}
