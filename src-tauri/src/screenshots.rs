use crate::clips::FileInfo;
use crate::fswatch::{ext_lower, file_stamp, stable_id, DirWatcher, Rescanner};
use crate::settings::AppSettings;
use crate::thumbs::ThumbService;
use once_cell::sync::{Lazy, OnceCell};
use parking_lot::RwLock;
use regex::Regex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

const IMAGE_EXT: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "bmp"];

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotEntry {
    pub id: String,
    pub path: String,
    pub file_name: String,
    pub month: String,
    pub captured_at_ms: Option<i64>,
    pub size_bytes: u64,
    pub extension: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotsPayload {
    pub generation: u64,
    pub screenshots: Option<Vec<ScreenshotEntry>>,
}

pub struct ScreenshotService {
    screenshots: RwLock<Vec<ScreenshotEntry>>,
    files: RwLock<HashMap<String, FileInfo>>,
    generation: AtomicU64,
    pub dirty: Arc<AtomicBool>,
    watcher: DirWatcher,
    rescanner: OnceCell<Rescanner>,
}

impl ScreenshotService {
    pub fn start(
        app: AppHandle,
        settings: Arc<RwLock<AppSettings>>,
        thumbs: Arc<ThumbService>,
        overlay_active: Arc<AtomicBool>,
    ) -> Arc<Self> {
        let svc = Arc::new(Self {
            screenshots: RwLock::new(Vec::new()),
            files: RwLock::new(HashMap::new()),
            generation: AtomicU64::new(1),
            dirty: Arc::new(AtomicBool::new(false)),
            watcher: DirWatcher::new(),
            rescanner: OnceCell::new(),
        });
        let worker = Arc::clone(&svc);
        let settings_w = Arc::clone(&settings);
        let rescanner = Rescanner::spawn("screenshots", move || {
            let roots = roots(&settings_w.read());
            worker.scan(&app, &roots, &thumbs);
        });
        let _ = svc.rescanner.set(rescanner.clone());
        let watched = watched_roots(&settings.read());
        svc.watcher
            .watch(&watched, true, is_relevant_change, &overlay_active, &svc.dirty, &rescanner);
        svc.request_rescan();
        svc
    }

    pub fn request_rescan(&self) {
        if let Some(r) = self.rescanner.get() {
            r.now();
        }
    }

    pub fn retarget(&self, settings: &AppSettings, overlay_active: Arc<AtomicBool>) {
        if let Some(r) = self.rescanner.get() {
            self.watcher
                .watch(&watched_roots(settings), true, is_relevant_change, &overlay_active, &self.dirty, r);
        }
        self.request_rescan();
    }

    pub fn snapshot(&self, since: Option<u64>) -> ScreenshotsPayload {
        let list = self.screenshots.read();
        let generation = self.generation.load(Ordering::SeqCst);
        ScreenshotsPayload {
            generation,
            screenshots: if since == Some(generation) {
                None
            } else {
                Some(list.clone())
            },
        }
    }

    pub fn file(&self, id: &str) -> Option<FileInfo> {
        self.files.read().get(id).cloned()
    }

    pub fn path_of(&self, id: &str) -> Option<PathBuf> {
        self.files.read().get(id).map(|f| f.path.clone())
    }

    pub fn forget(&self, app: &AppHandle, ids: &HashSet<String>) {
        {
            let mut list = self.screenshots.write();
            let before = list.len();
            list.retain(|s| !ids.contains(&s.id));
            if list.len() == before {
                return;
            }
            let mut files = self.files.write();
            for id in ids {
                files.remove(id);
            }
        }
        let g = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = app.emit("screenshots-updated", g);
    }

    fn scan(&self, app: &AppHandle, roots: &[PathBuf], thumbs: &ThumbService) {
        if let Some(main) = roots.first().filter(|r| !r.exists()) {
            let _ = std::fs::create_dir_all(main);
        }

        let mut next: Vec<ScreenshotEntry> = Vec::new();
        let mut files: HashMap<String, FileInfo> = HashMap::new();

        for root in roots.iter().filter(|r| r.is_dir()) {
            let walker = WalkDir::new(root)
                .max_depth(6)
                .into_iter()
                .filter_entry(|e| !(e.file_type().is_dir() && e.depth() > 0 && is_ignored_dir(e.file_name())));
            for entry in walker.filter_map(|e| e.ok()) {
                if !entry.file_type().is_file() {
                    continue;
                }
                let path = entry.path();
                let ext = ext_lower(path);
                if !IMAGE_EXT.contains(&ext.as_str()) {
                    continue;
                }
                let id = stable_id('s', path);
                if files.contains_key(&id) {
                    continue;
                }
                let Ok(meta) = entry.metadata() else { continue };
                let (size, mtime) = file_stamp(&meta);
                files.insert(
                    id.clone(),
                    FileInfo {
                        path: path.to_path_buf(),
                        size,
                        mtime_ms: mtime,
                    },
                );
                next.push(ScreenshotEntry {
                    id,
                    path: path.to_string_lossy().into_owned(),
                    file_name: path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("screenshot")
                        .to_string(),
                    month: month_of(path.strip_prefix(root).ok(), mtime),
                    captured_at_ms: (mtime > 0).then_some(mtime),
                    size_bytes: size,
                    extension: ext,
                });
            }
        }

        next.sort_by(|a, b| b.captured_at_ms.unwrap_or(0).cmp(&a.captured_at_ms.unwrap_or(0)));

        let changed = *self.screenshots.read() != next;
        if changed {
            let keep: Vec<_> = next
                .iter()
                .filter_map(|s| files.get(&s.id))
                .map(|f| (f.path.clone(), f.size, f.mtime_ms))
                .collect();
            *self.screenshots.write() = next;
            *self.files.write() = files;
            let g = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
            let _ = app.emit("screenshots-updated", g);
            thumbs.prewarm_and_prune('s', keep, true);
        }
    }
}

fn roots(s: &AppSettings) -> Vec<PathBuf> {
    let mut out = vec![s.screenshots_directory.clone()];
    if s.screenshots_from_clip_folders {
        for dir in std::iter::once(&s.clips_directory).chain(&s.extra_clip_directories) {
            if !out.contains(dir) {
                out.push(dir.clone());
            }
        }
    }
    out
}

fn watched_roots(s: &AppSettings) -> Vec<PathBuf> {
    let mut out = vec![s.screenshots_directory.clone()];
    if s.screenshots_from_clip_folders && s.clips_directory != s.screenshots_directory {
        out.push(s.clips_directory.clone());
    }
    out
}

fn is_ignored_dir(name: &std::ffi::OsStr) -> bool {
    let n = name.to_string_lossy();
    n.eq_ignore_ascii_case("thumb_cache") || n.eq_ignore_ascii_case("replay_cache") || n.starts_with('.')
}

fn is_relevant_change(path: &Path) -> bool {
    if path.components().any(|c| is_ignored_dir(c.as_os_str())) {
        return false;
    }
    let ext = ext_lower(path);
    ext.is_empty() || IMAGE_EXT.contains(&ext.as_str())
}

static MONTH_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\d{4}-\d{2}$").unwrap());

fn month_of(rel: Option<&Path>, mtime_ms: i64) -> String {
    let from_folder = rel.into_iter().flat_map(|r| r.components()).find_map(|c| match c {
        std::path::Component::Normal(name) => {
            let s = name.to_string_lossy();
            MONTH_RE.is_match(&s).then(|| s.into_owned())
        }
        _ => None,
    });
    from_folder
        .or_else(|| {
            chrono::DateTime::from_timestamp_millis(mtime_ms)
                .filter(|_| mtime_ms > 0)
                .map(|d| d.with_timezone(&chrono::Local).format("%Y-%m").to_string())
        })
        .unwrap_or_else(|| "Unknown".to_string())
}
