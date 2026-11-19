use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};

use eframe::egui::text::{CCursorRange, LayoutJob, TextWrapping};
use eframe::egui::text_edit::TextEditState;
use eframe::egui::{
    self, Align, Color32, FontId, Frame, Id, Key, Label, Layout, Margin, Modifiers, Rect, Response, RichText,
    ScrollArea, Sense, Stroke, StrokeKind, TextEdit, Ui, UiBuilder, Vec2, pos2, vec2,
};

use super::dialogs::Overlay;
use super::repo::{OpenFile, Repo};
use super::task::{Jobs, Later};
use super::theme::Palette;
use super::{App, actions, avatar, icons};
use crate::engine::api::Request;
use crate::engine::types::{AiConfig, Commit, DiffTarget, FileList, Message, OpArgs, Person, Worktree};
use coauthors::{Contributor, build_message, contributors, format_person, matching, parse_person, split_co_authors};

#[path = "panel_coauthors.rs"]
mod coauthors;
#[path = "panel_staging.rs"]
mod staging;
#[path = "panel_tree.rs"]
mod tree;

pub const OWN_WIP: &str = "WIP";
const SUMMARY_LIMIT: usize = 72;
const ROW_H: f32 = 24.0;

#[derive(Default)]
pub struct State {
    derived: Derived,
    files: Files,
    editing: Option<Editing>,
    edit_for: String,
    edit_error: String,
    picking: bool,
    query: String,
    focus_query: bool,
    offer: Vec<Contributor>,
    offer_key: Option<(u64, String, Vec<Person>)>,
    explained: HashMap<String, String>,
    explaining: String,
    explain_error: (String, String),
    staging: staging::State,
}

#[derive(Default)]
struct Derived {
    key: Option<(u64, Vec<String>)>,
    commit: Option<usize>,
    chosen: Vec<usize>,
    above: Option<usize>,
    explain_key: String,
}

#[derive(Default)]
struct Files {
    target: Option<DiffTarget>,
    list: Option<Result<FileList, String>>,
    tree: bool,
    collapsed: HashSet<String>,
    rows: Vec<tree::Row>,
    dirty: bool,
    counts: [usize; 4],
}

#[derive(Default)]
struct Editing {
    hash: String,
    summary: String,
    description: String,
    co_authors: Vec<Person>,
    loaded: bool,
    focus: Option<bool>,
}

struct Env<'a> {
    id: String,
    jobs: &'a mut Jobs,
    later: &'a mut Later,
    overlay: &'a mut Overlay,
    p: Palette,
    explain_on: bool,
    write_on: bool,
}

struct Btn<'a> {
    label: &'a str,
    size: f32,
    fg: Color32,
    fill: Color32,
    stroke: Color32,
    hover: Color32,
    pad: Vec2,
    width: Option<f32>,
}

#[derive(serde::Deserialize, Default)]
#[serde(default)]
struct Explained {
    text: String,
}

pub fn show(app: &mut App, ui: &mut Ui) {
    let Some(id) = app.active_id() else { return };
    load_ai(app);
    let explain_on = feature(&app.ai, "explainCommit");
    let write_on = feature(&app.ai, "commitMessage");
    let Some(repo) = app.repos.get_mut(&id) else { return };
    let mut st = std::mem::take(&mut repo.panel);
    let mut env = Env {
        id,
        jobs: &mut app.jobs,
        later: &mut app.later,
        overlay: &mut app.overlay,
        p: app.palette,
        explain_on,
        write_on,
    };
    staging::follow(repo, &mut st.staging);
    body(ui, &mut env, repo, &mut st);
    repo.panel = st;
}

/// The WIP row for this tab's own working tree, or `WIP:<name>` for another worktree's.
pub fn is_wip(hash: &str) -> bool {
    hash == OWN_WIP || wip_worktree(hash).is_some()
}

/// Which worktree a WIP row belongs to; None for this tab's own and for commits.
pub fn wip_worktree(hash: &str) -> Option<&str> {
    hash.strip_prefix(OWN_WIP)?.strip_prefix(':')
}

/// What to call a worktree: its directory's name, the same one its tab gets.
pub fn worktree_label(w: &Worktree) -> String {
    let trimmed = w.path.trim_end_matches(['/', '\\']);
    let leaf = trimmed.rsplit(['/', '\\']).next().unwrap_or("");
    if leaf.is_empty() { w.name.clone() } else { leaf.to_string() }
}

pub fn find_worktree<'a>(worktrees: &'a [Worktree], name: &str) -> Option<&'a Worktree> {
    worktrees.iter().find(|w| w.name == name)
}

fn body(ui: &mut Ui, env: &mut Env, repo: &mut Repo, st: &mut State) {
    let single = if repo.selected.len() == 1 { repo.selected.first().cloned() } else { None };
    let other = single
        .as_deref()
        .and_then(wip_worktree)
        .filter(|name| repo.data.as_ref().is_some_and(|d| find_worktree(&d.worktrees, name).is_some()));
    if let Some(name) = other {
        let name = name.to_string();
        staging::show(ui, env, repo, &mut st.staging, Some(&name));
        return;
    }
    if single.as_deref() == Some(OWN_WIP) {
        staging::show(ui, env, repo, &mut st.staging, None);
        return;
    }
    derive(st, repo);
    if repo.selected.len() > 1 {
        range_view(ui, env, repo, st);
        return;
    }
    let Some(at) = st.derived.commit else {
        empty(ui, env.p, "Select a commit");
        return;
    };
    commit_view(ui, env, repo, st, at);
}

fn derive(st: &mut State, repo: &Repo) {
    let Some(data) = repo.data.as_ref() else { return };
    let fresh = st.derived.key.as_ref().is_some_and(|(v, s)| *v == repo.version && *s == repo.selected);
    if fresh {
        return;
    }
    let single = if repo.selected.len() == 1 { repo.selected.first().filter(|h| !is_wip(h)) } else { None };
    let commit = single.and_then(|h| data.commits.iter().position(|c| &c.hash == h));
    let chosen: Vec<usize> = if repo.selected.len() > 1 {
        let wanted: HashSet<&str> = repo.selected.iter().map(String::as_str).collect();
        data.commits.iter().enumerate().filter(|(_, c)| wanted.contains(c.hash.as_str())).map(|(i, _)| i).collect()
    } else {
        Vec::new()
    };
    let hashes: Vec<&str> = match commit {
        Some(i) => data.commits.get(i).map(|c| c.hash.as_str()).into_iter().collect(),
        None => chosen.iter().filter_map(|&i| data.commits.get(i)).map(|c| c.hash.as_str()).collect(),
    };
    let above = commit
        .and_then(|i| data.commits.get(i))
        .and_then(|c| rewrite_depth(&data.commits, data.head.hash.as_deref(), &c.hash));
    st.derived = Derived {
        key: Some((repo.version, repo.selected.clone())),
        commit,
        chosen,
        above,
        explain_key: hashes.join(","),
    };
}

fn commit_view(ui: &mut Ui, env: &mut Env, repo: &mut Repo, st: &mut State, at: usize) {
    let p = env.p;
    let Some(data) = repo.data.as_ref() else { return };
    let Some(commit) = data.commits.get(at) else { return };
    if st.edit_for != commit.hash {
        st.edit_for = commit.hash.clone();
        st.editing = None;
        st.edit_error.clear();
        st.picking = false;
    }
    ensure_files(env, &mut st.files, DiffTarget::Commit { sha: commit.hash.clone() });
    let open_path = repo.open_file.as_ref().map(|f| f.path.clone());
    let mut open: Option<String> = None;
    let mut reveal: Option<String> = None;
    ScrollArea::vertical().id_salt("panel_commit").auto_shrink([false, false]).show(ui, |ui| {
        ui.spacing_mut().item_spacing.y = 0.0;
        head(ui, p, |ui| {
            text(ui, "commit:", 12.0, p.fg_dim);
            ui.label(RichText::new(short(&commit.hash, 6)).monospace().size(12.0).color(p.fg));
        });
        if st.editing.is_some() {
            editor(ui, env, st, commit, &data.commits, repo.version);
        } else {
            message(ui, env, st, commit);
        }
        if env.explain_on {
            explain(ui, env, st);
        }
        person_row(ui, p, commit, &mut reveal);
        if st.editing.is_none() && !commit.co_authors.is_empty() {
            co_authors(ui, p, &commit.co_authors);
        }
        let label = format!("commit {}", short(&commit.hash, 7));
        files_section(ui, env, &mut st.files, open_path.as_deref(), &mut open, "changes");
        if let Some(path) = open.take() {
            let target = DiffTarget::Commit { sha: commit.hash.clone() };
            repo.open_file = Some(OpenFile { path, target, label });
        }
    });
    if let Some(hash) = reveal {
        repo.reveal_commit(&hash);
    }
}

fn range_view(ui: &mut Ui, env: &mut Env, repo: &mut Repo, st: &mut State) {
    let p = env.p;
    let Some(data) = repo.data.as_ref() else { return };
    let chosen: Vec<&Commit> = st.derived.chosen.iter().filter_map(|&i| data.commits.get(i)).collect();
    let ends = chosen.first().zip(chosen.last()).map(|(newest, oldest)| (newest.hash.clone(), oldest.hash.clone()));
    if let Some((newest, oldest)) = &ends {
        ensure_files(env, &mut st.files, DiffTarget::Range { from: oldest.clone(), to: newest.clone() });
    }
    let open_path = repo.open_file.as_ref().map(|f| f.path.clone());
    let mut open: Option<String> = None;
    let count = repo.selected.len();
    ScrollArea::vertical().id_salt("panel_range").auto_shrink([false, false]).show(ui, |ui| {
        ui.spacing_mut().item_spacing.y = 0.0;
        head(ui, p, |ui| {
            text(ui, format!("{count} commits selected"), 12.0, p.fg_dim);
        });
        if ends.is_none() {
            return;
        }
        if env.explain_on {
            explain(ui, env, st);
        }
        Frame::new().inner_margin(Margin::symmetric(12, 10)).show(ui, |ui| {
            text(ui, format!("Viewing merged diff of {count} commits"), 12.0, p.fg_dim);
        });
        let list_h = (chosen.len() as f32 * 46.0).min(220.0);
        ScrollArea::vertical().id_salt("panel_range_list").max_height(list_h).auto_shrink([false, true]).show(
            ui,
            |ui| {
                rows(ui, chosen.len(), 46.0, |ui, rect, i| {
                    let Some(c) = chosen.get(i) else { return };
                    range_row(ui, rect.shrink2(vec2(12.0, 3.0)), p, c);
                });
            },
        );
        files_section(ui, env, &mut st.files, open_path.as_deref(), &mut open, "the combined diff");
    });
    let (Some(path), Some((newest, oldest))) = (open, ends) else { return };
    let label = format!("{} commits", chosen.len());
    repo.open_file = Some(OpenFile { path, target: DiffTarget::Range { from: oldest, to: newest }, label });
}

fn message(ui: &mut Ui, env: &mut Env, st: &mut State, commit: &Commit) {
    let p = env.p;
    let editable = st.derived.above.is_some();
    let tip = if editable {
        "Double-click to edit this commit's message"
    } else {
        "Only commits on the checked-out branch can be edited from here"
    };
    let mut start: Option<bool> = None;
    let shown = message_frame(p, p.bg_2).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.set_min_height(72.0);
        let subject =
            Label::new(RichText::new(&commit.subject).size(15.0).color(p.fg_bright)).wrap().sense(Sense::click());
        if ui.add(subject).on_hover_text(tip).double_clicked() {
            start = Some(true);
        }
        ui.add_space(8.0);
        let body = if !commit.body.is_empty() {
            Some(RichText::new(&commit.body).size(12.0).color(p.fg_dim))
        } else if editable {
            Some(RichText::new("no description").size(12.0).color(p.fg_faint).italics())
        } else {
            None
        };
        if let Some(body) = body {
            if ui.add(Label::new(body).wrap().sense(Sense::click())).on_hover_text(tip).double_clicked() {
                start = Some(false);
            }
        }
        if !st.edit_error.is_empty() {
            ui.add_space(8.0);
            ui.add(Label::new(RichText::new(&st.edit_error).size(11.0).color(p.red)).wrap());
        }
    });
    let rect = shown.response.rect.shrink(12.0);
    if editable && ui.rect_contains_pointer(rect) {
        ui.painter().rect_stroke(rect, 3.0, Stroke::new(1.0, p.line_hard), StrokeKind::Inside);
    }
    if let (Some(summary), true) = (start, editable) {
        start_edit(env, st, &commit.hash, summary);
    }
}

fn editor(ui: &mut Ui, env: &mut Env, st: &mut State, commit: &Commit, commits: &[Commit], version: u64) {
    let p = env.p;
    let base = ui.scope_id().with("reword");
    let summary_id = base.with("summary");
    let body_id = base.with("body");
    let query_id = base.with("query");
    let co_count = st.editing.as_ref().map_or(0, |e| e.co_authors.len());
    let focused = ui.memory(|m| m.focused());
    let inside = focused.is_some_and(|f| {
        f == summary_id
            || f == body_id
            || f == query_id
            || (0..co_count).any(|i| f == base.with((i, 0)) || f == base.with((i, 1)))
    });
    if inside && ui.input_mut(|i| i.consume_key(Modifiers::NONE, Key::Escape)) {
        if st.picking {
            st.picking = false;
        } else {
            st.editing = None;
            return;
        }
    }
    let submit_body =
        ui.memory(|m| m.has_focus(body_id)) && ui.input_mut(|i| i.consume_key(Modifiers::COMMAND, Key::Enter));
    if st.picking {
        refresh_offer(st, commits, commit, version);
    }
    let State { editing, picking, query, focus_query, offer, derived, .. } = st;
    let Some(e) = editing.as_mut() else { return };
    let mut save = submit_body;
    let mut cancel = false;
    let mut picked: Option<Person> = None;
    message_frame(p, p.accent).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.spacing_mut().item_spacing.y = 8.0;
        let left = SUMMARY_LIMIT as i64 - e.summary.chars().count() as i64;
        let counter = RichText::new(left.to_string()).size(11.0).color(if left < 0 { p.amber } else { p.fg_faint });
        let edit = TextEdit::singleline(&mut e.summary)
            .char_limit(200)
            .interactive(e.loaded)
            .text_color(p.fg_bright)
            .suffix(counter);
        let width = ui.available_width();
        let summary = field(ui, edit, summary_id, "Commit summary", p.bg_0, p, width, 13.0);
        if summary.lost_focus() && ui.input(|i| i.key_pressed(Key::Enter)) {
            save = true;
        }
        let edit = TextEdit::multiline(&mut e.description).desired_rows(4).interactive(e.loaded);
        let body = field(ui, edit, body_id, "Description", p.bg_0, p, width, 12.0);
        if let (Some(on_summary), true) = (e.focus, e.loaded) {
            e.focus = None;
            if on_summary {
                summary.request_focus();
                let mut state = TextEdit::load_state(ui.ctx(), summary_id).unwrap_or_default();
                state.cursor.set_char_range(Some(CCursorRange::select_all_str(&e.summary)));
                TextEditState::store(state, ui.ctx(), summary_id);
            } else {
                body.request_focus();
            }
        }

        let (rect, _) = ui.allocate_exact_size(vec2(ui.available_width(), 1.0), Sense::hover());
        ui.painter().hline(rect.x_range(), rect.center().y, Stroke::new(1.0, p.bg_2));
        ui.horizontal(|ui| {
            text(ui, "CO-AUTHORS", 11.0, p.fg_faint);
            let n = e.co_authors.len();
            text(ui, if n == 0 { "none".to_string() } else { n.to_string() }, 11.0, p.fg_muted);
        });
        let mut drop: Option<usize> = None;
        let width = ui.available_width();
        for (i, person) in e.co_authors.iter_mut().enumerate() {
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 6.0;
                let (r, _) = ui.allocate_exact_size(vec2(22.0, 22.0), Sense::hover());
                avatar::paint(ui, r, &person.name, &person.email);
                let fields = width - 22.0 - 18.0 - 18.0;
                let edit = TextEdit::singleline(&mut person.name).interactive(e.loaded);
                field(ui, edit, base.with((i, 0)), "Name", p.bg_0, p, fields * 0.4, 11.0);
                let edit = TextEdit::singleline(&mut person.email).interactive(e.loaded).text_color(p.fg_dim);
                field(ui, edit, base.with((i, 1)), "email", p.bg_0, p, fields * 0.6, 11.0);
                let who = if person.name.is_empty() { &person.email } else { &person.name };
                let (r, _) = ui.allocate_exact_size(vec2(18.0, 18.0), Sense::hover());
                if icon_button(ui, r, base.with((i, 2)), "close", &format!("Stop crediting {who}"), p, true) {
                    drop = Some(i);
                }
            });
        }
        if let Some(i) = drop.filter(|&i| i < e.co_authors.len()) {
            e.co_authors.remove(i);
        }

        let area = ui.scope(|ui| {
            let label = if *picking { "Cancel" } else { "+ Add co-author" };
            let btn = Btn {
                label,
                size: 11.0,
                fg: p.fg_muted,
                fill: Color32::TRANSPARENT,
                stroke: p.bg_2,
                hover: p.bg_3,
                pad: vec2(8.0, 3.0),
                width: None,
            };
            if btn.show(ui, e.loaded).clicked() {
                *picking = !*picking;
                *focus_query = *picking;
                query.clear();
            }
            if *picking {
                picked = picker(ui, p, offer, query, query_id, focus_query);
            }
        });
        let pressed = ui.input(|i| if i.pointer.any_pressed() { i.pointer.press_origin() } else { None });
        if pressed.is_some_and(|pos| !area.response.rect.contains(pos)) {
            *picking = false;
        }

        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 8.0;
            let enabled = e.loaded && !e.summary.trim().is_empty();
            let save_btn = Btn {
                label: "Save",
                size: 12.0,
                fg: p.accent_fg,
                fill: p.accent,
                stroke: p.accent,
                hover: p.accent_hover,
                pad: vec2(12.0, 4.0),
                width: None,
            };
            let cancel_btn = Btn {
                label: "Cancel",
                size: 12.0,
                fg: p.fg,
                fill: p.bg_2,
                stroke: p.bg_2,
                hover: p.bg_3,
                pad: vec2(12.0, 4.0),
                width: None,
            };
            let note = match derived.above {
                Some(0) => "Amends this commit. Its hash changes, so push again if it was pushed.".to_string(),
                Some(1) => "Rewrites this commit and the 1 above it.".to_string(),
                n => format!("Rewrites this commit and the {} above it.", n.unwrap_or(0)),
            };
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                if save_btn.show(ui, enabled).clicked() {
                    save = true;
                }
                if cancel_btn.show(ui, true).clicked() {
                    cancel = true;
                }
                ui.add(Label::new(RichText::new(note).size(11.0).color(p.fg_faint)).wrap());
            });
        });
    });
    if let Some(person) = picked {
        e.co_authors.push(person);
        *picking = false;
    }
    if cancel {
        *editing = None;
        return;
    }
    if !save || !e.loaded || e.summary.trim().is_empty() {
        return;
    }
    let message = build_message(&e.summary, &e.description, &e.co_authors);
    let hash = e.hash.clone();
    *editing = None;
    *picking = false;
    env.later.add(move |app| {
        actions::run_op(app, OpArgs { op: "reword".into(), shas: vec![hash], message, ..Default::default() })
    });
}

fn picker(
    ui: &mut Ui,
    p: Palette,
    offer: &[Contributor],
    query: &mut String,
    id: Id,
    focus: &mut bool,
) -> Option<Person> {
    let mut picked = None;
    Frame::new()
        .fill(p.bg_2)
        .stroke(Stroke::new(1.0, p.line_strong))
        .corner_radius(3)
        .inner_margin(Margin::same(6))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.spacing_mut().item_spacing.y = 5.0;
            let shown: Vec<&Contributor> = matching(offer, query).into_iter().take(40).collect();
            let typed = parse_person(query);
            let width = ui.available_width();
            let filter = field(ui, TextEdit::singleline(query), id, "Name <email>, or search", p.bg_0, p, width, 11.0);
            if std::mem::take(focus) {
                filter.request_focus();
            }
            if filter.lost_focus() && ui.input(|i| i.key_pressed(Key::Enter)) {
                picked = shown.first().map(|c| c.person.clone()).or_else(|| typed.clone());
            }
            ScrollArea::vertical().id_salt("coauthor_picker").max_height(200.0).auto_shrink([false, true]).show(
                ui,
                |ui| {
                    ui.spacing_mut().item_spacing.y = 0.0;
                    rows(ui, shown.len(), 28.0, |ui, rect, i| {
                        let Some(c) = shown.get(i) else { return };
                        let response = ui.interact(rect, id.with(("pick", i)), Sense::click());
                        if response.hovered() {
                            ui.painter().rect_filled(rect, 3.0, p.bg_4);
                        }
                        let mid = rect.center().y;
                        let a = Rect::from_center_size(pos2(rect.left() + 16.0, mid), vec2(20.0, 20.0));
                        avatar::paint(ui, a, &c.person.name, &c.person.email);
                        let count = c.count.to_string();
                        let cw = paint_text(ui, pos2(rect.right() - 6.0, mid), &count, 11.0, p.fg_faint, 60.0, true);
                        let x = rect.left() + 33.0;
                        let nw =
                            paint_text(ui, pos2(x, mid), &c.person.name, 12.0, p.fg, (rect.right() - x) * 0.6, false);
                        let ex = x + nw + 7.0;
                        paint_text(
                            ui,
                            pos2(ex, mid),
                            &c.person.email,
                            11.0,
                            p.fg_muted,
                            rect.right() - 6.0 - cw - 7.0 - ex,
                            false,
                        );
                        if response.clicked() {
                            picked = Some(c.person.clone());
                        }
                    });
                },
            );
            if !shown.is_empty() {
                return;
            }
            match &typed {
                Some(person) => {
                    let label = format!("Credit {}", format_person(person));
                    let btn = Btn {
                        label: &label,
                        size: 12.0,
                        fg: p.fg,
                        fill: Color32::TRANSPARENT,
                        stroke: Color32::TRANSPARENT,
                        hover: p.bg_4,
                        pad: vec2(6.0, 4.0),
                        width: Some(ui.available_width()),
                    };
                    if btn.show(ui, true).clicked() {
                        picked = Some(person.clone());
                    }
                }
                None => {
                    text(ui, "Nobody else has committed here yet - type a name.", 11.0, p.fg_faint);
                }
            }
        });
    picked
}

fn refresh_offer(st: &mut State, commits: &[Commit], commit: &Commit, version: u64) {
    let Some(e) = st.editing.as_ref() else { return };
    let fresh = st
        .offer_key
        .as_ref()
        .is_some_and(|(v, h, people)| *v == version && *h == commit.hash && *people == e.co_authors);
    if fresh {
        return;
    }
    let mut exclude = vec![Person { name: commit.author.clone(), email: commit.email.clone() }];
    exclude.extend(e.co_authors.iter().cloned());
    st.offer = contributors(commits, &exclude);
    st.offer_key = Some((version, commit.hash.clone(), e.co_authors.clone()));
}

fn start_edit(env: &mut Env, st: &mut State, hash: &str, summary: bool) {
    st.edit_error.clear();
    st.picking = false;
    st.editing = Some(Editing { hash: hash.to_string(), ..Default::default() });
    let tab = env.id.clone();
    let want = hash.to_string();
    let req = Request::CommitMessage { id: env.id.clone(), sha: hash.to_string() };
    env.jobs.request(req, move |app, result: Result<Message, String>| {
        let Some(repo) = app.repos.get_mut(&tab) else { return };
        let st = &mut repo.panel;
        let Some(e) = st.editing.as_mut().filter(|e| e.hash == want) else { return };
        match result {
            Ok(m) => {
                let (body, people) = split_co_authors(&m.description);
                e.summary = m.summary;
                e.description = body;
                e.co_authors = people;
                e.loaded = true;
                e.focus = Some(summary);
            }
            Err(err) => {
                st.editing = None;
                st.edit_error = err;
            }
        }
    });
}

fn explain(ui: &mut Ui, env: &mut Env, st: &mut State) {
    let p = env.p;
    let key = &st.derived.explain_key;
    if key.is_empty() {
        return;
    }
    if let Some(explanation) = st.explained.get(key) {
        let shown = Frame::new()
            .fill(p.bg_inset)
            .inner_margin(Margin { left: 12, right: 12, top: 8, bottom: 10 })
            .show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = 6.0;
                    icons::show(ui, "sparkle", 12.0, p.accent_fg);
                    text(ui, "Explanation", 11.0, p.accent_fg);
                });
                ui.add_space(6.0);
                ScrollArea::vertical().id_salt("explanation").max_height(260.0).show(ui, |ui| {
                    ui.add(Label::new(RichText::new(explanation).size(12.0).color(p.fg)).wrap());
                });
            });
        let r = shown.response.rect;
        ui.painter().hline(r.x_range(), r.bottom() - 0.5, Stroke::new(1.0, p.line));
        return;
    }
    let busy = st.explaining == *key;
    let count = st.derived.chosen.len();
    let label = if busy {
        "Explaining...".to_string()
    } else if count > 1 {
        format!("Explain these {count} commits")
    } else {
        "Explain this commit".to_string()
    };
    let mut clicked = false;
    let shown = Frame::new().inner_margin(Margin::symmetric(12, 6)).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.horizontal(|ui| {
            let btn = Btn {
                label: &label,
                size: 11.0,
                fg: p.fg_dim,
                fill: p.bg_2,
                stroke: p.line_strong,
                hover: p.bg_3,
                pad: vec2(8.0, 3.0),
                width: None,
            };
            clicked = btn.show(ui, !busy).clicked();
            if st.explain_error.0 == *key && !st.explain_error.1.is_empty() {
                ui.add(Label::new(RichText::new(&st.explain_error.1).size(11.0).color(p.red_fg)).truncate());
            }
        });
    });
    let r = shown.response.rect;
    ui.painter().hline(r.x_range(), r.bottom() - 0.5, Stroke::new(1.0, p.line));
    if !clicked {
        return;
    }
    let key = key.clone();
    st.explaining = key.clone();
    st.explain_error = (String::new(), String::new());
    let shas: Vec<String> = key.split(',').map(String::from).collect();
    let tab = env.id.clone();
    env.jobs.request(
        Request::ExplainCommits { id: env.id.clone(), shas },
        move |app, result: Result<Explained, String>| {
            let Some(repo) = app.repos.get_mut(&tab) else { return };
            let st = &mut repo.panel;
            if st.explaining == key {
                st.explaining.clear();
            }
            match result {
                Ok(answer) => {
                    st.explained.insert(key, answer.text);
                }
                Err(e) => st.explain_error = (key, e),
            }
        },
    );
}

fn person_row(ui: &mut Ui, p: Palette, commit: &Commit, reveal: &mut Option<String>) {
    Frame::new().inner_margin(Margin::symmetric(12, 8)).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 10.0;
            let (r, _) = ui.allocate_exact_size(vec2(34.0, 34.0), Sense::hover());
            avatar::paint(ui, r, &commit.author, &commit.email);
            ui.vertical(|ui| {
                ui.spacing_mut().item_spacing.y = 2.0;
                text(ui, &commit.author, 13.0, p.fg);
                text(ui, format!("authored {}", when(commit.date)), 11.0, p.fg_muted);
            });
            if commit.parents.is_empty() {
                return;
            }
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                ui.spacing_mut().item_spacing.x = 4.0;
                for (i, parent) in commit.parents.iter().enumerate().rev() {
                    let sep = if i + 1 < commit.parents.len() { "," } else { "" };
                    if !sep.is_empty() {
                        text(ui, sep, 11.0, p.fg_muted);
                    }
                    let link = Label::new(RichText::new(short(parent, 6)).size(11.0).monospace().color(p.accent))
                        .sense(Sense::click());
                    if ui.add(link).on_hover_text("Show this commit").clicked() {
                        *reveal = Some(parent.clone());
                    }
                }
                text(ui, "parent:", 11.0, p.fg_muted);
            });
        });
    });
}

fn co_authors(ui: &mut Ui, p: Palette, people: &[Person]) {
    Frame::new().inner_margin(Margin { left: 12, right: 12, top: 2, bottom: 8 }).show(ui, |ui| {
        ui.set_width(ui.available_width());
        let n = people.len();
        text(ui, format!("co-authored with {n} {}", if n == 1 { "other" } else { "others" }), 11.0, p.fg_muted);
        ui.add_space(6.0);
        for person in people {
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 8.0;
                let (r, _) = ui.allocate_exact_size(vec2(22.0, 22.0), Sense::hover());
                avatar::paint(ui, r, &person.name, &person.email);
                text(ui, &person.name, 12.0, p.fg);
                if !person.email.is_empty() {
                    ui.add(Label::new(RichText::new(&person.email).size(11.0).color(p.fg_muted)).truncate());
                }
            });
            ui.add_space(6.0);
        }
    });
}

fn range_row(ui: &mut Ui, rect: Rect, p: Palette, c: &Commit) {
    ui.painter().rect_filled(rect, 3.0, p.bg_inset);
    ui.painter().rect_stroke(rect, 3.0, Stroke::new(1.0, p.bg_2), StrokeKind::Inside);
    let mid = rect.center().y;
    let a = Rect::from_center_size(pos2(rect.left() + 10.0 + 13.0, mid), vec2(26.0, 26.0));
    avatar::paint(ui, a, &c.author, &c.email);
    let hash_w = paint_text(ui, pos2(rect.right() - 10.0, mid), short(&c.hash, 6), 11.0, p.fg_dim, 80.0, true);
    let x = a.right() + 9.0;
    let w = rect.right() - 10.0 - hash_w - 9.0 - x;
    paint_text(ui, pos2(x, mid - 7.0), &c.subject, 12.0, p.fg, w, false);
    paint_text(ui, pos2(x, mid + 8.0), &format!("{} by {}", when(c.date), c.author), 11.0, p.fg_muted, w, false);
}

fn ensure_files(env: &mut Env, files: &mut Files, target: DiffTarget) {
    if files.target.as_ref() == Some(&target) {
        return;
    }
    files.target = Some(target.clone());
    files.list = None;
    files.dirty = true;
    let req = match &target {
        DiffTarget::Commit { sha } => Request::CommitFiles { id: env.id.clone(), sha: sha.clone() },
        DiffTarget::Range { from, to } => {
            Request::RangeFiles { id: env.id.clone(), from: from.clone(), to: to.clone() }
        }
        DiffTarget::Wip { .. } => return,
    };
    let tab = env.id.clone();
    env.jobs.request(req, move |app, result: Result<FileList, String>| {
        let Some(repo) = app.repos.get_mut(&tab) else { return };
        let files = &mut repo.panel.files;
        if files.target.as_ref() != Some(&target) {
            return;
        }
        files.list = Some(result);
        files.dirty = true;
    });
}

fn files_section(
    ui: &mut Ui,
    env: &Env,
    files: &mut Files,
    active: Option<&str>,
    open: &mut Option<String>,
    what: &str,
) {
    let p = env.p;
    let list = match &files.list {
        None => return,
        Some(Err(e)) => {
            empty(ui, p, &format!("Could not read {what}: {e}"));
            return;
        }
        Some(Ok(list)) => list,
    };
    if files.dirty {
        files.dirty = false;
        let mut counts = [0; 4];
        for f in &list.files {
            let slot = match f.status.as_str() {
                "A" => 1,
                "D" => 2,
                "R" => 3,
                "M" => 0,
                _ => continue,
            };
            if let Some(n) = counts.get_mut(slot) {
                *n += 1;
            }
        }
        files.counts = counts;
        files.rows.clear();
        if files.tree {
            let nodes = tree::build_tree(list.files.iter().map(|f| f.path.as_str()));
            tree::flatten(&nodes, &files.collapsed, 0, &mut files.rows);
        }
    }
    let mut toggle: Option<bool> = None;
    Frame::new().inner_margin(Margin { left: 12, right: 12, top: 12, bottom: 6 }).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing.x = 4.0;
            let [modified, added, deleted, renamed] = files.counts;
            count_chip(ui, "edit", p.amber, &format!("{modified} modified"));
            if added > 0 {
                count_chip(ui, "added", p.green, &format!("{added} added"));
            }
            if deleted > 0 {
                count_chip(ui, "removed", p.red, &format!("{deleted} deleted"));
            }
            if renamed > 0 {
                count_chip(ui, "chevronRight", p.accent, &format!("{renamed} renamed"));
            }
            if list.added > 0 {
                text(ui, format!("+{}", list.added), 12.0, p.green).on_hover_text("Lines added and removed");
            }
            if list.removed > 0 {
                text(ui, format!("-{}", list.removed), 12.0, p.red).on_hover_text("Lines added and removed");
            }
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                ui.spacing_mut().item_spacing.x = 0.0;
                for (label, tree) in [("Tree", true), ("Path", false)] {
                    let on = files.tree == tree;
                    let fill = if on { p.bg_4 } else { p.bg_3 };
                    let fg = if on { p.fg } else { p.fg_dim };
                    let btn = Btn {
                        label,
                        size: 11.0,
                        fg,
                        fill,
                        stroke: p.line,
                        hover: p.bg_4,
                        pad: vec2(10.0, 3.0),
                        width: None,
                    };
                    if btn.show(ui, true).clicked() {
                        toggle = Some(tree);
                    }
                }
            });
        });
    });
    let mut fold: Option<String> = None;
    let id = ui.scope_id().with("files");
    if files.tree {
        rows(ui, files.rows.len(), ROW_H, |ui, rect, i| match files.rows.get(i) {
            Some(tree::Row::File { item, depth }) => {
                let Some(f) = list.files.get(*item) else { return };
                if file_row(ui, rect, id.with(i), p, &f.status, &f.path, active == Some(f.path.as_str()), Some(*depth))
                {
                    *open = Some(f.path.clone());
                }
            }
            Some(tree::Row::Folder { label, path, count, depth, open: expanded }) => {
                if folder_row(ui, rect, id.with(i), p, label, path, *count, *depth, *expanded) {
                    fold = Some(path.clone());
                }
            }
            None => {}
        });
    } else {
        rows(ui, list.files.len(), ROW_H, |ui, rect, i| {
            let Some(f) = list.files.get(i) else { return };
            if file_row(ui, rect, id.with(i), p, &f.status, &f.path, active == Some(f.path.as_str()), None) {
                *open = Some(f.path.clone());
            }
        });
    }
    ui.add_space(8.0);
    if let Some(path) = fold {
        if !files.collapsed.remove(&path) {
            files.collapsed.insert(path);
        }
        files.dirty = true;
    }
    if let Some(tree) = toggle.filter(|&t| t != files.tree) {
        files.tree = tree;
        files.dirty = true;
    }
}

fn count_chip(ui: &mut Ui, icon: &str, color: Color32, label: &str) {
    icons::show(ui, icon, 12.0, color);
    text(ui, label, 12.0, color);
    ui.add_space(8.0);
}

#[allow(clippy::too_many_arguments)]
fn file_row(
    ui: &mut Ui,
    rect: Rect,
    id: Id,
    p: Palette,
    status: &str,
    path: &str,
    active: bool,
    depth: Option<usize>,
) -> bool {
    let response = ui.interact(rect, id, Sense::click());
    if active {
        ui.painter().rect_filled(rect, 0.0, p.accent_bg);
    } else if response.hovered() {
        ui.painter().rect_filled(rect, 0.0, p.bg_3);
    }
    let (icon, color) = match status {
        "A" => ("added", p.green),
        "D" => ("removed", p.red),
        "R" => ("chevronRight", p.accent),
        _ => ("edit", p.amber),
    };
    let left = rect.left() + depth.map_or(12.0, |d| 10.0 + d as f32 * 12.0);
    let mid = rect.center().y;
    icons::paint(ui, Rect::from_center_size(pos2(left + 6.0, mid), vec2(11.0, 11.0)), icon, color);
    let x = left + 19.0;
    paint_path(ui, x, mid, rect.right() - 12.0 - x, path, depth.is_some(), p);
    response.on_hover_text(path).clicked()
}

#[allow(clippy::too_many_arguments)]
fn folder_row(
    ui: &mut Ui,
    rect: Rect,
    id: Id,
    p: Palette,
    label: &str,
    path: &str,
    count: usize,
    depth: usize,
    open: bool,
) -> bool {
    let response = ui.interact(rect, id, Sense::click());
    if response.hovered() {
        ui.painter().rect_filled(rect, 0.0, p.bg_3);
    }
    let left = rect.left() + 10.0 + depth as f32 * 12.0;
    let mid = rect.center().y;
    let chevron = if open { "chevronDown" } else { "chevronRight" };
    icons::paint(ui, Rect::from_center_size(pos2(left + 5.5, mid), vec2(11.0, 11.0)), chevron, p.fg_faint);
    let cw = paint_text(ui, pos2(rect.right() - 12.0, mid), &count.to_string(), 10.0, p.fg_faint, 60.0, true);
    let x = left + 17.0;
    let color = if response.hovered() { p.fg_dim } else { p.fg_muted };
    paint_text(ui, pos2(x, mid), label, 12.0, color, rect.right() - 12.0 - cw - 8.0 - x, false);
    response.on_hover_text(path).clicked()
}

/// `dir/` muted and truncated, then the file name; only the name when `base_only`.
fn paint_path(ui: &Ui, x: f32, mid: f32, width: f32, path: &str, base_only: bool, p: Palette) {
    let (dir, base) = match path.rfind('/') {
        Some(cut) => (path.get(..cut + 1).unwrap_or(""), path.get(cut + 1..).unwrap_or(path)),
        None => ("", path),
    };
    if base_only || dir.is_empty() {
        paint_text(ui, pos2(x, mid), base, 12.0, p.fg, width, false);
        return;
    }
    let base_galley = galley(ui, base, 12.0, p.fg, width);
    let base_w = base_galley.size().x;
    let dir_w = paint_text(ui, pos2(x, mid), dir, 12.0, p.fg_muted, width - base_w, false);
    ui.painter().galley(pos2(x + dir_w, mid - base_galley.size().y / 2.0), base_galley, p.fg);
}

/// Paints one line of text vertically centred on `pos.y`, from `pos.x` or ending there when `right`.
fn paint_text(ui: &Ui, pos: egui::Pos2, s: &str, size: f32, color: Color32, max_width: f32, right: bool) -> f32 {
    if max_width <= 0.0 {
        return 0.0;
    }
    let g = galley(ui, s, size, color, max_width);
    let size = g.size();
    let x = if right { pos.x - size.x } else { pos.x };
    ui.painter().galley(pos2(x, pos.y - size.y / 2.0), g, color);
    size.x
}

fn galley(ui: &Ui, s: &str, size: f32, color: Color32, max_width: f32) -> std::sync::Arc<egui::Galley> {
    let mut job = LayoutJob::simple_singleline(s.to_string(), FontId::proportional(size), color);
    job.wrap = TextWrapping::truncate_at_width(max_width.max(1.0));
    ui.painter().layout_job(job)
}

/// Draws only the rows of a long list that are inside the clip rect.
fn rows(ui: &mut Ui, count: usize, height: f32, mut draw: impl FnMut(&mut Ui, Rect, usize)) {
    if count == 0 {
        return;
    }
    let width = ui.available_width();
    let (rect, _) = ui.allocate_exact_size(vec2(width, height * count as f32), Sense::hover());
    let clip = ui.clip_rect();
    let first = ((clip.top() - rect.top()) / height).floor().max(0.0) as usize;
    let last = (((clip.bottom() - rect.top()) / height).ceil().max(0.0) as usize).min(count);
    for i in first..last {
        let top = rect.top() + i as f32 * height;
        draw(ui, Rect::from_min_size(pos2(rect.left(), top), vec2(width, height)), i);
    }
}

fn head(ui: &mut Ui, p: Palette, add: impl FnOnce(&mut Ui)) {
    let (rect, _) = ui.allocate_exact_size(vec2(ui.available_width(), 34.0), Sense::hover());
    ui.painter().hline(rect.x_range(), rect.bottom() - 0.5, Stroke::new(1.0, p.line));
    let inner = rect.shrink2(vec2(12.0, 0.0));
    let mut child = ui.new_child(UiBuilder::new().max_rect(inner).layout(Layout::left_to_right(Align::Center)));
    child.spacing_mut().item_spacing.x = 8.0;
    add(&mut child);
}

fn message_frame(p: Palette, stroke: Color32) -> Frame {
    Frame::new()
        .fill(p.bg_inset)
        .stroke(Stroke::new(1.0, stroke))
        .corner_radius(3)
        .inner_margin(Margin::symmetric(12, 10))
        .outer_margin(Margin::same(12))
}

#[allow(clippy::too_many_arguments)]
fn field(
    ui: &mut Ui,
    edit: TextEdit,
    id: Id,
    hint: &str,
    fill: Color32,
    p: Palette,
    width: f32,
    size: f32,
) -> Response {
    let focused = ui.memory(|m| m.has_focus(id));
    let stroke = if focused { p.accent } else { p.bg_2 };
    let frame =
        Frame::new().fill(fill).stroke(Stroke::new(1.0, stroke)).corner_radius(3).inner_margin(Margin::symmetric(8, 6));
    let hint = RichText::new(hint).size(size).color(p.fg_faint);
    edit.id(id)
        .hint_text(hint)
        .font(FontId::proportional(size))
        .frame(frame)
        .desired_width(width.max(24.0))
        .show(ui)
        .response
        .response
}

fn text(ui: &mut Ui, s: impl Into<String>, size: f32, color: Color32) -> Response {
    ui.add(Label::new(RichText::new(s).size(size).color(color)).selectable(false))
}

fn empty(ui: &mut Ui, p: Palette, s: &str) {
    Frame::new().inner_margin(Margin::symmetric(12, 40)).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.vertical_centered(|ui| {
            ui.add(Label::new(RichText::new(s).size(12.0).color(p.fg_faint)).wrap());
        });
    });
}

/// A small framed icon button, the row actions of the staging lists.
#[allow(clippy::too_many_arguments)]
fn row_action(
    ui: &mut Ui,
    rect: Rect,
    id: Id,
    icon: &str,
    tip: &str,
    p: Palette,
    danger: bool,
    dim: bool,
    enabled: bool,
) -> bool {
    let sense = if enabled { Sense::click() } else { Sense::hover() };
    let response = ui.interact(rect, id, sense);
    let hot = enabled && response.hovered();
    let (fill, stroke, fg) = match (hot, danger) {
        (false, _) => (p.bg_3, p.line, p.fg_dim),
        (true, true) => (p.red_bg, p.red_line, p.red_fg),
        (true, false) => (p.green_bg, p.green_line, p.green_fg),
    };
    let fade = if !enabled {
        0.4
    } else if dim {
        0.5
    } else {
        1.0
    };
    ui.painter().rect_filled(rect, 3.0, fill.gamma_multiply(fade));
    ui.painter().rect_stroke(rect, 3.0, Stroke::new(1.0, stroke.gamma_multiply(fade)), StrokeKind::Inside);
    icons::paint(ui, Rect::from_center_size(rect.center(), vec2(13.0, 13.0)), icon, fg.gamma_multiply(fade));
    response.on_hover_text(tip).clicked() && enabled
}

/// A frameless icon button that only shows a background when hovered.
fn icon_button(ui: &mut Ui, rect: Rect, id: Id, icon: &str, tip: &str, p: Palette, enabled: bool) -> bool {
    let sense = if enabled { Sense::click() } else { Sense::hover() };
    let response = ui.interact(rect, id, sense);
    let hot = enabled && response.hovered();
    if hot {
        ui.painter().rect_filled(rect, 3.0, p.bg_3);
    }
    let color = if !enabled {
        p.fg_muted.gamma_multiply(0.4)
    } else if hot {
        p.accent_fg
    } else {
        p.fg_muted
    };
    icons::paint(ui, Rect::from_center_size(rect.center(), vec2(13.0, 13.0)), icon, color);
    response.on_hover_text(tip).clicked() && enabled
}

impl Btn<'_> {
    fn show(self, ui: &mut Ui, enabled: bool) -> Response {
        let g = galley(ui, self.label, self.size, self.fg, f32::INFINITY);
        let inner = g.size();
        let width = self.width.unwrap_or(inner.x + self.pad.x * 2.0);
        let sense = if enabled { Sense::click() } else { Sense::hover() };
        let (rect, response) = ui.allocate_exact_size(vec2(width, inner.y + self.pad.y * 2.0), sense);
        let fade = if enabled { 1.0 } else { 0.5 };
        let fill = if enabled && response.hovered() { self.hover } else { self.fill };
        ui.painter().rect_filled(rect, 3.0, fill.gamma_multiply(fade));
        if self.stroke != Color32::TRANSPARENT {
            ui.painter().rect_stroke(rect, 3.0, Stroke::new(1.0, self.stroke.gamma_multiply(fade)), StrokeKind::Inside);
        }
        let pos = rect.center() - inner / 2.0;
        ui.painter().galley(pos, g, self.fg.gamma_multiply(fade));
        response
    }
}

static AI_ASKED: AtomicBool = AtomicBool::new(false);

fn load_ai(app: &mut App) {
    if app.ai.is_some() || AI_ASKED.swap(true, Ordering::Relaxed) {
        return;
    }
    app.jobs.request(Request::Ai, |app, result: Result<AiConfig, String>| {
        if app.ai.is_some() {
            return;
        }
        if let Ok(config) = result {
            app.ai = Some(config);
        }
    });
}

fn feature(ai: &Option<AiConfig>, name: &str) -> bool {
    ai.as_ref().is_some_and(|a| a.enabled && a.features.iter().any(|f| f == name))
}

/// How many commits above `hash` a reword rewrites: 0 for HEAD, None when it is off HEAD's
/// first-parent line or a merge sits in the way.
fn rewrite_depth(commits: &[Commit], head: Option<&str>, hash: &str) -> Option<usize> {
    let head = head?;
    if head == hash {
        return Some(0);
    }
    let by: HashMap<&str, &Commit> = commits.iter().map(|c| (c.hash.as_str(), c)).collect();
    let mut cursor = head;
    for steps in 0..=commits.len() {
        let c = by.get(cursor)?;
        if c.parents.len() > 1 {
            return None;
        }
        if cursor == hash {
            return Some(steps);
        }
        cursor = c.parents.first()?;
    }
    None
}

fn when(unix: i64) -> String {
    use chrono::TimeZone;
    chrono::Local.timestamp_opt(unix, 0).single().map(|d| d.format("%d/%m/%Y @ %H:%M").to_string()).unwrap_or_default()
}

fn short(hash: &str, n: usize) -> &str {
    hash.get(..n).unwrap_or(hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(name: &str, path: &str) -> Worktree {
        Worktree { name: name.into(), path: path.into(), ..Default::default() }
    }

    fn commit(hash: &str, parents: &[&str]) -> Commit {
        Commit { hash: hash.into(), parents: parents.iter().map(|p| p.to_string()).collect(), ..Default::default() }
    }

    #[test]
    fn wip_rows() {
        assert!(is_wip("WIP"));
        assert!(is_wip("WIP:agent"));
        assert!(!is_wip(&"a".repeat(40)));
        assert_eq!(wip_worktree("WIP:agent"), Some("agent"));
        assert_eq!(wip_worktree("WIP:"), Some(""));
        assert_eq!(wip_worktree("WIP"), None);
        assert_eq!(wip_worktree(&"a".repeat(40)), None);
    }

    #[test]
    fn worktree_labels() {
        assert_eq!(worktree_label(&tree("x", "/code/agent-7")), "agent-7");
        assert_eq!(worktree_label(&tree("", "C:\\Code\\gitc")), "gitc");
        assert_eq!(worktree_label(&tree("x", "/code/agent/")), "agent");
    }

    #[test]
    fn reword_depth() {
        let commits = vec![
            commit("d", &["c"]),
            commit("c", &["b", "x"]),
            commit("b", &["a"]),
            commit("a", &[]),
            commit("x", &["a"]),
        ];
        assert_eq!(rewrite_depth(&commits, Some("d"), "d"), Some(0));
        assert_eq!(rewrite_depth(&commits, Some("d"), "b"), None);
        assert_eq!(rewrite_depth(&commits, Some("b"), "a"), Some(1));
        assert_eq!(rewrite_depth(&commits, Some("b"), "x"), None);
        assert_eq!(rewrite_depth(&commits, None, "a"), None);
    }
}
