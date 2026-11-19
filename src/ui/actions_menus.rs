use std::collections::{HashMap, HashSet};

use eframe::egui::Pos2;

use super::super::App;
use super::super::dialogs::{Choice, Choose, Field, Form, MenuItem, Prompt};
use super::{
    AiConfig, Commit, OpArgs, Request, Submodule, chain_between, close_tab, confirm_op, edit_worktree, holder,
    is_active, is_wip, kind_label, locked_line, op, open_submodule, prompt_op, provider_for, remote_branch_check,
    remotes_of, run_on, save_ai, set_hidden, set_session, short, split_remote_branch, squash, validate_ref_name,
    validate_remote_name, validate_remote_url, view_worktree, wip_worktree, worktree_label,
};
use crate::engine::types::Ref;

/// Right-click on a graph row; acts on the whole selection when the row is part of it.
pub fn commit_menu(app: &mut App, pos: Pos2, hash: &str) {
    if let Some(name) = wip_worktree(hash) {
        let Some(repo) = app.repo() else { return };
        if !repo.data.as_ref().is_some_and(|d| d.worktrees.iter().any(|w| w.name == name)) {
            return;
        }
        repo.selected = vec![hash.to_string()];
        repo.anchor = None;
        worktree_menu(app, pos, name);
        return;
    }
    if is_wip(hash) {
        return;
    }
    let Some(id) = app.active_id() else { return };
    let Some(repo) = app.repos.get_mut(&id) else { return };
    let Some(data) = repo.data.as_ref() else { return };

    let order: HashMap<&str, (usize, &Commit)> =
        data.commits.iter().enumerate().map(|(i, c)| (c.hash.as_str(), (i, c))).collect();
    let mut chosen: Vec<String> = if repo.selected.iter().any(|h| h == hash) {
        repo.selected.iter().filter(|h| !is_wip(h)).cloned().collect()
    } else {
        repo.selected = vec![hash.to_string()];
        repo.anchor = Some(hash.to_string());
        vec![hash.to_string()]
    };
    chosen.sort_by_key(|h| order.get(h.as_str()).map_or(usize::MAX, |(i, _)| *i));

    let many = chosen.len() > 1;
    let n = chosen.len();
    let sha = short(hash).to_string();
    let on = data.head.branch.clone().unwrap_or_else(|| "HEAD".into());
    let is_head = data.head.hash.as_deref() == Some(hash);
    let clean = data.status.is_empty();
    let is_merge = |h: &str| order.get(h).is_some_and(|(_, c)| c.parents.len() > 1);
    let picks_merge = chosen.iter().any(|h| is_merge(h));
    let subject = order.get(hash).map(|(_, c)| c.subject.clone()).unwrap_or_default();
    let rewrite: Option<usize> = (|| {
        let head = data.head.hash.as_deref()?;
        let older = chosen.last()?;
        let by_hash: HashMap<&str, &Commit> = order.iter().map(|(h, (_, c))| (*h, *c)).collect();
        let chain = chain_between(&by_hash, head, older)?;
        if chain.iter().any(|h| is_merge(h)) {
            return None;
        }
        let picked: HashSet<&str> = chosen.iter().map(String::as_str).collect();
        Some(chain.iter().filter(|h| !picked.contains(*h)).count())
    })();
    let on_current = rewrite.is_some();

    let mut items = Vec::new();
    let (i, h, s) = (id.clone(), hash.to_string(), sha.clone());
    items.push(MenuItem::new("Checkout this commit", move |app| {
        let body = format!(
            "This detaches HEAD at {s}. Commits made while detached belong to no branch, so create one before moving away if you want to keep them."
        );
        confirm_op(app, &i, "Check out this commit?", body, "Checkout", false, OpArgs { shas: vec![h], ..op("checkoutCommit") })
    }));
    items.push(MenuItem::separator());
    let (i, h, s) = (id.clone(), hash.to_string(), sha.clone());
    items.push(MenuItem::new("Create branch here", move |app| {
        name_prompt(
            app,
            &i,
            "Create branch",
            format!("Branch at {s}"),
            "feature/my-work",
            "Create & checkout",
            move |name| OpArgs { name, shas: vec![h], checkout: true, ..op("createBranch") },
        )
    }));
    if many && on_current && !picks_merge {
        let shas = chosen.clone();
        items.push(
            MenuItem::new(format!("Squash {n} commits into one"), move |app| squash(app, shas))
                .hint("keeps the oldest commit's place in history and its author"),
        );
        items.push(MenuItem::separator());
    }
    let (i, shas) = (id.clone(), chosen.clone());
    let label = if many { format!("Cherry pick {n} commits") } else { "Cherry pick commit".into() };
    items.push(MenuItem::new(label, move |app| run_on(app, &i, OpArgs { shas, ..op("cherryPick") })));
    let (i, h, s, o) = (id.clone(), hash.to_string(), sha.clone(), on.clone());
    items.push(MenuItem::new(format!("Rebase {on} onto this commit"), move |app| {
        let body = format!(
            "This rewrites the commits on {o}. If they have already been pushed, anyone else who has them will have to reconcile."
        );
        confirm_op(app, &i, format!("Rebase {o} onto {s}?"), body, "Rebase", false, OpArgs { r#ref: h, ..op("rebaseOnto") })
    }));
    let (i, shas, s) = (id.clone(), chosen.clone(), sha.clone());
    let title = if many { format!("Revert {n} commits") } else { "Revert commit".into() };
    items.push(MenuItem::new(title.clone(), move |app| {
        let body = if many {
            "The changes these commits made are undone, newest first.".to_string()
        } else {
            format!("The changes {s} made are undone.")
        };
        let hint = if many { "one commit each".to_string() } else { format!("Revert \"{subject}\"") };
        app.overlay.choose(Choose {
            title,
            body,
            options: vec![
                Choice {
                    value: "worktree".into(),
                    label: "Leave the changes unstaged".into(),
                    hint: "edit or discard first".into(),
                },
                Choice { value: "commit".into(), label: "Commit the revert now".into(), hint },
            ],
            on_pick: Box::new(move |app, mode| run_on(app, &i, OpArgs { shas, mode, ..op("revert") })),
        });
    }));
    if on_current && !picks_merge {
        let (i, shas, s, o) = (id.clone(), chosen.clone(), sha.clone(), on.clone());
        let label = if many { format!("Drop {n} commits") } else { "Drop commit".into() };
        let confirm_label = label.clone();
        let above = rewrite.unwrap_or(0);
        items.push(
            MenuItem::new(label, move |app| {
                let title = if many { format!("Drop {n} commits?") } else { format!("Drop {s}?") };
                let mut body = if many {
                    format!("These {n} commits are removed from {o} entirely. ")
                } else {
                    format!("{s} is removed from {o} entirely. ")
                };
                body.push_str("Nothing undoes the change in a commit of its own - use Revert for that.");
                if above > 0 {
                    let (what, verb) =
                        if above == 1 { ("commit".to_string(), "is") } else { (format!("{above} commits"), "are") };
                    body.push_str(&format!(
                        "\n\nThe {what} above {verb} rewritten, so anyone who already has them will have to reconcile."
                    ));
                }
                confirm_op(app, &i, title, body, confirm_label, true, OpArgs { shas, ..op("drop") })
            })
            .hint("deleted outright, not undone by a new commit"),
        );
    }
    if !many && is_head {
        let (i, h) = (id.clone(), hash.to_string());
        let hint = if clean {
            "drops it and leaves its changes unstaged"
        } else {
            "needs a clean working tree - commit or stash what is there"
        };
        items.push(
            MenuItem::new("Unpack commit", move |app| run_on(app, &i, OpArgs { shas: vec![h], ..op("unpack") }))
                .hint(hint)
                .disabled(!clean),
        );
    }
    items.push(MenuItem::separator());
    let (i, h) = (id.clone(), hash.to_string());
    items.push(MenuItem::new(format!("Reset {on} here, keep changes"), move |app| {
        run_on(app, &i, OpArgs { shas: vec![h], mode: "mixed".into(), ..op("reset") })
    }));
    let (i, h, s, o) = (id.clone(), hash.to_string(), sha.clone(), on.clone());
    items.push(MenuItem::new(format!("Reset {on} here, discard changes"), move |app| {
        let body = format!(
            "{o} moves to {s} and the working tree is reset to match. Uncommitted changes, and any commits after it, are lost."
        );
        let args = OpArgs { shas: vec![h], mode: "hard".into(), ..op("reset") };
        confirm_op(app, &i, "Discard everything after this commit?", body, "Reset hard", true, args)
    }));
    items.push(MenuItem::separator());
    let (i, h, s) = (id.clone(), hash.to_string(), sha.clone());
    items.push(MenuItem::new("Create tag here", move |app| {
        name_prompt(app, &i, "Create tag", format!("Tag at {s}"), "v1.0.0", "Create tag", move |name| OpArgs {
            name,
            shas: vec![h],
            ..op("createTag")
        })
    }));
    let h = hash.to_string();
    items.push(MenuItem::new("Copy commit sha", move |app| copy(app, &h, short(&h))));
    let ctx = app.ctx.clone();
    app.overlay.menu(&ctx, pos, items);
}

/// Right-click on a branch, remote branch or tag (sidebar row or graph chip).
pub fn ref_menu(app: &mut App, pos: Pos2, r: &Ref) {
    let Some(id) = app.active_id() else { return };
    let Some(data) = app.repos.get(&id).and_then(|repo| repo.data.as_ref()) else { return };
    let name = r.short.clone();
    let branch = data.head.branch.clone().unwrap_or_else(|| "HEAD".into());
    let is_current = r.kind == "local" && data.head.branch.as_deref() == Some(name.as_str());
    let holding = if r.kind == "local" { holder(&data.worktrees, &name).cloned() } else { None };
    let hidden_now = data.hidden.contains(&name);
    let tracked = data.upstreams.get(&name).cloned();
    let remotes = data.remotes.clone();
    let mut items = Vec::new();

    if r.kind == "tag" {
        let (i, n) = (id.clone(), name.clone());
        items.push(MenuItem::new(format!("Checkout {name}"), move |app| {
            run_on(app, &i, OpArgs { r#ref: n, ..op("checkout") })
        }));
        items.push(MenuItem::separator());
        let (i, n) = (id.clone(), name.clone());
        items.push(MenuItem::new(format!("Delete tag {name}"), move |app| {
            let body = format!("Tag {n} will be deleted locally.");
            confirm_op(app, &i, "Delete tag?", body, "Delete", true, OpArgs { r#ref: n, ..op("deleteTag") })
        }));
        let ctx = app.ctx.clone();
        app.overlay.menu(&ctx, pos, items);
        return;
    }

    if !is_current {
        match holding.clone() {
            None => {
                let (i, n) = (id.clone(), name.clone());
                items.push(MenuItem::new(format!("Checkout {name}"), move |app| {
                    run_on(app, &i, OpArgs { r#ref: n, ..op("checkout") })
                }));
            }
            Some(w) => {
                let label = worktree_label(&w);
                items.push(
                    MenuItem::new(format!("Open {label}"), move |app| edit_worktree(app, &w.name))
                        .hint(format!("{name} is checked out in that worktree")),
                );
            }
        }
        let (i, n) = (id.clone(), name.clone());
        items.push(MenuItem::new(format!("Merge {name} into {branch}"), move |app| {
            run_on(app, &i, OpArgs { r#ref: n, ..op("merge") })
        }));
        let (i, n) = (id.clone(), name.clone());
        items.push(MenuItem::new(format!("Fast-forward to {name}"), move |app| {
            run_on(app, &i, OpArgs { r#ref: n, ..op("fastForward") })
        }));
        let (i, n) = (id.clone(), name.clone());
        items.push(MenuItem::new(format!("Rebase {branch} onto {name}"), move |app| {
            run_on(app, &i, OpArgs { r#ref: n, ..op("rebaseOnto") })
        }));
    }
    items.push(MenuItem::separator());
    let (i, n) = (id.clone(), name.clone());
    items.push(MenuItem::new("Create branch here", move |app| {
        let label = format!("Branch from {n}");
        name_prompt(app, &i, "Create branch", label, "", "Create & checkout", move |name| OpArgs {
            name,
            r#ref: n,
            checkout: true,
            ..op("createBranch")
        })
    }));

    if r.kind == "local" {
        let (i, n) = (id.clone(), name.clone());
        items.push(MenuItem::new("Rename branch", move |app| {
            let make = {
                let n = n.clone();
                move |name| Some(OpArgs { r#ref: n, name, ..op("renameBranch") })
            };
            let prompt = prompt_op(&i, "Rename branch", "Rename", Box::new(validate_ref_name), make);
            app.overlay.prompt(Prompt { label: "New name".into(), initial: n, ..prompt });
        }));
        if let Some(first) = remotes.first().cloned() {
            let label = match &tracked {
                Some(t) => format!("Change upstream ({t})"),
                None => "Set upstream".into(),
            };
            let (i, n, t) = (id.clone(), name.clone(), tracked.clone());
            items.push(MenuItem::new(label, move |app| {
                let remotes = remotes_of(app, &i);
                let remote = t.as_deref().and_then(|t| split_remote_branch(t, &remotes)).map_or(first, |(r, _)| r);
                let check = remote_branch_check(remotes.clone());
                let b = n.clone();
                let make = move |value: String| {
                    let (remote, name) = split_remote_branch(&value, &remotes)?;
                    Some(OpArgs { r#ref: b, remote, name, ..op("setUpstream") })
                };
                let prompt = prompt_op(&i, "Set upstream", "Set upstream", check, make);
                let label = format!("Remote branch {n} pushes to and pulls from");
                app.overlay.prompt(Prompt { label, initial: format!("{remote}/{n}"), ..prompt });
            }));
        }
        if let Some(t) = &tracked {
            let (i, n) = (id.clone(), name.clone());
            items.push(MenuItem::new(format!("Stop tracking {t}"), move |app| {
                run_on(app, &i, OpArgs { r#ref: n, ..op("setUpstream") })
            }));
        }
        if is_current {
            items.push(MenuItem::new("Delete (checked out)", |_| {}).disabled(true));
        } else if let Some(w) = &holding {
            items.push(MenuItem::new(format!("Delete (checked out in {})", worktree_label(w)), |_| {}).disabled(true));
        } else {
            let (i, n) = (id.clone(), name.clone());
            items.push(MenuItem::new(format!("Delete {name}"), move |app| {
                let body = format!("{n} will be deleted.");
                confirm_op(app, &i, "Delete branch?", body, "Delete", true, OpArgs { r#ref: n, ..op("deleteBranch") })
            }));
        }
    }

    if let (true, Some(remote)) = (r.kind == "remote", r.remote.clone()) {
        let bare = name.strip_prefix(&format!("{remote}/")).unwrap_or(&name).to_string();
        let i = id.clone();
        items.push(MenuItem::new(format!("Delete {bare} on {remote}"), move |app| {
            let body =
                format!("{bare} will be deleted on {remote}. This affects everyone using that remote, not just you.");
            let args = OpArgs { r#ref: bare, remote, ..op("deleteRemoteBranch") };
            confirm_op(app, &i, "Delete remote branch?", body, "Delete on remote", true, args)
        }));
    }

    items.push(MenuItem::separator());
    let label = if hidden_now { format!("Show {name} in the graph") } else { format!("Hide {name} in the graph") };
    let n = name.clone();
    items.push(MenuItem::new(label, move |app| set_hidden(app, vec![n], !hidden_now)));
    items.push(MenuItem::separator());
    items.push(MenuItem::new("Copy branch name", move |app| copy(app, &name, &name)));
    let ctx = app.ctx.clone();
    app.overlay.menu(&ctx, pos, items);
}

/// Right-click on a graph chip group, named the way Graph.tsx's onContext named it.
pub fn chip_menu(app: &mut App, pos: Pos2, kind: &str, name: &str) {
    match kind {
        "stash" => stash_menu(app, pos, name),
        "worktree" => worktree_menu(app, pos, name),
        _ => {
            let found = app
                .repo()
                .and_then(|r| r.data.as_ref())
                .and_then(|d| d.refs.iter().find(|r| r.kind == kind && r.short == name))
                .cloned();
            if let Some(r) = found {
                ref_menu(app, pos, &r);
            }
        }
    }
}

pub fn remote_menu(app: &mut App, pos: Pos2, remote: &str) {
    let Some(id) = app.active_id() else { return };
    let Some(data) = app.repos.get(&id).and_then(|r| r.data.as_ref()) else { return };
    let url = data.remote_detail.iter().find(|r| r.name == remote).map(|r| r.url.clone()).unwrap_or_default();
    let refs: Vec<String> = data
        .refs
        .iter()
        .filter(|r| r.kind == "remote" && r.remote.as_deref() == Some(remote))
        .map(|r| r.short.clone())
        .collect();
    let all_hidden = !refs.is_empty() && refs.iter().all(|r| data.hidden.contains(r));
    let count = refs.len();
    let name = remote.to_string();
    let mut items = Vec::new();

    let (i, n) = (id.clone(), name.clone());
    items.push(MenuItem::new(format!("Fetch {name}"), move |app| {
        run_on(app, &i, OpArgs { r#ref: n, ..op("fetchRemote") })
    }));
    let (i, n) = (id.clone(), name.clone());
    items.push(
        MenuItem::new(format!("Prune {name}"), move |app| run_on(app, &i, OpArgs { r#ref: n, ..op("pruneRemote") }))
            .hint("drop branches deleted on the remote"),
    );
    items.push(MenuItem::separator());
    let label = if all_hidden { format!("Show {name} in the graph") } else { format!("Hide {name} in the graph") };
    items.push(MenuItem::new(label, move |app| set_hidden(app, refs, !all_hidden)).hint(branches(count)));
    items.push(MenuItem::separator());
    let (i, n, u) = (id.clone(), name.clone(), url.clone());
    items.push(MenuItem::new(format!("Edit {name}"), move |app| {
        let fields = vec![
            Field {
                key: "name".into(),
                label: "Name".into(),
                initial: n.clone(),
                validate: Some(Box::new(validate_remote_name)),
                ..Default::default()
            },
            Field {
                key: "url".into(),
                label: "URL".into(),
                initial: u.clone(),
                validate: Some(Box::new(validate_remote_url)),
                ..Default::default()
            },
        ];
        app.overlay.form(Form {
            title: "Edit remote".into(),
            body: String::new(),
            fields,
            confirm_label: "Save".into(),
            on_confirm: Box::new(move |app, v| {
                let new_url = v.get("url").cloned().unwrap_or_default();
                let new_name = v.get("name").cloned().unwrap_or_default();
                let mut chain = Vec::new();
                if new_url != u {
                    chain.push(OpArgs { r#ref: n.clone(), message: new_url, ..op("setRemoteUrl") });
                }
                if new_name != n {
                    chain.push(OpArgs { r#ref: n, name: new_name, ..op("renameRemote") });
                }
                super::run_chain(app, &i, chain);
            }),
        });
    }));
    let (i, n) = (id.clone(), name.clone());
    items.push(
        MenuItem::new(format!("Remove {name}"), move |app| {
            let body = format!(
                "{n} and its remote-tracking branches will be removed from this repository. Nothing is deleted on the server, and you can add it back."
            );
            confirm_op(app, &i, "Remove remote?", body, "Remove remote", true, OpArgs { r#ref: n, ..op("removeRemote") })
        })
        .danger(),
    );
    if !url.is_empty() {
        items.push(MenuItem::separator());
        items.push(MenuItem::new(format!("Copy link to remote: {name}"), move |app| copy(app, &url, &url)));
    }
    let ctx = app.ctx.clone();
    app.overlay.menu(&ctx, pos, items);
}

pub fn folder_menu(app: &mut App, pos: Pos2, label: &str, refs: Vec<String>) {
    let Some(data) = app.repo().and_then(|r| r.data.as_ref()) else { return };
    let all_hidden = !refs.is_empty() && refs.iter().all(|r| data.hidden.contains(r));
    let count = refs.len();
    let text = if all_hidden { format!("Show {label} in the graph") } else { format!("Hide {label} in the graph") };
    let items = vec![MenuItem::new(text, move |app| set_hidden(app, refs, !all_hidden)).hint(branches(count))];
    let ctx = app.ctx.clone();
    app.overlay.menu(&ctx, pos, items);
}

pub fn stash_menu(app: &mut App, pos: Pos2, selector: &str) {
    let Some(id) = app.active_id() else { return };
    let sel = selector.to_string();
    let mut items = Vec::new();
    let (i, s) = (id.clone(), sel.clone());
    items.push(
        MenuItem::new(format!("Apply {sel}"), move |app| run_on(app, &i, OpArgs { r#ref: s, ..op("stashApply") }))
            .hint("keeps the stash"),
    );
    let (i, s) = (id.clone(), sel.clone());
    items.push(
        MenuItem::new(format!("Pop {sel}"), move |app| run_on(app, &i, OpArgs { r#ref: s, ..op("stashPop") }))
            .hint("applies, then drops it"),
    );
    items.push(MenuItem::separator());
    let s = sel.clone();
    items.push(MenuItem::new(format!("Delete {sel}"), move |app| {
        let body =
            format!("{s} will be dropped. The changes it holds are not on any branch, so this cannot be undone.");
        confirm_op(app, &id, "Delete stash?", body, "Delete", true, OpArgs { r#ref: s, ..op("stashDrop") })
    }));
    let ctx = app.ctx.clone();
    app.overlay.menu(&ctx, pos, items);
}

pub fn submodule_menu(app: &mut App, pos: Pos2, sub: &Submodule) {
    let Some(id) = app.active_id() else { return };
    let path = sub.path.clone();
    let mut items = Vec::new();
    if sub.state == "uninitialized" {
        let (i, p) = (id.clone(), path.clone());
        items.push(
            MenuItem::new(format!("Clone and check out {path}"), move |app| {
                run_on(app, &i, OpArgs { path: p, ..op("submoduleUpdate") })
            })
            .hint("runs submodule update --init"),
        );
    } else {
        let s = sub.clone();
        items.push(MenuItem::new(format!("Open {path}"), move |app| open_submodule(app, &s)));
        items.push(MenuItem::separator());
        let hint = if sub.state == "moved" { "this submodule has moved away from it" } else { "already there" };
        let (i, p) = (id.clone(), path.clone());
        items.push(
            MenuItem::new("Update to the recorded commit", move |app| {
                run_on(app, &i, OpArgs { path: p, ..op("submoduleUpdate") })
            })
            .hint(hint),
        );
        let (i, p) = (id.clone(), path.clone());
        items.push(
            MenuItem::new("Update to the latest remote commit", move |app| {
                run_on(app, &i, OpArgs { path: p, ..op("submoduleUpdateRemote") })
            })
            .hint("leaves a pointer change to commit here"),
        );
    }
    items.push(MenuItem::separator());
    let absolute = sub.absolute.clone();
    items.push(MenuItem::new("Copy path", move |app| copy(app, &absolute, &absolute)));
    if !sub.url.is_empty() {
        let url = sub.url.clone();
        items.push(MenuItem::new("Copy URL", move |app| copy(app, &url, &url)));
    }
    let ctx = app.ctx.clone();
    app.overlay.menu(&ctx, pos, items);
}

pub fn worktree_menu(app: &mut App, pos: Pos2, name: &str) {
    let Some(id) = app.active_id() else { return };
    let Some(w) = app
        .repos
        .get(&id)
        .and_then(|r| r.data.as_ref())
        .and_then(|d| d.worktrees.iter().find(|w| w.name == name))
        .cloned()
    else {
        return;
    };
    let label = worktree_label(&w);
    let mut items = Vec::new();
    if !w.current {
        let look =
            if w.status.is_empty() { format!("Show where {label} is") } else { format!("Look at {label}'s changes") };
        let n = w.name.clone();
        items.push(MenuItem::new(look, move |app| view_worktree(app, &n)).hint("read-only, in this tab"));
        let n = w.name.clone();
        items.push(
            MenuItem::new(format!("Open {label} to edit"), move |app| edit_worktree(app, &n))
                .hint("from this repository's tab"),
        );
        items.push(MenuItem::separator());
    }
    let path = w.path.clone();
    items.push(MenuItem::new("Copy path", move |app| copy(app, &path, &path)));
    if !w.current && !w.main {
        items.push(MenuItem::separator());
        let hint = if w.prunable { "clear git's record" } else { "delete its directory" };
        items.push(
            MenuItem::new(format!("Remove {label}"), move |app| remove_worktree(app, &id, w)).hint(hint).danger(),
        );
    }
    let ctx = app.ctx.clone();
    app.overlay.menu(&ctx, pos, items);
}

pub fn tab_menu(app: &mut App, pos: Pos2, tab_id: &str) {
    let Some(tab) = app.session.tabs.iter().find(|t| t.id == tab_id).cloned() else { return };
    let mut items = vec![MenuItem::note("Show in")];
    for w in &app.session.workspaces {
        let on = tab.workspaces.contains(&w.id);
        let last = on && tab.workspaces.len() == 1;
        let workspaces: Vec<String> = if on {
            tab.workspaces.iter().filter(|x| **x != w.id).cloned().collect()
        } else {
            tab.workspaces.iter().cloned().chain([w.id.clone()]).collect()
        };
        let id = tab.id.clone();
        let item = MenuItem::new(w.name.clone(), move |app| {
            app.jobs.request(Request::TabWorkspaces { id, workspaces }, set_session)
        });
        items.push(item.checked(on).disabled(last));
    }
    items.push(MenuItem::separator());
    let label = if tab.workspaces.len() > 1 { "Close in this workspace" } else { "Close" };
    items.push(MenuItem::new(label, move |app| close_tab(app, &tab.id)));
    let ctx = app.ctx.clone();
    app.overlay.menu(&ctx, pos, items);
}

pub fn workspace_menu(app: &mut App, pos: Pos2) {
    let session = &app.session;
    let mut items: Vec<MenuItem> = session
        .workspaces
        .iter()
        .map(|w| {
            let id = w.id.clone();
            MenuItem::new(w.name.clone(), move |app| app.jobs.request(Request::Workspace { id }, set_session))
                .checked(w.id == session.workspace)
        })
        .collect();
    items.push(MenuItem::separator());
    items.push(MenuItem::new("New workspace...", |app| {
        let prompt = Prompt::new("New workspace", "Create", |app, name| {
            app.jobs.request(Request::AddWorkspace { name }, set_session)
        });
        app.overlay.prompt(Prompt { label: "Name".into(), ..prompt });
    }));
    if let Some(current) = session.workspaces.iter().find(|w| w.id == session.workspace) {
        let (id, name) = (current.id.clone(), current.name.clone());
        items.push(MenuItem::new(format!("Rename {name}..."), move |app| {
            let prompt = Prompt::new("Rename workspace", "Rename", move |app, name| {
                app.jobs.request(Request::RenameWorkspace { id, name }, set_session)
            });
            app.overlay.prompt(Prompt { label: "Name".into(), initial: name, ..prompt });
        }));
        let order: Vec<String> = session.workspaces.iter().map(|w| w.id.clone()).collect();
        let at = order.iter().position(|w| *w == current.id).unwrap_or(0);
        for (label, to) in [("Move up", at.checked_sub(1)), ("Move down", Some(at + 1).filter(|&i| i < order.len()))] {
            let Some(to) = to else { continue };
            let mut order = order.clone();
            order.swap(at, to);
            items.push(MenuItem::new(label, move |app| {
                app.jobs.request(Request::ReorderWorkspaces { order }, set_session)
            }));
        }
        if session.workspaces.len() > 1 {
            let closing = session
                .tabs
                .iter()
                .filter(|t| t.workspaces.len() == 1 && t.workspaces.first() == Some(&current.id))
                .count();
            let id = current.id.clone();
            let mut item = MenuItem::new(format!("Delete {}", current.name), move |app| {
                app.jobs.request(Request::RemoveWorkspace { id }, set_session)
            })
            .danger();
            if closing > 0 {
                let tabs = if closing == 1 { "tab" } else { "tabs" };
                item = item.hint(format!("closes {closing} {tabs} no other workspace has"));
            }
            items.push(item);
        }
    }
    let ctx = app.ctx.clone();
    app.overlay.menu(&ctx, pos, items);
}

pub fn ai_menu(app: &mut App, pos: Pos2) {
    let (Some(config), Some(tab)) = (app.ai.clone(), app.active_tab().cloned()) else { return };
    let host = tab.host.clone().unwrap_or_default();
    let path = tab.path.clone();
    let current = provider_for(&config, &host, &path).map(|(p, pinned)| (p.id.clone(), pinned));
    let mut items: Vec<MenuItem> = config
        .providers
        .iter()
        .map(|p| {
            let hint =
                if current.as_ref().is_some_and(|(id, _)| *id == p.id) { "In use here" } else { kind_label(&p.kind) };
            let (c, h, pa, pid) = (config.clone(), host.clone(), path.clone(), p.id.clone());
            MenuItem::new(p.name.clone(), move |app| pick_provider(app, c, &h, &pa, Some(pid))).hint(hint)
        })
        .collect();
    if current.as_ref().is_some_and(|(_, pinned)| *pinned) {
        let c = config.clone();
        items.push(MenuItem::new("Use the default", move |app| pick_provider(app, c, &host, &path, None)));
    }
    if !items.is_empty() {
        items.push(MenuItem::separator());
    }
    items.push(MenuItem::new("AI settings", |app| {
        app.prefs_section = "ai".into();
        app.prefs_open = true;
    }));
    let ctx = app.ctx.clone();
    app.overlay.menu(&ctx, pos, items);
}

/// Deletes another checkout's directory and git's record of it, after saying what goes with it.
fn remove_worktree(app: &mut App, id: &str, w: crate::engine::types::Worktree) {
    if w.current || w.main {
        return;
    }
    let label = worktree_label(&w);
    let dirty = !w.status.is_empty();
    let mut body = Vec::new();
    if w.prunable {
        body.push("Its directory is already gone; this clears git's record of it.".to_string());
    } else {
        let mut line = format!("Deletes {}, ignored files included.", w.path);
        if let (Some(b), false) = (&w.branch, w.detached) {
            line.push_str(&format!(" The branch {b} stays."));
        }
        body.push(line);
    }
    if dirty {
        let n = w.status.len();
        let files = if n == 1 { "file" } else { "files" };
        body.push(format!("It has {n} uncommitted {files}, which will be lost."));
    }
    if is_active(&w) {
        body.push(format!(
            "Something changed there {} seconds ago. If an agent is working in it, it will lose its checkout.",
            (w.idle_ms + 500) / 1000
        ));
    }
    if w.locked {
        body.push(locked_line(&w));
    }
    let args = OpArgs { name: w.name.clone(), force: dirty || w.locked, ..op("removeWorktree") };
    confirm_op(app, id, format!("Remove worktree {label}?"), body.join("\n\n"), "Remove", true, args);
}

fn pick_provider(app: &mut App, mut config: AiConfig, host: &str, path: &str, provider_id: Option<String>) {
    config.repos.retain(|r| r.host != host || r.path != path);
    if let Some(provider_id) = provider_id {
        config.repos.push(crate::engine::types::AiRepoProvider { host: host.into(), path: path.into(), provider_id });
    }
    save_ai(app, config);
}

/// A prompt for a new ref name, checked the way git would.
fn name_prompt(
    app: &mut App,
    id: &str,
    title: &str,
    label: String,
    placeholder: &str,
    confirm_label: &str,
    make: impl FnOnce(String) -> OpArgs + 'static,
) {
    let prompt = prompt_op(id, title, confirm_label, Box::new(validate_ref_name), move |v| Some(make(v)));
    app.overlay.prompt(Prompt { label, placeholder: placeholder.to_string(), ..prompt });
}

fn copy(app: &mut App, text: &str, shown: &str) {
    app.ctx.copy_text(text.to_string());
    app.toasts.ok(&format!("copied {shown}"));
}

fn branches(count: usize) -> String {
    if count == 1 { "1 branch".into() } else { format!("{count} branches") }
}
