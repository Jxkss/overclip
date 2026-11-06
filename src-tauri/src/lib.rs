mod amd;
mod audio;
mod audio_icon;
mod clips;
mod detect;
mod gamebar;
mod fswatch;
mod migrate;
mod obs;
mod recorder;
mod settings;
mod screenshots;
mod single_instance;
mod thumbs;
mod win_hotkeys;
mod windows_util;

use clips::{ClipService, ClipsPayload};
use parking_lot::RwLock;
use screenshots::{ScreenshotService, ScreenshotsPayload};
use settings::{load_settings, save_settings, AppSettings};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::image::Image;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::window::Color;
use tauri::{AppHandle, Emitter, Manager, State};
use thumbs::ThumbService;

#[cfg(not(windows))]
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

struct AppState {
    settings: Arc<RwLock<AppSettings>>,
    clips: Arc<ClipService>,
    screenshots: Arc<ScreenshotService>,
    thumbs: Arc<ThumbService>,
    deafened: AtomicBool,
    overlay_active: Arc<AtomicBool>,
    panel_mode: AtomicBool,
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

fn with_overlay_unpinned_for(app: &AppHandle, action: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    let mut should_restore = false;
    if let Some(w) = app.get_webview_window("overlay") {
        let vis = w.is_visible().unwrap_or(false);
        let was_top = w.is_always_on_top().unwrap_or(false);
        if vis && was_top {
            let _ = w.set_always_on_top(false);
            should_restore = true;
        }
    }

    let res = action();

    if should_restore {
        let app = app.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(1200));
            if let Some(w) = app.get_webview_window("overlay") {
                if w.is_visible().unwrap_or(false) {
                    let _ = w.set_always_on_top(true);
                }
            }
        });
    }

    res
}

#[tauri::command]
async fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    Ok(state.settings.read().clone())
}

#[tauri::command]
async fn set_settings(app: AppHandle, state: State<'_, AppState>, settings: AppSettings) -> Result<(), String> {
    apply_settings(&app, &state, settings)
}

#[tauri::command]
async fn default_settings() -> Result<AppSettings, String> {
    Ok(AppSettings::default())
}

fn apply_settings(app: &AppHandle, state: &AppState, mut settings: AppSettings) -> Result<(), String> {
    settings.sanitize();
    for shortcut in [&settings.overlay_shortcut, &settings.panel_shortcut] {
        if win_hotkeys::parse_shortcut(shortcut).is_none() {
            return Err(format!("\"{shortcut}\" isn't a valid shortcut"));
        }
    }
    if win_hotkeys::parse_shortcut(&settings.overlay_shortcut) == win_hotkeys::parse_shortcut(&settings.panel_shortcut) {
        return Err("The gallery and side panel need different shortcuts".into());
    }
    let prev = state.settings.read().clone();
    *state.settings.write() = settings.clone();
    save_settings(app, &settings)?;
    if prev.clips_directory != settings.clips_directory {
        state.clips.retarget(&settings.clips_directory);
    }
    if prev.extra_clip_directories != settings.extra_clip_directories {
        state.clips.extras_changed();
    }
    if prev.screenshots_directory != settings.screenshots_directory
        || prev.screenshots_from_clip_folders != settings.screenshots_from_clip_folders
        || (settings.screenshots_from_clip_folders
            && (prev.clips_directory != settings.clips_directory
                || prev.extra_clip_directories != settings.extra_clip_directories))
    {
        state
            .screenshots
            .retarget(&settings, Arc::clone(&state.overlay_active));
    }
    if prev.overlay_shortcut != settings.overlay_shortcut || prev.panel_shortcut != settings.panel_shortcut {
        win_hotkeys::reload_overlay_hotkey();
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    if prev.startup_with_windows != settings.startup_with_windows && !cfg!(debug_assertions) {
        sync_autostart(app, settings.startup_with_windows)?;
    }
    if prev.ui.scale != settings.ui.scale {
        apply_zoom(app, settings.ui.scale);
    }
    let _ = app.emit("settings-changed", &settings);
    Ok(())
}

fn apply_zoom(app: &AppHandle, scale: f32) {
    for label in ["overlay", "setup"] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.set_zoom(scale as f64);
        }
    }
}

#[tauri::command]
async fn detect_media_folders(app: AppHandle, state: State<'_, AppState>) -> Result<detect::DetectedFolders, String> {
    let s = state.settings.read().clone();
    blocking(move || Ok(detect::detect(&app, &s))).await
}

#[tauri::command]
async fn open_setup(app: AppHandle) -> Result<(), String> {
    open_setup_window(&app);
    Ok(())
}

#[tauri::command]
async fn finish_setup(app: AppHandle, open_gallery: bool) -> Result<(), String> {
    mark_setup_done(&app);
    if let Some(w) = app.get_webview_window("setup") {
        let _ = w.close();
    }
    if open_gallery {
        show_overlay(&app, false)?;
    }
    Ok(())
}

#[tauri::command]
async fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only web links can be opened".into());
    }
    let _ = hide_overlay(&app);
    blocking(move || open::that(&url).map_err(|e| e.to_string())).await
}

fn mark_setup_done(app: &AppHandle) {
    settings::clear_setup_marker(app);
    let Some(st) = app.try_state::<AppState>() else { return };
    let snapshot = {
        let mut s = st.settings.write();
        if s.setup_complete {
            return;
        }
        s.setup_complete = true;
        s.clone()
    };
    let _ = save_settings(app, &snapshot);
    let _ = app.emit("settings-changed", &snapshot);
}

pub fn open_setup_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("setup") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    if app
        .try_state::<AppState>()
        .is_some_and(|st| st.overlay_active.load(Ordering::SeqCst))
    {
        let _ = hide_overlay(app);
    }
    let built = tauri::WebviewWindowBuilder::new(app, "setup", tauri::WebviewUrl::App("index.html#/setup".into()))
        .title("Overclip Setup")
        .inner_size(1000.0, 680.0)
        .min_inner_size(860.0, 600.0)
        .center()
        .decorations(false)
        .resizable(true)
        .focused(true)
        .background_color(Color(20, 20, 20, 255))
        .build();
    if let Ok(w) = built {
        if let Some(st) = app.try_state::<AppState>() {
            let _ = w.set_zoom(st.settings.read().ui.scale as f64);
        }
        let app2 = app.clone();
        w.on_window_event(move |e| {
            if let tauri::WindowEvent::Destroyed = e {
                mark_setup_done(&app2);
            }
        });
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn sync_autostart(app: &AppHandle, enable: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let autostart = app.autolaunch();
    if enable {
        autostart.enable().map_err(|e| e.to_string())?;
    } else {
        autostart.disable().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn get_clips(state: State<'_, AppState>, since: Option<u64>) -> Result<ClipsPayload, String> {
    Ok(state.clips.snapshot(since))
}

#[tauri::command]
async fn refresh_clips(state: State<'_, AppState>) -> Result<(), String> {
    state.clips.request_rescan();
    Ok(())
}

#[tauri::command]
async fn get_screenshots(state: State<'_, AppState>, since: Option<u64>) -> Result<ScreenshotsPayload, String> {
    Ok(state.screenshots.snapshot(since))
}

#[tauri::command]
async fn refresh_screenshots(state: State<'_, AppState>) -> Result<(), String> {
    state.screenshots.request_rescan();
    Ok(())
}

fn media_path(st: &AppState, id: &str) -> Option<PathBuf> {
    if id.starts_with('s') {
        st.screenshots.path_of(id)
    } else {
        st.clips.path_of(id)
    }
}

fn media_paths(st: &AppState, ids: &[String]) -> Vec<(String, PathBuf)> {
    let mut seen = HashSet::new();
    ids.iter()
        .filter(|id| seen.insert(id.as_str()))
        .filter_map(|id| media_path(st, id).map(|p| (id.clone(), p)))
        .collect()
}

#[tauri::command]
async fn get_media_path(state: State<'_, AppState>, id: String) -> Result<String, String> {
    media_path(&state, &id)
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| "File not found".into())
}

#[tauri::command]
async fn open_media(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    let path = media_path(&state, &id).ok_or("File not found")?;
    blocking(move || with_overlay_unpinned_for(&app, || open::that(&path).map_err(|e| e.to_string()))).await
}

#[tauri::command]
async fn reveal_media(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    let path = media_path(&state, &id).ok_or("File not found")?;
    blocking(move || {
        with_overlay_unpinned_for(&app, || windows_util::reveal_in_file_manager(&path.to_string_lossy()))
    })
    .await
}

#[tauri::command]
async fn open_media_folder(app: AppHandle, state: State<'_, AppState>, kind: String) -> Result<(), String> {
    let dir = {
        let s = state.settings.read();
        if kind == "screenshots" {
            s.screenshots_directory.clone()
        } else {
            s.clips_directory.clone()
        }
    };
    blocking(move || with_overlay_unpinned_for(&app, || open::that(&dir).map_err(|e| e.to_string()))).await
}

#[tauri::command]
async fn delete_media(app: AppHandle, state: State<'_, AppState>, ids: Vec<String>) -> Result<usize, String> {
    let targets = media_paths(&state, &ids);
    let paths: Vec<PathBuf> = targets.iter().map(|(_, p)| p.clone()).collect();
    let app2 = app.clone();
    blocking(move || with_overlay_unpinned_for(&app2, || windows_util::move_to_recycle_bin(&paths))).await?;

    let gone: HashSet<String> = targets
        .into_iter()
        .filter(|(_, p)| !p.exists())
        .map(|(id, _)| id)
        .collect();
    state.clips.forget(&app, &gone);
    state.screenshots.forget(&app, &gone);
    Ok(gone.len())
}

#[tauri::command]
async fn rename_media(app: AppHandle, state: State<'_, AppState>, id: String, new_name: String) -> Result<String, String> {
    let old = media_path(&state, &id).ok_or("File not found")?;
    let target = clips::rename_target(&old, &new_name)?;
    if target != old {
        std::fs::rename(&old, &target).map_err(|e| match e.kind() {
            std::io::ErrorKind::PermissionDenied => "File is in use (close the player first)".to_string(),
            _ => e.to_string(),
        })?;
    }
    let is_shot = id.starts_with('s');
    let gone: HashSet<String> = [id].into_iter().collect();
    if is_shot {
        state.screenshots.forget(&app, &gone);
        state.screenshots.request_rescan();
    } else {
        state.clips.forget(&app, &gone);
        state.clips.request_rescan();
    }
    Ok(fswatch::stable_id(if is_shot { 's' } else { 'c' }, &target))
}

#[tauri::command]
async fn copy_media_files(app: AppHandle, state: State<'_, AppState>, ids: Vec<String>) -> Result<usize, String> {
    let paths: Vec<PathBuf> = media_paths(&state, &ids).into_iter().map(|(_, p)| p).collect();
    let owner = app
        .get_webview_window("overlay")
        .and_then(|w| w.hwnd().ok())
        .map(|h| h.0 as isize)
        .unwrap_or(0);
    let n = paths.len();
    blocking(move || windows_util::copy_files_to_clipboard(owner, &paths)).await?;
    Ok(n)
}

#[tauri::command]
async fn clear_thumbnail_cache(state: State<'_, AppState>) -> Result<(), String> {
    let thumbs = Arc::clone(&state.thumbs);
    blocking(move || {
        thumbs.clear();
        Ok(())
    })
    .await
}

#[tauri::command]
async fn get_audio_state(state: State<'_, AppState>) -> Result<audio::AudioMixerState, String> {
    let d = state.deafened.load(Ordering::SeqCst);
    blocking(move || audio::get_mixer_state(d)).await
}

#[tauri::command]
async fn audio_set_master_volume(vol: f32) -> Result<(), String> {
    blocking(move || audio::set_master_volume(vol)).await
}

#[tauri::command]
async fn audio_set_master_mute(mute: bool) -> Result<(), String> {
    blocking(move || audio::set_master_mute(mute)).await
}

#[tauri::command]
async fn audio_set_session_volume(id: String, vol: f32) -> Result<(), String> {
    blocking(move || audio::set_session_volume(&id, vol)).await
}

#[tauri::command]
async fn audio_set_session_mute(id: String, mute: bool) -> Result<(), String> {
    blocking(move || audio::set_session_mute(&id, mute)).await
}

fn recorder_notify(app: &AppHandle) -> amd::Notify {
    let app = app.clone();
    Arc::new(move |_| {
        if let Some(st) = app.try_state::<AppState>() {
            let s = st.settings.read().clone();
            let _ = app.emit("recorder-changed", recorder::overview(&s));
        }
    })
}

#[tauri::command]
async fn recorder_status(state: State<'_, AppState>) -> Result<recorder::Overview, String> {
    let s = state.settings.read().clone();
    blocking(move || Ok(recorder::overview(&s))).await
}

#[tauri::command]
async fn recorder_action(app: AppHandle, state: State<'_, AppState>, action: String) -> Result<Option<String>, String> {
    let s = state.settings.read().clone();
    let overview = blocking({
        let s = s.clone();
        move || Ok(recorder::overview(&s))
    })
    .await?;
    let cur = overview.current.ok_or("No recorder was found on this PC.")?;
    if !cur.ready {
        return Err(cur.problem.unwrap_or_else(|| format!("{} isn't ready.", cur.name)));
    }
    let was_open = recorder::hide_overlay_first(&cur.id, &action, cur.recording)
        && state.overlay_active.load(Ordering::SeqCst);
    if was_open {
        hide_overlay(&app)?;
    }
    blocking(move || {
        if was_open {
            thread::sleep(Duration::from_millis(450));
        }
        recorder::run(&cur.id, &s, &action, cur.recording)
    })
    .await
}

#[tauri::command]
async fn recorder_set_replay(app: AppHandle, state: State<'_, AppState>, on: bool) -> Result<recorder::Overview, String> {
    let s = state.settings.read().clone();
    let notify = recorder_notify(&app);
    blocking(move || {
        let id = recorder::overview(&s).current.map(|c| c.id).ok_or("No recorder was found on this PC.")?;
        recorder::set_replay(&id, on, notify)?;
        Ok(recorder::overview(&s))
    })
    .await
}

#[tauri::command]
async fn amd_set_settings(app: AppHandle, settings: amd::RecorderSettings) -> Result<amd::AmdStatus, String> {
    let notify = recorder_notify(&app);
    blocking(move || amd::set_settings(notify, settings)).await
}

#[tauri::command]
async fn gamebar_set_settings(settings: gamebar::GameBarSettings) -> Result<gamebar::GameBarStatus, String> {
    blocking(move || gamebar::set_settings(settings)).await
}

#[tauri::command]
async fn obs_set_settings(settings: obs::ObsSettings) -> Result<obs::ObsStatus, String> {
    blocking(move || obs::set_settings(settings)).await
}

#[tauri::command]
async fn obs_enable_remote_control() -> Result<(), String> {
    blocking(obs::enable_remote_control).await
}

#[tauri::command]
fn overlay_show(app: AppHandle) -> Result<(), String> {
    show_overlay(&app, false)
}

#[tauri::command]
fn overlay_set_mode(state: State<'_, AppState>, panel: bool) {
    state.panel_mode.store(panel, Ordering::SeqCst);
}

#[tauri::command]
fn overlay_hide(app: AppHandle) -> Result<(), String> {
    hide_overlay(&app)
}

#[tauri::command]
fn overlay_toggle(app: AppHandle) -> Result<(), String> {
    toggle_overlay(&app, false)
}

fn apply_overlay_webview_transparency(app: &AppHandle) {
    if let Some(ww) = app.get_webview_window("overlay") {
        let wv = ww.as_ref();
        let _ = wv.window().set_background_color(None);
        let _ = wv.set_background_color(Some(Color(0, 0, 0, 0)));
    }
}

static OVERLAY_RECT: parking_lot::Mutex<Option<(i32, i32, i32, i32)>> = parking_lot::Mutex::new(None);

fn fit_overlay(w: &tauri::WebviewWindow) {
    let rect = windows_util::foreground_monitor_rect().or(*OVERLAY_RECT.lock());
    let Some((x, y, width, height)) = rect else { return };
    *OVERLAY_RECT.lock() = Some((x, y, width, height));
    apply_overlay_rect(w, (x, y, width, height));
}

fn apply_overlay_rect(w: &tauri::WebviewWindow, (x, y, width, height): (i32, i32, i32, i32)) {
    let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
    let _ = w.set_size(tauri::PhysicalSize::new(width.max(1) as u32, height.max(1) as u32));
}

fn watch_overlay_geometry(app: &AppHandle) {
    let Some(w) = app.get_webview_window("overlay") else { return };
    let app2 = app.clone();
    w.on_window_event(move |e| {
        if !matches!(e, tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_)) {
            return;
        }
        let active = app2
            .try_state::<AppState>()
            .is_some_and(|st| st.overlay_active.load(Ordering::SeqCst));
        let Some(rect) = *OVERLAY_RECT.lock() else { return };
        if !active {
            return;
        }
        let Some(w) = app2.get_webview_window("overlay") else { return };
        let (Ok(pos), Ok(size)) = (w.outer_position(), w.outer_size()) else { return };
        let off = (pos.x - rect.0).abs() > 1
            || (pos.y - rect.1).abs() > 1
            || (size.width as i32 - rect.2).abs() > 1
            || (size.height as i32 - rect.3).abs() > 1;
        if off {
            std::thread::spawn(move || apply_overlay_rect(&w, rect));
        }
    });
}

fn show_overlay(app: &AppHandle, panel: bool) -> Result<(), String> {
    let Some(st) = app.try_state::<AppState>() else {
        return Ok(());
    };
    st.overlay_active.store(true, Ordering::SeqCst);
    st.panel_mode.store(panel, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window("overlay") {
        apply_overlay_webview_transparency(app);
        fit_overlay(&w);
        let _ = w.show();
        let _ = w.set_always_on_top(true);
        let _ = w.set_focus();
        let _ = app.emit("overlay-open", serde_json::json!({ "panel": panel }));
    }
    st.clips.on_overlay_shown();
    let unwatched_shots = {
        let s = st.settings.read();
        s.screenshots_from_clip_folders && !s.extra_clip_directories.is_empty()
    };
    if st.screenshots.dirty.swap(false, Ordering::Relaxed) || unwatched_shots {
        st.screenshots.request_rescan();
    }
    Ok(())
}

fn hide_overlay(app: &AppHandle) -> Result<(), String> {
    if let Some(st) = app.try_state::<AppState>() {
        st.overlay_active.store(false, Ordering::SeqCst);
        st.clips.on_overlay_hidden();
    }
    let _ = app.emit("overlay-close", ());
    Ok(())
}

#[tauri::command]
fn overlay_finish_hide(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if state.overlay_active.load(Ordering::SeqCst) {
        return Ok(());
    }
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.hide();
    }
    Ok(())
}

fn toggle_overlay(app: &AppHandle, panel: bool) -> Result<(), String> {
    let Some(st) = app.try_state::<AppState>() else {
        return Ok(());
    };
    let active = st.overlay_active.load(Ordering::SeqCst);
    if active && st.panel_mode.load(Ordering::SeqCst) == panel {
        hide_overlay(app)
    } else {
        show_overlay(app, panel)
    }
}

fn register_shortcuts(app: &AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        win_hotkeys::spawn_hotkey_thread(app.clone());
    }

    #[cfg(not(windows))]
    {
        let gs = app.global_shortcut();
        gs.on_shortcut(
            Shortcut::new(
                Some(Modifiers::CONTROL | Modifiers::ALT),
                Code::KeyP,
            ),
            |app, _shortcut, e| {
                if e.state == ShortcutState::Pressed {
                    let _ = toggle_overlay(app, false);
                }
            },
        )
        .map_err(|e| e.to_string())?;

        gs.on_shortcut(
            Shortcut::new(
                Some(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SHIFT),
                Code::KeyU,
            ),
            |app, _shortcut, e| {
                if e.state == ShortcutState::Pressed {
                    let _ = (|| -> Result<(), String> {
                        let cur = audio::read_microphone_muted()?;
                        let next = !cur;
                        audio::set_microphone_mute(next)?;
                        let _ = app.emit("mic-state", next);
                        Ok(())
                    })();
                }
            },
        )
        .map_err(|e| e.to_string())?;

        gs.on_shortcut(
            Shortcut::new(
                Some(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SHIFT),
                Code::KeyH,
            ),
            |app, _shortcut, e| {
                if e.state == ShortcutState::Pressed {
                    if let Some(st) = app.try_state::<AppState>() {
                        let next = !st.deafened.load(Ordering::SeqCst);
                        st.deafened.store(next, Ordering::SeqCst);
                        let _ = audio::set_deafen(next);
                        let _ = app.emit("deafen-state", next);
                    }
                }
            },
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn tray_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, String> {
    let item = |id: &str, text: &str| MenuItem::with_id(app, id, text, true, None::<&str>).map_err(|e| e.to_string());
    let sep = || PredefinedMenuItem::separator(app).map_err(|e| e.to_string());
    Menu::with_items(
        app,
        &[
            &item("open", "Open gallery")?,
            &item("panel", "Open side panel")?,
            &sep()?,
            &item("settings", "Settings…")?,
            &item("setup", "Setup wizard…")?,
            &item("refresh", "Rescan folders")?,
            &sep()?,
            &item("quit", "Quit Overclip")?,
        ],
    )
    .map_err(|e| e.to_string())
}

fn on_menu(app: &AppHandle, e: MenuEvent) {
    if e.id() == "open" {
        let _ = show_overlay(app, false);
    } else if e.id() == "panel" {
        let _ = show_overlay(app, true);
    } else if e.id() == "setup" {
        open_setup_window(app);
    } else if e.id() == "settings" {
        let _ = show_overlay(app, false);
        let _ = app.emit("open-settings", ());
    } else if e.id() == "refresh" {
        if let Some(st) = app.try_state::<AppState>() {
            st.clips.request_rescan();
            st.screenshots.request_rescan();
        }
    } else if e.id() == "quit" {
        app.exit(0);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let wants_setup = std::env::args().any(|a| a == "--setup");
    if !single_instance::acquire() {
        single_instance::notify_running(if wants_setup {
            single_instance::Request::OpenSetup
        } else {
            single_instance::Request::ShowGallery
        });
        return;
    }
    migrate::from_jutil();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .register_asynchronous_uri_scheme_protocol("thumb", |ctx, request, responder| {
            let app = ctx.app_handle();
            let id = request.uri().path().trim_start_matches('/').to_string();
            let Some(st) = app.try_state::<AppState>() else {
                thumbs::respond_missing(responder);
                return;
            };
            let kind = if id.starts_with('s') { 's' } else { 'c' };
            let info = if kind == 's' {
                st.screenshots.file(&id)
            } else {
                st.clips.file(&id)
            };
            match info {
                Some(f) => st.thumbs.serve(kind, f.path, f.size, f.mtime_ms, responder),
                None => thumbs::respond_missing(responder),
            }
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let first_run = !settings::settings_exist(&handle);
            let settings = Arc::new(RwLock::new(load_settings(&handle)));
            let overlay_active = Arc::new(AtomicBool::new(false));
            let cache_dir = handle
                .path()
                .app_cache_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("overclip"));
            let _ = std::fs::create_dir_all(&cache_dir);
            let thumbs = ThumbService::start(cache_dir.clone());
            let clips = ClipService::start(
                handle.clone(),
                Arc::clone(&settings),
                Arc::clone(&thumbs),
                Arc::clone(&overlay_active),
                &cache_dir,
            );
            let shots = ScreenshotService::start(
                handle.clone(),
                Arc::clone(&settings),
                Arc::clone(&thumbs),
                Arc::clone(&overlay_active),
            );

            app.manage(AppState {
                settings: Arc::clone(&settings),
                clips,
                screenshots: shots,
                thumbs,
                deafened: AtomicBool::new(false),
                overlay_active,
                panel_mode: AtomicBool::new(false),
            });

            let menu = tray_menu(&handle)?;
            let icon_bytes: &[u8] = include_bytes!("../icons/icon.png");
            let icon = Image::from_bytes(icon_bytes).map_err(|e| e.to_string())?;

            let h = handle.clone();
            TrayIconBuilder::with_id("main")
                .icon(icon)
                .tooltip("Overclip")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(on_menu)
                .on_tray_icon_event(|tray, ev| {
                    use tauri::tray::TrayIconEvent;
                    if let TrayIconEvent::Click { button, .. } = ev {
                        use tauri::tray::MouseButton;
                        if button == MouseButton::Left {
                            let app = tray.app_handle();
                            let panel = app
                                .try_state::<AppState>()
                                .is_some_and(|st| st.settings.read().ui.tray_opens == "panel");
                            let _ = toggle_overlay(app, panel);
                        }
                    }
                })
                .build(&h)?;

            register_shortcuts(&handle)?;

            apply_overlay_webview_transparency(&handle);
            watch_overlay_geometry(&handle);
            apply_zoom(&handle, settings.read().ui.scale);

            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                use tauri_plugin_autostart::ManagerExt;
                if settings.read().startup_with_windows && !cfg!(debug_assertions) {
                    let _ = handle.autolaunch().enable();
                }
            }

            let setup_pending = !settings.read().setup_complete;
            let from_installer = settings::setup_requested_by_installer(&handle);
            if wants_setup || (setup_pending && (first_run || from_installer)) {
                open_setup_window(&handle);
            } else if from_installer {
                settings::clear_setup_marker(&handle);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_settings,
            get_clips,
            refresh_clips,
            get_screenshots,
            refresh_screenshots,
            get_media_path,
            open_media,
            reveal_media,
            open_media_folder,
            delete_media,
            rename_media,
            copy_media_files,
            clear_thumbnail_cache,
            get_audio_state,
            audio_set_master_volume,
            audio_set_master_mute,
            audio_set_session_volume,
            audio_set_session_mute,
            overlay_show,
            overlay_hide,
            overlay_finish_hide,
            overlay_toggle,
            overlay_set_mode,
            default_settings,
            detect_media_folders,
            open_setup,
            finish_setup,
            open_external,
            recorder_status,
            recorder_action,
            recorder_set_replay,
            amd_set_settings,
            gamebar_set_settings,
            obs_set_settings,
            obs_enable_remote_control,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
