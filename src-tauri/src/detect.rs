
use crate::settings::AppSettings;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use walkdir::WalkDir;

const VIDEO_EXT: &[&str] = &["mp4", "mov", "mkv", "webm", "avi"];
const IMAGE_EXT: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "bmp"];
const COUNT_LIMIT: usize = 5000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderCandidate {
    pub path: String,
    pub label: String,
    pub count: usize,
    pub current: bool,
}

#[derive(Serialize)]
pub struct DetectedFolders {
    pub clips: Vec<FolderCandidate>,
    pub screenshots: Vec<FolderCandidate>,
}

fn count_files(dir: &Path, exts: &[&str]) -> usize {
    WalkDir::new(dir)
        .max_depth(4)
        .into_iter()
        .filter_entry(|e| {
            !(e.file_type().is_dir()
                && e.depth() > 0
                && e.file_name().to_string_lossy().eq_ignore_ascii_case("replay_cache"))
        })
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_type().is_file()
                && e.path()
                    .extension()
                    .and_then(|x| x.to_str())
                    .is_some_and(|x| exts.contains(&x.to_ascii_lowercase().as_str()))
        })
        .take(COUNT_LIMIT)
        .count()
}

#[cfg(windows)]
fn other_drives() -> Vec<PathBuf> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};
    const DRIVE_REMOVABLE: u32 = 2;
    const DRIVE_FIXED: u32 = 3;
    let mask = unsafe { GetLogicalDrives() };
    (0..26u8)
        .filter(|i| mask & (1 << i) != 0)
        .map(|i| (b'A' + i) as char)
        .filter(|&c| c != 'A' && c != 'B' && c != 'C')
        .filter_map(|c| {
            let root = format!("{c}:\\");
            let wide: Vec<u16> = root.encode_utf16().chain(Some(0)).collect();
            let kind = unsafe { GetDriveTypeW(PCWSTR(wide.as_ptr())) };
            (kind == DRIVE_FIXED || kind == DRIVE_REMOVABLE).then(|| PathBuf::from(root))
        })
        .collect()
}

#[cfg(not(windows))]
fn other_drives() -> Vec<PathBuf> {
    Vec::new()
}

struct Collector {
    seen: HashSet<String>,
    out: Vec<FolderCandidate>,
    exts: &'static [&'static str],
}

impl Collector {
    fn new(exts: &'static [&'static str]) -> Self {
        Self {
            seen: HashSet::new(),
            out: Vec::new(),
            exts,
        }
    }

    fn add(&mut self, path: PathBuf, label: &str, current: bool) {
        let key = path.to_string_lossy().trim_end_matches(['\\', '/']).to_lowercase();
        if !self.seen.insert(key) {
            return;
        }
        let exists = path.is_dir();
        let count = if exists { count_files(&path, self.exts) } else { 0 };
        if current || count > 0 {
            self.out.push(FolderCandidate {
                path: path.to_string_lossy().into_owned(),
                label: label.to_string(),
                count,
                current,
            });
        }
    }

    fn finish(mut self) -> Vec<FolderCandidate> {
        self.out.sort_by(|a, b| b.current.cmp(&a.current).then(b.count.cmp(&a.count)));
        self.out
    }
}

pub fn detect(app: &AppHandle, settings: &AppSettings) -> DetectedFolders {
    let p = app.path();
    let home = std::env::var("USERPROFILE").map(PathBuf::from).unwrap_or_default();
    let videos = p.video_dir().unwrap_or_else(|_| home.join("Videos"));
    let pictures = p.picture_dir().unwrap_or_else(|_| home.join("Pictures"));
    let documents = p.document_dir().unwrap_or_else(|_| home.join("Documents"));
    let desktop = p.desktop_dir().unwrap_or_else(|_| home.join("Desktop"));

    let mut clips = Collector::new(VIDEO_EXT);
    if settings.setup_complete || crate::settings::settings_exist(app) {
        clips.add(settings.clips_directory.clone(), "Current clips folder", true);
        for extra in &settings.extra_clip_directories {
            clips.add(extra.clone(), "Current extra folder", true);
        }
    }
    clips.add(videos.join("Captures"), "Xbox Game Bar", false);
    clips.add(videos.join("Radeon ReLive"), "AMD ReLive / Adrenalin", false);
    clips.add(videos.join("NVIDIA"), "NVIDIA ShadowPlay / App", false);
    clips.add(videos.join("Medal"), "Medal", false);
    clips.add(PathBuf::from("C:\\Medal\\Clips"), "Medal", false);
    clips.add(videos.join("Overwolf").join("Outplayed"), "Outplayed", false);
    clips.add(desktop.join("Clips"), "Desktop clips folder", false);
    clips.add(videos.join("Clips"), "Clips", false);
    clips.add(videos.clone(), "Videos (OBS default)", false);
    for drive in other_drives() {
        for name in ["Clips", "Recordings", "Videos", "Captures"] {
            clips.add(drive.join(name), "Other drive", false);
        }
    }

    let mut shots = Collector::new(IMAGE_EXT);
    if settings.setup_complete || crate::settings::settings_exist(app) {
        shots.add(settings.screenshots_directory.clone(), "Current screenshots folder", true);
    }
    shots.add(pictures.join("Screenshots"), "Windows (Win+PrtSc)", false);
    shots.add(documents.join("ShareX").join("Screenshots"), "ShareX", false);
    shots.add(videos.join("Captures"), "Xbox Game Bar", false);
    if let Ok(od) = std::env::var("OneDrive") {
        shots.add(PathBuf::from(od).join("Pictures").join("Screenshots"), "OneDrive", false);
    }
    shots.add(pictures.join("Steam Screenshots"), "Steam", false);

    DetectedFolders {
        clips: clips.finish(),
        screenshots: shots.finish(),
    }
}
