
use crate::windows_util;
use serde::{Deserialize, Serialize};
use windows::core::HSTRING;
use windows::Foundation::TimeSpan;
use windows::Media::Capture::{
    AppCaptureHistoricalBufferLengthUnit, AppCaptureManager, AppCaptureSettings, AppCaptureVideoEncodingBitrateMode,
    AppCaptureVideoEncodingFrameRateMode,
};
use windows::Storage::StorageFolder;
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

pub const REPLAY_CHOICES: &[u32] = &[15, 30, 60, 180, 300, 600];
pub const MAX_RECORD_CHOICES: &[u32] = &[30, 60, 120, 240];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GameBarSettings {
    pub background_recording: bool,
    pub replay_seconds: u32,
    pub max_record_minutes: u32,
    pub frame_rate: u32,
    pub quality: String,
    pub system_audio: bool,
    pub microphone: bool,
    pub capture_cursor: bool,
    pub output_folder: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameBarHotkeys {
    pub save_replay: String,
    pub record: String,
    pub screenshot: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameBarStatus {
    pub disabled_by_policy: bool,
    pub settings: GameBarSettings,
    pub hotkeys: GameBarHotkeys,
}

fn winrt() {
    unsafe {
        let _ = RoInitialize(RO_INIT_MULTITHREADED);
    }
}

fn read(s: &AppCaptureSettings) -> windows::core::Result<GameBarSettings> {
    let unit = s.HistoricalBufferLengthUnit()?;
    let length = s.HistoricalBufferLength()?;
    let replay_seconds = if unit == AppCaptureHistoricalBufferLengthUnit::Seconds { length } else { 30 };
    let max = s.MaximumRecordLength()?.Duration / 10_000_000 / 60;
    Ok(GameBarSettings {
        background_recording: s.IsHistoricalCaptureEnabled()?,
        replay_seconds,
        max_record_minutes: max.clamp(1, 24 * 60) as u32,
        frame_rate: if s.VideoEncodingFrameRateMode()? == AppCaptureVideoEncodingFrameRateMode::High { 60 } else { 30 },
        quality: if s.VideoEncodingBitrateMode()? == AppCaptureVideoEncodingBitrateMode::High { "high" } else { "standard" }
            .into(),
        system_audio: s.IsAudioCaptureEnabled()?,
        microphone: s.IsMicrophoneCaptureEnabled()?,
        capture_cursor: s.IsCursorImageCaptureEnabled()?,
        output_folder: s
            .AppCaptureDestinationFolder()
            .and_then(|f| f.Path())
            .map(|p| p.to_string())
            .unwrap_or_default(),
    })
}

pub fn status() -> Option<GameBarStatus> {
    winrt();
    let s = AppCaptureManager::GetCurrentSettings().ok()?;
    Some(GameBarStatus {
        disabled_by_policy: s.IsDisabledByPolicy().unwrap_or(false),
        settings: read(&s).ok()?,
        hotkeys: GameBarHotkeys {
            save_replay: describe(hotkey(Shortcut::SaveReplay)),
            record: describe(hotkey(Shortcut::Record)),
            screenshot: describe(hotkey(Shortcut::Screenshot)),
        },
    })
}

pub fn set_settings(next: GameBarSettings) -> Result<GameBarStatus, String> {
    winrt();
    let e = |e: windows::core::Error| format!("Windows refused the Game Bar setting: {}", e.message());
    let s = AppCaptureManager::GetCurrentSettings().map_err(e)?;
    let cur = read(&s).map_err(e)?;
    let nearest = |choices: &[u32], v: u32| *choices.iter().min_by_key(|c| c.abs_diff(v)).unwrap_or(&v);

    if next.background_recording != cur.background_recording {
        s.SetIsHistoricalCaptureEnabled(next.background_recording).map_err(e)?;
        if next.background_recording {
            s.SetIsAppCaptureEnabled(true).map_err(e)?;
        }
    }
    if next.replay_seconds != cur.replay_seconds {
        s.SetHistoricalBufferLengthUnit(AppCaptureHistoricalBufferLengthUnit::Seconds).map_err(e)?;
        s.SetHistoricalBufferLength(nearest(REPLAY_CHOICES, next.replay_seconds)).map_err(e)?;
    }
    if next.max_record_minutes != cur.max_record_minutes {
        let minutes = nearest(MAX_RECORD_CHOICES, next.max_record_minutes) as i64;
        s.SetMaximumRecordLength(TimeSpan { Duration: minutes * 60 * 10_000_000 }).map_err(e)?;
    }
    if next.frame_rate != cur.frame_rate {
        let mode = if next.frame_rate >= 60 {
            AppCaptureVideoEncodingFrameRateMode::High
        } else {
            AppCaptureVideoEncodingFrameRateMode::Standard
        };
        s.SetVideoEncodingFrameRateMode(mode).map_err(e)?;
    }
    if next.quality != cur.quality {
        let mode = if next.quality == "high" {
            AppCaptureVideoEncodingBitrateMode::High
        } else {
            AppCaptureVideoEncodingBitrateMode::Standard
        };
        s.SetVideoEncodingBitrateMode(mode).map_err(e)?;
    }
    if next.system_audio != cur.system_audio {
        s.SetIsAudioCaptureEnabled(next.system_audio).map_err(e)?;
    }
    if next.microphone != cur.microphone {
        s.SetIsMicrophoneCaptureEnabled(next.microphone).map_err(e)?;
    }
    if next.capture_cursor != cur.capture_cursor {
        s.SetIsCursorImageCaptureEnabled(next.capture_cursor).map_err(e)?;
    }
    let folder = next.output_folder.trim().trim_end_matches(['\\', '/']);
    if !folder.is_empty() && !folder.eq_ignore_ascii_case(cur.output_folder.trim_end_matches(['\\', '/'])) {
        std::fs::create_dir_all(folder).map_err(|err| format!("Can't use that folder: {err}"))?;
        let f = StorageFolder::GetFolderFromPathAsync(&HSTRING::from(folder))
            .and_then(|op| op.get())
            .map_err(e)?;
        s.SetAppCaptureDestinationFolder(&f).map_err(e)?;
    }
    AppCaptureManager::ApplySettings(&s).map_err(e)?;
    status().ok_or_else(|| "Couldn't read Game Bar's settings back".into())
}

#[derive(Clone, Copy)]
pub enum Shortcut {
    SaveReplay,
    Record,
    Screenshot,
}

const MOD_ALT: u32 = 1;
const MOD_WIN: u32 = 8;

fn hotkey(which: Shortcut) -> (u32, u32) {
    let (name, default) = match which {
        Shortcut::SaveReplay => ("SaveHistoricalVideo", (MOD_WIN | MOD_ALT, b'G' as u32)),
        Shortcut::Record => ("ToggleRecording", (MOD_WIN | MOD_ALT, b'R' as u32)),
        Shortcut::Screenshot => ("TakeScreenshot", (MOD_WIN | MOD_ALT, 0x2C)),
    };
    let key = RegKey::predef(HKEY_CURRENT_USER).open_subkey(r"Software\Microsoft\Windows\CurrentVersion\GameDVR");
    let custom = key.ok().and_then(|k| {
        let vk: u32 = k.get_value(format!("VK{name}")).ok()?;
        let mods: u32 = k.get_value(format!("VKM{name}")).unwrap_or(0);
        (vk != 0).then_some((mods, vk))
    });
    custom.unwrap_or(default)
}

pub fn describe((mods, vk): (u32, u32)) -> String {
    let mut parts: Vec<String> = Vec::new();
    for (bit, name) in [(8, "Win"), (2, "Ctrl"), (1, "Alt"), (4, "Shift")] {
        if mods & bit != 0 {
            parts.push(name.into());
        }
    }
    parts.push(match vk {
        0x30..=0x39 | 0x41..=0x5A => char::from_u32(vk).map(String::from).unwrap_or_default(),
        0x70..=0x87 => format!("F{}", vk - 0x6F),
        0x2C => "PrtScn".into(),
        0x20 => "Space".into(),
        _ => format!("Key {vk:#04x}"),
    });
    parts.join("+")
}

pub fn press(which: Shortcut) -> Result<(), String> {
    if status().is_some_and(|s| s.disabled_by_policy) {
        return Err("Game Bar captures are turned off by a Windows policy on this PC.".into());
    }
    let (mods, vk) = hotkey(which);
    windows_util::send_chord(mods, vk)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore]
    fn gamebar_live() {
        let st = status().expect("Game Bar settings");
        println!("{st:#?}");
        let orig = st.settings.clone();
        let mut next = orig.clone();
        next.replay_seconds = if orig.replay_seconds == 60 { 180 } else { 60 };
        next.frame_rate = if orig.frame_rate == 60 { 30 } else { 60 };
        let after = set_settings(next.clone()).expect("apply");
        assert_eq!(after.settings.replay_seconds, next.replay_seconds);
        assert_eq!(after.settings.frame_rate, next.frame_rate);
        let back = set_settings(orig.clone()).expect("restore");
        assert_eq!(back.settings, orig);
        println!("changed and restored: replay {} s, {} fps", orig.replay_seconds, orig.frame_rate);
    }
}
