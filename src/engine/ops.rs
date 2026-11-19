use std::collections::{BTreeSet, HashSet};
use std::path::Path;
use std::process::{Command, Stdio};

use super::git::{extract_co_authors, git, git_or_none, git_with, hide_console};
use super::paths::{in_repo, need_in_repo, safe_argument, safe_remote_url, temp_file};
use super::refs::{read_pending, read_remotes};
use super::types::{OpArgs, OpResult, Person, PushRefusal};
use super::worktrees::{as_registered_here, list_worktrees};

const CO_AUTHOR_LABEL: &str = "Co-authored-by: ";

/// Runs one repository operation, named by `args.op`.
///
/// A refusal the user can act on (a conflict, a question, a push that needs a
/// destination or was rejected) comes back as an `OpResult`; `Err` is a plain failure.
pub fn run_op(repo: &str, a: &OpArgs) -> Result<OpResult, String> {
    match a.op.as_str() {
        "checkout" => {
            let r = need_ref(&a.r#ref, "branch")?;
            checkout_ref(repo, r, &detached_warning(repo), &a.mode)
        }
        "checkoutCommit" => {
            let sha = first_sha(a)?;
            git(repo, &["checkout", "--detach", sha])?;
            Ok(ok(format!("HEAD is now detached at {}", short(sha))))
        }
        "createBranch" => create_branch(repo, a),
        "renameBranch" => {
            let name = need_name(&a.name, "branch needs a name", "branch name")?;
            let r = need_ref(&a.r#ref, "branch")?;
            git(repo, &["branch", "-m", r, name])?;
            Ok(ok(format!("renamed to {name}")))
        }
        "setUpstream" => set_upstream(repo, a),
        "deleteBranch" => delete_branch(repo, a),
        "removeWorktree" => remove_worktree(repo, a),
        "deleteRemoteBranch" => {
            let r = need_ref(&a.r#ref, "branch")?;
            let remote = need_name(&a.remote, "no remote given", "remote")?;
            git(repo, &["push", remote, "--delete", r])?;
            Ok(ok(format!("deleted {remote}/{r}")))
        }
        "merge" => {
            let r = need_ref(&a.r#ref, "branch")?;
            conflict_prone(repo, &["merge", "--no-edit", r], &format!("Merging {r}"), &format!("merged {r}"), &[])
        }
        "fastForward" => {
            let r = need_ref(&a.r#ref, "branch")?;
            git(repo, &["merge", "--ff-only", r])?;
            Ok(ok(format!("fast-forwarded to {r}")))
        }
        "rebaseOnto" => {
            let r = need_ref(&a.r#ref, "target")?;
            conflict_prone(
                repo,
                &["-c", "core.editor=true", "rebase", "--autostash", r],
                "Rebase",
                &format!("rebased onto {r}"),
                &[],
            )
        }
        "cherryPick" => {
            let shas = need_shas(a)?;
            let args: Vec<&str> = ["cherry-pick"].into_iter().chain(shas.iter().rev().copied()).collect();
            conflict_prone(repo, &args, "Cherry-pick", &format!("cherry-picked {} commit(s)", shas.len()), &[])
        }
        "revert" => revert(repo, a),
        "reset" => {
            let sha = first_sha(a)?;
            let mode = if a.mode == "soft" || a.mode == "hard" { a.mode.as_str() } else { "mixed" };
            git(repo, &["reset", &format!("--{mode}"), sha])?;
            Ok(ok(format!("reset {mode} to {}", short(sha))))
        }
        "createTag" => {
            let name = need_name(&a.name, "tag needs a name", "tag name")?;
            let at = safe_argument(a.shas.first().map(String::as_str).unwrap_or("HEAD"), "commit")?;
            if a.message.is_empty() {
                git(repo, &["tag", name, at])?;
            } else {
                git(repo, &["tag", "-a", name, "-m", &a.message, at])?;
            }
            Ok(ok(format!("tagged {name}")))
        }
        "deleteTag" => {
            let r = need_ref(&a.r#ref, "tag")?;
            git(repo, &["tag", "-d", r])?;
            Ok(ok(format!("deleted tag {r}")))
        }
        "stash" => {
            let mut args = vec!["stash", "push", "--include-untracked"];
            if !a.message.is_empty() {
                args.extend(["-m", a.message.as_str()]);
            }
            let out = git(repo, &args)?;
            Ok(ok(if out.contains("No local changes") { "nothing to stash" } else { "stashed" }))
        }
        "stashPop" | "stashApply" => stash_restore(repo, a),
        "stashDrop" => {
            let which = need_ref(&a.r#ref, "stash")?;
            git(repo, &["stash", "drop", which])?;
            Ok(ok(format!("dropped {which}")))
        }
        "squash" => squash(repo, a),
        "reword" => reword(repo, a),
        "unpack" => unpack(repo, a),
        "drop" => drop_commits(repo, a),
        "submoduleUpdate" | "submoduleUpdateRemote" => {
            let remote = a.op == "submoduleUpdateRemote";
            let target = a.path.trim();
            let mut args = vec!["submodule", "update", "--init", if remote { "--remote" } else { "--recursive" }];
            if !target.is_empty() {
                args.extend(["--", target]);
            }
            git(repo, &args)?;
            Ok(ok(match (remote, target.is_empty()) {
                (false, true) => "updated all submodules".to_string(),
                (false, false) => format!("updated {target}"),
                (true, true) => "submodules moved to the latest remote commit; commit the pointer to keep it".into(),
                (true, false) => format!("{target} moved to the latest remote commit; commit the pointer to keep it"),
            }))
        }
        "applyPatch" => apply_patch(repo, a),
        "editFile" => {
            if a.path.trim().is_empty() {
                return Err("no file to open".into());
            }
            let full = need_in_repo(repo, &a.path)?;
            if !full.exists() {
                return Err(format!("{} is not in the working tree", a.path));
            }
            open_in_editor(&full);
            Ok(ok(format!("opened {}", a.path)))
        }
        "writeFile" => {
            let Some(full) = in_repo(repo, &a.path) else {
                return Ok(refused(format!("{} is outside the repository", a.path)));
            };
            if !full.is_file() {
                return Ok(refused(format!("{} is not in the working tree", a.path)));
            }
            std::fs::write(&full, &a.message).map_err(|e| format!("cannot save {}: {e}", a.path))?;
            Ok(ok(format!("saved {}", a.path)))
        }
        "addRemote" => {
            let name = need_name(&a.name, "the remote needs a name", "remote name")?;
            let url = safe_remote_url(&a.message)?;
            if read_remotes(repo).remotes.iter().any(|r| r == name) {
                return Err(format!("A remote called {name} already exists."));
            }
            git(repo, &["remote", "add", name, &url])?;
            let _ = git_or_none(repo, &["fetch", name, "--prune"]);
            Ok(ok(format!("added {name} and fetched it")))
        }
        "renameRemote" => {
            let r = need_ref(&a.r#ref, "remote")?;
            let name = need_name(&a.name, "the remote needs a name", "remote name")?;
            git(repo, &["remote", "rename", r, name])?;
            Ok(ok(format!("renamed {r} to {name}")))
        }
        "removeRemote" => {
            let r = need_ref(&a.r#ref, "remote")?;
            git(repo, &["remote", "remove", r])?;
            Ok(ok(format!("removed {r}")))
        }
        "setRemoteUrl" => {
            let r = need_ref(&a.r#ref, "remote")?;
            let url = safe_remote_url(&a.message)?;
            git(repo, &["remote", "set-url", r, &url])?;
            Ok(ok(format!("updated the URL for {r}")))
        }
        "fetchRemote" => {
            let r = need_ref(&a.r#ref, "remote")?;
            git(repo, &["fetch", r, "--prune"])?;
            Ok(ok(format!("fetched {r}")))
        }
        "pruneRemote" => {
            let r = need_ref(&a.r#ref, "remote")?;
            git(repo, &["remote", "prune", r])?;
            Ok(ok(format!("pruned branches that no longer exist on {r}")))
        }
        "fetch" => {
            git(repo, &["fetch", "--all", "--prune"])?;
            Ok(ok("fetched"))
        }
        "pull" => {
            let (flag, done) = match a.mode.as_str() {
                "rebase" => ("--rebase", "pulled; your commits are on top now, push again to publish"),
                "merge" => ("--no-rebase", "pulled and merged; push again to publish"),
                _ => ("--ff-only", "pulled"),
            };
            conflict_prone(repo, &["pull", flag, "--autostash"], "Pull", done, &[])
        }
        "push" => push(repo, a),
        "abort" => {
            let kind = need_ref(&a.r#ref, "operation")?;
            let args: &[&str] = match kind {
                "rebase" => &["rebase", "--abort"],
                "cherry-pick" => &["cherry-pick", "--abort"],
                "revert" => &["revert", "--abort"],
                "merge" => &["merge", "--abort"],
                "bisect" => &["bisect", "reset"],
                _ => return Err("nothing to abort".into()),
            };
            git(repo, args)?;
            Ok(ok(format!("abandoned the {kind}")))
        }
        "continue" => {
            let kind = need_ref(&a.r#ref, "operation")?;
            let (args, label): (&[&str], &str) = match kind {
                "rebase" => (&["-c", "core.editor=true", "rebase", "--continue"], "Rebase"),
                "cherry-pick" => (&["cherry-pick", "--continue", "--no-edit"], "Cherry-pick"),
                "revert" => (&["revert", "--continue", "--no-edit"], "Revert"),
                "merge" => {
                    git(repo, &["commit", "--no-edit", "--cleanup=strip"])?;
                    return Ok(ok("completed the merge"));
                }
                _ => return Err("nothing to continue".into()),
            };
            conflict_prone(repo, args, label, &format!("continued the {kind}"), &[])
        }
        "skip" => {
            let kind = need_ref(&a.r#ref, "operation")?;
            if !matches!(kind, "rebase" | "cherry-pick" | "revert") {
                return Err("nothing to skip".into());
            }
            git(repo, &[kind, "--skip"])?;
            Ok(ok(format!("skipped a commit in the {kind}")))
        }
        other => Err(format!("unknown operation: {other}")),
    }
}

fn create_branch(repo: &str, a: &OpArgs) -> Result<OpResult, String> {
    let name = need_name(&a.name, "branch needs a name", "branch name")?;
    let start = a.shas.first().unwrap_or(&a.r#ref).trim();
    if !start.is_empty() {
        safe_argument(start, "start point")?;
    }
    let mut args = if a.checkout { vec!["checkout", "-b", name] } else { vec!["branch", name] };
    let remotes = read_remotes(repo).remotes;
    let on_remote = remotes.iter().find_map(|r| start.strip_prefix(r.as_str()).and_then(|s| s.strip_prefix('/')));
    if on_remote.is_some_and(|branch| branch != name) {
        args.push("--no-track");
    }
    if !start.is_empty() {
        args.push(start);
    }
    git(repo, &args)?;
    Ok(ok(if a.checkout { format!("created and checked out {name}") } else { format!("created {name}") }))
}

fn set_upstream(repo: &str, a: &OpArgs) -> Result<OpResult, String> {
    let r = need_ref(&a.r#ref, "branch")?;
    if a.remote.is_empty() {
        git(repo, &["branch", "--unset-upstream", r])?;
        return Ok(ok(format!("{r} no longer tracks anything")));
    }
    if !read_remotes(repo).remotes.contains(&a.remote) {
        return Err(format!("No such remote: {}", a.remote));
    }
    let name = need_ref(&a.name, "remote branch")?;
    write_upstream(repo, r, &a.remote, name)?;
    Ok(ok(format!("{r} now tracks {}/{name}", a.remote)))
}

fn delete_branch(repo: &str, a: &OpArgs) -> Result<OpResult, String> {
    let r = need_ref(&a.r#ref, "branch")?;
    if a.force {
        git(repo, &["branch", "-D", r])?;
        return Ok(ok(format!("deleted {r}")));
    }
    let Err(e) = git(repo, &["branch", "-d", r]) else {
        return Ok(ok(format!("deleted {r}")));
    };
    if !e.contains("not fully merged") {
        return Err(e);
    }
    let ahead = count_commits(repo, &format!("HEAD..{r}"));
    let note = if ahead == 1 {
        format!("{r} has 1 commit that is on no other branch. Deleting it loses that commit.")
    } else {
        format!("{r} has {ahead} commits that are on no other branch. Deleting it loses them.")
    };
    Ok(OpResult { confirm: format!("Delete {r} anyway?"), ..refused(note) })
}

fn remove_worktree(repo: &str, a: &OpArgs) -> Result<OpResult, String> {
    let w = list_worktrees(repo).into_iter().find(|w| !a.name.is_empty() && w.name == a.name);
    let Some(w) = w else {
        return Err("no such worktree".into());
    };
    if w.main {
        return Err("the main worktree cannot be removed".into());
    }
    if w.current {
        return Err("that is the worktree this tab is in".into());
    }
    let mut args = vec!["worktree", "remove"];
    if a.force {
        args.push("--force");
        if w.locked {
            args.push("--force");
        }
    }
    args.push(&w.path);
    let Err(e) = as_registered_here(repo, &w.name, || git(repo, &args)) else {
        return Ok(ok(format!("removed worktree {}", w.name)));
    };
    let locked = e.contains("locked");
    if a.force || (!locked && !e.contains("modified or untracked")) {
        return Err(e);
    }
    let note = if locked {
        let reason = if w.lock_reason.is_empty() { String::new() } else { format!(": {}", w.lock_reason) };
        format!("{} is locked{reason}.", w.name)
    } else {
        format!("{} has uncommitted changes. Removing it deletes them.", w.name)
    };
    Ok(OpResult { confirm: format!("Remove {} anyway?", w.name), ..refused(note) })
}

/// Undoes commits: as a commit of its own, or with mode "worktree" as unstaged changes.
fn revert(repo: &str, a: &OpArgs) -> Result<OpResult, String> {
    let shas = need_shas(a)?;
    let count = if shas.len() > 1 { format!("{} commits", shas.len()) } else { "1 commit".to_string() };
    if a.mode != "worktree" {
        let args: Vec<&str> = ["revert", "--no-edit"].into_iter().chain(shas.iter().copied()).collect();
        return conflict_prone(repo, &args, "Revert", &format!("reverted {count}"), &[]);
    }

    let mut touched = BTreeSet::new();
    for sha in &shas {
        let out = git_or_none(repo, &["diff-tree", "-r", "--no-commit-id", "--name-only", sha]).unwrap_or_default();
        touched.extend(out.lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from));
    }
    let args: Vec<&str> = ["revert", "--no-commit"].into_iter().chain(shas.iter().copied()).collect();
    let result = conflict_prone(repo, &args, "Revert", &format!("reverted {count} into the working tree"), &[])?;
    if !result.ok {
        return Ok(result);
    }
    let _ = git_or_none(repo, &["revert", "--quit"]);
    if !touched.is_empty() {
        let args: Vec<&str> =
            ["reset", "-q", "HEAD", "--"].into_iter().chain(touched.iter().map(String::as_str)).collect();
        let _ = git_or_none(repo, &args);
    }
    Ok(result)
}

/// Restores a stash (`ref`, or the latest when empty); a conflict keeps the stash and is a next step.
fn stash_restore(repo: &str, a: &OpArgs) -> Result<OpResult, String> {
    let which = a.r#ref.trim();
    let keep = a.op == "stashApply";
    let mut args = vec!["stash", if keep { "apply" } else { "pop" }];
    if !which.is_empty() {
        args.push(safe_argument(which, "stash")?);
    }
    let named = if which.is_empty() { "the latest stash" } else { which };
    let Err(e) = git(repo, &args) else {
        return Ok(ok(format!("{} {named}", if keep { "applied" } else { "popped" })));
    };
    let pending = read_pending(repo).kind;
    if pending.is_empty() && !has_unmerged(repo) {
        return Err(e);
    }
    Ok(stopped(
        format!(
            "Restoring {named} hit conflicts. Resolve them below; the stash itself is untouched, so nothing is lost either way."
        ),
        if pending.is_empty() { "unmerged" } else { &pending },
    ))
}

/// Folds a contiguous run (newest first) into its oldest commit, crediting everyone in it.
fn squash(repo: &str, a: &OpArgs) -> Result<OpResult, String> {
    if a.shas.len() < 2 {
        return Err("select at least two commits to squash".into());
    }
    let shas = need_shas(a)?;
    let Some((&oldest, folded)) = shas.split_last() else {
        return Err("nothing to squash".into());
    };
    no_merges_among(repo, &shas, "squashing them")?;
    check_rewritable(repo, oldest, "squashing")?;

    let author_out = git_or_none(repo, &["log", "--no-walk", "--format=%an%x00%ae", oldest]).unwrap_or_default();
    let (name, email) = author_out.trim().split_once('\0').unwrap_or((author_out.trim(), ""));
    let author = Person { name: name.trim().to_string(), email: email.trim().to_string() };
    let typed = a.message.trim();
    let message = if typed.is_empty() { squash_message(repo, &shas) } else { typed.to_string() };
    let credited = with_credits(&message, &credits_for(repo, &shas, &author));

    rebase_with(repo, "squash", folded, oldest, Some(&credited), "Squash", &format!("squashed {} commits", shas.len()))
}

/// Changes a commit's message only: an amend for HEAD, a rebase reword otherwise.
fn reword(repo: &str, a: &OpArgs) -> Result<OpResult, String> {
    let sha = first_sha(a)?;
    let message = a.message.trim();
    if message.is_empty() {
        return Err("a commit needs a message".into());
    }
    if is_head(repo, sha) {
        git_with(
            repo,
            &["commit", "--amend", "--only", "--allow-empty", "-F", "-"],
            &[],
            Some(&format!("{message}\n")),
        )?;
        return Ok(ok(format!("reworded {}", short(sha))));
    }
    check_rewritable(repo, sha, "rewording")?;
    rebase_with(repo, "reword", &[sha], sha, Some(message), "Reword", &format!("reworded {}", short(sha)))
}

/// Takes the tip commit apart into unstaged changes, from a clean tree only.
fn unpack(repo: &str, a: &OpArgs) -> Result<OpResult, String> {
    let sha = first_sha(a)?;
    if !is_head(repo, sha) {
        return Err("only the commit at the tip can be unpacked; its changes have nowhere to go otherwise".into());
    }
    let parent = format!("{sha}^");
    if git_or_none(repo, &["rev-parse", "--verify", &parent]).is_none() {
        return Err("that is the first commit, so there is nothing to unpack it onto".into());
    }
    let dirty = git_or_none(repo, &["--no-optional-locks", "status", "--porcelain", "-uall"]);
    if dirty.is_none_or(|d| !d.trim().is_empty()) {
        return Err("the working tree has to be clean to unpack a commit; commit or stash what is there first".into());
    }
    git(repo, &["reset", "--mixed", &parent])?;
    Ok(ok(format!("unpacked {} into the working tree", short(sha))))
}

fn drop_commits(repo: &str, a: &OpArgs) -> Result<OpResult, String> {
    let shas = need_shas(a)?;
    let Some(&oldest) = shas.last() else {
        return Err("nothing to drop".into());
    };
    no_merges_among(repo, &shas, "dropping them")?;
    check_rewritable(repo, oldest, "dropping")?;
    let done =
        if shas.len() == 1 { format!("dropped {}", short(oldest)) } else { format!("dropped {} commits", shas.len()) };
    rebase_with(repo, "drop", &shas, oldest, None, "Drop", &done)
}

/// Applies one hunk's patch to the index ("stage"), reversed ("unstage"), or reversed to the working tree ("discard").
fn apply_patch(repo: &str, a: &OpArgs) -> Result<OpResult, String> {
    if a.patch.trim().is_empty() {
        return Err("no patch to apply".into());
    }
    let (args, done): (&[&str], &str) = match a.mode.as_str() {
        "stage" => (&["apply", "--cached"], "staged the hunk"),
        "unstage" => (&["apply", "--cached", "--reverse"], "unstaged the hunk"),
        "discard" => (&["apply", "--reverse"], "discarded the hunk"),
        other => return Err(format!("unknown patch target: {other}")),
    };
    git_with(repo, args, &[], Some(&a.patch))?;
    Ok(ok(done))
}

/// Pushes where the branch's configuration unambiguously says, or asks (`push_to`).
fn push(repo: &str, a: &OpArgs) -> Result<OpResult, String> {
    let branch = git(repo, &["rev-parse", "--abbrev-ref", "HEAD"])?.trim().to_string();
    if branch == "HEAD" {
        return Err("Check out a branch to push it.".into());
    }
    let remotes = read_remotes(repo).remotes;
    if remotes.is_empty() {
        return Err("This repository has no remotes configured.".into());
    }

    let (args, target) = if !a.remote.is_empty() {
        if !remotes.contains(&a.remote) {
            return Err(format!("No such remote: {}", a.remote));
        }
        let name = need_ref(&a.name, "remote branch")?;
        write_upstream(repo, &branch, &a.remote, name)?;
        (vec!["push".to_string(), a.remote.clone(), format!("HEAD:refs/heads/{name}")], format!("{}/{name}", a.remote))
    } else {
        let (upstream, push_default) = both(
            || git_or_none(repo, &["rev-parse", "--abbrev-ref", "@{upstream}"]).unwrap_or_default().trim().to_string(),
            || git_or_none(repo, &["config", "push.default"]).unwrap_or_default().trim().to_string(),
        );
        let remote = remotes.iter().find(|r| upstream.strip_prefix(r.as_str()).is_some_and(|s| s.starts_with('/')));
        let clear = remote.is_some_and(|r| {
            upstream.get(r.len() + 1..) == Some(branch.as_str())
                || (!push_default.is_empty() && push_default != "simple")
        });
        if !clear {
            let suggest = remote
                .or_else(|| remotes.iter().find(|r| *r == "origin"))
                .or(remotes.first())
                .cloned()
                .unwrap_or_default();
            let note = if upstream.is_empty() {
                format!("{branch} has not been pushed yet.")
            } else {
                format!("{branch} tracks {upstream}, a branch of another name.")
            };
            return Ok(OpResult { push_to: Some(format!("{suggest}/{branch}")), ..refused(note) });
        }
        (vec!["push".to_string()], upstream)
    };

    let mut run = args;
    if a.force {
        run.push("--force-with-lease".into());
    }
    let Err(e) = git(repo, &run) else {
        return Ok(ok(format!("{} to {target}", if a.force { "force-pushed" } else { "pushed" })));
    };
    if !is_refusal(&e) && !(a.force && e.contains("stale info")) {
        return Err(e);
    }
    let refusal = classify_refusal(repo, &target);
    let note = if a.force {
        "The remote moved while you were deciding."
    } else {
        match refusal.kind.as_str() {
            "rewrite" => "The remote still has the old version of these commits.",
            "behind" => "This branch is behind the remote.",
            _ => "The remote has commits you do not.",
        }
    };
    Ok(OpResult { refusal, ..refused(note) })
}

/// Checks a ref out; a remote-tracking ref means its local branch, created, fast-forwarded,
/// or, when diverged, a question answered by re-running with mode "rebase" or "reset".
fn checkout_ref(repo: &str, r: &str, note: &str, mode: &str) -> Result<OpResult, String> {
    if ref_exists(repo, &format!("refs/heads/{r}")) {
        let switched = checkout_carrying_changes(repo, &["checkout", r], r, note)?;
        if !switched.ok {
            return Ok(switched);
        }
        let tracking = adopt_upstream(repo, r, "");
        return Ok(if tracking.is_empty() { switched } else { ok(say(note, &tracking, &format!("on {r}"))) });
    }

    let plain = || checkout_carrying_changes(repo, &["checkout", r], r, note);
    let Some((_, name)) = r.split_once('/').filter(|(remote, _)| !remote.is_empty()) else {
        return plain();
    };
    if name.is_empty() || name == "HEAD" || !ref_exists(repo, &format!("refs/remotes/{r}")) {
        return plain();
    }

    if !ref_exists(repo, &format!("refs/heads/{name}")) {
        let done = say(note, "", &format!("created {name} from {r} and checked it out"));
        return checkout_carrying_changes(repo, &["checkout", "-b", name, "--track", r], name, &done);
    }

    let switched = checkout_carrying_changes(repo, &["checkout", name], name, note)?;
    if !switched.ok {
        return Ok(switched);
    }
    let tracking = adopt_upstream(repo, name, r);
    let tell = |text: &str| say(note, &tracking, text);
    let (behind, ahead) =
        both(|| count_commits(repo, &format!("{name}..{r}")), || count_commits(repo, &format!("{r}..{name}")));

    if behind == 0 {
        if ahead == 0 {
            return Ok(ok(tell(&format!("on {name}, already level with {r}"))));
        }
        return Ok(ok(tell(&format!("on {name}, {} ahead of {r}, nothing to bring across", commits(ahead)))));
    }
    if ahead > 0 {
        return match mode {
            "rebase" => conflict_prone(
                repo,
                &["-c", "core.editor=true", "rebase", "--autostash", "--fork-point", r],
                "Rebase",
                &tell(&format!("rebased {name} onto {r}, {} of your own on top", commits(ahead))),
                &[],
            ),
            "reset" => {
                git(repo, &["reset", "--keep", r])?;
                Ok(ok(tell(&format!("reset {name} to {r}, dropped {} of your own", commits(ahead)))))
            }
            _ => Ok(OpResult {
                warn: true,
                confirm: format!("{name} has diverged from {r}"),
                ..ok(tell(&format!(
                    "On {name}, but it has diverged from {r} ({ahead} ahead, {behind} behind). Taking the remote's version drops {} of your own; rebasing puts them on top of it.",
                    commits(ahead)
                )))
            }),
        };
    }
    git(repo, &["merge", "--ff-only", r])?;
    Ok(ok(tell(&format!("updated {name} to {r}, {}", commits(behind)))))
}

/// Checks out, and when git refuses over local changes, stashes them, switches and puts them back.
fn checkout_carrying_changes(repo: &str, args: &[&str], r: &str, note: &str) -> Result<OpResult, String> {
    let Err(e) = git(repo, args) else {
        return Ok(ok(note));
    };
    let blocked = e.contains("would be overwritten")
        || e.contains("Please commit your changes")
        || e.contains("Please, commit your changes");
    if !blocked {
        return Err(e);
    }
    let stashed = git(repo, &["stash", "push", "--include-untracked", "-m", &format!("gitc: switching to {r}")])?;
    if stashed.contains("No local changes") {
        git(repo, args)?;
        return Ok(ok(note));
    }
    if let Err(e) = git(repo, args) {
        let _ = git_or_none(repo, &["stash", "pop"]);
        return Err(e);
    }
    if git(repo, &["stash", "pop"]).is_err() {
        let pending = read_pending(repo).kind;
        return Ok(stopped(
            format!(
                "Switched to {r}, but restoring your changes hit conflicts. Resolve them below; your work is also still saved in the stash until you drop it."
            ),
            if pending.is_empty() { "unmerged" } else { &pending },
        ));
    }
    Ok(ok(format!("switched to {r} and brought your changes across")))
}

/// Sets the upstream of `name` to the same-named remote branch when it has none and the
/// answer is unambiguous (`prefer`, or exactly one remote). Returns the upstream set, or "".
fn adopt_upstream(repo: &str, name: &str, prefer: &str) -> String {
    let existing = git_or_none(repo, &["for-each-ref", "--format=%(upstream:short)", &format!("refs/heads/{name}")]);
    if existing.is_some_and(|e| !e.trim().is_empty()) {
        return String::new();
    }
    let upstream = if !prefer.is_empty() && ref_exists(repo, &format!("refs/remotes/{prefer}")) {
        prefer.to_string()
    } else {
        let mut found = read_remotes(repo)
            .remotes
            .into_iter()
            .map(|r| format!("{r}/{name}"))
            .filter(|c| ref_exists(repo, &format!("refs/remotes/{c}")));
        let (Some(only), None) = (found.next(), found.next()) else {
            return String::new();
        };
        only
    };
    match git_or_none(repo, &["branch", &format!("--set-upstream-to={upstream}"), name]) {
        Some(_) => upstream,
        None => String::new(),
    }
}

/// Runs an operation that can stop half-way: a stop with an operation pending is a next step, not an error.
fn conflict_prone<S: AsRef<str>>(
    repo: &str,
    args: &[S],
    label: &str,
    done: &str,
    env: &[(&str, &str)],
) -> Result<OpResult, String> {
    match git_with(repo, args, env, None) {
        Ok(_) if has_unmerged(repo) => Ok(stopped(
            format!(
                "{label} went through, but your uncommitted changes clash with it. Resolve them below; a copy is kept in the stash, so nothing is lost either way."
            ),
            "unmerged",
        )),
        Ok(_) => Ok(ok(done)),
        Err(e) => {
            let pending = read_pending(repo).kind;
            if pending.is_empty() {
                return Err(e);
            }
            Ok(stopped(format!("{label} stopped with conflicts. Resolve them, then continue, or abort."), &pending))
        }
    }
}

/// Runs `git rebase -i` with gitc itself as both editors: the sequence editor applies
/// `command` to `hashes`, the message editor (when `message` is given) writes the message.
fn rebase_with(
    repo: &str,
    command: &str,
    hashes: &[&str],
    oldest: &str,
    message: Option<&str>,
    label: &str,
    done: &str,
) -> Result<OpResult, String> {
    let exe = std::env::current_exe().map_err(|e| format!("cannot find gitc itself: {e}"))?;
    let spec = temp_file(&format!("{command}.txt"))?;
    let spec_text: Vec<&str> = std::iter::once(command).chain(hashes.iter().copied()).collect();
    std::fs::write(&spec, spec_text.join("\n")).map_err(|e| format!("cannot write the rebase plan: {e}"))?;
    let msg = match message {
        Some(m) => {
            let path = temp_file(&format!("{command}-msg.txt"))?;
            if let Err(e) = std::fs::write(&path, m) {
                let _ = std::fs::remove_file(&spec);
                return Err(format!("cannot write the commit message: {e}"));
            }
            Some(path)
        }
        None => None,
    };

    let parent = format!("{oldest}^");
    let base = if git_or_none(repo, &["rev-parse", "--verify", &parent]).is_some() { parent } else { "--root".into() };
    let sequence = format!("{} --rebase-todo {}", sh_quote(&exe), sh_quote(&spec));
    let editor = msg.as_ref().map(|m| format!("{} --rebase-message {}", sh_quote(&exe), sh_quote(m)));
    let mut env = vec![("GIT_SEQUENCE_EDITOR", sequence.as_str())];
    if let Some(e) = &editor {
        env.push(("GIT_EDITOR", e.as_str()));
    }

    let result = conflict_prone(repo, &["rebase", "-i", "--autostash", &base], label, done, &env);
    let _ = std::fs::remove_file(&spec);
    if let Some(m) = msg {
        let _ = std::fs::remove_file(m);
    }
    result
}

/// Refuses a rewrite of `oldest..HEAD` that interactive rebase would get wrong:
/// off the current branch, or across or onto a merge.
fn check_rewritable(repo: &str, oldest: &str, what: &str) -> Result<(), String> {
    let range = format!("{oldest}..HEAD");
    let ((ancestor, is_merge), merges) = both(
        || {
            both(
                || git_or_none(repo, &["merge-base", "--is-ancestor", oldest, "HEAD"]).is_some(),
                || {
                    git_or_none(repo, &["rev-list", "--no-walk", "--merges", oldest])
                        .is_some_and(|o| !o.trim().is_empty())
                },
            )
        },
        || count_commits_with(repo, &["rev-list", "--count", "--merges", &range]),
    );
    if !ancestor {
        return Err(format!(
            "that commit is not on the current branch, so {what} it would rewrite history you are not on; check the branch out first"
        ));
    }
    if is_merge {
        return Err(format!(
            "that is a merge commit, and an interactive rebase leaves merges out of its todo entirely, so {what} one would flatten the merge instead"
        ));
    }
    match merges {
        0 => Ok(()),
        1 => Err("there is a merge commit between that commit and HEAD; rewriting across it would flatten the merged branch away".into()),
        n => Err(format!(
            "there are {n} merge commits between that commit and HEAD; rewriting across them would flatten the merged branches away"
        )),
    }
}

fn no_merges_among(repo: &str, shas: &[&str], what: &str) -> Result<(), String> {
    let args: Vec<&str> = ["rev-list", "--no-walk", "--merges"].into_iter().chain(shas.iter().copied()).collect();
    let found = git_or_none(repo, &args).unwrap_or_default();
    let n = found.lines().filter(|l| !l.trim().is_empty()).count();
    let head = match n {
        0 => return Ok(()),
        1 => "one of those commits is a merge".to_string(),
        n => format!("{n} of those commits are merges"),
    };
    Err(format!(
        "{head}, and an interactive rebase leaves merges out of its todo entirely, so {what} would flatten what they merged"
    ))
}

/// The squashed message: the oldest subject, then its body, then every later commit's
/// subject and body, oldest first. Co-author trailers are lifted out for `with_credits`.
fn squash_message(repo: &str, shas: &[&str]) -> String {
    let args: Vec<&str> =
        ["log", "--no-walk=unsorted", "--format=%s%x00%b%x01"].into_iter().chain(shas.iter().rev().copied()).collect();
    let Some(out) = git_or_none(repo, &args) else {
        return String::new();
    };
    let mut entries = out.split('\u{1}').filter(|r| !r.trim().is_empty()).map(|record| {
        let (subject, body) = record.split_once('\0').unwrap_or((record, ""));
        (subject.replace(['\r', '\n'], "").trim().to_string(), extract_co_authors(body).0.trim().to_string())
    });
    let Some((head, first_body)) = entries.next() else {
        return String::new();
    };
    let mut paragraphs = Vec::new();
    if !first_body.is_empty() {
        paragraphs.push(first_body);
    }
    for (subject, body) in entries {
        if subject.is_empty() && body.is_empty() {
            continue;
        }
        paragraphs.push(if body.is_empty() { subject } else { format!("{subject}\n\n{body}") });
    }
    if paragraphs.is_empty() {
        return head;
    }
    format!("{head}\n\n{}", paragraphs.join("\n\n"))
}

/// Everyone a squash must still credit: every author and co-author in the run but `author`.
fn credits_for(repo: &str, shas: &[&str], author: &Person) -> Vec<Person> {
    let args: Vec<&str> = ["log", "--no-walk=unsorted", "--format=%an%x00%ae%x00%B%x01"]
        .into_iter()
        .chain(shas.iter().rev().copied())
        .collect();
    let mut seen = HashSet::from([person_key(author)]);
    let mut credits = Vec::new();
    let Some(out) = git_or_none(repo, &args) else {
        return credits;
    };
    for record in out.split('\u{1}').filter(|r| !r.trim().is_empty()) {
        let mut fields = record.splitn(3, '\0');
        let name = fields.next().unwrap_or("").replace(['\r', '\n'], "").trim().to_string();
        let email = fields.next().unwrap_or("").trim().to_string();
        let body = fields.next().unwrap_or("");
        let people = std::iter::once(Person { name, email }).chain(extract_co_authors(body).1);
        for person in people {
            if person.name.trim().is_empty() && person.email.trim().is_empty() {
                continue;
            }
            let key = person_key(&person);
            if !key.is_empty() && seen.insert(key) {
                credits.push(person);
            }
        }
    }
    credits
}

/// Appends co-author trailers for `credits` the message does not already carry.
fn with_credits(message: &str, credits: &[Person]) -> String {
    let mut already: HashSet<String> = extract_co_authors(message).1.iter().map(person_key).collect();
    let lines: Vec<String> = credits
        .iter()
        .filter(|p| already.insert(person_key(p)))
        .map(|p| format!("{CO_AUTHOR_LABEL}{}", person_text(p)))
        .collect();
    if lines.is_empty() {
        return message.to_string();
    }
    format!("{}\n\n{}", message.trim(), lines.join("\n"))
}

/// Works out whether a refused push wants a pull ("behind", "diverged") or a force ("rewrite").
/// Anything undeterminable reads as "diverged", the answer that cannot lose work.
fn classify_refusal(repo: &str, upstream: &str) -> PushRefusal {
    let remote = upstream.split_once('/').map(|(r, _)| r).unwrap_or(upstream);
    if !remote.is_empty() {
        let _ = git_or_none(repo, &["fetch", remote]);
    }
    let sym = format!("{upstream}...HEAD");
    let ((ahead, behind), (theirs, listed)) = both(
        || {
            both(
                || count_commits(repo, &format!("{upstream}..HEAD")),
                || count_commits(repo, &format!("HEAD..{upstream}")),
            )
        },
        || {
            both(
                || {
                    git_or_none(repo, &["rev-list", "--count", "--left-only", "--cherry-pick", &sym])
                        .and_then(|o| o.trim().parse::<u64>().ok())
                },
                || {
                    git_or_none(
                        repo,
                        &["log", "--left-only", "--cherry-pick", "--max-count=5", "--format=%an: %s", &sym],
                    )
                    .unwrap_or_default()
                },
            )
        },
    );
    let kind = match theirs {
        _ if ahead == 0 && behind > 0 => "behind",
        Some(0) => "rewrite",
        _ => "diverged",
    };
    PushRefusal {
        kind: kind.into(),
        upstream: upstream.to_string(),
        ahead,
        behind,
        theirs: theirs.unwrap_or(behind),
        their_commits: listed.lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect(),
    }
}

fn is_refusal(message: &str) -> bool {
    ["non-fast-forward", "fetch first", "Updates were rejected"].iter().any(|m| message.contains(m))
}

fn detached_warning(repo: &str) -> String {
    if git_or_none(repo, &["symbolic-ref", "-q", "HEAD"]).is_some() {
        return String::new();
    }
    match git_or_none(repo, &["rev-parse", "--short", "HEAD"]) {
        Some(desc) => format!("left detached HEAD at {}", desc.trim()),
        None => String::new(),
    }
}

/// Hands a file to GITC_EDITOR, or else to the platform's opener.
fn open_in_editor(file: &Path) {
    let mut cmd = match std::env::var_os("GITC_EDITOR").filter(|e| !e.is_empty()) {
        Some(editor) => Command::new(editor),
        None if cfg!(windows) => {
            let mut c = Command::new("cmd");
            c.args(["/c", "start", ""]);
            hide_console(&mut c);
            c
        }
        None if cfg!(target_os = "macos") => Command::new("open"),
        None => Command::new("xdg-open"),
    };
    cmd.arg(file).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    match cmd.spawn() {
        Ok(mut child) => {
            std::thread::spawn(move || child.wait());
        }
        Err(e) => eprintln!("gitc: cannot open {}: {e}", file.display()),
    }
}

fn write_upstream(repo: &str, branch: &str, remote: &str, name: &str) -> Result<(), String> {
    git(repo, &["config", &format!("branch.{branch}.remote"), remote])?;
    git(repo, &["config", &format!("branch.{branch}.merge"), &format!("refs/heads/{name}")])?;
    Ok(())
}

fn has_unmerged(repo: &str) -> bool {
    git_or_none(repo, &["--no-optional-locks", "ls-files", "--unmerged"]).is_some_and(|o| !o.trim().is_empty())
}

fn is_head(repo: &str, sha: &str) -> bool {
    git_or_none(repo, &["rev-parse", "HEAD"]).is_some_and(|h| h.trim() == sha)
}

fn ref_exists(repo: &str, full: &str) -> bool {
    git_or_none(repo, &["rev-parse", "--verify", "--quiet", full]).is_some()
}

fn count_commits(repo: &str, range: &str) -> u64 {
    count_commits_with(repo, &["rev-list", "--count", range])
}

fn count_commits_with(repo: &str, args: &[&str]) -> u64 {
    git_or_none(repo, args).and_then(|o| o.trim().parse().ok()).unwrap_or(0)
}

/// Runs `b` on another thread while `a` runs here.
fn both<A, B: Send + Default>(a: impl FnOnce() -> A, b: impl FnOnce() -> B + Send) -> (A, B) {
    std::thread::scope(|s| {
        let other = s.spawn(b);
        let here = a();
        (here, other.join().unwrap_or_default())
    })
}

/// A ref argument: present, and not readable by git as an option.
fn need_ref<'a>(value: &'a str, what: &str) -> Result<&'a str, String> {
    if value.trim().is_empty() {
        return Err(format!("no {what} given"));
    }
    safe_argument(value, what)
}

fn need_name<'a>(value: &'a str, missing: &str, what: &str) -> Result<&'a str, String> {
    if value.trim().is_empty() {
        return Err(missing.to_string());
    }
    safe_argument(value, what)
}

fn need_shas(a: &OpArgs) -> Result<Vec<&str>, String> {
    if a.shas.is_empty() {
        return Err("no commits given".into());
    }
    a.shas.iter().map(|s| safe_argument(s, "commit")).collect()
}

fn first_sha(a: &OpArgs) -> Result<&str, String> {
    let Some(sha) = a.shas.first() else {
        return Err("no commit given".into());
    };
    safe_argument(sha, "commit")
}

/// Quotes a path for the POSIX shell git runs its editors through, with forward slashes.
fn sh_quote(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    format!("'{}'", text.replace('\'', "'\\''"))
}

fn say(note: &str, tracking: &str, text: &str) -> String {
    let head = if note.is_empty() { text.to_string() } else { format!("{note}; {text}") };
    match (tracking.is_empty(), head.ends_with('.')) {
        (true, _) => head,
        (false, true) => format!("{head} Now tracking {tracking}."),
        (false, false) => format!("{head}, now tracking {tracking}"),
    }
}

fn commits(n: u64) -> String {
    format!("{n} {}", if n == 1 { "commit" } else { "commits" })
}

fn short(sha: &str) -> &str {
    sha.get(..7).unwrap_or(sha)
}

fn person_key(person: &Person) -> String {
    let email = person.email.trim().to_lowercase();
    if email.is_empty() { person.name.trim().to_lowercase() } else { email }
}

fn person_text(person: &Person) -> String {
    let (name, email) = (person.name.trim(), person.email.trim());
    match (name.is_empty(), email.is_empty()) {
        (_, true) => name.to_string(),
        (true, false) => format!("<{email}>"),
        (false, false) => format!("{name} <{email}>"),
    }
}

fn no_refusal() -> PushRefusal {
    PushRefusal { kind: "none".into(), ..Default::default() }
}

fn ok(note: impl Into<String>) -> OpResult {
    OpResult { ok: true, note: note.into(), refusal: no_refusal(), ..Default::default() }
}

/// Refused before anything was touched; also the base for a question or a push refusal.
fn refused(note: impl Into<String>) -> OpResult {
    OpResult { note: note.into(), refusal: no_refusal(), ..Default::default() }
}

/// Stopped part-way with `pending` to resolve.
fn stopped(note: String, pending: &str) -> OpResult {
    OpResult { pending: pending.to_string(), ..refused(note) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn sh(cwd: &Path, args: &[&str]) -> String {
        let out = Command::new("git").args(args).current_dir(cwd).output().expect("git runs");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn configure(dir: &Path) {
        for (k, v) in [("user.name", "t"), ("user.email", "t@t"), ("core.autocrlf", "false")] {
            sh(dir, &["config", k, v]);
        }
    }

    fn sandbox(name: &str) -> PathBuf {
        let root = temp_file(name).expect("temp dir");
        std::fs::create_dir_all(&root).expect("sandbox");
        root
    }

    fn clone(root: &Path, from: &Path, name: &str) -> PathBuf {
        sh(root, &["clone", "-q", "-c", "core.autocrlf=false", &from.to_string_lossy(), name]);
        let dir = root.join(name);
        configure(&dir);
        dir
    }

    fn commit(cwd: &Path, file: &str) {
        std::fs::write(cwd.join(file), file).expect("write");
        sh(cwd, &["add", file]);
        sh(cwd, &["commit", "-q", "-m", file]);
    }

    fn op(op: &str, r: &str, mode: &str) -> OpArgs {
        OpArgs { op: op.into(), r#ref: r.into(), mode: mode.into(), ..Default::default() }
    }

    fn run(repo: &Path, args: OpArgs) -> OpResult {
        run_op(&repo.to_string_lossy(), &args).expect("op runs")
    }

    fn read(dir: &Path, file: &str) -> String {
        std::fs::read_to_string(dir.join(file)).unwrap_or_default()
    }

    #[test]
    fn checkout_diverged_remote_branch() {
        let root = sandbox("checkout-test");
        sh(&root, &["init", "-q", "-b", "master", "upstream"]);
        let upstream = root.join("upstream");
        configure(&upstream);
        commit(&upstream, "base");
        sh(&upstream, &["branch", "topic"]);

        let diverged = |name: &str| {
            let dir = clone(&root, &upstream, name);
            sh(&dir, &["checkout", "-q", "-b", "topic", "origin/topic"]);
            commit(&dir, &format!("mine-{name}"));
            sh(&dir, &["checkout", "-q", "master"]);
            sh(&upstream, &["checkout", "-q", "topic"]);
            commit(&upstream, &format!("theirs-{name}"));
            sh(&upstream, &["checkout", "-q", "master"]);
            sh(&dir, &["fetch", "-q"]);
            dir
        };

        let asked = diverged("asked");
        let question = run(&asked, op("checkout", "origin/topic", ""));
        assert_eq!(question.confirm, "topic has diverged from origin/topic");
        assert_eq!(sh(&asked, &["branch", "--show-current"]), "topic");
        assert_eq!(sh(&asked, &["rev-list", "--count", "origin/topic..topic"]), "1");

        let rebased = diverged("rebased");
        std::fs::write(rebased.join("base"), "edited").expect("edit");
        assert!(run(&rebased, op("checkout", "origin/topic", "rebase")).ok);
        assert_eq!(sh(&rebased, &["rev-list", "--count", "topic..origin/topic"]), "0");
        assert_eq!(sh(&rebased, &["log", "-1", "--format=%s", "topic"]), "mine-rebased");
        assert_eq!(sh(&rebased, &["status", "--porcelain"]), "M base");

        let reset = diverged("reset");
        std::fs::write(reset.join("base"), "edited").expect("edit");
        assert!(run(&reset, op("checkout", "origin/topic", "reset")).ok);
        assert_eq!(sh(&reset, &["rev-parse", "topic"]), sh(&reset, &["rev-parse", "origin/topic"]));
        assert_eq!(sh(&reset, &["status", "--porcelain"]), "M base");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn pull_and_rebase_mid_edit() {
        let root = sandbox("pull-test");
        sh(&root, &["init", "-q", "--bare", "-b", "master", "upstream"]);
        let upstream = root.join("upstream");
        let other = clone(&root, &upstream, "other");
        std::fs::write(other.join("f"), "1\n2\n3\n").expect("write");
        std::fs::write(other.join("g"), "x\n").expect("write");
        sh(&other, &["add", "."]);
        sh(&other, &["commit", "-q", "-m", "base"]);
        sh(&other, &["push", "-q", "origin", "master"]);

        let mut n = 0;
        let mut behind_with_edit = |file: &str, edit: &dyn Fn(&mut Vec<String>)| {
            n += 1;
            let dir = clone(&root, &upstream, &format!("c{n}"));
            std::fs::write(other.join("f"), format!("1\ntheirs {n}\n3\n")).expect("write");
            sh(&other, &["commit", "-q", "-am", &format!("theirs {n}")]);
            sh(&other, &["push", "-q"]);
            sh(&dir, &["fetch", "-q"]);
            let mut lines: Vec<String> = read(&dir, file).split('\n').map(String::from).collect();
            edit(&mut lines);
            std::fs::write(dir.join(file), lines.join("\n")).expect("write");
            dir
        };
        let set_line = |at: usize| {
            move |l: &mut Vec<String>| {
                if let Some(x) = l.get_mut(at) {
                    *x = "mine".into();
                }
            }
        };
        let own_commit_and_edit = |dir: &Path| {
            std::fs::write(dir.join("h"), "h\n").expect("write");
            sh(dir, &["add", "h"]);
            sh(dir, &["commit", "-q", "-m", "own"]);
            std::fs::write(dir.join("g"), "mine\n").expect("write");
        };

        let apart = behind_with_edit("g", &set_line(0));
        assert!(run(&apart, op("pull", "", "")).ok);
        assert_eq!(sh(&apart, &["rev-parse", "HEAD"]), sh(&apart, &["rev-parse", "origin/master"]));
        assert_eq!(read(&apart, "g"), "mine\n");

        let same_file = behind_with_edit("f", &|l| l.insert(3, "mine".into()));
        assert!(run(&same_file, op("pull", "", "")).ok);
        assert_eq!(read(&same_file, "f"), "1\ntheirs 2\n3\nmine\n");
        assert_eq!(sh(&same_file, &["stash", "list"]), "");

        let same_line = behind_with_edit("f", &set_line(1));
        let r3 = run(&same_line, op("pull", "", ""));
        assert_eq!((r3.ok, r3.pending.as_str()), (false, "unmerged"));
        assert_eq!(sh(&same_line, &["rev-parse", "HEAD"]), sh(&same_line, &["rev-parse", "origin/master"]));
        assert_eq!(sh(&same_line, &["status", "--porcelain"]), "UU f");
        assert!(sh(&same_line, &["stash", "list"]).contains("autostash"));

        let rebased = behind_with_edit("g", &set_line(0));
        own_commit_and_edit(&rebased);
        assert!(run(&rebased, op("pull", "", "rebase")).ok);
        assert_eq!(sh(&rebased, &["log", "-1", "--format=%s"]), "own");
        assert_eq!(sh(&rebased, &["status", "--porcelain"]), "M g");

        let onto = behind_with_edit("g", &set_line(0));
        own_commit_and_edit(&onto);
        assert!(run(&onto, op("rebaseOnto", "origin/master", "")).ok);
        assert_eq!(sh(&onto, &["rev-parse", "HEAD^"]), sh(&onto, &["rev-parse", "origin/master"]));
        assert_eq!(sh(&onto, &["status", "--porcelain"]), "M g");

        let aborted = behind_with_edit("g", &set_line(0));
        std::fs::write(aborted.join("f"), "1\nown\n3\n").expect("write");
        sh(&aborted, &["commit", "-q", "-m", "own", "f"]);
        assert_eq!(run(&aborted, op("rebaseOnto", "origin/master", "")).pending, "rebase");
        run(&aborted, op("abort", "rebase", ""));
        assert_eq!(sh(&aborted, &["status", "--porcelain"]), "M g");
        assert_eq!(sh(&aborted, &["stash", "list"]), "");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn credits_and_wording() {
        let a = Person { name: "A".into(), email: "a@x".into() };
        let b = Person { name: "B".into(), email: "B@x".into() };
        let msg = "subject\n\nbody\n\nCo-authored-by: B <b@x>";
        assert_eq!(with_credits(msg, &[b.clone()]), msg);
        assert_eq!(with_credits("subject", &[a, b]), "subject\n\nCo-authored-by: A <a@x>\nCo-authored-by: B <B@x>");
        assert_eq!(say("", "origin/x", "on x"), "on x, now tracking origin/x");
        assert_eq!(say("left", "origin/x", "Done."), "left; Done. Now tracking origin/x.");
        assert_eq!(sh_quote(Path::new("C:\\a b\\it's")), "'C:/a b/it'\\''s'");
    }

    #[test]
    fn continued_merge_drops_conflict_comments() {
        let root = sandbox("merge-continue-test");
        sh(&root, &["init", "-q", "-b", "main", "repo"]);
        let repo = root.join("repo");
        configure(&repo);
        commit(&repo, "f");
        sh(&repo, &["checkout", "-q", "-b", "feature"]);
        std::fs::write(repo.join("f"), "feature").expect("write");
        sh(&repo, &["commit", "-qam", "feature"]);
        sh(&repo, &["checkout", "-q", "main"]);
        std::fs::write(repo.join("f"), "main").expect("write");
        sh(&repo, &["commit", "-qam", "main"]);

        assert!(!run(&repo, op("merge", "feature", "")).ok);
        std::fs::write(repo.join("f"), "both").expect("write");
        sh(&repo, &["add", "f"]);
        assert!(run(&repo, op("continue", "merge", "")).ok);
        assert_eq!(sh(&repo, &["log", "-1", "--format=%B"]), "Merge branch 'feature'");

        let _ = std::fs::remove_dir_all(&root);
    }
}
