use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const SETTINGS_FILE: &str = "settings.json";
const SETUP_MARKER: &str = "run-setup";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub clips_directory: PathBuf,
    #[serde(default)]
    pub extra_clip_directories: Vec<PathBuf>,
    #[serde(default = "default_screenshots_dir")]
    pub screenshots_directory: PathBuf,
    pub overlay_shortcut: String,
    #[serde(default = "default_panel_shortcut")]
    pub panel_shortcut: String,
    pub theme: String,
    #[serde(default)]
    pub startup_with_windows: bool,
    #[serde(default)]
    pub setup_complete: bool,
    #[serde(default = "default_true")]
    pub mic_hotkeys: bool,
    #[serde(default = "default_true")]
    pub recorder_controls: bool,
    #[serde(default = "default_true")]
    pub screenshots_from_clip_folders: bool,
    #[serde(default = "default_recorder")]
    pub recorder: String,
    #[serde(default)]
    pub recorder_hotkeys: RecorderHotkeys,
    #[serde(default)]
    pub ui: UiSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct UiSettings {
    pub accent: String,
    pub scale: f32,
    pub dim: f32,
    pub animations: bool,
    pub gallery_size: String,
    pub panel_side: String,
    pub panel_width: u32,
    pub density: String,
    pub hover_preview: bool,
    pub autoplay: bool,
    pub confirm_delete: bool,
    pub new_badges: bool,
    pub group_by_day: bool,
    pub show_covers: bool,
    pub click_outside_closes: bool,
    pub tray_opens: String,
    pub start_tab: String,
}

impl Default for UiSettings {
    fn default() -> Self {
        Self {
            accent: "#76b900".into(),
            scale: 1.0,
            dim: 0.72,
            animations: true,
            gallery_size: "comfortable".into(),
            panel_side: "left".into(),
            panel_width: 460,
            density: "m".into(),
            hover_preview: true,
            autoplay: true,
            confirm_delete: true,
            new_badges: true,
            group_by_day: true,
            show_covers: true,
            click_outside_closes: true,
            tray_opens: "gallery".into(),
            start_tab: "remember".into(),
        }
    }
}

impl UiSettings {
    pub fn sanitize(&mut self) {
        let d = UiSettings::default();
        let pick = |v: &mut String, allowed: &[&str], fallback: &str| {
            if !allowed.contains(&v.as_str()) {
                *v = fallback.to_string();
            }
        };
        let hex = self.accent.trim_start_matches('#');
        if hex.len() != 6 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
            self.accent = d.accent.clone();
        } else {
            self.accent = format!("#{}", hex.to_ascii_lowercase());
        }
        self.scale = if self.scale.is_finite() { self.scale.clamp(0.8, 1.4) } else { 1.0 };
        self.dim = if self.dim.is_finite() { self.dim.clamp(0.0, 0.95) } else { d.dim };
        self.panel_width = self.panel_width.clamp(340, 760);
        pick(&mut self.gallery_size, &["comfortable", "large", "full"], &d.gallery_size);
        pick(&mut self.panel_side, &["left", "right"], &d.panel_side);
        pick(&mut self.density, &["s", "m", "l"], &d.density);
        pick(&mut self.tray_opens, &["gallery", "panel"], &d.tray_opens);
        pick(&mut self.start_tab, &["remember", "clips", "screenshots"], &d.start_tab);
    }
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            clips_directory: default_clips_dir(),
            extra_clip_directories: Vec::new(),
            screenshots_directory: default_screenshots_dir(),
            overlay_shortcut: "Ctrl+Alt+P".to_string(),
            panel_shortcut: default_panel_shortcut(),
            theme: "dark".to_string(),
            startup_with_windows: true,
            setup_complete: false,
            mic_hotkeys: false,
            recorder_controls: true,
            screenshots_from_clip_folders: true,
            recorder: default_recorder(),
            recorder_hotkeys: RecorderHotkeys::default(),
            ui: UiSettings::default(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct HotkeySet {
    pub save_replay: String,
    pub record: String,
    pub screenshot: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RecorderHotkeys {
    pub nvidia: HotkeySet,
    pub medal: HotkeySet,
}

impl Default for RecorderHotkeys {
    fn default() -> Self {
        Self {
            nvidia: HotkeySet {
                save_replay: "Alt+F10".into(),
                record: "Alt+F9".into(),
                screenshot: "Alt+F1".into(),
            },
            medal: HotkeySet {
                save_replay: "F8".into(),
                ..HotkeySet::default()
            },
        }
    }
}

pub const RECORDERS: &[&str] = &["auto", "amd", "gamebar", "obs", "nvidia", "medal"];

impl AppSettings {
    pub fn sanitize(&mut self) {
        if self.theme != "dark" && self.theme != "black" {
            self.theme = "dark".into();
        }
        if !RECORDERS.contains(&self.recorder.as_str()) {
            self.recorder = default_recorder();
        }
        self.ui.sanitize();
    }
}

fn default_true() -> bool {
    true
}

fn default_recorder() -> String {
    "auto".into()
}

fn default_panel_shortcut() -> String {
    "Ctrl+P".to_string()
}

fn user_profile() -> PathBuf {
    std::env::var("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("C:\\Users\\Public"))
}

fn default_clips_dir() -> PathBuf {
    user_profile().join("Videos").join("Captures")
}

fn default_screenshots_dir() -> PathBuf {
    user_profile().join("Pictures").join("Screenshots")
}

pub fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?;
    Ok(dir.join(SETTINGS_FILE))
}

pub fn settings_exist(app: &AppHandle) -> bool {
    settings_path(app).is_ok_and(|p| p.is_file())
}

pub fn load_settings(app: &AppHandle) -> AppSettings {
    let path = match settings_path(app) {
        Ok(p) => p,
        Err(_) => return AppSettings::default(),
    };
    let Some(value) = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
    else {
        return AppSettings::default();
    };
    let legacy = value.get("screenshotsDirectory").is_none();
    let mut settings: AppSettings = serde_json::from_value(value).unwrap_or_default();
    if legacy {
        settings.overlay_shortcut = AppSettings::default().overlay_shortcut;
    }
    settings.sanitize();
    settings
}

pub fn save_settings(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(SETTINGS_FILE);
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{SETTINGS_FILE}.tmp"));
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn setup_marker(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(SETUP_MARKER))
}

pub fn setup_requested_by_installer(app: &AppHandle) -> bool {
    setup_marker(app).is_some_and(|p| p.exists())
}

pub fn clear_setup_marker(app: &AppHandle) {
    if let Some(p) = setup_marker(app) {
        let _ = std::fs::remove_file(p);
    }
}
