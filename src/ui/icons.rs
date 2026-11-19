use eframe::egui::{self, Color32, Rect, Response, Sense, Ui, Vec2};

use super::icon_data::svg;

/// One of the 24x24 stroked icons, tinted. Names are the TS IconName values ("fetch", "chevronRight", ...).
pub fn image(name: &str, size: f32, color: Color32) -> egui::Image<'static> {
    let bytes: &'static [u8] = svg(name).unwrap_or("").as_bytes();
    egui::Image::from_bytes(format!("bytes://icon/{name}.svg"), bytes).fit_to_exact_size(Vec2::splat(size)).tint(color)
}

pub fn show(ui: &mut Ui, name: &str, size: f32, color: Color32) -> Response {
    ui.add(image(name, size, color))
}

pub fn paint(ui: &Ui, rect: Rect, name: &str, color: Color32) {
    image(name, rect.width().min(rect.height()), color).paint_at(ui, rect);
}

/// A flat icon button: no frame until hovered.
pub fn button(ui: &mut Ui, name: &str, size: f32, tooltip: &str) -> Response {
    let pad = 4.0;
    let (rect, response) = ui.allocate_exact_size(Vec2::splat(size + pad * 2.0), Sense::click());
    let visuals = ui.style().interact(&response);
    if response.hovered() {
        ui.painter().rect_filled(rect, 3.0, visuals.weak_bg_fill);
    }
    let color = if ui.is_enabled() { visuals.fg_stroke.color } else { ui.visuals().weak_text_color() };
    paint(ui, rect.shrink(pad), name, color);
    if tooltip.is_empty() {
        return response;
    }
    response.on_hover_text(tooltip)
}
