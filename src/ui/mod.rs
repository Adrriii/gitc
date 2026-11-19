pub mod actions;
pub mod avatar;
pub mod conflict_panel;
pub mod dialogs;
pub mod diff_view;
pub mod git_log;
pub mod graph;
pub mod icon_data;
pub mod icons;
pub mod legacy;
pub mod merge_editor;
pub mod panel;
pub mod preferences;
pub mod repo;
pub mod repo_picker;
pub mod settings;
pub mod sidebar;
pub mod tabbar;
pub mod task;
pub mod theme;
pub mod toolbar;
pub mod updating;
pub mod welcome;

use std::collections::HashMap;
use std::sync::Mutex;

use eframe::egui::{self, RichText};

use crate::engine::api::Request;
use crate::engine::types::{
    AiConfig, OpArgs, Opened, PushRefusal, RemoteState, Session, Tab, UpdateInfo, UpdateProgress,
};
use dialogs::{Overlay, Toasts};
use repo::Repo;
use settings::Settings;
use task::{Jobs, Later};
use theme::Palette;

pub struct App {
    pub ctx: egui::Context,
    pub session: Session,
    pub settings: Settings,
    pub palette: Palette,
    pub light: bool,
    pub repos: HashMap<String, Repo>,
    pub overlay: Overlay,
    pub toasts: Toasts,
    pub jobs: Jobs,
    pub later: Later,
    pub prefs_open: bool,
    pub prefs_section: String,
    pub log_open: bool,
    pub remotes: Vec<RemoteState>,
    pub ai: Option<AiConfig>,
    pub update: Option<UpdateInfo>,
    pub update_progress: Option<UpdateProgress>,
    pub updating: bool,
    pub push_refusal: Option<(PushRefusal, OpArgs)>,
    pub tabbar: tabbar::State,
    pub welcome: welcome::State,
    pub prefs: preferences::State,
    pub git_log: git_log::State,
    pub actions: actions::State,
    pub updates: updating::State,
    applied: Option<(Palette, bool)>,
    session_loaded: bool,
    last_active: Option<String>,
    window_state: Option<String>,
}

impl App {
    fn new(cc: &eframe::CreationContext<'_>, open: Option<String>) -> App {
        let ctx = cc.egui_ctx.clone();
        task::set_context(&ctx);
        egui_extras::install_image_loaders(&ctx);
        let settings = Settings::load();
        let (palette, light) = Palette::from_settings(&settings);
        let mut app = App {
            ctx,
            session: Session::default(),
            settings,
            palette,
            light,
            repos: HashMap::new(),
            overlay: Overlay::default(),
            toasts: Toasts::default(),
            jobs: Jobs::default(),
            later: Later::default(),
            prefs_open: false,
            prefs_section: "theme".into(),
            log_open: false,
            remotes: Vec::new(),
            ai: None,
            update: None,
            update_progress: None,
            updating: false,
            push_refusal: None,
            tabbar: tabbar::State::default(),
            welcome: welcome::State::default(),
            prefs: preferences::State::default(),
            git_log: git_log::State::default(),
            actions: actions::State::default(),
            updates: updating::State::default(),
            applied: None,
            session_loaded: false,
            last_active: None,
            window_state: cc.storage.and_then(|s| s.get_string(WINDOW_KEY)),
        };
        app.jobs.request(Request::Session, |app, result: Result<Session, String>| {
            app.session_loaded = true;
            match result {
                Ok(session) => app.set_session(session),
                Err(e) => app.toasts.error(&e),
            }
        });
        if let Some(path) = open {
            app.open(&path, "");
        }
        crate::engine::instance::listen(|path| {
            deliver(if path.is_empty() { "focus".to_string() } else { format!("open {path}") })
        });
        app
    }

    pub fn active_id(&self) -> Option<String> {
        self.session.active_id.clone().filter(|id| self.session.tabs.iter().any(|t| &t.id == id))
    }

    pub fn active_tab(&self) -> Option<&Tab> {
        let id = self.session.active_id.as_deref()?;
        self.session.tabs.iter().find(|t| t.id == id)
    }

    /// The repository state of the tab in front.
    pub fn repo(&mut self) -> Option<&mut Repo> {
        let id = self.active_id()?;
        self.repos.get_mut(&id)
    }

    /// Takes a session the engine answered with, keeping per-tab state for tabs still open.
    pub fn set_session(&mut self, session: Session) {
        self.repos.retain(|id, _| session.tabs.iter().any(|t| &t.id == id));
        for tab in &session.tabs {
            self.repos.entry(tab.id.clone()).or_insert_with(Repo::new);
        }
        self.session = session;
        let active = self.active_id();
        if active != self.last_active {
            self.overlay.tab_changed(active.as_deref());
            self.push_refusal = None;
            self.last_active = active;
        }
    }

    /// Opens a repository (on `host` when not empty) and brings its tab to the front.
    pub fn open(&mut self, path: &str, host: &str) {
        let req = Request::Open { path: path.to_string(), host: host.to_string(), want_id: None };
        self.jobs.request(req, |app, result: Result<Opened, String>| match result {
            Ok(opened) => {
                let id = opened.tab.id.clone();
                app.set_session(opened.session);
                app.activate(&id);
            }
            Err(e) => app.toasts.error(&e),
        });
    }

    pub fn activate(&mut self, id: &str) {
        self.session.active_id = Some(id.to_string());
        self.prefs_open = false;
        self.jobs.request(Request::Activate { id: id.to_string() }, |app, result: Result<Session, String>| {
            if let Ok(session) = result {
                app.set_session(session);
            }
        });
    }

    /// Persists the settings and re-derives everything that depends on them.
    pub fn save_settings(&mut self) {
        self.settings.save();
        let (palette, light) = Palette::from_settings(&self.settings);
        self.palette = palette;
        self.light = light;
    }

    fn apply_theme(&mut self) {
        if self.applied == Some((self.palette, self.light)) {
            return;
        }
        self.palette.apply(&self.ctx, self.light);
        self.applied = Some((self.palette, self.light));
    }

    fn take_messages(&mut self) {
        let messages = INBOX.lock().map(|mut m| std::mem::take(&mut *m)).unwrap_or_default();
        for message in messages {
            if let Some(path) = message.strip_prefix("open ") {
                self.open(path.trim(), "");
            }
            self.ctx.send_viewport_cmd(egui::ViewportCommand::Minimized(false));
            self.ctx.send_viewport_cmd(egui::ViewportCommand::Focus);
        }
    }

    fn body(&mut self, ui: &mut egui::Ui) {
        let Some(id) = self.active_id() else {
            if self.session_loaded {
                egui::CentralPanel::default().frame(self.floor()).show(ui, |ui| welcome::show(self, ui));
            }
            return;
        };
        repo::tick(self, &id);
        let Some(repo) = self.repos.get(&id) else { return };
        if repo.data.is_none() {
            let name = self.active_tab().map(|t| t.name.clone()).unwrap_or_default();
            let error = repo.error.clone();
            egui::CentralPanel::default()
                .frame(self.floor())
                .show(ui, |ui| loading(ui, &name, error.as_deref(), self.palette));
            return;
        }
        let resolving = repo.resolving();
        let merging = repo.merge_file.is_some() && repo.conflicts.is_some();
        let diffing = repo.open_file.is_some();

        egui::Panel::top("toolbar").frame(self.chrome()).show(ui, |ui| toolbar::show(self, ui));
        egui::Panel::bottom("status")
            .frame(self.chrome())
            .exact_size(24.0)
            .show(ui, |ui| toolbar::status_bar(self, ui));
        if self.log_open {
            egui::Panel::bottom("gitlog")
                .resizable(true)
                .default_size(220.0)
                .frame(self.chrome())
                .show(ui, |ui| git_log::show(self, ui));
        }
        if !resolving {
            let shown = egui::Panel::left("sidebar")
                .resizable(true)
                .default_size(self.settings.sidebar_width)
                .size_range(150.0..=480.0)
                .frame(self.chrome())
                .show(ui, |ui| sidebar::show(self, ui));
            self.settings.sidebar_width = shown.response.rect.width();
        }
        let shown = egui::Panel::right("panel")
            .resizable(true)
            .default_size(self.settings.panel_width)
            .size_range(260.0..=900.0)
            .frame(self.chrome())
            .show(ui, |ui| if resolving { conflict_panel::show(self, ui) } else { panel::show(self, ui) });
        self.settings.panel_width = shown.response.rect.width();
        egui::CentralPanel::default().frame(self.floor()).show(ui, |ui| {
            if merging {
                merge_editor::show(self, ui);
            } else if diffing {
                diff_view::show(self, ui);
            } else {
                graph::show(self, ui);
            }
        });
    }

    pub fn chrome(&self) -> egui::Frame {
        egui::Frame::new().fill(self.palette.bg_1).inner_margin(0.0)
    }

    pub fn floor(&self) -> egui::Frame {
        egui::Frame::new().fill(self.palette.bg_0).inner_margin(0.0)
    }
}

impl eframe::App for App {
    fn persist_egui_memory(&self) -> bool {
        false
    }

    fn save(&mut self, storage: &mut dyn eframe::Storage) {
        let saved: Option<egui_winit::WindowSettings> = eframe::get_value(storage, WINDOW_KEY);
        if saved.is_some_and(|w| w.inner_size_points().min_elem() > 0.0) {
            self.window_state = storage.get_string(WINDOW_KEY);
            return;
        }
        storage.set_string(WINDOW_KEY, self.window_state.clone().unwrap_or_default());
    }

    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        self.apply_theme();
        self.take_messages();
        task::finish_jobs(self);
        actions::frame(self, ui);

        egui::Panel::top("tabs").frame(self.chrome()).exact_size(34.0).show(ui, |ui| tabbar::show(self, ui));
        if self.prefs_open {
            egui::CentralPanel::default().frame(self.floor()).show(ui, |ui| preferences::show(self, ui));
        } else {
            self.body(ui);
        }

        let ctx = self.ctx.clone();
        dialogs::show(self, &ctx);
        updating::show(self, &ctx);
        dialogs::show_toasts(self, &ctx);
        task::run_later(self);
        if !self.jobs.is_empty() {
            ctx.request_repaint_after(std::time::Duration::from_millis(250));
        }
    }

    fn on_exit(&mut self, _gl: Option<&eframe::glow::Context>) {
        self.settings.save();
    }

    fn clear_color(&self, _visuals: &egui::Visuals) -> [f32; 4] {
        self.palette.bg_0.to_normalized_gamma_f32()
    }
}

static INBOX: Mutex<Vec<String>> = Mutex::new(Vec::new());
const WINDOW_KEY: &str = "window";

/// Hands the window a message from another gitc process: "open <path>" or "focus".
pub fn deliver(message: String) {
    if let Ok(mut inbox) = INBOX.lock() {
        inbox.push(message);
    }
    task::repaint();
}

/// Opens the window and runs until it is closed. `open` is a repository to open first.
pub fn run(open: Option<String>) {
    let mut viewport = egui::ViewportBuilder::default()
        .with_title("gitc")
        .with_inner_size([1600.0, 1000.0])
        .with_min_inner_size([800.0, 500.0])
        .with_maximized(true)
        .with_app_id("gitc");
    if let Some(icon) = window_icon() {
        viewport = viewport.with_icon(icon);
    }
    let options = eframe::NativeOptions {
        viewport,
        persistence_path: Some(crate::engine::paths::config_dir().join("window.ron")),
        ..Default::default()
    };
    let result = eframe::run_native("gitc", options, Box::new(move |cc| Ok(Box::new(App::new(cc, open)))));
    if let Err(e) = result {
        eprintln!("gitc could not open its window: {e}");
    }
}

fn window_icon() -> Option<egui::IconData> {
    let image = image::load_from_memory(include_bytes!("../../icons/gitc-256.png")).ok()?.into_rgba8();
    let (width, height) = image.dimensions();
    Some(egui::IconData { rgba: image.into_raw(), width, height })
}

fn loading(ui: &mut egui::Ui, name: &str, error: Option<&str>, palette: Palette) {
    ui.centered_and_justified(|ui| {
        let text = match error {
            Some(e) => RichText::new(format!("Could not read {name}\n{e}")).color(palette.red_fg),
            None => RichText::new(format!("Reading {name}...")).color(palette.fg_muted),
        };
        ui.label(text);
    });
}
