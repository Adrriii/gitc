use std::sync::{Arc, Mutex, OnceLock};

use eframe::egui;
use serde::de::DeserializeOwned;

use super::App;
use crate::engine::api::{self, Request};

type Finish = Box<dyn FnMut(&mut App) -> bool>;

/// Work running on a background thread; its result is collected once, on the UI thread.
pub struct Task<T> {
    slot: Arc<Mutex<Option<T>>>,
}

impl<T: Send + 'static> Task<T> {
    pub fn spawn(work: impl FnOnce() -> T + Send + 'static) -> Task<T> {
        let slot = Arc::new(Mutex::new(None));
        let out = slot.clone();
        std::thread::spawn(move || {
            let value = work();
            if let Ok(mut guard) = out.lock() {
                *guard = Some(value);
            }
            repaint();
        });
        Task { slot }
    }

    /// The result, the first time it is asked for after it arrives.
    pub fn take(&self) -> Option<T> {
        self.slot.lock().ok()?.take()
    }
}

/// Every background job in flight, each with what to do with its result.
#[derive(Default)]
pub struct Jobs {
    list: Vec<Finish>,
}

impl Jobs {
    /// Runs `work` off the UI thread, then `then` with its result on the UI thread.
    pub fn run<T: Send + 'static>(
        &mut self,
        work: impl FnOnce() -> T + Send + 'static,
        then: impl FnOnce(&mut App, T) + 'static,
    ) {
        let task = Task::spawn(work);
        let mut then = Some(then);
        self.list.push(Box::new(move |app| {
            let Some(value) = task.take() else { return false };
            if let Some(finish) = then.take() {
                finish(app, value);
            }
            true
        }));
    }

    /// Sends one engine request off the UI thread.
    pub fn request<T: DeserializeOwned + Send + 'static>(
        &mut self,
        req: Request,
        then: impl FnOnce(&mut App, Result<T, String>) + 'static,
    ) {
        self.run(move || api::call::<T>(req), then);
    }

    /// Sends a request whose answer does not matter beyond reporting a failure.
    pub fn send(&mut self, req: Request) {
        self.request::<serde_json::Value>(req, |app, result| {
            if let Err(e) = result {
                app.toasts.error(&e);
            }
        });
    }

    pub fn is_empty(&self) -> bool {
        self.list.is_empty()
    }
}

/// Things to do to the app once the current frame's borrows are released.
#[derive(Default)]
pub struct Later {
    list: Vec<Box<dyn FnOnce(&mut App)>>,
}

impl Later {
    pub fn add(&mut self, action: impl FnOnce(&mut App) + 'static) {
        self.list.push(Box::new(action));
    }
}

pub fn finish_jobs(app: &mut App) {
    let mut pending = std::mem::take(&mut app.jobs.list);
    pending.retain_mut(|finish| !finish(app));
    pending.append(&mut app.jobs.list);
    app.jobs.list = pending;
}

pub fn run_later(app: &mut App) {
    for _ in 0..8 {
        let actions = std::mem::take(&mut app.later.list);
        if actions.is_empty() {
            return;
        }
        for action in actions {
            action(app);
        }
    }
}

static CONTEXT: OnceLock<egui::Context> = OnceLock::new();

pub fn set_context(ctx: &egui::Context) {
    let _ = CONTEXT.set(ctx.clone());
}

/// Asks for another frame, from any thread.
pub fn repaint() {
    if let Some(ctx) = CONTEXT.get() {
        ctx.request_repaint();
    }
}
