use base64::Engine as _;
use eframe::egui::{self, Align2, Color32, ColorImage, FontId, Rect, TextureHandle, Ui, Vec2};

use crate::engine::api::{self, Request};
use crate::engine::types::Media;
use crate::ui::theme::Palette;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MediaKind {
    Image,
    Video,
    Audio,
}

/// One side of a media change, as the diff view holds it.
pub struct Pane {
    pub side: &'static str,
    pub label: &'static str,
    pub state: PaneState,
}

pub enum PaneState {
    Loading,
    Failed(String),
    /// `texture` is None for media egui cannot draw, or bytes that do not decode as their name says.
    Ready {
        texture: Option<TextureHandle>,
        size: [usize; 2],
        bytes: usize,
    },
}

/// What a blocking media read hands back to the UI thread.
pub struct Decoded {
    pub bytes: usize,
    pub image: Option<ColorImage>,
}

/// What a file previews as, decided by its name only and never by its contents.
pub fn media_for(path: &str) -> Option<MediaKind> {
    let ext = extension(path)?;
    Some(match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "avif" | "bmp" | "ico" => MediaKind::Image,
        "mp4" | "m4v" | "mov" | "webm" | "ogv" => MediaKind::Video,
        "mp3" | "wav" | "ogg" | "oga" | "opus" | "flac" | "m4a" | "aac" => MediaKind::Audio,
        _ => return None,
    })
}

/// The sides of a change there are to show: an added file has no before, a deleted one no after.
pub fn media_sides(status: &str) -> &'static [&'static str] {
    match status {
        "A" => &["new"],
        "D" => &["old"],
        _ => &["old", "new"],
    }
}

pub fn panes(status: &str) -> Vec<Pane> {
    let sides = media_sides(status);
    sides
        .iter()
        .map(|&side| {
            let label = match (sides.len(), side) {
                (1, "old") => "Deleted",
                (1, _) => "Added",
                (_, "old") => "Before",
                _ => "After",
            };
            Pane { side, label, state: PaneState::Loading }
        })
        .collect()
}

/// Reads one side's bytes and, for an image, decodes it as the format its name says. Blocking.
pub fn load(req: Request, path: &str) -> Result<Decoded, String> {
    let media: Media = api::call(req)?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(media.data).map_err(|e| e.to_string())?;
    let format = extension(path).and_then(image::ImageFormat::from_extension);
    let image = format
        .filter(|_| media_for(path) == Some(MediaKind::Image))
        .and_then(|f| image::load_from_memory_with_format(&bytes, f).ok())
        .map(|img| {
            let rgba = img.to_rgba8();
            ColorImage::from_rgba_unmultiplied([rgba.width() as usize, rgba.height() as usize], rgba.as_raw())
        });
    Ok(Decoded { bytes: bytes.len(), image })
}

/// Before and after side by side, one pane for an added or deleted file.
pub fn show(ui: &mut Ui, panes: &[Pane], kind: MediaKind, p: &Palette) {
    let full = ui.available_rect_before_wrap();
    let full = Rect::from_min_size(full.min, Vec2::new(full.width(), full.height().max(240.0)));
    ui.allocate_rect(full, egui::Sense::hover());
    let count = panes.len().max(1) as f32;
    let width = (full.width() - (count - 1.0)) / count;
    let painter = ui.painter_at(full);
    painter.rect_filled(full, 0.0, p.line);
    for (i, pane) in panes.iter().enumerate() {
        let rect =
            Rect::from_min_size(full.min + Vec2::new(i as f32 * (width + 1.0), 0.0), Vec2::new(width, full.height()));
        painter.rect_filled(rect, 0.0, p.bg_0);
        let head = Rect::from_min_size(rect.min, Vec2::new(width, 26.0));
        painter.line_segment([head.left_bottom(), head.right_bottom()], (1.0, p.line));
        let (bg, fg) = if pane.side == "old" { (p.red_bg, p.red_fg) } else { (p.green_bg, p.green_fg) };
        let label = painter.layout_no_wrap(pane.label.to_uppercase(), FontId::proportional(10.0), fg);
        let chip = Rect::from_min_size(head.min + Vec2::new(10.0, 5.0), label.size() + Vec2::new(12.0, 4.0));
        painter.rect_filled(chip, 3.0, bg);
        painter.galley(chip.min + Vec2::new(6.0, 2.0), label, fg);
        let stage = Rect::from_min_max(head.left_bottom(), rect.max).shrink(16.0);
        let note = |text: String| {
            painter.text(stage.center(), Align2::CENTER_CENTER, text, FontId::proportional(12.0), p.fg_muted);
        };
        let meta = |text: String| {
            painter.text(
                chip.right_center() + Vec2::new(8.0, 0.0),
                Align2::LEFT_CENTER,
                text,
                FontId::proportional(11.0),
                p.fg_muted,
            );
        };
        match &pane.state {
            PaneState::Loading => note("Loading...".into()),
            PaneState::Failed(e) => note(e.clone()),
            PaneState::Ready { texture: Some(texture), size, bytes } => {
                meta(format!("{} x {}, {}", size[0], size[1], format_bytes(*bytes)));
                let natural = Vec2::new(size[0] as f32, size[1] as f32);
                let scale = (stage.width() / natural.x).min(stage.height() / natural.y).min(1.0);
                let shown = Rect::from_center_size(stage.center(), natural * scale);
                painter.rect_filled(shown, 0.0, p.bg_2);
                painter.image(
                    texture.id(),
                    shown,
                    Rect::from_min_max(egui::pos2(0.0, 0.0), egui::pos2(1.0, 1.0)),
                    Color32::WHITE,
                );
            }
            PaneState::Ready { texture: None, bytes, .. } => {
                meta(format_bytes(*bytes));
                note(match kind {
                    MediaKind::Image => "This file could not be shown - it may not be the format its name says.".into(),
                    MediaKind::Video => "Video cannot be previewed here.".into(),
                    MediaKind::Audio => "Audio cannot be previewed here.".into(),
                });
            }
        }
    }
}

/// A byte count as somebody would say it.
pub fn format_bytes(n: usize) -> String {
    let n = n as f64;
    if n < 1024.0 {
        return format!("{n} B");
    }
    if n < 1024.0 * 1024.0 {
        return format!("{:.1} KB", n / 1024.0);
    }
    format!("{:.1} MB", n / (1024.0 * 1024.0))
}

/// A repository file's absolute path, with backslashes when the repository's own path has them.
pub fn absolute_path(repo: &str, file: &str) -> String {
    let windows = repo.contains('\\');
    let root = repo.strip_suffix(['/', '\\']).unwrap_or(repo);
    if windows {
        return format!("{root}\\{}", file.replace('/', "\\"));
    }
    format!("{root}/{file}")
}

fn extension(path: &str) -> Option<String> {
    let name = path.rsplit('/').next().unwrap_or(path);
    let dot = name.rfind('.')?;
    if dot == 0 {
        return None;
    }
    name.get(dot + 1..).map(|e| e.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn previews_by_name() {
        assert_eq!(media_for("icons/app.png"), Some(MediaKind::Image));
        assert_eq!(media_for("SHOT.JPG"), Some(MediaKind::Image));
        assert_eq!(media_for("docs/demo.webm"), Some(MediaKind::Video));
        assert_eq!(media_for("a/b/c.mp3"), Some(MediaKind::Audio));
        assert_eq!(media_for("logo.svg"), None);
        assert_eq!(media_for("src/main.ts"), None);
        assert_eq!(media_for("Makefile"), None);
        assert_eq!(media_for(".png"), None);
        assert_eq!(media_for("v1.png/readme"), None);
        assert_eq!(media_for("shot.png.txt"), None);
    }

    #[test]
    fn sides() {
        assert_eq!(media_sides("A"), &["new"]);
        assert_eq!(media_sides("D"), &["old"]);
        assert_eq!(media_sides("M"), &["old", "new"]);
        assert_eq!(media_sides("R"), &["old", "new"]);
    }

    #[test]
    fn bytes() {
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(1536), "1.5 KB");
        assert_eq!(format_bytes(5 * 1024 * 1024), "5.0 MB");
    }

    #[test]
    fn absolute_paths() {
        assert_eq!(absolute_path("C:\\Code\\gitc", "src/ui/a.png"), "C:\\Code\\gitc\\src\\ui\\a.png");
        assert_eq!(absolute_path("/home/a/repo", "src/a.png"), "/home/a/repo/src/a.png");
        assert_eq!(absolute_path("/home/a/repo/", "x"), "/home/a/repo/x");
    }
}
