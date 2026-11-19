use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::Duration;

use base64::Engine as _;
use eframe::egui::{self, Align2, Color32, ColorImage, FontId, Rect, TextureHandle, TextureId, TextureOptions, Ui};
use sha2::{Digest, Sha256};

use crate::engine::api::{self, Request};
use crate::engine::types::Media;

const SIZE: u32 = 64;
const WORKERS: usize = 4;

enum Slot {
    Pending,
    Face(TextureHandle),
    Initials,
}

struct Job {
    email: String,
    remote: bool,
    generation: u64,
    ctx: egui::Context,
}

static CACHE: LazyLock<Mutex<HashMap<String, Slot>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static ENABLED: AtomicBool = AtomicBool::new(true);
static GENERATION: AtomicU64 = AtomicU64::new(0);
static QUEUE: OnceLock<Mutex<Sender<Job>>> = OnceLock::new();

/// Draws an author's avatar into `rect`, as a circle: override, GitHub, Gravatar, then initials.
pub fn paint(ui: &Ui, rect: Rect, name: &str, email: &str) {
    let painter = ui.painter();
    let radius = rect.width().min(rect.height()) / 2.0;
    if let Some(texture) = face(ui.ctx(), email) {
        painter.circle_filled(rect.center(), radius, Color32::from_gray(40));
        egui::Image::new(egui::load::SizedTexture::new(texture, rect.size())).corner_radius(radius).paint_at(ui, rect);
        return;
    }
    painter.circle_filled(rect.center(), radius, tint(email, name));
    let size = (rect.height() * 0.4).round().max(8.0);
    painter.text(
        rect.center(),
        Align2::CENTER_CENTER,
        initials(name),
        FontId::proportional(size),
        Color32::from_rgba_unmultiplied(255, 255, 255, 235),
    );
}

/// `false` restricts avatars to local overrides and initials: nothing leaves the machine.
pub fn set_enabled(enabled: bool) {
    if ENABLED.swap(enabled, Ordering::Relaxed) == enabled {
        return;
    }
    GENERATION.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut cache) = CACHE.lock() {
        cache.clear();
    }
}

/// The author's own colour, from the address (else the name): hue only, fixed saturation and lightness.
pub fn tint(email: &str, name: &str) -> Color32 {
    let source = if email.trim().is_empty() { name } else { email };
    let key = source.trim().to_lowercase();
    let mut h: u32 = 0x811c_9dc5;
    for unit in key.encode_utf16() {
        h ^= u32::from(unit);
        h = h.wrapping_mul(16_777_619);
    }
    hsl((h % 360) as f32, 0.42, 0.34)
}

/// Two letters from a display name.
pub fn initials(name: &str) -> String {
    let mut parts = name.split_whitespace();
    let Some(first) = parts.next() else { return "?".into() };
    match parts.last() {
        Some(last) => first.chars().take(1).chain(last.chars().take(1)).collect::<String>().to_uppercase(),
        None => first.chars().take(2).collect::<String>().to_uppercase(),
    }
}

fn face(ctx: &egui::Context, email: &str) -> Option<TextureId> {
    let email = email.trim();
    if email.is_empty() {
        return None;
    }
    let mut cache = CACHE.lock().ok()?;
    match cache.get(email) {
        Some(Slot::Face(texture)) => return Some(texture.id()),
        Some(_) => return None,
        None => {}
    }
    cache.insert(email.to_string(), Slot::Pending);
    drop(cache);
    let job = Job {
        email: email.to_string(),
        remote: ENABLED.load(Ordering::Relaxed),
        generation: GENERATION.load(Ordering::Relaxed),
        ctx: ctx.clone(),
    };
    if let Ok(queue) = QUEUE.get_or_init(start_workers).lock() {
        let _ = queue.send(job);
    }
    None
}

fn start_workers() -> Mutex<Sender<Job>> {
    let (send, receive) = channel::<Job>();
    let receive = Arc::new(Mutex::new(receive));
    for _ in 0..WORKERS {
        let receive = receive.clone();
        std::thread::spawn(move || work(&receive));
    }
    Mutex::new(send)
}

fn work(receive: &Mutex<Receiver<Job>>) {
    loop {
        let Ok(job) = receive.lock().map_err(|_| ()).and_then(|r| r.recv().map_err(|_| ())) else { return };
        let image = fetch(&job.email, job.remote).and_then(|bytes| decode(&bytes));
        let slot = match image {
            Some(image) => {
                Slot::Face(job.ctx.load_texture(format!("avatar:{}", job.email), image, TextureOptions::LINEAR))
            }
            None => Slot::Initials,
        };
        if GENERATION.load(Ordering::Relaxed) != job.generation {
            continue;
        }
        if let Ok(mut cache) = CACHE.lock() {
            cache.insert(job.email, slot);
        }
        job.ctx.request_repaint();
    }
}

// ponytail: a network failure is cached like a 404, so an offline start keeps initials until restart.
fn fetch(email: &str, remote: bool) -> Option<Vec<u8>> {
    let local = api::call::<Media>(Request::AvatarOverride { email: email.to_string() })
        .ok()
        .and_then(|m| base64::engine::general_purpose::STANDARD.decode(m.data).ok());
    if local.is_some() || !remote {
        return local;
    }
    if let Some(url) = github_url(email) {
        return get(&url);
    }
    get(&gravatar_url(email))
}

fn get(url: &str) -> Option<Vec<u8>> {
    static AGENT: LazyLock<ureq::Agent> =
        LazyLock::new(|| ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(10))).build().into());
    let mut response = AGENT.get(url).call().ok()?;
    response.body_mut().with_config().limit(4 << 20).read_to_vec().ok()
}

fn github_url(email: &str) -> Option<String> {
    let lower = email.to_lowercase();
    let local = lower.strip_suffix("@users.noreply.github.com")?;
    if let Some((id, _)) =
        local.split_once('+').filter(|(id, _)| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()))
    {
        return Some(format!("https://avatars.githubusercontent.com/u/{id}?s={SIZE}"));
    }
    (!local.is_empty()).then(|| format!("https://github.com/{local}.png?size={SIZE}"))
}

fn gravatar_url(email: &str) -> String {
    let digest = Sha256::digest(email.trim().to_lowercase().as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("https://gravatar.com/avatar/{hex}?d=404&s={SIZE}")
}

fn decode(bytes: &[u8]) -> Option<ColorImage> {
    let image = image::load_from_memory(bytes).ok()?;
    let image = image.resize_to_fill(SIZE, SIZE, image::imageops::FilterType::Triangle).into_rgba8();
    let size = [image.width() as usize, image.height() as usize];
    Some(ColorImage::from_rgba_unmultiplied(size, image.as_raw()))
}

fn hsl(hue: f32, s: f32, l: f32) -> Color32 {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let x = c * (1.0 - ((hue / 60.0) % 2.0 - 1.0).abs());
    let m = l - c / 2.0;
    let (r, g, b) = match hue as u32 / 60 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let byte = |v: f32| ((v + m) * 255.0).round().clamp(0.0, 255.0) as u8;
    Color32::from_rgb(byte(r), byte(g), byte(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initials_from_names() {
        assert_eq!(initials("Adrien Boitelle"), "AB");
        assert_eq!(initials("  ada  "), "AD");
        assert_eq!(initials("Jean Luc Picard"), "JP");
        assert_eq!(initials(""), "?");
    }

    #[test]
    fn github_noreply_names_the_account() {
        assert_eq!(
            github_url("12345+octo@users.noreply.github.com").as_deref(),
            Some("https://avatars.githubusercontent.com/u/12345?s=64")
        );
        assert_eq!(github_url("octo@users.noreply.github.com").as_deref(), Some("https://github.com/octo.png?size=64"));
        assert_eq!(github_url("someone@example.com"), None);
    }

    #[test]
    fn tint_is_stable_and_keyed_on_email() {
        assert_eq!(tint("a@b.c", "Ann"), tint("A@B.C ", "Other"));
        assert_eq!(hsl(0.0, 0.42, 0.34), Color32::from_rgb(123, 50, 50));
    }
}
