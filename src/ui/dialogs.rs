use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use eframe::egui::{self, Align2, Color32, Id, Key, Pos2, RichText, Vec2};

use super::task::Task;
use super::{App, icons};

pub type Action = Box<dyn FnOnce(&mut App)>;
pub type Validate = Box<dyn Fn(&str) -> Option<String>>;
pub type Suggest = Arc<dyn Fn() -> Result<String, String> + Send + Sync>;

#[derive(Default)]
pub struct MenuItem {
    pub label: String,
    pub hint: String,
    pub danger: bool,
    pub checked: Option<bool>,
    pub disabled: bool,
    pub separator: bool,
    pub action: Option<Action>,
}

impl MenuItem {
    pub fn new(label: impl Into<String>, action: impl FnOnce(&mut App) + 'static) -> MenuItem {
        MenuItem { label: label.into(), action: Some(Box::new(action)), ..Default::default() }
    }

    pub fn separator() -> MenuItem {
        MenuItem { separator: true, ..Default::default() }
    }

    /// A line of text that does nothing, e.g. a heading or an explanation.
    pub fn note(label: impl Into<String>) -> MenuItem {
        MenuItem { label: label.into(), disabled: true, ..Default::default() }
    }

    pub fn hint(mut self, hint: impl Into<String>) -> MenuItem {
        self.hint = hint.into();
        self
    }

    pub fn danger(mut self) -> MenuItem {
        self.danger = true;
        self
    }

    pub fn checked(mut self, checked: bool) -> MenuItem {
        self.checked = Some(checked);
        self
    }

    pub fn disabled(mut self, disabled: bool) -> MenuItem {
        self.disabled = disabled;
        self
    }
}

pub struct Menu {
    pub pos: Pos2,
    pub items: Vec<MenuItem>,
    opened: u64,
}

pub struct Prompt {
    pub title: String,
    pub label: String,
    pub placeholder: String,
    pub initial: String,
    pub confirm_label: String,
    pub hint: String,
    pub validate: Option<Validate>,
    pub suggest: Option<(String, Suggest)>,
    pub on_confirm: Box<dyn FnOnce(&mut App, String)>,
}

pub struct Confirm {
    pub title: String,
    pub body: String,
    pub confirm_label: String,
    pub destructive: bool,
    /// The tab it was asked about; switching away dismisses it. None for app-wide questions.
    pub tab_id: Option<String>,
    pub on_confirm: Action,
}

pub struct Choice {
    pub value: String,
    pub label: String,
    pub hint: String,
}

pub struct Choose {
    pub title: String,
    pub body: String,
    pub options: Vec<Choice>,
    pub on_pick: Box<dyn FnOnce(&mut App, String)>,
}

#[derive(Default)]
pub struct Field {
    pub key: String,
    pub label: String,
    pub placeholder: String,
    pub initial: String,
    pub validate: Option<Validate>,
    pub optional: bool,
    pub secret: bool,
    /// When set, the field is a picker among these (value, label) pairs.
    pub options: Vec<(String, String)>,
}

pub struct Form {
    pub title: String,
    pub body: String,
    pub fields: Vec<Field>,
    pub confirm_label: String,
    pub on_confirm: Box<dyn FnOnce(&mut App, BTreeMap<String, String>)>,
}

/// Whatever floats above the window: at most one of each.
#[derive(Default)]
pub struct Overlay {
    pub menu: Option<Menu>,
    prompt: Option<(Prompt, PromptState)>,
    pub confirm: Option<Confirm>,
    pub choose: Option<Choose>,
    form: Option<(Form, BTreeMap<String, String>)>,
}

#[derive(Default)]
struct PromptState {
    value: String,
    suggesting: Option<Task<Result<String, String>>>,
    error: String,
    focused: bool,
}

impl Overlay {
    pub fn menu(&mut self, ctx: &egui::Context, pos: Pos2, items: Vec<MenuItem>) {
        if items.is_empty() {
            return;
        }
        self.menu = Some(Menu { pos, items, opened: ctx.cumulative_pass_nr() });
    }

    pub fn prompt(&mut self, prompt: Prompt) {
        let state = PromptState { value: prompt.initial.clone(), ..Default::default() };
        self.prompt = Some((prompt, state));
    }

    pub fn confirm(&mut self, confirm: Confirm) {
        self.confirm = Some(confirm);
    }

    pub fn choose(&mut self, choose: Choose) {
        self.choose = Some(choose);
    }

    pub fn form(&mut self, form: Form) {
        let values = form.fields.iter().map(|f| (f.key.clone(), f.initial.clone())).collect();
        self.form = Some((form, values));
    }

    pub fn is_open(&self) -> bool {
        self.menu.is_some()
            || self.prompt.is_some()
            || self.confirm.is_some()
            || self.choose.is_some()
            || self.form.is_some()
    }

    /// Drops questions that were about a tab no longer in front.
    pub fn tab_changed(&mut self, active: Option<&str>) {
        if self.confirm.as_ref().is_some_and(|c| c.tab_id.is_some() && c.tab_id.as_deref() != active) {
            self.confirm = None;
        }
        self.choose = None;
        self.menu = None;
    }
}

impl Prompt {
    pub fn new(
        title: impl Into<String>,
        confirm_label: impl Into<String>,
        on_confirm: impl FnOnce(&mut App, String) + 'static,
    ) -> Prompt {
        Prompt {
            title: title.into(),
            label: String::new(),
            placeholder: String::new(),
            initial: String::new(),
            confirm_label: confirm_label.into(),
            hint: String::new(),
            validate: None,
            suggest: None,
            on_confirm: Box::new(on_confirm),
        }
    }
}

impl Confirm {
    pub fn new(
        title: impl Into<String>,
        body: impl Into<String>,
        confirm_label: impl Into<String>,
        on_confirm: impl FnOnce(&mut App) + 'static,
    ) -> Confirm {
        Confirm {
            title: title.into(),
            body: body.into(),
            confirm_label: confirm_label.into(),
            destructive: false,
            tab_id: None,
            on_confirm: Box::new(on_confirm),
        }
    }
}

pub fn show(app: &mut App, ctx: &egui::Context) {
    show_menu(app, ctx);
    show_prompt(app, ctx);
    show_confirm(app, ctx);
    show_choose(app, ctx);
    show_form(app, ctx);
}

fn show_menu(app: &mut App, ctx: &egui::Context) {
    let Some(menu) = app.overlay.menu.as_mut() else { return };
    let palette = app.palette;
    let mut picked: Option<usize> = None;
    let area = egui::Area::new(Id::unique("gitc-menu"))
        .order(egui::Order::Foreground)
        .fixed_pos(menu.pos)
        .constrain(true)
        .show(ctx, |ui| {
            egui::Frame::popup(ui.style()).fill(palette.bg_2).show(ui, |ui| {
                ui.set_min_width(200.0);
                ui.spacing_mut().item_spacing.y = 0.0;
                for (i, item) in menu.items.iter().enumerate() {
                    if item.separator {
                        ui.add_space(3.0);
                        ui.separator();
                        ui.add_space(3.0);
                        continue;
                    }
                    let color = if item.disabled {
                        palette.fg_faint
                    } else if item.danger {
                        palette.red_fg
                    } else {
                        palette.fg
                    };
                    let width = ui.available_width().max(200.0);
                    let (rect, response) = ui.allocate_exact_size(Vec2::new(width, 24.0), egui::Sense::click());
                    if response.hovered() && !item.disabled {
                        ui.painter().rect_filled(rect, 3.0, palette.bg_4);
                    }
                    let mut x = rect.left() + 8.0;
                    if let Some(checked) = item.checked {
                        if checked {
                            icons::paint(
                                ui,
                                egui::Rect::from_center_size(Pos2::new(x + 6.0, rect.center().y), Vec2::splat(12.0)),
                                "check",
                                palette.accent,
                            );
                        }
                        x += 18.0;
                    }
                    ui.painter().text(
                        Pos2::new(x, rect.center().y),
                        Align2::LEFT_CENTER,
                        &item.label,
                        egui::FontId::proportional(13.0),
                        color,
                    );
                    if !item.hint.is_empty() {
                        ui.painter().text(
                            Pos2::new(rect.right() - 8.0, rect.center().y),
                            Align2::RIGHT_CENTER,
                            &item.hint,
                            egui::FontId::proportional(11.5),
                            palette.fg_muted,
                        );
                    }
                    if response.clicked() && !item.disabled {
                        picked = Some(i);
                    }
                }
            });
        });
    let inside = area.response.rect;
    let opened = menu.opened;
    let escape = ctx.input(|i| i.key_pressed(Key::Escape));
    let clicked_away = ctx.cumulative_pass_nr() > opened
        && ctx.input(|i| i.pointer.any_pressed() && i.pointer.interact_pos().is_some_and(|p| !inside.contains(p)));
    if let Some(i) = picked {
        let action = app.overlay.menu.take().and_then(|mut m| m.items.get_mut(i).and_then(|item| item.action.take()));
        if let Some(action) = action {
            app.later.add(action);
        }
        return;
    }
    if escape || clicked_away {
        app.overlay.menu = None;
    }
}

fn dialog_frame(app: &App) -> egui::Frame {
    egui::Frame::window(&egui::Style::default())
        .fill(app.palette.bg_2)
        .stroke(egui::Stroke::new(1.0, app.palette.line_strong))
        .inner_margin(16.0)
        .corner_radius(6.0)
}

fn show_prompt(app: &mut App, ctx: &egui::Context) {
    let frame = dialog_frame(app);
    let palette = app.palette;
    let Some((prompt, state)) = app.overlay.prompt.as_mut() else { return };
    if let Some(task) = state.suggesting.as_ref() {
        if let Some(result) = task.take() {
            state.suggesting = None;
            match result {
                Ok(text) => state.value = text,
                Err(e) => state.error = e,
            }
        }
    }
    let mut submit = false;
    let mut cancel = false;
    let modal = egui::Modal::new(Id::unique("gitc-prompt")).frame(frame).show(ctx, |ui| {
        ui.set_width(380.0);
        ui.label(RichText::new(&prompt.title).size(15.0).color(palette.fg_bright).strong());
        ui.add_space(8.0);
        if !prompt.label.is_empty() {
            ui.label(RichText::new(&prompt.label).color(palette.fg_dim));
        }
        ui.horizontal(|ui| {
            let edit = egui::TextEdit::singleline(&mut state.value)
                .hint_text(&prompt.placeholder)
                .desired_width(if prompt.suggest.is_some() { 300.0 } else { f32::INFINITY });
            let response = ui.add(edit);
            if !state.focused {
                response.request_focus();
                state.focused = true;
            }
            if response.lost_focus() && ui.input(|i| i.key_pressed(Key::Enter)) {
                submit = true;
            }
            if let Some((title, run)) = prompt.suggest.as_ref() {
                let busy = state.suggesting.is_some();
                if ui
                    .add_enabled(!busy, egui::Button::image(icons::image("sparkle", 14.0, palette.purple)))
                    .on_hover_text(title)
                    .clicked()
                {
                    let run = run.clone();
                    state.error.clear();
                    state.suggesting = Some(Task::spawn(move || run()));
                }
            }
        });
        let problem = prompt.validate.as_ref().and_then(|v| v(&state.value));
        if !state.error.is_empty() {
            ui.label(RichText::new(&state.error).color(palette.red_fg));
        } else if let Some(problem) = problem.as_ref().filter(|_| !state.value.is_empty()) {
            ui.label(RichText::new(problem).color(palette.amber_fg));
        } else if !prompt.hint.is_empty() {
            ui.label(RichText::new(&prompt.hint).color(palette.fg_muted).size(12.0));
        }
        ui.add_space(12.0);
        let valid = problem.is_none() && !state.value.trim().is_empty();
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if ui.add_enabled(valid, egui::Button::new(&prompt.confirm_label).fill(palette.accent_line)).clicked() {
                submit = true;
            }
            if ui.button("Cancel").clicked() {
                cancel = true;
            }
        });
        if !valid {
            submit = false;
        }
    });
    if modal.should_close() {
        cancel = true;
    }
    if submit {
        if let Some((prompt, state)) = app.overlay.prompt.take() {
            let value = state.value.trim().to_string();
            let confirm = prompt.on_confirm;
            app.later.add(move |app| confirm(app, value));
        }
        return;
    }
    if cancel {
        app.overlay.prompt = None;
    }
}

fn show_confirm(app: &mut App, ctx: &egui::Context) {
    let frame = dialog_frame(app);
    let palette = app.palette;
    let Some(confirm) = app.overlay.confirm.as_ref() else { return };
    let mut yes = false;
    let mut no = false;
    let modal = egui::Modal::new(Id::unique("gitc-confirm")).frame(frame).show(ctx, |ui| {
        ui.set_width(420.0);
        ui.label(RichText::new(&confirm.title).size(15.0).color(palette.fg_bright).strong());
        ui.add_space(8.0);
        if !confirm.body.is_empty() {
            ui.label(RichText::new(&confirm.body).color(palette.fg));
        }
        ui.add_space(12.0);
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            let fill = if confirm.destructive { palette.red_line } else { palette.accent_line };
            let button = ui.add(egui::Button::new(&confirm.confirm_label).fill(fill));
            if button.clicked() {
                yes = true;
            }
            if ui.button("Cancel").clicked() {
                no = true;
            }
        });
        if ui.input(|i| i.key_pressed(Key::Enter)) {
            yes = true;
        }
    });
    if yes {
        if let Some(confirm) = app.overlay.confirm.take() {
            app.later.add(confirm.on_confirm);
        }
        return;
    }
    if no || modal.should_close() {
        app.overlay.confirm = None;
    }
}

fn show_choose(app: &mut App, ctx: &egui::Context) {
    let frame = dialog_frame(app);
    let palette = app.palette;
    let Some(choose) = app.overlay.choose.as_ref() else { return };
    let mut picked: Option<String> = None;
    let mut cancel = false;
    let modal = egui::Modal::new(Id::unique("gitc-choose")).frame(frame).show(ctx, |ui| {
        ui.set_width(420.0);
        ui.label(RichText::new(&choose.title).size(15.0).color(palette.fg_bright).strong());
        if !choose.body.is_empty() {
            ui.add_space(6.0);
            ui.label(RichText::new(&choose.body).color(palette.fg_dim));
        }
        ui.add_space(10.0);
        for option in &choose.options {
            let text = if option.hint.is_empty() {
                RichText::new(&option.label).color(palette.fg_bright)
            } else {
                RichText::new(format!("{}\n{}", option.label, option.hint)).color(palette.fg)
            };
            let button = egui::Button::new(text).min_size(Vec2::new(ui.available_width(), 32.0));
            if ui.add(button).clicked() {
                picked = Some(option.value.clone());
            }
            ui.add_space(4.0);
        }
        ui.add_space(6.0);
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if ui.button("Cancel").clicked() {
                cancel = true;
            }
        });
    });
    if let Some(value) = picked {
        if let Some(choose) = app.overlay.choose.take() {
            let pick = choose.on_pick;
            app.later.add(move |app| pick(app, value));
        }
        return;
    }
    if cancel || modal.should_close() {
        app.overlay.choose = None;
    }
}

fn show_form(app: &mut App, ctx: &egui::Context) {
    let frame = dialog_frame(app);
    let palette = app.palette;
    let Some((form, values)) = app.overlay.form.as_mut() else { return };
    let mut submit = false;
    let mut cancel = false;
    let modal = egui::Modal::new(Id::unique("gitc-form")).frame(frame).show(ctx, |ui| {
        ui.set_width(420.0);
        ui.label(RichText::new(&form.title).size(15.0).color(palette.fg_bright).strong());
        if !form.body.is_empty() {
            ui.add_space(6.0);
            ui.label(RichText::new(&form.body).color(palette.fg_dim));
        }
        ui.add_space(8.0);
        let mut valid = true;
        for field in &form.fields {
            let value = values.entry(field.key.clone()).or_default();
            ui.label(RichText::new(&field.label).color(palette.fg_dim));
            if field.options.is_empty() {
                let edit = egui::TextEdit::singleline(value)
                    .hint_text(&field.placeholder)
                    .password(field.secret)
                    .desired_width(f32::INFINITY);
                ui.add(edit);
            } else {
                let shown = field.options.iter().find(|(v, _)| v == value).map(|(_, l)| l.clone()).unwrap_or_default();
                egui::ComboBox::from_id_salt(("form-field", &field.key))
                    .selected_text(shown)
                    .width(ui.available_width())
                    .show_ui(ui, |ui| {
                        for (v, l) in &field.options {
                            ui.selectable_value(value, v.clone(), l);
                        }
                    });
            }
            let empty = value.trim().is_empty();
            if empty && !field.optional {
                valid = false;
            }
            if let Some(problem) = field.validate.as_ref().filter(|_| !empty).and_then(|v| v(value)) {
                ui.label(RichText::new(problem).color(palette.amber_fg));
                valid = false;
            }
            ui.add_space(6.0);
        }
        ui.add_space(6.0);
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if ui.add_enabled(valid, egui::Button::new(&form.confirm_label).fill(palette.accent_line)).clicked() {
                submit = true;
            }
            if ui.button("Cancel").clicked() {
                cancel = true;
            }
        });
        if valid && ui.input(|i| i.key_pressed(Key::Enter)) {
            submit = true;
        }
    });
    if submit {
        if let Some((form, values)) = app.overlay.form.take() {
            let values: BTreeMap<String, String> = values.into_iter().map(|(k, v)| (k, v.trim().to_string())).collect();
            let confirm = form.on_confirm;
            app.later.add(move |app| confirm(app, values));
        }
        return;
    }
    if cancel || modal.should_close() {
        app.overlay.form = None;
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ToastKind {
    Ok,
    Warn,
    Error,
}

pub struct Toast {
    pub id: u64,
    pub kind: ToastKind,
    pub title: String,
    pub detail: String,
    pub until: Option<Instant>,
}

#[derive(Default)]
pub struct Toasts {
    pub list: Vec<Toast>,
    next: u64,
}

impl Toasts {
    pub fn push(&mut self, kind: ToastKind, message: &str) {
        let (title, detail) = match message.split_once('\n') {
            Some((t, d)) => (t.trim().to_string(), d.trim().to_string()),
            None => (message.trim().to_string(), String::new()),
        };
        if title.is_empty() {
            return;
        }
        self.list.retain(|t| !(t.title == title && t.detail == detail));
        let life = match kind {
            ToastKind::Ok => Some(Duration::from_secs(5)),
            ToastKind::Warn => Some(Duration::from_secs(12)),
            ToastKind::Error => None,
        };
        self.next += 1;
        self.list.push(Toast { id: self.next, kind, title, detail, until: life.map(|d| Instant::now() + d) });
        while self.list.len() > 5 {
            self.list.remove(0);
        }
    }

    pub fn ok(&mut self, message: &str) {
        self.push(ToastKind::Ok, message);
    }

    pub fn warn(&mut self, message: &str) {
        self.push(ToastKind::Warn, message);
    }

    pub fn error(&mut self, message: &str) {
        self.push(ToastKind::Error, message);
    }
}

pub fn show_toasts(app: &mut App, ctx: &egui::Context) {
    let now = Instant::now();
    app.toasts.list.retain(|t| t.until.is_none_or(|u| u > now));
    if app.toasts.list.is_empty() {
        return;
    }
    if let Some(next) = app.toasts.list.iter().filter_map(|t| t.until).min() {
        ctx.request_repaint_after(next.saturating_duration_since(now));
    }
    let palette = app.palette;
    let mut dismiss: Option<u64> = None;
    let mut hold: Option<u64> = None;
    egui::Area::new(Id::unique("gitc-toasts"))
        .order(egui::Order::Tooltip)
        .anchor(Align2::RIGHT_BOTTOM, Vec2::new(-14.0, -34.0))
        .show(ctx, |ui| {
            ui.set_max_width(380.0);
            for toast in &app.toasts.list {
                let (accent, icon, bg) = match toast.kind {
                    ToastKind::Ok => (palette.green, "check", palette.green_bg),
                    ToastKind::Warn => (palette.amber, "warning", palette.amber_bg),
                    ToastKind::Error => (palette.red, "warning", palette.red_bg),
                };
                let response = egui::Frame::new()
                    .fill(blend(palette.bg_2, bg))
                    .stroke(egui::Stroke::new(1.0, accent))
                    .corner_radius(5.0)
                    .inner_margin(10.0)
                    .show(ui, |ui| {
                        ui.set_width(360.0);
                        ui.horizontal(|ui| {
                            icons::show(ui, icon, 14.0, accent);
                            ui.add(egui::Label::new(RichText::new(&toast.title).color(palette.fg_bright)).wrap());
                            ui.with_layout(egui::Layout::right_to_left(egui::Align::Min), |ui| {
                                if icons::button(ui, "close", 10.0, "").clicked() {
                                    dismiss = Some(toast.id);
                                }
                            });
                        });
                        if !toast.detail.is_empty() {
                            ui.add(
                                egui::Label::new(RichText::new(&toast.detail).color(palette.fg_dim).size(12.0)).wrap(),
                            );
                        }
                    })
                    .response
                    .interact(egui::Sense::click());
                if response.hovered() {
                    hold = Some(toast.id);
                }
                if response.clicked() {
                    ctx.copy_text(format!("{}\n{}", toast.title, toast.detail).trim().to_string());
                }
                ui.add_space(6.0);
            }
        });
    if let Some(id) = hold {
        if let Some(t) = app.toasts.list.iter_mut().find(|t| t.id == id) {
            if t.until.is_some() {
                t.until = Some(Instant::now() + Duration::from_secs(4));
            }
        }
    }
    if let Some(id) = dismiss {
        app.toasts.list.retain(|t| t.id != id);
    }
}

fn blend(base: Color32, over: Color32) -> Color32 {
    let mix = |a: u8, b: u8| ((a as u16 + b as u16 * 3) / 4) as u8;
    Color32::from_rgb(mix(base.r(), over.r()), mix(base.g(), over.g()), mix(base.b(), over.b()))
}
