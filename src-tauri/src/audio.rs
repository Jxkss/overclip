
use serde::Serialize;
use std::path::PathBuf;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::collections::HashMap;
use windows::core::{Interface, PWSTR};
use windows::Win32::Foundation::{BOOL, FALSE, CloseHandle};
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{
    eCapture, eConsole, eRender, AudioSessionStateExpired, AudioSessionStateInactive,
    IAudioSessionControl2, IAudioSessionManager2, IMMDevice, IMMDeviceCollection,
    IMMDeviceEnumerator, ISimpleAudioVolume, MMDeviceEnumerator, DEVICE_STATE, DEVICE_STATE_ACTIVE,
    DEVICE_STATE_UNPLUGGED, DEVICE_STATE_DISABLED,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
thread_local! {
    static COM_INIT: () = unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    };
}

fn ensure_com() {
    COM_INIT.with(|_| {});
}

type IconKey = (u32, Option<String>);

static ICON_CACHE: Lazy<Mutex<HashMap<IconKey, Option<String>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn cached_icon(pid: u32, com_icon: Option<String>) -> Option<String> {
    let key = (pid, com_icon);
    if let Some(v) = ICON_CACHE.lock().get(&key) {
        return v.clone();
    }
    let v = crate::audio_icon::session_icon_data_url(pid, key.1.clone());
    let mut cache = ICON_CACHE.lock();
    if cache.len() > 256 {
        cache.clear();
    }
    cache.insert(key, v.clone());
    v
}

unsafe fn default_device(flow: windows::Win32::Media::Audio::EDataFlow) -> windows::core::Result<IMMDevice> {
    ensure_com();
    let enumerator: IMMDeviceEnumerator =
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
    enumerator.GetDefaultAudioEndpoint(flow, eConsole)
}

unsafe fn device_id(device: &IMMDevice) -> Option<String> {
    let pw = device.GetId().ok()?;
    pwstr_to_option_string(pw)
}

unsafe fn pwstr_to_option_string(pw: PWSTR) -> Option<String> {
    if pw.is_null() {
        return None;
    }
    let s = match pw.to_string() {
        Ok(s) => s,
        Err(_) => {
            CoTaskMemFree(Some(pw.0 as *const _));
            return None;
        }
    };
    CoTaskMemFree(Some(pw.0 as *const _));
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSessionInfo {
    pub id: String,
    pub name: String,
    pub volume: f32,
    pub muted: bool,
    pub process_id: u32,
    pub icon_data_url: Option<String>,
    pub controllable: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioMixerState {
    pub output_device_name: Option<String>,
    pub master_volume: f32,
    pub master_muted: bool,
    pub master_capable: bool,
    pub sessions: Vec<AudioSessionInfo>,
    pub mic_muted: bool,
    pub mic_capable: bool,
    pub deafened: bool,
}

fn process_name(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = vec![0u16; 1024];
        let mut sz = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            h,
            PROCESS_NAME_WIN32,
            PWSTR::from_raw(buf.as_mut_ptr()),
            &mut sz,
        )
        .is_ok();
        let _ = CloseHandle(h);
        if !ok {
            return None;
        }
        let end = (sz as usize).min(buf.len());
        let len = buf[..end]
            .iter()
            .position(|&x| x == 0)
            .unwrap_or(end);
        let path = String::from_utf16_lossy(&buf[..len]);
        PathBuf::from(&path)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
    }
}

unsafe fn render_device_collection() -> windows::core::Result<IMMDeviceCollection> {
    let enumerator: IMMDeviceEnumerator =
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
    let mask = DEVICE_STATE(
        DEVICE_STATE_ACTIVE.0 | DEVICE_STATE_UNPLUGGED.0 | DEVICE_STATE_DISABLED.0,
    );
    enumerator.EnumAudioEndpoints(eRender, mask)
}

unsafe fn session_stable_id(c2: &IAudioSessionControl2, idx: i32) -> String {
    if let Ok(pw) = c2.GetSessionInstanceIdentifier() {
        if let Some(s) = pwstr_to_option_string(pw) {
            return s;
        }
    }
    if let Ok(pw) = c2.GetSessionIdentifier() {
        if let Some(s) = pwstr_to_option_string(pw) {
            return s;
        }
    }
    format!("__idx_{idx}")
}

pub fn get_mixer_state(deafened: bool) -> Result<AudioMixerState, String> {
    unsafe {
        ensure_com();
        let render = default_device(eRender).map_err(|e: windows::core::Error| e.to_string())?;
        let output_name = device_id(&render);
        let default_dev_id = device_id(&render);
        let ev: IAudioEndpointVolume = render
            .Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None)
            .map_err(|e: windows::core::Error| e.to_string())?;
        let master = ev.GetMasterVolumeLevelScalar().unwrap_or(1.0);
        let master_muted = ev.GetMute().unwrap_or(FALSE);
        let master_capable = true;

        let collection = render_device_collection().map_err(|e| e.to_string())?;
        let dev_count = collection
            .GetCount()
            .map_err(|e: windows::core::Error| e.to_string())?;
        let mut devices: Vec<IMMDevice> = Vec::new();
        for d in 0..dev_count {
            if let Ok(dev) = collection.Item(d) {
                devices.push(dev);
            }
        }
        devices.sort_by_key(|dev| {
            let id = device_id(dev);
            if id.is_some() && id == default_dev_id {
                0u8
            } else {
                1u8
            }
        });

        let mut sessions = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

        for device in devices {
            let Ok(sm) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else {
                continue;
            };
            let Ok(se) = sm.GetSessionEnumerator() else {
                continue;
            };
            let Ok(n) = se.GetCount() else {
                continue;
            };
            for i in 0..n {
                let Ok(ctl) = se.GetSession(i) else {
                    continue;
                };
                let state = ctl.GetState().unwrap_or(AudioSessionStateInactive);
                if state == AudioSessionStateExpired {
                    continue;
                }
                let Ok(c2) = ctl.cast::<IAudioSessionControl2>() else {
                    continue;
                };
                let pid = c2.GetProcessId().unwrap_or(0);
                let sid = session_stable_id(&c2, i);
                if !seen.insert(sid.clone()) {
                    continue;
                }
                let display = ctl
                    .GetDisplayName()
                    .ok()
                    .and_then(|pw| pwstr_to_option_string(pw))
                    .filter(|n| !n.starts_with('@'));
                let name = display.or_else(|| process_name(pid)).unwrap_or_else(|| {
                    if pid == 0 {
                        "System sounds".to_string()
                    } else {
                        format!("PID {pid}")
                    }
                });
                let com_icon = match ctl.GetIconPath() {
                    Ok(pw) => pwstr_to_option_string(pw),
                    Err(_) => None,
                };
                let icon_data_url = cached_icon(pid, com_icon);
                let (vol, muted, controllable) = match ctl.cast::<ISimpleAudioVolume>() {
                    Ok(simple) => {
                        let vol = simple.GetMasterVolume().unwrap_or(1.0);
                        let m = simple.GetMute().unwrap_or(FALSE);
                        (vol, m.as_bool(), true)
                    }
                    Err(_) => (1.0, false, false),
                };
                sessions.push(AudioSessionInfo {
                    id: sid,
                    name,
                    volume: vol,
                    muted,
                    process_id: pid,
                    icon_data_url,
                    controllable,
                });
            }
        }

        let capture = default_device(eCapture).ok();
        let (mic_muted, mic_capable) = if let Some(dev) = capture {
            let evc: std::result::Result<IAudioEndpointVolume, windows::core::Error> =
                dev.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None);
            if let Ok(cev) = evc {
                let m = cev.GetMute().unwrap_or(FALSE);
                (m.as_bool(), true)
            } else {
                (false, false)
            }
        } else {
            (false, false)
        };

        Ok(AudioMixerState {
            output_device_name: output_name,
            master_volume: master,
            master_muted: master_muted.as_bool(),
            master_capable,
            sessions,
            mic_muted,
            mic_capable,
            deafened,
        })
    }
}

pub fn set_session_volume(session_id: &str, volume: f32) -> Result<(), String> {
    let vol = volume.clamp(0.0, 1.0);
    unsafe {
        ensure_com();
        let collection = render_device_collection().map_err(|e| e.to_string())?;
        let dev_count = collection
            .GetCount()
            .map_err(|e: windows::core::Error| e.to_string())?;
        for d in 0..dev_count {
            let Ok(device) = collection.Item(d) else {
                continue;
            };
            let Ok(sm) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else {
                continue;
            };
            let Ok(se) = sm.GetSessionEnumerator() else {
                continue;
            };
            let Ok(n) = se.GetCount() else {
                continue;
            };
            for i in 0..n {
                let Ok(ctl) = se.GetSession(i) else {
                    continue;
                };
                let Ok(c2) = ctl.cast::<IAudioSessionControl2>() else {
                    continue;
                };
                let sid = session_stable_id(&c2, i);
                if sid != session_id {
                    continue;
                }
                let simple: ISimpleAudioVolume = ctl
                    .cast::<ISimpleAudioVolume>()
                    .map_err(|e: windows::core::Error| e.to_string())?;
                simple
                    .SetMasterVolume(vol, std::ptr::null())
                    .map_err(|e: windows::core::Error| e.to_string())?;
                return Ok(());
            }
        }
    }
    Err("Session not found".into())
}

pub fn set_session_mute(session_id: &str, mute: bool) -> Result<(), String> {
    unsafe {
        ensure_com();
        let collection = render_device_collection().map_err(|e| e.to_string())?;
        let dev_count = collection
            .GetCount()
            .map_err(|e: windows::core::Error| e.to_string())?;
        for d in 0..dev_count {
            let Ok(device) = collection.Item(d) else {
                continue;
            };
            let Ok(sm) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else {
                continue;
            };
            let Ok(se) = sm.GetSessionEnumerator() else {
                continue;
            };
            let Ok(n) = se.GetCount() else {
                continue;
            };
            for i in 0..n {
                let Ok(ctl) = se.GetSession(i) else {
                    continue;
                };
                let Ok(c2) = ctl.cast::<IAudioSessionControl2>() else {
                    continue;
                };
                let sid = session_stable_id(&c2, i);
                if sid != session_id {
                    continue;
                }
                let simple: ISimpleAudioVolume = ctl
                    .cast::<ISimpleAudioVolume>()
                    .map_err(|e: windows::core::Error| e.to_string())?;
                simple
                    .SetMute(BOOL::from(mute), std::ptr::null())
                    .map_err(|e: windows::core::Error| e.to_string())?;
                return Ok(());
            }
        }
    }
    Err("Session not found".into())
}

pub fn set_master_volume(volume: f32) -> Result<(), String> {
    let vol = volume.clamp(0.0, 1.0);
    unsafe {
        ensure_com();
        let render = default_device(eRender).map_err(|e: windows::core::Error| e.to_string())?;
        let ev: IAudioEndpointVolume = render
            .Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None)
            .map_err(|e: windows::core::Error| e.to_string())?;
        ev.SetMasterVolumeLevelScalar(vol, std::ptr::null())
            .map_err(|e: windows::core::Error| e.to_string())?;
    }
    Ok(())
}

pub fn set_master_mute(mute: bool) -> Result<(), String> {
    unsafe {
        ensure_com();
        let render = default_device(eRender).map_err(|e: windows::core::Error| e.to_string())?;
        let ev: IAudioEndpointVolume = render
            .Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None)
            .map_err(|e: windows::core::Error| e.to_string())?;
        ev.SetMute(BOOL::from(mute), std::ptr::null())
            .map_err(|e: windows::core::Error| e.to_string())?;
    }
    Ok(())
}

pub fn set_microphone_mute(mute: bool) -> Result<(), String> {
    unsafe {
        ensure_com();
        let cap = default_device(eCapture).map_err(|e: windows::core::Error| e.to_string())?;
        let ev: IAudioEndpointVolume = cap
            .Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None)
            .map_err(|e: windows::core::Error| e.to_string())?;
        ev.SetMute(BOOL::from(mute), std::ptr::null())
            .map_err(|e: windows::core::Error| e.to_string())?;
    }
    Ok(())
}

pub fn set_deafen(mute: bool) -> Result<(), String> {
    set_master_mute(mute)
}

pub fn read_microphone_muted() -> Result<bool, String> {
    unsafe {
        ensure_com();
        let cap = default_device(eCapture).map_err(|e: windows::core::Error| e.to_string())?;
        let ev: IAudioEndpointVolume = cap
            .Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None)
            .map_err(|e: windows::core::Error| e.to_string())?;
        let m = ev
            .GetMute()
            .map_err(|e: windows::core::Error| e.to_string())?;
        Ok(m.as_bool())
    }
}
