use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::engine::paths::config_dir;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub tab_size: usize,
    pub diff_wrap: bool,
    pub fetch_minutes: u64,
    pub fetch_on_focus: bool,
    pub branch_folders: bool,
    pub hidden_commands: Vec<String>,
    pub update_check_minutes: i64,
    pub update_channel: String,
    pub update_stream: String,
    /// "patch" | "minor" | "major": the smallest bump worth prompting for.
    pub update_level: String,
    pub remote_hold_minutes: u64,
    pub theme_preset: String,
    pub theme_overrides: BTreeMap<String, String>,
    pub avatars: bool,
    pub sidebar_width: f32,
    pub panel_width: f32,
    pub graph_width: Option<f32>,
    pub chips_width: f32,
}

impl Default for Settings {
    fn default() -> Self {
        let prerelease = crate::VERSION.contains('-');
        Settings {
            tab_size: 4,
            diff_wrap: true,
            fetch_minutes: 5,
            fetch_on_focus: true,
            branch_folders: true,
            hidden_commands: Vec::new(),
            update_check_minutes: 0,
            update_channel: if prerelease { "test".into() } else { "stable".into() },
            update_stream: String::new(),
            update_level: "patch".into(),
            remote_hold_minutes: 10,
            theme_preset: "midnight".into(),
            theme_overrides: BTreeMap::new(),
            avatars: true,
            sidebar_width: 208.0,
            panel_width: 400.0,
            graph_width: None,
            chips_width: 160.0,
        }
    }
}

pub const TAB_SIZES: [usize; 3] = [2, 4, 8];
pub const FETCH_INTERVALS: [u64; 4] = [0, 1, 5, 15];
pub const UPDATE_CHECKS: [(i64, &str); 5] =
    [(-1, "Never"), (0, "On launch"), (5, "Every 5 min"), (60, "Every hour"), (1440, "Every day")];
pub const REMOTE_HOLDS: [(u64, &str); 4] = [(1, "1 min"), (10, "10 min"), (60, "1 hour"), (0, "Always")];

impl Settings {
    pub fn load() -> Settings {
        let Ok(text) = std::fs::read_to_string(path()) else { return Settings::default() };
        serde_json::from_str(&text).unwrap_or_default()
    }

    pub fn exists() -> bool {
        path().exists()
    }

    pub fn save(&self) {
        let Ok(text) = serde_json::to_string_pretty(self) else { return };
        let target = path();
        if let Some(dir) = target.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let temp = target.with_extension("json.tmp");
        if std::fs::write(&temp, text).is_ok() {
            let _ = std::fs::rename(&temp, &target);
        }
    }
}

fn path() -> PathBuf {
    config_dir().join("settings.json")
}
