use eframe::egui::{
    self, Frame, Id, Key, Margin, Modifiers, Rect, RichText, ScrollArea, Sense, Stroke, Ui, UiBuilder, vec2,
};
use serde::Deserialize;

use super::{
    Btn, Env, ROW_H, SUMMARY_LIMIT, field, find_worktree, head, icon_button, paint_path, row_action, rows, text,
    worktree_label,
};
use crate::engine::api::Request;
use crate::engine::types::{CommitDone, DiffTarget, Message, WorkingFile};
use crate::ui::dialogs::Confirm;
use crate::ui::repo::{OpenFile, Repo};
use crate::ui::task::Jobs;
use crate::ui::{actions, icons};

#[derive(Default)]
pub struct State {
    summary: String,
    description: String,
    amend: bool,
    busy: bool,
    error: String,
    write_run: u64,
    writing: bool,
    before: Option<(String, String)>,
    status_gen: u64,
    lists_key: Option<(u64, u64, Option<String>)>,
    unstaged: Vec<usize>,
    staged: Vec<usize>,
    follow_key: Option<(u64, u64, String, bool, Option<String>)>,
    viewed: Vec<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct StatusAnswer {
    status: Vec<WorkingFile>,
}

enum Act {
    Open(usize, bool),
    Stage(String),
    Unstage(String),
    Discard(Vec<usize>),
    StageAll,
    UnstageAll,
}

/// The WIP panel: this checkout's changes, or another worktree's (by name) read-only.
pub fn show(ui: &mut Ui, env: &mut Env, repo: &mut Repo, st: &mut State, worktree: Option<&str>) {
    let p = env.p;
    let Some(data) = repo.data.as_ref() else { return };
    let (status, branch, ro) = match worktree {
        Some(name) => {
            let Some(w) = find_worktree(&data.worktrees, name) else { return };
            let branch = if w.detached { "detached" } else { w.branch.as_deref().unwrap_or("detached") };
            (&w.status[..], branch, Some((worktree_label(w), w.path.as_str(), w.name.as_str())))
        }
        None => (&data.status[..], data.head.branch.as_deref().unwrap_or("detached"), None),
    };
    let key = (repo.version, st.status_gen, worktree.map(String::from));
    if st.lists_key.as_ref() != Some(&key) {
        st.unstaged = unstaged_files(status);
        st.staged = staged_files(status);
        st.lists_key = Some(key);
    }
    let busy = st.busy || repo.busy;
    let open_path = repo.open_file.as_ref().map(|f| f.path.as_str());
    let mut act: Option<Act> = None;

    let box_frame = Frame::new().fill(p.bg_1).inner_margin(Margin { left: 12, right: 12, top: 10, bottom: 12 });
    egui::Panel::bottom("staging_commit_box").frame(box_frame).show(ui, |ui| {
        ui.spacing_mut().item_spacing.y = 8.0;
        match &ro {
            Some((label, path, name)) => read_only_box(ui, env, label, path, name),
            None => {
                let staged = st.staged.len();
                commit_box(ui, env, st, staged, busy);
            }
        }
    });

    head(ui, p, |ui| {
        if ro.is_none() {
            let rect = ui.allocate_exact_size(vec2(24.0, 22.0), Sense::hover()).0;
            let id = ui.scope_id().with("discard_all");
            if row_action(ui, rect, id, "trash", "Discard all changes", p, true, false, !busy && !status.is_empty()) {
                act = Some(Act::Discard((0..status.len()).collect()));
            }
        }
        let plural = if status.len() == 1 { "" } else { "s" };
        text(ui, format!("{} file change{plural} on", status.len()), 12.0, p.fg_dim);
        egui::Frame::new().fill(p.chip_head).corner_radius(3).inner_margin(Margin::symmetric(7, 1)).show(ui, |ui| {
            text(ui, branch, 11.0, p.chip_head_fg);
        });
        if let Some((label, path, _)) = &ro {
            ui.add(egui::Label::new(RichText::new(format!("in {label}")).size(12.0).color(p.fg_muted)).truncate())
                .on_hover_text(*path);
        }
    });

    if !st.error.is_empty() {
        Frame::new()
            .fill(p.red_bg)
            .stroke(Stroke::new(1.0, p.red_line))
            .corner_radius(3)
            .inner_margin(Margin::symmetric(9, 6))
            .outer_margin(Margin::symmetric(12, 8))
            .show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.add(egui::Label::new(RichText::new(&st.error).size(11.0).color(p.red_fg)).wrap());
            });
    }

    let section_h = 36.0;
    let list_h = ((ui.available_height() - section_h * 2.0) / 2.0).max(ROW_H * 2.0);
    let lists = [(false, &st.unstaged), (true, &st.staged)];
    for (staged, list) in lists {
        let (title, all, empty) = if staged {
            ("Staged Files", "Unstage All Changes", "Nothing staged")
        } else {
            ("Unstaged Files", "Stage All Changes", "Nothing unstaged")
        };
        section(ui, env, section_h, &format!("{title} ({})", list.len()), |ui| {
            if ro.is_some() {
                return;
            }
            let (fg, border) = if staged { (p.red_fg, p.red) } else { (p.green_fg, p.green) };
            let btn = Btn {
                label: all,
                size: 11.0,
                fg,
                fill: egui::Color32::TRANSPARENT,
                stroke: border,
                hover: border.gamma_multiply(0.16),
                pad: vec2(9.0, 3.0),
                width: None,
            };
            if btn.show(ui, !busy && !list.is_empty()).clicked() {
                act = Some(if staged { Act::UnstageAll } else { Act::StageAll });
            }
        });
        let (rect, _) = ui.allocate_exact_size(vec2(ui.available_width(), list_h), Sense::hover());
        let mut child = ui.new_child(UiBuilder::new().max_rect(rect));
        ScrollArea::vertical().id_salt(("staging_list", staged)).auto_shrink([false, false]).show(&mut child, |ui| {
            ui.spacing_mut().item_spacing.y = 0.0;
            if list.is_empty() {
                ui.add_space(4.0);
                ui.horizontal(|ui| {
                    ui.add_space(12.0);
                    text(ui, empty, 11.0, p.fg_faint);
                });
                return;
            }
            rows(ui, list.len(), ROW_H, |ui, rect, i| {
                let Some(file) = list.get(i).and_then(|&at| status.get(at)) else { return };
                let active = open_path == Some(file.path.as_str());
                let id = Id::unique(("staging_file", staged, &file.path));
                if let Some(a) = file_row(ui, rect, id, env, file, staged, active, ro.is_some(), busy) {
                    act = Some(match a {
                        Row::Open => Act::Open(list.get(i).copied().unwrap_or(0), staged),
                        Row::Stage => Act::Stage(file.path.clone()),
                        Row::Unstage => Act::Unstage(file.path.clone()),
                        Row::Discard => Act::Discard(list.get(i).copied().into_iter().collect()),
                    });
                }
            });
        });
    }

    let Some(act) = act else { return };
    let tab = env.id.clone();
    match act {
        Act::Open(at, staged) => {
            let Some(file) = status.get(at) else { return };
            let untracked = !staged && file.untracked;
            let label = match &ro {
                Some((label, _, _)) => format!("{label}{}", if staged { "'s staged changes" } else { "" }),
                None => (if staged { "staged changes" } else { "the working tree" }).to_string(),
            };
            let worktree = ro.as_ref().map(|(_, _, name)| name.to_string());
            let target = DiffTarget::Wip { staged, untracked, worktree };
            repo.open_file = Some(OpenFile { path: file.path.clone(), target, label });
        }
        Act::Stage(path) => run(env.jobs, st, &tab, Request::Stage { id: tab.clone(), paths: vec![path] }),
        Act::Unstage(path) => run(env.jobs, st, &tab, Request::Unstage { id: tab.clone(), paths: vec![path] }),
        Act::StageAll => run(env.jobs, st, &tab, Request::Stage { id: tab.clone(), paths: Vec::new() }),
        Act::UnstageAll => run(env.jobs, st, &tab, Request::Unstage { id: tab.clone(), paths: Vec::new() }),
        Act::Discard(files) => {
            let picked: Vec<&WorkingFile> = files.iter().filter_map(|&i| status.get(i)).collect();
            ask_discard(env, &tab, &picked);
        }
    }
}

/// Follows the file being viewed once it leaves its list: the next one down opens instead.
pub fn follow(repo: &mut Repo, st: &mut State) {
    let Some(open) = repo.open_file.as_ref() else {
        st.viewed.clear();
        return;
    };
    let DiffTarget::Wip { staged, worktree, .. } = &open.target else {
        st.viewed.clear();
        return;
    };
    let Some(data) = repo.data.as_ref() else { return };
    let same = st.follow_key.as_ref().is_some_and(|(v, g, path, s, w)| {
        *v == repo.version && *g == st.status_gen && *path == open.path && s == staged && w == worktree
    });
    if same {
        return;
    }
    st.follow_key = Some((repo.version, st.status_gen, open.path.clone(), *staged, worktree.clone()));
    let source = match worktree {
        Some(name) => find_worktree(&data.worktrees, name).map(|w| &w.status[..]).unwrap_or(&[]),
        None => &data.status[..],
    };
    let list = if *staged { staged_files(source) } else { unstaged_files(source) };
    let paths: Vec<String> = list.iter().filter_map(|&i| source.get(i)).map(|f| f.path.clone()).collect();
    if paths.contains(&open.path) {
        st.viewed = paths;
        return;
    }
    let next = next_after(&st.viewed, &paths, &open.path);
    st.viewed = paths;
    let Some(next) = next else {
        repo.open_file = None;
        return;
    };
    let untracked = !*staged && source.iter().any(|f| f.path == next && f.untracked);
    let target = DiffTarget::Wip { staged: *staged, untracked, worktree: worktree.clone() };
    let label = open.label.clone();
    repo.open_file = Some(OpenFile { path: next, target, label });
}

/// Changes in the working tree, untracked files included, as indexes into `status`.
pub fn unstaged_files(status: &[WorkingFile]) -> Vec<usize> {
    let has = |f: &WorkingFile| f.untracked || (!f.worktree.is_empty() && f.worktree != " ");
    status.iter().enumerate().filter(|(_, f)| has(f)).map(|(i, _)| i).collect()
}

/// Changes in the index, as indexes into `status`.
pub fn staged_files(status: &[WorkingFile]) -> Vec<usize> {
    status.iter().enumerate().filter(|(_, f)| f.staged).map(|(i, _)| i).collect()
}

/// What takes the place of `path` once it left `list`; `previous` is the list while it was still in it.
pub fn next_after(previous: &[String], list: &[String], path: &str) -> Option<String> {
    let last = list.len().checked_sub(1)?;
    let Some(was) = previous.iter().position(|p| p == path) else { return list.first().cloned() };
    list.get(was.min(last)).cloned()
}

#[derive(Clone, Copy)]
enum Row {
    Open,
    Stage,
    Unstage,
    Discard,
}

fn commit_box(ui: &mut Ui, env: &mut Env, st: &mut State, staged: usize, busy: bool) {
    let p = env.p;
    if ui.checkbox(&mut st.amend, RichText::new("Amend previous commit").size(12.0).color(p.fg_dim)).changed()
        && st.amend
    {
        prefill_amend(env);
    }
    let can_commit = (staged > 0 || st.amend) && !st.summary.trim().is_empty();
    let summary_id = ui.scope_id().with("commit_summary");
    let submit =
        ui.memory(|m| m.has_focus(summary_id)) && ui.input_mut(|i| i.consume_key(Modifiers::COMMAND, Key::Enter));
    let mut write = false;
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 4.0;
        let ai_w = if env.write_on { 26.0 } else { 0.0 };
        let left = SUMMARY_LIMIT as i64 - st.summary.chars().count() as i64;
        let counter = RichText::new(left.to_string()).size(11.0).color(if left < 0 { p.amber } else { p.fg_faint });
        let color = if st.writing { p.fg.gamma_multiply(0.6) } else { p.fg };
        let edit = egui::TextEdit::singleline(&mut st.summary).char_limit(200).text_color(color).suffix(counter);
        let width = ui.available_width() - ai_w;
        let shown = field(ui, edit, summary_id, "Commit summary", p.bg_inset, p, width, 13.0);
        if shown.changed() {
            st.before = None;
        }
        if !env.write_on {
            return;
        }
        let undo = st.before.is_some() && !st.writing;
        let nothing = staged == 0 && !st.amend;
        let tip = if st.writing {
            "Writing the message - click to stop waiting"
        } else if undo {
            "Put back what was here before"
        } else if nothing {
            "Stage changes for AI to describe"
        } else {
            "Write the summary and description from the staged changes"
        };
        let enabled = st.writing || undo || !nothing;
        let rect = ui.allocate_exact_size(vec2(22.0, 22.0), Sense::hover()).0;
        let icon = if undo { "undo" } else { "sparkle" };
        let id = ui.scope_id().with("ai_write");
        if icon_button(ui, rect, id, icon, tip, p, enabled) {
            write = true;
        }
    });
    if write {
        if st.before.is_some() && !st.writing {
            if let Some((summary, description)) = st.before.take() {
                st.summary = summary;
                st.description = description;
            }
        } else {
            write_message(env, st);
        }
    }
    let color = if st.writing { p.fg.gamma_multiply(0.6) } else { p.fg };
    let edit = egui::TextEdit::multiline(&mut st.description).desired_rows(4).text_color(color);
    let (id, width) = (ui.scope_id().with("commit_description"), ui.available_width());
    if field(ui, edit, id, "Description", p.bg_inset, p, width, 12.0).changed() {
        st.before = None;
    }
    let label = if staged == 0 && !st.amend {
        "Stage Changes to Commit".to_string()
    } else if st.summary.trim().is_empty() {
        "Type a Message to Commit".to_string()
    } else if st.amend {
        "Amend Previous Commit".to_string()
    } else {
        format!("Commit {staged} file{}", if staged == 1 { "" } else { "s" })
    };
    let enabled = can_commit && !busy;
    let (fg, fill, stroke) =
        if enabled { (p.green_fg, p.green_bg, p.green_line) } else { (p.fg_faint, p.bg_2, p.line) };
    let btn = Btn {
        label: &label,
        size: 12.0,
        fg,
        fill,
        stroke,
        hover: p.green_line,
        pad: vec2(12.0, 8.0),
        width: Some(ui.available_width()),
    };
    if (btn.show(ui, enabled).clicked() || submit) && enabled {
        commit(env, st);
    }
}

fn read_only_box(ui: &mut Ui, env: &mut Env, label: &str, path: &str, name: &str) {
    let p = env.p;
    ui.horizontal_wrapped(|ui| {
        ui.spacing_mut().item_spacing.x = 4.0;
        icons::show(ui, "eye", 13.0, p.fg_dim);
        text(ui, "Read-only.", 12.0, p.fg_dim);
        ui.label(RichText::new(label).size(12.0).color(p.fg_bright).strong());
        text(ui, "is another worktree - nothing here changes it.", 12.0, p.fg_dim);
    });
    let caption = format!("Open {label} to Edit");
    let btn = Btn {
        label: &caption,
        size: 12.0,
        fg: p.green_fg,
        fill: p.green_bg,
        stroke: p.green_line,
        hover: p.green_line,
        pad: vec2(12.0, 8.0),
        width: Some(ui.available_width()),
    };
    if btn.show(ui, true).on_hover_text(path).clicked() {
        let name = name.to_string();
        env.later.add(move |app| actions::edit_worktree(app, &name));
    }
}

fn section(ui: &mut Ui, env: &Env, height: f32, title: &str, add: impl FnOnce(&mut Ui)) {
    let p = env.p;
    let (rect, _) = ui.allocate_exact_size(vec2(ui.available_width(), height), Sense::hover());
    let inner = Rect::from_min_max(rect.min + vec2(12.0, 12.0), rect.max - vec2(12.0, 6.0));
    let mut child =
        ui.new_child(UiBuilder::new().max_rect(inner).layout(egui::Layout::left_to_right(egui::Align::Center)));
    child.spacing_mut().item_spacing.x = 5.0;
    icons::show(&mut child, "chevronDown", 11.0, p.fg_muted);
    text(&mut child, title, 12.0, p.fg_dim);
    child.with_layout(egui::Layout::right_to_left(egui::Align::Center), add);
}

#[allow(clippy::too_many_arguments)]
fn file_row(
    ui: &mut Ui,
    rect: Rect,
    id: Id,
    env: &Env,
    file: &WorkingFile,
    staged: bool,
    active: bool,
    ro: bool,
    busy: bool,
) -> Option<Row> {
    let p = env.p;
    let response = ui.interact(rect, id, Sense::click());
    let hovered = ui.rect_contains_pointer(rect);
    if active {
        ui.painter().rect_filled(rect, 0.0, p.accent_bg);
    } else if hovered {
        ui.painter().rect_filled(rect, 0.0, p.bg_3);
    }
    let code = if staged {
        file.index.as_str()
    } else if file.untracked {
        "?"
    } else {
        file.worktree.as_str()
    };
    let (icon, color) = match code {
        "A" | "?" => ("added", p.green),
        "D" => ("removed", p.red),
        _ => ("edit", p.amber),
    };
    let mid = rect.center().y;
    icons::paint(ui, Rect::from_center_size(egui::pos2(rect.left() + 18.5, mid), vec2(12.0, 12.0)), icon, color);
    let buttons: &[(&str, &str, bool, Row)] = match (ro, staged) {
        (true, _) => &[],
        (false, false) => {
            &[("trash", "Discard changes", true, Row::Discard), ("added", "Stage this file", false, Row::Stage)]
        }
        (false, true) => &[("removed", "Unstage this file", false, Row::Unstage)],
    };
    let mut right = rect.right() - 12.0;
    let mut picked = None;
    for (n, (icon, tip, danger, row)) in buttons.iter().enumerate().rev() {
        let b = Rect::from_min_size(egui::pos2(right - 24.0, mid - 11.0), vec2(24.0, 22.0));
        right -= 27.0;
        let dim = !hovered;
        if row_action(ui, b, id.with(n), icon, tip, p, *danger, dim, !busy) {
            picked = Some(*row);
        }
    }
    let left = rect.left() + 32.0;
    paint_path(ui, left, mid, right - 4.0 - left, &file.path, false, p);
    if picked.is_some() {
        return picked;
    }
    if response.on_hover_text(file.path.as_str()).clicked() {
        return Some(Row::Open);
    }
    None
}

fn run(jobs: &mut Jobs, st: &mut State, tab: &str, req: Request) {
    st.busy = true;
    st.error.clear();
    let tab = tab.to_string();
    jobs.request(req, move |app, result: Result<StatusAnswer, String>| {
        let Some(repo) = app.repos.get_mut(&tab) else { return };
        let st = &mut repo.panel.staging;
        st.busy = false;
        match result {
            Ok(answer) => {
                st.status_gen += 1;
                if let Some(data) = repo.data.as_mut() {
                    data.status = answer.status;
                }
                repo.refresh();
            }
            Err(e) => st.error = e,
        }
    });
}

fn ask_discard(env: &mut Env, tab: &str, files: &[&WorkingFile]) {
    let tracked: Vec<String> = files.iter().filter(|f| !f.untracked).map(|f| f.path.clone()).collect();
    let untracked: Vec<String> = files.iter().filter(|f| f.untracked).map(|f| f.path.clone()).collect();
    let total = tracked.len() + untracked.len();
    let plural = |n: usize| if n == 1 { "" } else { "s" };
    let mut body = format!("{total} file{} will be changed. This cannot be undone by gitc.", plural(total));
    if !tracked.is_empty() {
        body.push_str(&format!(
            "\n\n{} tracked file{} reverted to the last commit.",
            tracked.len(),
            plural(tracked.len())
        ));
    }
    if !untracked.is_empty() {
        body.push_str(&format!("\n\n{} untracked file{} deleted from disk.", untracked.len(), plural(untracked.len())));
    }
    let tab = tab.to_string();
    let mut confirm = Confirm::new("Discard changes?", body, "Discard", move |app| {
        let Some(repo) = app.repos.get_mut(&tab) else { return };
        let req = Request::Discard { id: tab.clone(), tracked, untracked };
        run(&mut app.jobs, &mut repo.panel.staging, &tab, req);
    });
    confirm.destructive = true;
    confirm.tab_id = Some(env.id.clone());
    env.overlay.confirm(confirm);
}

fn prefill_amend(env: &mut Env) {
    let tab = env.id.clone();
    env.jobs.request(Request::HeadMessage { id: tab.clone() }, move |app, result: Result<Message, String>| {
        let Ok(message) = result else { return };
        let Some(repo) = app.repos.get_mut(&tab) else { return };
        let st = &mut repo.panel.staging;
        if !st.amend {
            return;
        }
        if st.summary.trim().is_empty() {
            st.summary = message.summary;
        }
        if st.description.trim().is_empty() {
            st.description = message.description;
        }
    });
}

fn write_message(env: &mut Env, st: &mut State) {
    st.write_run += 1;
    if st.writing {
        st.writing = false;
        return;
    }
    let run = st.write_run;
    let typed = (st.summary.clone(), st.description.clone());
    st.writing = true;
    st.error.clear();
    let hint: Vec<&str> = [st.summary.trim(), st.description.trim()].into_iter().filter(|t| !t.is_empty()).collect();
    let req = Request::WriteCommitMessage { id: env.id.clone(), hint: hint.join("\n\n"), amend: st.amend };
    let tab = env.id.clone();
    env.jobs.request(req, move |app, result: Result<Message, String>| {
        let Some(repo) = app.repos.get_mut(&tab) else { return };
        let st = &mut repo.panel.staging;
        if st.write_run != run {
            return;
        }
        st.writing = false;
        match result {
            Ok(message) => {
                st.before = Some(typed);
                st.summary = message.summary;
                st.description = message.description;
            }
            Err(e) => st.error = e,
        }
    });
}

fn commit(env: &mut Env, st: &mut State) {
    st.busy = true;
    st.error.clear();
    let tab = env.id.clone();
    let req = Request::Commit {
        id: tab.clone(),
        summary: st.summary.clone(),
        description: st.description.clone(),
        amend: st.amend,
    };
    env.jobs.request(req, move |app, result: Result<CommitDone, String>| {
        let Some(repo) = app.repos.get_mut(&tab) else { return };
        let st = &mut repo.panel.staging;
        st.busy = false;
        if let Err(e) = result {
            st.error = e;
            return;
        }
        st.summary.clear();
        st.description.clear();
        st.amend = false;
        st.before = None;
        repo.open_file = None;
        repo.refresh();
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str, code: &str) -> WorkingFile {
        let index = code.get(0..1).unwrap_or(" ").to_string();
        let worktree = code.get(1..2).unwrap_or(" ").to_string();
        WorkingFile {
            path: path.into(),
            staged: index != " " && index != "?",
            untracked: code == "??",
            index,
            worktree,
        }
    }

    fn names(status: &[WorkingFile], list: Vec<usize>) -> Vec<&str> {
        list.into_iter().filter_map(|i| status.get(i)).map(|f| f.path.as_str()).collect()
    }

    #[test]
    fn splits_the_two_lists() {
        let status = vec![
            file("only-staged.txt", "M "),
            file("only-unstaged.txt", " M"),
            file("both.txt", "MM"),
            file("added-then-edited.txt", "AM"),
            file("untracked.txt", "??"),
            file("deleted-in-tree.txt", " D"),
            file("staged-delete.txt", "D "),
        ];
        assert_eq!(
            names(&status, unstaged_files(&status)),
            ["only-unstaged.txt", "both.txt", "added-then-edited.txt", "untracked.txt", "deleted-in-tree.txt"]
        );
        assert_eq!(
            names(&status, staged_files(&status)),
            ["only-staged.txt", "both.txt", "added-then-edited.txt", "staged-delete.txt"]
        );
    }

    #[test]
    fn follows_the_list() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let before = s(&["a.txt", "b.txt", "c.txt"]);
        assert_eq!(next_after(&before, &s(&["a.txt", "c.txt"]), "b.txt").as_deref(), Some("c.txt"));
        assert_eq!(next_after(&before, &s(&["b.txt", "c.txt"]), "a.txt").as_deref(), Some("b.txt"));
        assert_eq!(next_after(&before, &s(&["a.txt", "b.txt"]), "c.txt").as_deref(), Some("b.txt"));
        assert_eq!(next_after(&before, &[], "a.txt"), None);
        assert_eq!(next_after(&[], &s(&["x.txt", "y.txt"]), "gone.txt").as_deref(), Some("x.txt"));
    }
}
