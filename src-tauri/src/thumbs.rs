
use parking_lot::{Condvar, Mutex};
use std::collections::{HashSet, VecDeque};
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::http::Response;
use tauri::UriSchemeResponder;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{GENERIC_WRITE, SIZE};
use windows::Win32::Graphics::Gdi::{DeleteObject, HBITMAP, HPALETTE};
use windows::Win32::Graphics::Imaging::{
    CLSID_WICImagingFactory, GUID_ContainerFormatJpeg, GUID_WICPixelFormat24bppBGR,
    IWICImagingFactory, IWICPalette, WICBitmapDitherTypeNone, WICBitmapEncoderNoCache,
    WICBitmapIgnoreAlpha, WICBitmapPaletteTypeCustom,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, IBindCtx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
    COINIT_DISABLE_OLE1DDE,
};
use windows::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_MODE_BACKGROUND_BEGIN};
use windows::Win32::UI::Shell::{IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_THUMBNAILONLY};

const THUMB_PX: i32 = 480;
const INTERACTIVE_WORKERS: usize = 2;
const PREWARM_LIMIT: usize = 300;

struct Job {
    src: PathBuf,
    dst: PathBuf,
    responder: Option<UriSchemeResponder>,
}

struct Queue {
    jobs: Mutex<VecDeque<Job>>,
    cv: Condvar,
    lifo: bool,
}

impl Queue {
    fn new(lifo: bool) -> Arc<Self> {
        Arc::new(Self {
            jobs: Mutex::new(VecDeque::new()),
            cv: Condvar::new(),
            lifo,
        })
    }

    fn pop(&self) -> Job {
        let mut q = self.jobs.lock();
        loop {
            if let Some(j) = if self.lifo { q.pop_back() } else { q.pop_front() } {
                return j;
            }
            self.cv.wait(&mut q);
        }
    }
}

pub struct ThumbService {
    dir: PathBuf,
    interactive: Arc<Queue>,
    prewarm: Arc<Queue>,
    failed: Arc<Mutex<HashSet<PathBuf>>>,
}

impl ThumbService {
    pub fn start(cache_dir: PathBuf) -> Arc<Self> {
        let dir = cache_dir.join("thumbs");
        let _ = std::fs::create_dir_all(dir.join("c"));
        let _ = std::fs::create_dir_all(dir.join("s"));
        let svc = Arc::new(Self {
            dir,
            interactive: Queue::new(true),
            prewarm: Queue::new(false),
            failed: Arc::new(Mutex::new(HashSet::new())),
        });
        for i in 0..INTERACTIVE_WORKERS {
            spawn_worker(format!("overclip-thumb-{i}"), Arc::clone(&svc.interactive), Arc::clone(&svc.failed), false);
        }
        spawn_worker("overclip-thumb-bg".into(), Arc::clone(&svc.prewarm), Arc::clone(&svc.failed), true);
        svc
    }

    fn thumb_path(&self, kind: char, src: &Path, size: u64, mtime_ms: i64) -> PathBuf {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut h = DefaultHasher::new();
        src.to_string_lossy().hash(&mut h);
        size.hash(&mut h);
        mtime_ms.hash(&mut h);
        self.dir.join(kind.to_string()).join(format!("{:016x}.jpg", h.finish()))
    }

    pub fn serve(&self, kind: char, src: PathBuf, size: u64, mtime_ms: i64, responder: UriSchemeResponder) {
        let dst = self.thumb_path(kind, &src, size, mtime_ms);
        if self.failed.lock().contains(&dst) {
            respond_missing(responder);
            return;
        }
        if dst.is_file() {
            tauri::async_runtime::spawn_blocking(move || respond_file(&dst, responder));
            return;
        }
        let mut q = self.interactive.jobs.lock();
        q.push_back(Job {
            src,
            dst,
            responder: Some(responder),
        });
        self.interactive.cv.notify_one();
    }

    pub fn prewarm_and_prune(&self, kind: char, files: Vec<(PathBuf, u64, i64)>, prune: bool) {
        let mut expected = HashSet::with_capacity(files.len());
        let mut todo = VecDeque::new();
        {
            let failed = self.failed.lock();
            for (i, (src, size, mtime)) in files.into_iter().enumerate() {
                let dst = self.thumb_path(kind, &src, size, mtime);
                if i < PREWARM_LIMIT && !dst.is_file() && !failed.contains(&dst) {
                    todo.push_back(Job {
                        src,
                        dst: dst.clone(),
                        responder: None,
                    });
                }
                expected.insert(dst);
            }
        }
        *self.prewarm.jobs.lock() = todo;
        self.prewarm.cv.notify_one();

        if !prune || expected.is_empty() {
            return;
        }
        if let Ok(entries) = std::fs::read_dir(self.dir.join(kind.to_string())) {
            for e in entries.flatten() {
                let p = e.path();
                if !expected.contains(&p) {
                    let _ = std::fs::remove_file(p);
                }
            }
        }
    }

    pub fn clear(&self) {
        self.failed.lock().clear();
        for kind in ["c", "s"] {
            if let Ok(entries) = std::fs::read_dir(self.dir.join(kind)) {
                for e in entries.flatten() {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    }
}

fn spawn_worker(name: String, queue: Arc<Queue>, failed: Arc<Mutex<HashSet<PathBuf>>>, background: bool) {
    let _ = std::thread::Builder::new().name(name).spawn(move || unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
        if background {
            let _ = SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN);
        }
        let factory: Option<IWICImagingFactory> =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).ok();
        loop {
            let job = queue.pop();
            if !job.dst.is_file() && !failed.lock().contains(&job.dst) {
                let ok = factory
                    .as_ref()
                    .is_some_and(|f| generate(f, &job.src, &job.dst).is_ok());
                if !ok {
                    failed.lock().insert(job.dst.clone());
                }
            }
            if let Some(r) = job.responder {
                respond_file(&job.dst, r);
            }
        }
    });
}

fn respond_file(path: &Path, responder: UriSchemeResponder) {
    match std::fs::read(path) {
        Ok(bytes) => responder.respond(
            Response::builder()
                .status(200)
                .header("Content-Type", "image/jpeg")
                .header("Cache-Control", "public, max-age=31536000, immutable")
                .header("Access-Control-Allow-Origin", "*")
                .body(bytes)
                .unwrap(),
        ),
        Err(_) => respond_missing(responder),
    }
}

pub fn respond_missing(responder: UriSchemeResponder) {
    responder.respond(
        Response::builder()
            .status(404)
            .header("Access-Control-Allow-Origin", "*")
            .body(Vec::new())
            .unwrap(),
    );
}

fn wide_null(p: &OsStr) -> Vec<u16> {
    p.encode_wide().chain(Some(0)).collect()
}

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

unsafe fn generate(factory: &IWICImagingFactory, src: &Path, dst: &Path) -> windows::core::Result<()> {
    let normalized = src.to_string_lossy().replace('/', "\\");
    let wide = wide_null(OsStr::new(&normalized));
    let item: IShellItemImageFactory = SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None::<&IBindCtx>)?;
    let hbmp = item.GetImage(SIZE { cx: THUMB_PX, cy: THUMB_PX }, SIIGBF_THUMBNAILONLY)?;
    let res = encode_jpeg(factory, hbmp, dst);
    let _ = DeleteObject(hbmp);
    res
}

unsafe fn encode_jpeg(factory: &IWICImagingFactory, hbmp: HBITMAP, dst: &Path) -> windows::core::Result<()> {
    let bmp = factory.CreateBitmapFromHBITMAP(hbmp, HPALETTE::default(), WICBitmapIgnoreAlpha)?;
    let conv = factory.CreateFormatConverter()?;
    conv.Initialize(
        &bmp,
        &GUID_WICPixelFormat24bppBGR,
        WICBitmapDitherTypeNone,
        None::<&IWICPalette>,
        0.0,
        WICBitmapPaletteTypeCustom,
    )?;

    let tmp = dst.with_extension(format!("{}.tmp", TMP_SEQ.fetch_add(1, Ordering::Relaxed)));
    {
        let wide = wide_null(tmp.as_os_str());
        let stream = factory.CreateStream()?;
        stream.InitializeFromFilename(PCWSTR(wide.as_ptr()), GENERIC_WRITE.0)?;
        let encoder = factory.CreateEncoder(&GUID_ContainerFormatJpeg, std::ptr::null())?;
        encoder.Initialize(&stream, WICBitmapEncoderNoCache)?;
        let mut frame = None;
        let mut props = None;
        encoder.CreateNewFrame(&mut frame, &mut props)?;
        let frame = frame.ok_or_else(windows::core::Error::empty)?;
        frame.Initialize(props.as_ref())?;
        let mut fmt = GUID_WICPixelFormat24bppBGR;
        frame.SetPixelFormat(&mut fmt)?;
        frame.WriteSource(&conv, std::ptr::null())?;
        frame.Commit()?;
        encoder.Commit()?;
    }
    if std::fs::rename(&tmp, dst).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    Ok(())
}
