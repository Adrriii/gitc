use std::sync::Arc;

use eframe::egui::text::{LayoutJob, TextWrapping};
use eframe::egui::{
    Color32, FontId, Galley, Id, Key, Modifiers, Pos2, Rect, Response, Sense, Stroke, StrokeKind, Ui, Vec2, pos2, vec2,
};

use super::App;
use super::dialogs::Confirm;
use super::diff_view::highlight::{self as syntax, Token};
use super::theme::Palette;
use crate::engine::api::{self, Request};
use crate::engine::types::{AiPick, ConflictState, ConflictVersions};

#[path = "merge_editor_draw.rs"]
mod draw;
#[path = "merge_editor_parse.rs"]
mod parse;

use parse::{Parsed, Pick, Segment, Side, Take};

#[derive(Default)]
pub struct State {
    path: String,
    loading: bool,
    error: Option<String>,
    doc: Option<Doc>,
    picks: Vec<Pick>,
    output: String,
    starts: Vec<usize>,
    manual: bool,
    current: usize,
    saving: bool,
    suggesting: bool,
    ai: Option<Vec<AiPick>>,
    split: f32,
    scroll_to: Option<usize>,
    sync: Option<Vec2>,
    last: Vec2,
    out_jump: Option<f32>,
    out_width: f32,
    colors: Colors,
}

/// Syntax tokens for the output, per line, kept in step with the text as it is edited.
#[derive(Default)]
struct Colors {
    plain: bool,
    lines: Vec<String>,
    toks: Vec<Vec<Token>>,
    generation: u64,
    exact: bool,
    pending: bool,
    galley: Option<(u64, f32, Palette, Arc<Galley>)>,
}

struct Doc {
    binary: bool,
    parsed: Parsed,
    rows: Vec<Row>,
    heads: Vec<usize>,
    ours: Vec<String>,
    theirs: Vec<String>,
    ours_toks: Vec<Vec<Token>>,
    theirs_toks: Vec<Vec<Token>>,
    widest: usize,
}

/// One row of the two side panes, which share their row layout so a conflict sits level in both.
#[derive(Clone, Copy)]
enum Row {
    Stable {
        ours: usize,
        theirs: usize,
    },
    Head(usize),
    /// Each side: (line within the conflict, line in that side's file); None pads the shorter side.
    Line {
        conflict: usize,
        ours: Option<(usize, usize)>,
        theirs: Option<(usize, usize)>,
    },
}

#[derive(Clone, Copy)]
enum Change {
    Line { conflict: usize, side: Side, line: usize, on: bool },
    Take { conflict: usize, take: Take },
    Drop { conflict: usize, side: Side },
    Swap(usize),
    Accept(Option<usize>),
}

enum Intent {
    Change(Change),
    Focus(usize),
    Jump(isize),
    Rebuild,
    Suggest,
    Save,
    Close,
    Colorize,
}

struct Labels {
    ours: String,
    theirs: String,
    operation: String,
}

#[derive(serde::Deserialize, Default)]
#[serde(default)]
struct Suggested {
    picks: Vec<AiPick>,
}

pub fn show(app: &mut App, ui: &mut Ui) {
    let Some(id) = app.active_id() else { return };
    let palette = app.palette;
    let assist = app.ai.as_ref().is_some_and(|c| c.enabled && c.features.iter().any(|f| f == "conflictAssist"));
    let keys = !app.overlay.is_open();
    let Some(repo) = app.repos.get_mut(&id) else { return };
    let Some(path) = repo.merge_file.clone() else { return };
    let labels = Labels::of(repo.conflicts.as_ref());
    let st = &mut repo.merge;
    if st.path != path {
        st.reset(&path);
        st.loading = true;
        let (tab, file, name) = (id.clone(), path.clone(), path.clone());
        let req = Request::ConflictVersions { id: id.clone(), path: path.clone() };
        app.jobs.run(
            move || api::call::<ConflictVersions>(req).map(|v| Doc::new(&v, &name)),
            move |app, result| loaded(app, &tab, &file, result),
        );
    }
    let focused = ui.ctx().memory(|m| m.focused().is_some());
    let mut intents = draw::draw(ui, st, &palette, &labels, assist);
    if keys {
        if ui.input(|i| i.key_pressed(Key::Escape)) && !focused {
            intents.push(Intent::Close);
        }
        if ui.input_mut(|i| i.consume_key(Modifiers::COMMAND, Key::S)) && st.can_save() {
            intents.push(Intent::Save);
        }
    }
    for intent in intents {
        apply(app, &id, &path, intent);
    }
}

fn apply(app: &mut App, id: &str, path: &str, intent: Intent) {
    let Some(repo) = app.repos.get_mut(id) else { return };
    let st = &mut repo.merge;
    match intent {
        Intent::Change(change) if st.manual => {
            let tab = id.to_string();
            let mut confirm = Confirm::new(
                "Rebuild the output?",
                "You have edited the output by hand. Changing the selections rebuilds it and discards those edits.",
                "Rebuild from the selections",
                move |app| {
                    if let Some(repo) = app.repos.get_mut(&tab) {
                        repo.merge.change(change);
                    }
                },
            );
            confirm.destructive = true;
            confirm.tab_id = Some(id.to_string());
            app.overlay.confirm(confirm);
        }
        Intent::Change(change) => st.change(change),
        Intent::Focus(conflict) => st.current = conflict,
        Intent::Jump(delta) => {
            let total = st.picks.len() as isize;
            if total > 0 {
                let next = (st.current as isize + delta).rem_euclid(total) as usize;
                st.current = next;
                st.scroll_to = Some(next);
            }
        }
        Intent::Rebuild => st.rebuild(),
        Intent::Colorize => {
            let colors = &mut st.colors;
            colors.pending = true;
            let lines = colors.lines.clone();
            let generation = colors.generation;
            let (tab, file, name) = (id.to_string(), path.to_string(), path.to_string());
            app.jobs.run(
                move || syntax::tokens(&name, &lines.iter().map(String::as_str).collect::<Vec<_>>()),
                move |app, toks| {
                    let Some(repo) = app.repos.get_mut(&tab) else { return };
                    if repo.merge.path != file {
                        return;
                    }
                    let colors = &mut repo.merge.colors;
                    colors.pending = false;
                    if colors.generation == generation && toks.len() == colors.lines.len() {
                        colors.toks = toks;
                        colors.exact = true;
                        colors.generation += 1;
                    }
                },
            );
        }
        Intent::Close => {
            st.reset("");
            repo.merge_file = None;
        }
        Intent::Suggest => {
            let Some(doc) = st.doc.as_ref() else { return };
            st.suggesting = true;
            st.error = None;
            let req = Request::SuggestPicks { id: id.to_string(), path: path.to_string(), hunks: doc.parsed.hunks() };
            let (tab, file) = (id.to_string(), path.to_string());
            app.jobs.request(req, move |app, result: Result<Suggested, String>| {
                let Some(repo) = app.repos.get_mut(&tab) else { return };
                let st = &mut repo.merge;
                if st.path != file {
                    return;
                }
                st.suggesting = false;
                match result {
                    Ok(s) => st.ai = Some(s.picks),
                    Err(e) => st.error = Some(e),
                }
            });
        }
        Intent::Save => {
            if !st.can_save() {
                return;
            }
            let crlf = st.doc.as_ref().is_some_and(|d| d.parsed.crlf);
            let mut content = st.output.replace("\r\n", "\n");
            if !content.is_empty() && !content.ends_with('\n') {
                content.push('\n');
            }
            if crlf {
                content = content.replace('\n', "\r\n");
            }
            st.saving = true;
            st.error = None;
            let req = Request::Resolve {
                id: id.to_string(),
                path: path.to_string(),
                side: String::new(),
                content,
                paths: Vec::new(),
            };
            let (tab, file) = (id.to_string(), path.to_string());
            app.jobs.request(req, move |app, result: Result<ConflictState, String>| {
                let Some(repo) = app.repos.get_mut(&tab) else { return };
                if repo.merge.path != file {
                    return;
                }
                repo.merge.saving = false;
                match result {
                    Ok(state) => {
                        repo.conflicts = Some(state);
                        repo.merge.reset("");
                        repo.merge_file = None;
                        repo.refresh();
                    }
                    Err(e) => repo.merge.error = Some(e),
                }
            });
        }
    }
}

fn loaded(app: &mut App, id: &str, path: &str, result: Result<Doc, String>) {
    let Some(repo) = app.repos.get_mut(id) else { return };
    let st = &mut repo.merge;
    if st.path != path {
        return;
    }
    st.loading = false;
    match result {
        Ok(doc) => {
            st.colors.plain = !syntax::supported(path);
            st.picks = doc.parsed.empty_picks();
            st.doc = Some(doc);
            st.rebuild();
            st.scroll_to = Some(0);
        }
        Err(e) => st.error = Some(e),
    }
}

impl State {
    fn reset(&mut self, path: &str) {
        let split = self.split;
        *self = State { path: path.to_string(), split, ..Default::default() };
    }

    fn change(&mut self, change: Change) {
        match change {
            Change::Line { conflict, side, line, on } => {
                if let Some(p) = self.picks.get_mut(conflict) {
                    p.set_line(side, line, on);
                }
            }
            Change::Take { conflict, take } => {
                if let Some(p) = self.picks.get_mut(conflict) {
                    p.take(take);
                }
            }
            Change::Drop { conflict, side } => {
                if let Some(p) = self.picks.get_mut(conflict) {
                    p.drop_side(side);
                }
            }
            Change::Swap(conflict) => {
                if let Some(p) = self.picks.get_mut(conflict) {
                    p.theirs_first = !p.theirs_first;
                }
            }
            Change::Accept(only) => {
                let Some(ai) = self.ai.as_ref() else { return };
                for (i, (pick, suggestion)) in self.picks.iter_mut().zip(ai).enumerate() {
                    if only.is_none_or(|o| o == i) {
                        pick.accept(suggestion);
                    }
                }
            }
        }
        self.rebuild();
    }

    /// Recomposes the output from the picks, dropping any hand edit.
    fn rebuild(&mut self) {
        let Some(doc) = self.doc.as_ref() else { return };
        let (output, starts) = doc.parsed.compose(&self.picks);
        self.output = output;
        self.starts = starts;
        self.manual = false;
    }

    fn undecided(&self) -> usize {
        self.picks.iter().filter(|p| !p.decided()).count()
    }

    fn still_marked(&self) -> bool {
        self.output.contains("<<<<<<<") || self.output.contains(">>>>>>>")
    }

    fn can_save(&self) -> bool {
        let ready = self.doc.as_ref().is_some_and(|d| !d.binary);
        ready && !self.saving && !self.still_marked() && (self.manual || self.undecided() == 0)
    }
}

impl Doc {
    fn new(versions: &ConflictVersions, path: &str) -> Doc {
        let parsed = if versions.binary { Parsed::default() } else { parse::parse(&versions.merged) };
        let mut doc = Doc {
            binary: versions.binary,
            parsed: Parsed::default(),
            rows: Vec::new(),
            heads: Vec::new(),
            ours: Vec::new(),
            theirs: Vec::new(),
            ours_toks: Vec::new(),
            theirs_toks: Vec::new(),
            widest: 0,
        };
        let mut conflict = 0;
        for segment in &parsed.segments {
            match segment {
                Segment::Stable(lines) => {
                    for line in lines {
                        doc.rows.push(Row::Stable { ours: doc.ours.len(), theirs: doc.theirs.len() });
                        doc.ours.push(line.clone());
                        doc.theirs.push(line.clone());
                    }
                }
                Segment::Conflict(region) => {
                    doc.heads.push(doc.rows.len());
                    doc.rows.push(Row::Head(conflict));
                    for i in 0..region.ours.len().max(region.theirs.len()) {
                        let ours = region.ours.get(i).map(|l| {
                            doc.ours.push(l.clone());
                            (i, doc.ours.len() - 1)
                        });
                        let theirs = region.theirs.get(i).map(|l| {
                            doc.theirs.push(l.clone());
                            (i, doc.theirs.len() - 1)
                        });
                        doc.rows.push(Row::Line { conflict, ours, theirs });
                    }
                    conflict += 1;
                }
            }
        }
        doc.widest = doc
            .ours
            .iter()
            .chain(&doc.theirs)
            .map(|l| l.chars().map(|c| if c == '\t' { 4 } else { 1 }).sum())
            .max()
            .unwrap_or(0);
        doc.parsed = parsed;
        let tokens = |lines: &[String]| syntax::tokens(path, &lines.iter().map(String::as_str).collect::<Vec<_>>());
        doc.ours_toks = tokens(&doc.ours);
        doc.theirs_toks = tokens(&doc.theirs);
        doc
    }

    /// The first row of a conflict and how many rows it spans, header included.
    fn block(&self, conflict: usize) -> (usize, usize) {
        let Some(&head) = self.heads.get(conflict) else { return (0, 0) };
        let len = self.rows.iter().skip(head + 1).take_while(|r| matches!(r, Row::Line { .. })).count();
        (head, len + 1)
    }
}

impl Colors {
    /// Follows an edit: lines unchanged at either end keep their tokens, a few changed lines are
    /// coloured on their own at once, and the whole text is re-read in the background (`exact`).
    fn follow(&mut self, text: &str, path: &str) {
        let fresh: Vec<&str> = text.split('\n').collect();
        if fresh.len() == self.lines.len() && fresh.iter().zip(&self.lines).all(|(a, b)| *a == b.as_str()) {
            return;
        }
        let max = fresh.len().min(self.lines.len());
        let head = fresh.iter().zip(&self.lines).take_while(|(a, b)| **a == b.as_str()).count();
        let tail = fresh
            .iter()
            .rev()
            .zip(self.lines.iter().rev())
            .take(max - head)
            .take_while(|(a, b)| **a == b.as_str())
            .count();
        let middle = fresh.get(head..fresh.len() - tail).unwrap_or_default();
        let quick: Vec<Vec<Token>> = if self.plain || middle.len() > 50 {
            vec![Vec::new(); middle.len()]
        } else {
            middle.iter().map(|line| syntax::tokens(path, &[line]).pop().unwrap_or_default()).collect()
        };
        self.toks.resize(self.lines.len(), Vec::new());
        let kept_tail = self.toks.split_off(self.toks.len() - tail);
        self.toks.truncate(head);
        self.toks.extend(quick);
        self.toks.extend(kept_tail);
        self.lines = fresh.iter().map(|l| l.to_string()).collect();
        self.generation += 1;
        self.exact = self.plain;
    }

    fn galley(&mut self, ui: &Ui, font: &FontId, p: &Palette, line_height: f32) -> Arc<Galley> {
        let scale = ui.ctx().pixels_per_point();
        if let Some((generation, at, palette, galley)) = &self.galley {
            if *generation == self.generation && *at == scale && palette == p {
                return galley.clone();
            }
        }
        let base = eframe::egui::text::TextFormat {
            font_id: font.clone(),
            color: p.fg,
            line_height: Some(line_height),
            ..Default::default()
        };
        let mut job = LayoutJob::default();
        for (i, line) in self.lines.iter().enumerate() {
            if i > 0 {
                job.append("\n", 0.0, base.clone());
            }
            syntax::append(&mut job, line, self.toks.get(i).map(Vec::as_slice).unwrap_or_default(), p, &base);
        }
        if job.sections.is_empty() {
            job = LayoutJob::simple_format(String::new(), base);
        }
        job.wrap.max_width = f32::INFINITY;
        job.keep_trailing_whitespace = true;
        let galley = ui.fonts_mut(|f| f.layout_job(job));
        self.galley = Some((self.generation, scale, *p, galley.clone()));
        galley
    }
}

impl Labels {
    fn of(state: Option<&ConflictState>) -> Labels {
        let progress = state.and_then(|s| s.progress.as_ref());
        let pick = |name: Option<&String>, fallback: &str| {
            name.filter(|n| !n.is_empty()).cloned().unwrap_or_else(|| fallback.to_string())
        };
        Labels {
            ours: pick(progress.map(|p| &p.onto_name), "current"),
            theirs: pick(progress.map(|p| &p.branch), "incoming"),
            operation: state.map(|s| s.operation.clone()).unwrap_or_default(),
        }
    }
}

/// Colours of a small flat button.
#[derive(Clone, Copy)]
pub(super) struct Look {
    pub fill: Color32,
    pub stroke: Color32,
    pub fg: Color32,
    pub hover_fill: Color32,
    pub hover_fg: Color32,
}

impl Look {
    pub fn new(fill: Color32, stroke: Color32, fg: Color32) -> Look {
        Look { fill, stroke, fg, hover_fill: fill, hover_fg: fg }
    }

    pub fn hover(mut self, fill: Color32, fg: Color32) -> Look {
        self.hover_fill = fill;
        self.hover_fg = fg;
        self
    }
}

/// A compact button laid out in the flow; its label is cut short at `max_width`.
pub(super) fn button(
    ui: &mut Ui,
    text: &str,
    size: f32,
    pad: Vec2,
    max_width: f32,
    look: Look,
    enabled: bool,
    p: &Palette,
) -> Response {
    let galley = label(ui, text, size, (max_width - pad.x * 2.0).max(8.0), look.fg);
    let sense = if enabled { Sense::click() } else { Sense::hover() };
    let (rect, response) = ui.allocate_exact_size(galley.size() + pad * 2.0, sense);
    paint_button(ui, rect, &response, galley, look, enabled, p);
    response
}

/// A compact button at a fixed spot, for rows painted by hand.
pub(super) fn button_at(
    ui: &Ui,
    id: Id,
    left_center: Pos2,
    height: f32,
    text: &str,
    size: f32,
    look: Look,
    p: &Palette,
) -> Response {
    let galley = label(ui, text, size, f32::INFINITY, look.fg);
    let rect =
        Rect::from_min_size(pos2(left_center.x, left_center.y - height / 2.0), vec2(galley.size().x + 14.0, height));
    let response = ui.interact(rect, id, Sense::click());
    paint_button(ui, rect, &response, galley, look, true, p);
    response
}

fn paint_button(ui: &Ui, rect: Rect, response: &Response, galley: Arc<Galley>, look: Look, enabled: bool, p: &Palette) {
    let (fill, stroke, fg) = if !enabled {
        (p.bg_2, p.line, p.fg_faint)
    } else if response.hovered() {
        (look.hover_fill, look.stroke, look.hover_fg)
    } else {
        (look.fill, look.stroke, look.fg)
    };
    let painter = ui.painter();
    painter.rect(rect, 3.0, fill, Stroke::new(1.0, stroke), StrokeKind::Inside);
    let pos = rect.center() - galley.size() / 2.0;
    painter.galley_with_override_text_color(pos, galley, fg);
}

pub(super) fn label(ui: &Ui, text: &str, size: f32, max_width: f32, color: Color32) -> Arc<Galley> {
    let mut job = LayoutJob::simple_singleline(text.to_string(), FontId::proportional(size), color);
    job.wrap = TextWrapping::truncate_at_width(max_width);
    ui.painter().layout_job(job)
}

pub(super) fn faded(color: Color32, fade: f32) -> Color32 {
    if fade >= 1.0 { color } else { color.gamma_multiply(fade) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token(n: usize) -> Vec<Token> {
        vec![Token { start: 0, end: n, syn: syntax::Syn::Keyword }]
    }

    #[test]
    fn colors_keep_tokens_of_unchanged_lines() {
        let mut colors = Colors { plain: true, ..Default::default() };
        colors.follow("a\nbb\nccc", "x");
        assert_eq!(colors.lines.len(), 3);
        colors.toks = vec![token(1), token(2), token(3)];
        colors.follow("a\nnew\nbb\nccc", "x");
        assert_eq!(colors.toks, vec![token(1), Vec::new(), token(2), token(3)]);
        colors.follow("a\nccc", "x");
        assert_eq!(colors.toks, vec![token(1), token(3)]);
        colors.follow("", "x");
        assert_eq!((colors.lines.len(), colors.toks.len()), (1, 1));
        assert!(colors.exact);
    }

    #[test]
    fn doc_rows_pad_the_shorter_side() {
        let versions =
            ConflictVersions { merged: "a\n<<<<<<< x\n1\n2\n=======\n3\n>>>>>>> y\nb\n".into(), ..Default::default() };
        let doc = Doc::new(&versions, "f.txt");
        assert_eq!(doc.rows.len(), 5);
        assert_eq!(doc.block(0), (1, 3));
        assert!(matches!(doc.rows.get(3), Some(Row::Line { conflict: 0, ours: Some((1, 2)), theirs: None })));
        assert_eq!(doc.ours, vec!["a", "1", "2", "b"]);
        assert_eq!(doc.theirs, vec!["a", "3", "b"]);
    }
}
