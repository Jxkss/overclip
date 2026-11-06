
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime};
use windows::core::{w, PCWSTR};
use windows::Win32::UI::WindowsAndMessaging::FindWindowW;
use winreg::enums::{RegType, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WRITE};
use winreg::{RegKey, RegValue};

const USER_KEY: &str = r"Software\AMD\DVR";
const MACHINE_KEY: &str = r"SOFTWARE\AMD\DVR";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub const RESOLUTIONS: &[&str] = &["InGame", "720", "1080", "1440", "2160"];
pub const FRAME_RATES: &[u32] = &[30, 60];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecorderSettings {
    pub instant_replay: bool,
    pub replay_seconds: u32,
    pub output_folder: String,
    pub resolution: String,
    pub frame_rate: u32,
    pub bitrate_kbps: u32,
    pub codec: String,
    pub system_audio: bool,
    pub microphone: bool,
    pub mic_volume: u32,
    pub stereo_audio: bool,
    pub record_desktop: bool,
}

impl RecorderSettings {
    fn sanitize(&mut self, codecs: &[String]) {
        self.replay_seconds = self.replay_seconds.clamp(5, 1200);
        self.bitrate_kbps = self.bitrate_kbps.clamp(1000, 100_000);
        self.mic_volume = self.mic_volume.min(100);
        if !RESOLUTIONS.contains(&self.resolution.as_str()) {
            self.resolution = "InGame".into();
        }
        if !FRAME_RATES.contains(&self.frame_rate) {
            self.frame_rate = 60;
        }
        if !codecs.contains(&self.codec) {
            self.codec = "AVC".into();
        }
        self.output_folder = self.output_folder.trim().trim_end_matches(['\\', '/']).to_string();
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hotkeys {
    pub save_replay: Option<String>,
    pub screenshot: Option<String>,
    pub record: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AmdStatus {
    pub installed: bool,
    pub running: bool,
    pub recording: bool,
    pub applying: bool,
    pub settings: Option<RecorderSettings>,
    pub codecs: Vec<String>,
    pub hotkeys: Hotkeys,
}

struct Reg {
    user: Option<RegKey>,
    machine: Option<RegKey>,
}

impl Reg {
    fn open() -> Self {
        Self {
            user: RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(USER_KEY, KEY_READ).ok(),
            machine: RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(MACHINE_KEY, KEY_READ).ok(),
        }
    }

    fn raw(&self, name: &str) -> Option<RegValue> {
        [&self.user, &self.machine]
            .into_iter()
            .flatten()
            .find_map(|k| k.get_raw_value(name).ok())
    }

    fn string(&self, name: &str) -> Option<String> {
        let v = self.raw(name)?;
        match v.vtype {
            RegType::REG_DWORD => Some(dword_of(&v)?.to_string()),
            _ => {
                let wide: Vec<u16> = v.bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
                let end = wide.iter().position(|&c| c == 0).unwrap_or(wide.len());
                Some(String::from_utf16_lossy(&wide[..end]).trim().to_string())
            }
        }
    }

    fn number(&self, name: &str) -> Option<u32> {
        let v = self.raw(name)?;
        dword_of(&v).or_else(|| self.string(name)?.parse().ok())
    }

    fn flag(&self, name: &str) -> Option<bool> {
        match self.string(name)?.to_ascii_lowercase().as_str() {
            "1" | "true" => Some(true),
            "0" | "false" => Some(false),
            _ => None,
        }
    }
}

fn dword_of(v: &RegValue) -> Option<u32> {
    (v.vtype == RegType::REG_DWORD && v.bytes.len() >= 4)
        .then(|| u32::from_le_bytes([v.bytes[0], v.bytes[1], v.bytes[2], v.bytes[3]]))
}

enum Val<'a> {
    Num(u32),
    Str(&'a str),
}

fn write(reg: &Reg, key: &RegKey, name: &str, val: Val) -> Result<(), String> {
    let existing = reg.raw(name).map(|v| v.vtype);
    let res = match (val, existing) {
        (Val::Num(n), Some(RegType::REG_SZ)) => key.set_value(name, &n.to_string()),
        (Val::Num(n), _) => key.set_value(name, &n),
        (Val::Str(s), _) => key.set_value(name, &s),
    };
    res.map_err(|e| format!("Couldn't change AMD setting {name}: {e}"))
}

fn supported_codecs(reg: &Reg) -> Vec<String> {
    let mut out: Vec<String> = [("AVC", "AVCCaps"), ("HEVC", "HEVCCaps"), ("AV1", "AV1CCaps")]
        .into_iter()
        .filter(|(_, caps)| {
            reg.string(caps)
                .and_then(|c| c.split(',').nth(1).map(|f| f.trim() == "1"))
                .unwrap_or(false)
        })
        .map(|(name, _)| name.to_string())
        .collect();
    if out.is_empty() {
        out.push("AVC".into());
    }
    out
}

fn hotkey(reg: &Reg, name: &str) -> Option<String> {
    let s = reg.string(name)?;
    let s = s.trim();
    (!s.is_empty()).then(|| s.replace(',', "+"))
}

fn read_settings(reg: &Reg) -> Option<RecorderSettings> {
    reg.user.as_ref().or(reg.machine.as_ref())?;
    Some(RecorderSettings {
        instant_replay: reg.flag("InstantReplayEnabled").unwrap_or(false),
        replay_seconds: reg.number("InstantReplayDuration").unwrap_or(60),
        output_folder: reg.string("CaptureFileOutput").unwrap_or_default(),
        resolution: reg.string("FileCustomResolution").unwrap_or_else(|| "InGame".into()),
        frame_rate: reg.number("FileCustomFrameRate").unwrap_or(60),
        bitrate_kbps: reg.number("FileCustomBitrate").unwrap_or(30_000),
        codec: reg.string("FileEncoderType").unwrap_or_else(|| "AVC".into()),
        system_audio: reg.flag("AudioOutputCaptureEnabled").unwrap_or(true),
        microphone: reg.flag("AudioInputCaptureEnabled").unwrap_or(false),
        mic_volume: reg.number("MicVolumeLevel").unwrap_or(100),
        stereo_audio: reg.number("AudioChannelType") == Some(1),
        record_desktop: reg.flag("DesktopRecordingEnabled").unwrap_or(false),
    })
}

fn cli_path() -> Option<PathBuf> {
    let from_reg = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(r"SOFTWARE\AMD\CN", KEY_READ)
        .and_then(|k| k.get_value::<String, _>("InstallDir"))
        .ok()
        .map(PathBuf::from);
    let default = std::env::var_os("ProgramW6432")
        .or_else(|| std::env::var_os("ProgramFiles"))
        .map(|p| PathBuf::from(p).join(r"AMD\CNext\CNext"));
    [from_reg, default]
        .into_iter()
        .flatten()
        .map(|d| d.join("RSServCmd.exe"))
        .find(|p| p.is_file())
}

fn service_running() -> bool {
    unsafe { FindWindowW(w!("DVREventWindowClass"), PCWSTR::null()) }.is_ok_and(|h| !h.is_invalid())
}

fn run_cli(verb: &str) -> Result<(), String> {
    run_cli_for(verb, Duration::from_secs(10))
}

fn run_cli_for(verb: &str, timeout: Duration) -> Result<(), String> {
    let exe = cli_path().ok_or("AMD Software isn't installed")?;
    if !service_running() {
        return Err("AMD Software isn't running. Start it and try again.".into());
    }
    let mut child = Command::new(exe)
        .arg(verb)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("Couldn't reach AMD Software: {e}"))?;
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(40));
    }
    let _ = child.kill();
    Err("AMD Software didn't respond".into())
}

fn is_recording(folder: &Path) -> bool {
    let Ok(dir) = std::fs::read_dir(folder) else { return false };
    let now = SystemTime::now();
    dir.flatten().any(|e| {
        let path = e.path();
        let video = path
            .extension()
            .is_some_and(|x| ["mp4", "mkv", "mov"].iter().any(|v| x.eq_ignore_ascii_case(v)));
        let recent = e
            .metadata()
            .ok()
            .filter(|m| m.is_file())
            .and_then(|m| m.modified().ok())
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age < Duration::from_secs(6 * 3600));
        video
            && recent
            && std::fs::OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(&path)
                .is_err()
    })
}

pub type Notify = Arc<dyn Fn(AmdStatus) + Send + Sync>;

static APPLYING: AtomicBool = AtomicBool::new(false);
static PENDING: AtomicBool = AtomicBool::new(false);
static RESTART: AtomicBool = AtomicBool::new(false);
static TOGGLE: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

pub fn status() -> AmdStatus {
    let reg = Reg::open();
    let installed = cli_path().is_some() && (reg.user.is_some() || reg.machine.is_some());
    let settings = installed.then(|| read_settings(&reg)).flatten();
    let running = installed && service_running();
    AmdStatus {
        installed,
        running,
        recording: running && settings.as_ref().is_some_and(|s| is_recording(Path::new(&s.output_folder))),
        applying: APPLYING.load(Ordering::SeqCst),
        codecs: supported_codecs(&reg),
        hotkeys: Hotkeys {
            save_replay: hotkey(&reg, "SaveInstantReplayHotkey"),
            screenshot: hotkey(&reg, "TakeScreenshotHotkey"),
            record: hotkey(&reg, "ToggleDvrRecordingHotkey"),
        },
        settings,
    }
}

pub fn set_settings(notify: Notify, mut next: RecorderSettings) -> Result<AmdStatus, String> {
    let reg = Reg::open();
    let cur = read_settings(&reg).ok_or("AMD Software isn't installed")?;
    next.sanitize(&supported_codecs(&reg));
    if next.output_folder.is_empty() {
        next.output_folder = cur.output_folder.clone();
    }
    if next.output_folder != cur.output_folder {
        std::fs::create_dir_all(&next.output_folder)
            .map_err(|e| format!("Can't use that folder: {e}"))?;
    }
    let key = RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey_with_flags(USER_KEY, KEY_READ | KEY_WRITE)
        .map_err(|e| e.to_string())?
        .0;

    let flag = |b: bool| Val::Num(b as u32);
    let mut changed = false;
    let mut put = |differs: bool, name: &str, val: Val| -> Result<(), String> {
        if differs {
            write(&reg, &key, name, val)?;
            changed = true;
        }
        Ok(())
    };
    put(next.replay_seconds != cur.replay_seconds, "InstantReplayDuration", Val::Num(next.replay_seconds))?;
    put(next.output_folder != cur.output_folder, "CaptureFileOutput", Val::Str(&next.output_folder))?;
    put(next.resolution != cur.resolution, "FileCustomResolution", Val::Str(&next.resolution))?;
    put(next.frame_rate != cur.frame_rate, "FileCustomFrameRate", Val::Num(next.frame_rate))?;
    put(next.bitrate_kbps != cur.bitrate_kbps, "FileCustomBitrate", Val::Num(next.bitrate_kbps))?;
    put(next.codec != cur.codec, "FileEncoderType", Val::Str(&next.codec))?;
    put(next.system_audio != cur.system_audio, "AudioOutputCaptureEnabled", flag(next.system_audio))?;
    put(next.microphone != cur.microphone, "AudioInputCaptureEnabled", flag(next.microphone))?;
    put(next.mic_volume != cur.mic_volume, "MicVolumeLevel", Val::Num(next.mic_volume))?;
    put(next.stereo_audio != cur.stereo_audio, "AudioChannelType", flag(next.stereo_audio))?;
    put(next.record_desktop != cur.record_desktop, "DesktopRecordingEnabled", flag(next.record_desktop))?;
    let audio_changed = next.system_audio != cur.system_audio
        || next.microphone != cur.microphone
        || next.mic_volume != cur.mic_volume
        || next.stereo_audio != cur.stereo_audio;
    let quality_changed = next.resolution != cur.resolution
        || next.frame_rate != cur.frame_rate
        || next.bitrate_kbps != cur.bitrate_kbps;
    if quality_changed && !reg.string("UserProfileFile").is_some_and(|p| p.starts_with("Custom")) {
        write(&reg, &key, "UserProfileFile", Val::Str("Custom"))?;
    }

    if audio_changed {
        RESTART.store(true, Ordering::SeqCst);
    }
    if next.instant_replay != cur.instant_replay {
        set_instant_replay(&key, next.instant_replay)?;
        if audio_changed {
            request_apply(notify);
        }
    } else if changed && (cur.instant_replay || audio_changed) {
        request_apply(notify);
    }
    Ok(status())
}

fn set_instant_replay(key: &RegKey, on: bool) -> Result<(), String> {
    if !service_running() {
        return key
            .set_value("InstantReplayEnabled", &(on as u32))
            .map_err(|e| e.to_string());
    }
    let _guard = TOGGLE.lock();
    let is_on = Reg::open().flag("InstantReplayEnabled").unwrap_or(false);
    if is_on != on {
        run_cli("toggle_ir")?;
    }
    Ok(())
}

fn request_apply(notify: Notify) {
    PENDING.store(true, Ordering::SeqCst);
    if APPLYING.swap(true, Ordering::SeqCst) {
        return;
    }
    notify(status());
    thread::spawn(move || {
        loop {
            thread::sleep(Duration::from_millis(400));
            if !PENDING.swap(false, Ordering::SeqCst) {
                break;
            }
            while status().recording {
                thread::sleep(Duration::from_secs(2));
            }
            let _guard = TOGGLE.lock();
            if RESTART.swap(false, Ordering::SeqCst) && service_running() {
                let _ = run_cli_for("restart", Duration::from_secs(30));
                let back = Instant::now() + Duration::from_secs(20);
                while !service_running() && Instant::now() < back {
                    thread::sleep(Duration::from_millis(250));
                }
                thread::sleep(Duration::from_secs(2));
            } else if Reg::open().flag("InstantReplayEnabled").unwrap_or(false) && service_running() {
                let _ = run_cli("toggle_ir");
                thread::sleep(Duration::from_millis(1500));
                let _ = run_cli("toggle_ir");
            }
        }
        APPLYING.store(false, Ordering::SeqCst);
        notify(status());
    });
}

pub enum Action {
    SaveReplay,
    Screenshot,
    StartRecording,
    StopRecording,
}

pub fn run(action: Action) -> Result<(), String> {
    match action {
        Action::SaveReplay => {
            if !Reg::open().flag("InstantReplayEnabled").unwrap_or(false) {
                return Err("Instant Replay is off. Turn it on first.".into());
            }
            if APPLYING.load(Ordering::SeqCst) {
                return Err("Instant Replay is restarting with your new settings. Try again in a moment.".into());
            }
            run_cli("save_ir")
        }
        Action::Screenshot => run_cli("still_cap"),
        Action::StartRecording => run_cli("capture_to_file_start"),
        Action::StopRecording => run_cli("capture_to_file_stop"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wait_applied() {
        thread::sleep(Duration::from_millis(600));
        while APPLYING.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(200));
        }
    }

    fn newest_clip(dir: &Path, after: SystemTime) -> Option<PathBuf> {
        walkdir::WalkDir::new(dir)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| !e.path().components().any(|c| c.as_os_str() == "replay_cache"))
            .filter(|e| e.path().extension().is_some_and(|x| x == "mp4"))
            .filter(|e| e.metadata().ok().and_then(|m| m.created().ok()).is_some_and(|t| t > after))
            .map(|e| e.into_path())
            .next()
    }

    fn duration_secs(path: &Path) -> f64 {
        let out = Command::new("ffprobe")
            .args(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0"])
            .arg(path)
            .output()
            .expect("ffprobe");
        String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0.0)
    }

    fn audio_channels(path: &Path) -> u32 {
        let out = Command::new("ffprobe")
            .args(["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels", "-of", "csv=p=0"])
            .arg(path)
            .output()
            .expect("ffprobe");
        String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0)
    }

    fn save_now(dir: &Path) -> PathBuf {
        thread::sleep(Duration::from_secs(14));
        let t0 = SystemTime::now();
        run(Action::SaveReplay).unwrap();
        for _ in 0..60 {
            thread::sleep(Duration::from_millis(500));
            if let Some(clip) = newest_clip(dir, t0) {
                thread::sleep(Duration::from_secs(5));
                return clip;
            }
        }
        panic!("no replay saved");
    }

    #[test]
    #[ignore]
    fn amd_live_stereo() {
        let orig = status().settings.expect("AMD Software");
        assert!(orig.instant_replay, "turn Instant Replay on first");
        let dir = PathBuf::from(&orig.output_folder);
        let notify: Notify = Arc::new(|_| {});
        for stereo in [false, true] {
            let mut next = orig.clone();
            next.stereo_audio = stereo;
            set_settings(Arc::clone(&notify), next).unwrap();
            wait_applied();
            let clip = save_now(&dir);
            let ch = audio_channels(&clip);
            println!("stereo_audio={stereo}: {ch} channels ({})", clip.display());
            let _ = std::fs::remove_file(&clip);
            if stereo {
                assert_eq!(ch, 2);
            }
        }
        set_settings(notify, orig.clone()).unwrap();
        wait_applied();
        assert_eq!(status().settings.unwrap(), orig);
    }

    #[test]
    #[ignore]
    fn amd_live() {
        let st = status();
        println!("status: {st:#?}");
        assert!(st.installed && st.running, "AMD Software must be running");
        let orig = st.settings.clone().unwrap();
        assert!(orig.instant_replay, "turn Instant Replay on first");
        assert!(!st.recording);
        let notify: Notify = Arc::new(|s| println!("notify: applying={}", s.applying));

        let mut short = orig.clone();
        short.replay_seconds = 20;
        let after_set = set_settings(Arc::clone(&notify), short).unwrap();
        assert_eq!(after_set.settings.unwrap().replay_seconds, 20);
        wait_applied();
        println!("applied; buffering 30 s");
        thread::sleep(Duration::from_secs(30));

        let t0 = SystemTime::now();
        run(Action::SaveReplay).unwrap();
        let dir = PathBuf::from(&orig.output_folder);
        let mut clip = None;
        for _ in 0..60 {
            thread::sleep(Duration::from_millis(500));
            clip = newest_clip(&dir, t0);
            if clip.is_some() {
                thread::sleep(Duration::from_secs(5));
                break;
            }
        }
        let clip = clip.expect("no replay saved");
        let secs = duration_secs(&clip);
        println!("saved {} ({secs:.1} s)", clip.display());

        set_settings(notify, orig.clone()).unwrap();
        wait_applied();
        assert_eq!(status().settings.unwrap(), orig, "settings restored");
        let _ = std::fs::remove_file(&clip);
        assert!((19.0..=21.5).contains(&secs), "expected a ~20 s replay, got {secs}");
    }
}
