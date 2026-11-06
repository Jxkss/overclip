
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, PartialEq, Eq)]
enum ScanReq {
    Now,
    Soon,
}

const SETTLE: Duration = Duration::from_millis(700);

#[derive(Clone)]
pub struct Rescanner {
    tx: Sender<ScanReq>,
}

impl Rescanner {
    pub fn spawn(name: &str, scan: impl Fn() + Send + 'static) -> Self {
        let (tx, rx) = channel::<ScanReq>();
        std::thread::Builder::new()
            .name(format!("overclip-scan-{name}"))
            .spawn(move || {
                while let Ok(first) = rx.recv() {
                    if first == ScanReq::Soon {
                        let deadline = Instant::now() + Duration::from_secs(4);
                        loop {
                            match rx.recv_timeout(SETTLE) {
                                Ok(ScanReq::Now) => break,
                                Ok(ScanReq::Soon) if Instant::now() < deadline => continue,
                                Ok(ScanReq::Soon) => break,
                                Err(RecvTimeoutError::Timeout) => break,
                                Err(RecvTimeoutError::Disconnected) => return,
                            }
                        }
                    }
                    while rx.try_recv().is_ok() {}
                    scan();
                }
            })
            .expect("spawn scan thread");
        Self { tx }
    }

    pub fn now(&self) {
        let _ = self.tx.send(ScanReq::Now);
    }

    pub fn soon(&self) {
        let _ = self.tx.send(ScanReq::Soon);
    }
}

pub struct DirWatcher {
    inner: Mutex<Vec<(RecommendedWatcher, PathBuf)>>,
}

impl DirWatcher {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Vec::new()),
        }
    }

    pub fn watch(
        &self,
        roots: &[PathBuf],
        create_missing: bool,
        relevant: fn(&Path) -> bool,
        overlay_active: &Arc<AtomicBool>,
        dirty: &Arc<AtomicBool>,
        rescanner: &Rescanner,
    ) {
        let mut guard = self.inner.lock();
        guard.retain(|(_, r)| roots.contains(r) && r.is_dir());
        for root in roots {
            if guard.iter().any(|(_, r)| r == root) {
                continue;
            }
            if create_missing {
                let _ = std::fs::create_dir_all(root);
            }
            if !root.is_dir() {
                continue;
            }
            let (overlay_active, dirty, rescanner) =
                (Arc::clone(overlay_active), Arc::clone(dirty), rescanner.clone());
            let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                let Ok(ev) = res else { return };
                if matches!(ev.kind, EventKind::Access(_)) {
                    return;
                }
                if !ev.paths.iter().any(|p| relevant(p)) {
                    return;
                }
                if overlay_active.load(Ordering::Relaxed) {
                    rescanner.soon();
                } else {
                    dirty.store(true, Ordering::Relaxed);
                }
            });
            let Ok(mut watcher) = watcher else { continue };
            if watcher.watch(root, RecursiveMode::Recursive).is_ok() {
                guard.push((watcher, root.clone()));
            }
        }
    }

    pub fn clear(&self) {
        self.inner.lock().clear();
    }
}

pub fn file_stamp(meta: &std::fs::Metadata) -> (u64, i64) {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    (meta.len(), mtime)
}

pub fn stable_id(prefix: char, path: &Path) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    path.to_string_lossy().hash(&mut h);
    format!("{prefix}{:016x}", h.finish())
}

pub fn ext_lower(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}
