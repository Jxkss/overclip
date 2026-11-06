use crate::fswatch::{ext_lower, file_stamp, stable_id, DirWatcher, Rescanner};
use crate::settings::AppSettings;
use crate::thumbs::ThumbService;
use chrono::{Local, NaiveDate, TimeZone};
use once_cell::sync::{Lazy, OnceCell};
use parking_lot::{Mutex, RwLock};
use regex::Regex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

const VIDEO_EXT: &[&str] = &["mp4", "mov", "mkv", "webm", "avi"];

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClipEntry {
    pub id: String,
    pub path: String,
    pub file_name: String,
    pub game_name: String,
    pub captured_at_ms: Option<i64>,
    pub duration_ms: Option<u64>,
    pub size_bytes: u64,
    pub extension: String,
    pub library: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipsPayload {
    pub generation: u64,
    pub clips: Option<Vec<ClipEntry>>,
    pub offline_roots: Vec<String>,
}

#[derive(Clone)]
pub struct FileInfo {
    pub path: PathBuf,
    pub size: u64,
    pub mtime_ms: i64,
}

type Stamp = (u64, i64);

pub struct ClipService {
    clips: RwLock<Vec<ClipEntry>>,
    files: RwLock<HashMap<String, FileInfo>>,
    generation: AtomicU64,
    probe_cache: Mutex<HashMap<PathBuf, (Stamp, Option<u64>)>>,
    probe_cache_file: PathBuf,
    pub dirty: Arc<AtomicBool>,
    offline: RwLock<Vec<String>>,
    watcher: DirWatcher,
    extra_watcher: DirWatcher,
    rescanner: OnceCell<Rescanner>,
    settings: Arc<RwLock<AppSettings>>,
    overlay_active: Arc<AtomicBool>,
}

impl ClipService {
    pub fn start(
        app: AppHandle,
        settings: Arc<RwLock<AppSettings>>,
        thumbs: Arc<ThumbService>,
        overlay_active: Arc<AtomicBool>,
        cache_dir: &Path,
    ) -> Arc<Self> {
        let probe_cache_file = cache_dir.join("clip-durations.json");
        let svc = Arc::new(Self {
            clips: RwLock::new(Vec::new()),
            files: RwLock::new(HashMap::new()),
            generation: AtomicU64::new(1),
            probe_cache: Mutex::new(load_probe_cache(&probe_cache_file)),
            probe_cache_file,
            dirty: Arc::new(AtomicBool::new(false)),
            offline: RwLock::new(Vec::new()),
            watcher: DirWatcher::new(),
            extra_watcher: DirWatcher::new(),
            rescanner: OnceCell::new(),
            settings: Arc::clone(&settings),
            overlay_active: Arc::clone(&overlay_active),
        });
        let worker = Arc::clone(&svc);
        let app_w = app.clone();
        let rescanner = Rescanner::spawn("clips", move || {
            worker.scan(&app_w, &thumbs);
        });
        let _ = svc.rescanner.set(rescanner.clone());
        let root = settings.read().clips_directory.clone();
        svc.watcher
            .watch(&[root], true, is_relevant_change, &overlay_active, &svc.dirty, &rescanner);
        svc.request_rescan();
        svc
    }

    fn roots(&self) -> (PathBuf, Vec<PathBuf>) {
        let s = self.settings.read();
        let main = s.clips_directory.clone();
        let norm = |p: &Path| p.to_string_lossy().trim_end_matches(['\\', '/']).to_lowercase();
        let mut seen = vec![norm(&main)];
        let extras = s
            .extra_clip_directories
            .iter()
            .filter(|p| !p.as_os_str().is_empty())
            .filter(|p| {
                let key = norm(p);
                if seen.contains(&key) {
                    false
                } else {
                    seen.push(key);
                    true
                }
            })
            .cloned()
            .collect();
        (main, extras)
    }

    fn watch_extras(&self) {
        if let Some(r) = self.rescanner.get() {
            let (_, extras) = self.roots();
            self.extra_watcher
                .watch(&extras, false, is_relevant_change, &self.overlay_active, &self.dirty, r);
        }
    }

    pub fn on_overlay_shown(&self) {
        self.watch_extras();
        let (_, extras) = self.roots();
        if self.dirty.swap(false, Ordering::Relaxed) || !extras.is_empty() {
            self.request_rescan();
        }
    }

    pub fn on_overlay_hidden(&self) {
        self.extra_watcher.clear();
    }

    pub fn extras_changed(&self) {
        if self.overlay_active.load(Ordering::SeqCst) {
            self.watch_extras();
        }
        self.request_rescan();
    }

    pub fn request_rescan(&self) {
        if let Some(r) = self.rescanner.get() {
            r.now();
        }
    }

    pub fn retarget(&self, root: &Path) {
        if let Some(r) = self.rescanner.get() {
            self.watcher.watch(
                &[root.to_path_buf()],
                true,
                is_relevant_change,
                &self.overlay_active,
                &self.dirty,
                r,
            );
        }
        self.request_rescan();
    }

    pub fn snapshot(&self, since: Option<u64>) -> ClipsPayload {
        let list = self.clips.read();
        let generation = self.generation.load(Ordering::SeqCst);
        ClipsPayload {
            generation,
            clips: if since == Some(generation) {
                None
            } else {
                Some(list.clone())
            },
            offline_roots: self.offline.read().clone(),
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
            let mut list = self.clips.write();
            let before = list.len();
            list.retain(|c| !ids.contains(&c.id));
            if list.len() == before {
                return;
            }
            let mut files = self.files.write();
            for id in ids {
                files.remove(id);
            }
        }
        let g = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = app.emit("clips-updated", g);
    }

    fn scan(&self, app: &AppHandle, thumbs: &ThumbService) {
        let (main, extras) = self.roots();
        if !main.exists() {
            let _ = std::fs::create_dir_all(&main);
        }

        let mut next: Vec<ClipEntry> = Vec::new();
        let mut files: HashMap<String, FileInfo> = HashMap::new();
        let mut offline: Vec<String> = Vec::new();
        let mut cache = self.probe_cache.lock();
        let mut new_cache = HashMap::with_capacity(cache.len());
        let mut probed = false;

        for root in std::iter::once(&main).chain(extras.iter()) {
            if !root.is_dir() {
                if root != &main {
                    offline.push(root.to_string_lossy().into_owned());
                }
                continue;
            }
            let library = root.to_string_lossy().into_owned();
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
                if !VIDEO_EXT.contains(&ext.as_str()) {
                    continue;
                }
                let id = stable_id('c', path);
                if files.contains_key(&id) {
                    continue;
                }
                let Ok(meta) = entry.metadata() else { continue };
                let stamp = file_stamp(&meta);
                let duration = match cache.get(path) {
                    Some((s, d)) if *s == stamp => *d,
                    _ => {
                        probed = true;
                        probe_duration_ms(path, &ext)
                    }
                };
                new_cache.insert(path.to_path_buf(), (stamp, duration));

                let file_name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("clip")
                    .to_string();
                let captured = if stamp.1 > 0 {
                    Some(stamp.1)
                } else {
                    parse_from_filename(&file_name)
                };
                files.insert(
                    id.clone(),
                    FileInfo {
                        path: path.to_path_buf(),
                        size: stamp.0,
                        mtime_ms: stamp.1,
                    },
                );
                next.push(ClipEntry {
                    id,
                    path: path.to_string_lossy().into_owned(),
                    file_name,
                    game_name: game_name_from_rel(path.strip_prefix(root).ok()),
                    captured_at_ms: captured,
                    duration_ms: duration,
                    size_bytes: stamp.0,
                    extension: ext,
                    library: library.clone(),
                });
            }
        }
        let offline_roots: Vec<&PathBuf> = std::iter::once(&main)
            .chain(extras.iter())
            .filter(|r| !r.is_dir())
            .collect();
        for (path, v) in cache.iter() {
            if offline_roots.iter().any(|r| path.starts_with(r)) {
                new_cache.entry(path.clone()).or_insert(*v);
            }
        }
        if probed || new_cache.len() != cache.len() {
            save_probe_cache(&self.probe_cache_file, &new_cache);
        }
        *cache = new_cache;
        drop(cache);

        next.sort_by(|a, b| b.captured_at_ms.unwrap_or(0).cmp(&a.captured_at_ms.unwrap_or(0)));

        let offline_changed = *self.offline.read() != offline;
        let all_online = offline.is_empty();
        if offline_changed {
            *self.offline.write() = offline;
        }
        let changed = *self.clips.read() != next || offline_changed;
        if changed {
            let keep: Vec<_> = next
                .iter()
                .filter_map(|c| files.get(&c.id))
                .map(|f| (f.path.clone(), f.size, f.mtime_ms))
                .collect();
            *self.clips.write() = next;
            *self.files.write() = files;
            let g = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
            let _ = app.emit("clips-updated", g);
            thumbs.prewarm_and_prune('c', keep, all_online);
        }
    }
}

type ProbeRow = (PathBuf, u64, i64, Option<u64>);

fn load_probe_cache(file: &Path) -> HashMap<PathBuf, (Stamp, Option<u64>)> {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<ProbeRow>>(&s).ok())
        .map(|rows| rows.into_iter().map(|(p, size, mtime, d)| (p, ((size, mtime), d))).collect())
        .unwrap_or_default()
}

fn save_probe_cache(file: &Path, cache: &HashMap<PathBuf, (Stamp, Option<u64>)>) {
    let rows: Vec<ProbeRow> = cache
        .iter()
        .map(|(p, ((size, mtime), d))| (p.clone(), *size, *mtime, *d))
        .collect();
    if let Ok(json) = serde_json::to_string(&rows) {
        let tmp = file.with_extension("json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, file);
        }
    }
}

fn is_ignored_dir(name: &std::ffi::OsStr) -> bool {
    let n = name.to_string_lossy();
    n.eq_ignore_ascii_case("replay_cache") || n.starts_with('.')
}

fn is_relevant_change(path: &Path) -> bool {
    if path.components().any(|c| is_ignored_dir(c.as_os_str())) {
        return false;
    }
    let ext = ext_lower(path);
    ext.is_empty() || VIDEO_EXT.contains(&ext.as_str())
}

fn game_name_from_rel(rel: Option<&Path>) -> String {
    let Some(rel) = rel else {
        return "Unknown/Desktop".to_string();
    };
    let mut c = rel.components();
    let Some(std::path::Component::Normal(first)) = c.next() else {
        return "Unknown/Desktop".to_string();
    };
    if c.next().is_none() {
        return "Unknown/Desktop".to_string();
    }
    first.to_string_lossy().into_owned()
}

static DATE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(20\d{2})[.\-](\d{2})[.\-](\d{2})").unwrap());
static TIME_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?:[T_\s\-]+|^)(\d{1,2})[.\-:](\d{2})[.\-:](\d{2})").unwrap());

fn parse_from_filename(name: &str) -> Option<i64> {
    let base = name.rsplit_once('.').map(|(b, _)| b).unwrap_or(name);
    let caps = DATE_RE.captures(base)?;
    let y: i32 = caps.get(1)?.as_str().parse().ok()?;
    let m: u32 = caps.get(2)?.as_str().parse().ok()?;
    let d: u32 = caps.get(3)?.as_str().parse().ok()?;
    let date = NaiveDate::from_ymd_opt(y, m, d)?;
    let tail = &base[caps.get(0)?.end()..];
    let (mut h, mut mi, mut s) = (12u32, 0u32, 0u32);
    if let Some(tc) = TIME_RE.captures(tail.trim_start()) {
        h = tc.get(1)?.as_str().parse().ok()?;
        mi = tc.get(2)?.as_str().parse().ok()?;
        s = tc.get(3)?.as_str().parse().ok()?;
    }
    let dt = date.and_hms_opt(h, mi, s)?;
    Local.from_local_datetime(&dt).single().map(|d| d.timestamp_millis())
}

fn probe_duration_ms(path: &Path, ext: &str) -> Option<u64> {
    match ext {
        "mp4" | "mov" => mp4_duration(path),
        "mkv" | "webm" => mkv_duration(path),
        _ => None,
    }
}

fn mp4_duration(path: &Path) -> Option<u64> {
    let mut f = File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let mut pos = 0u64;
    while pos + 8 <= len {
        let (kind, body, end) = read_box_header(&mut f, pos, len)?;
        if &kind == b"moov" {
            let mut child = body;
            while child + 8 <= end {
                let (ck, cbody, cend) = read_box_header(&mut f, child, end)?;
                if &ck == b"mvhd" {
                    return read_mvhd(&mut f, cbody);
                }
                child = cend;
            }
            return None;
        }
        pos = end;
    }
    None
}

fn read_box_header(f: &mut File, pos: u64, limit: u64) -> Option<([u8; 4], u64, u64)> {
    f.seek(SeekFrom::Start(pos)).ok()?;
    let mut hdr = [0u8; 8];
    f.read_exact(&mut hdr).ok()?;
    let mut size = u32::from_be_bytes(hdr[0..4].try_into().ok()?) as u64;
    let kind: [u8; 4] = hdr[4..8].try_into().ok()?;
    let mut header_len = 8;
    if size == 1 {
        let mut big = [0u8; 8];
        f.read_exact(&mut big).ok()?;
        size = u64::from_be_bytes(big);
        header_len = 16;
    } else if size == 0 {
        size = limit - pos;
    }
    if size < header_len {
        return None;
    }
    Some((kind, pos + header_len, pos.saturating_add(size).min(limit)))
}

fn read_mvhd(f: &mut File, body: u64) -> Option<u64> {
    f.seek(SeekFrom::Start(body)).ok()?;
    let mut buf = [0u8; 32];
    f.read_exact(&mut buf).ok()?;
    let (timescale, duration) = if buf[0] == 1 {
        (
            u32::from_be_bytes(buf[20..24].try_into().ok()?) as u64,
            u64::from_be_bytes(buf[24..32].try_into().ok()?),
        )
    } else {
        (
            u32::from_be_bytes(buf[12..16].try_into().ok()?) as u64,
            u32::from_be_bytes(buf[16..20].try_into().ok()?) as u64,
        )
    };
    if timescale == 0 || duration == 0 || duration == u32::MAX as u64 || duration == u64::MAX {
        return None;
    }
    Some(duration.saturating_mul(1000) / timescale)
}

fn mkv_duration(path: &Path) -> Option<u64> {
    let mut f = BufReader::new(File::open(path).ok()?);
    if read_ebml_id(&mut f)? != 0x1A45_DFA3 {
        return None;
    }
    let hdr = read_ebml_size(&mut f)?;
    f.seek_relative(i64::try_from(hdr).ok()?).ok()?;
    if read_ebml_id(&mut f)? != 0x1853_8067 {
        return None;
    }
    read_ebml_size(&mut f)?;
    for _ in 0..64 {
        let id = read_ebml_id(&mut f)?;
        let size = read_ebml_size(&mut f)?;
        match id {
            0x1549_A966 => {
                let end = f.stream_position().ok()? + size;
                let mut scale = 1_000_000u64;
                let mut dur: Option<f64> = None;
                while f.stream_position().ok()? < end {
                    let cid = read_ebml_id(&mut f)?;
                    let csz = read_ebml_size(&mut f)?;
                    match cid {
                        0x2A_D7B1 => scale = read_ebml_uint(&mut f, csz)?,
                        0x4489 => dur = read_ebml_float(&mut f, csz),
                        _ => f.seek_relative(i64::try_from(csz).ok()?).ok()?,
                    }
                }
                let ms = dur? * scale as f64 / 1_000_000.0;
                return (ms.is_finite() && ms > 0.0).then_some(ms as u64);
            }
            0x1F43_B675 => return None,
            _ => f.seek_relative(i64::try_from(size).ok()?).ok()?,
        }
    }
    None
}

fn read_byte(r: &mut impl Read) -> Option<u8> {
    let mut b = [0u8; 1];
    r.read_exact(&mut b).ok()?;
    Some(b[0])
}

fn read_ebml_id(r: &mut impl Read) -> Option<u32> {
    let first = read_byte(r)?;
    let len = first.leading_zeros() as usize + 1;
    if len > 4 {
        return None;
    }
    let mut v = first as u32;
    for _ in 1..len {
        v = (v << 8) | read_byte(r)? as u32;
    }
    Some(v)
}

fn read_ebml_size(r: &mut impl Read) -> Option<u64> {
    let first = read_byte(r)?;
    let len = first.leading_zeros() as usize + 1;
    if len > 8 {
        return None;
    }
    let mut v = (first as u64) & (0xFF >> len);
    let mut all_ones = v == (0xFF >> len);
    for _ in 1..len {
        let b = read_byte(r)?;
        all_ones &= b == 0xFF;
        v = (v << 8) | b as u64;
    }
    Some(if all_ones { u64::MAX >> 8 } else { v })
}

fn read_ebml_uint(r: &mut impl Read, size: u64) -> Option<u64> {
    if size > 8 {
        return None;
    }
    let mut v = 0u64;
    for _ in 0..size {
        v = (v << 8) | read_byte(r)? as u64;
    }
    Some(v)
}

fn read_ebml_float(r: &mut impl Read, size: u64) -> Option<f64> {
    match size {
        4 => {
            let mut b = [0u8; 4];
            r.read_exact(&mut b).ok()?;
            Some(f32::from_be_bytes(b) as f64)
        }
        8 => {
            let mut b = [0u8; 8];
            r.read_exact(&mut b).ok()?;
            Some(f64::from_be_bytes(b))
        }
        _ => None,
    }
}

pub fn rename_target(old: &Path, new_name: &str) -> Result<PathBuf, String> {
    let name = new_name.trim();
    if name.is_empty() {
        return Err("Name can't be empty".into());
    }
    if name.chars().any(|c| matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control()) {
        return Err("Name contains characters Windows doesn't allow".into());
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return Err("Name can't end with a dot or space".into());
    }
    let old_ext = ext_lower(old);
    let new_ext = ext_lower(Path::new(name));
    let file_name = if !old_ext.is_empty() && new_ext != old_ext {
        format!("{name}.{}", old.extension().and_then(|e| e.to_str()).unwrap_or(&old_ext))
    } else {
        name.to_string()
    };
    let target = old.with_file_name(file_name);
    if target == old {
        return Ok(target);
    }
    if target.exists() && !target.to_string_lossy().eq_ignore_ascii_case(&old.to_string_lossy()) {
        return Err("A file with that name already exists".into());
    }
    Ok(target)
}
