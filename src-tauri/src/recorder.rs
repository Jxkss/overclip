
use crate::settings::{AppSettings, HotkeySet};
use crate::{amd, gamebar, obs, win_hotkeys, windows_util};
use serde::Serialize;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyAppStatus {
    pub installed: bool,
    pub running: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hotkeys {
    pub save_replay: Option<String>,
    pub record: Option<String>,
    pub screenshot: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Current {
    pub id: String,
    pub name: String,
    pub ready: bool,
    pub problem: Option<String>,
    pub replay_on: Option<bool>,
    pub replay_seconds: Option<u32>,
    pub recording: Option<bool>,
    pub applying: bool,
    pub can_toggle_replay: bool,
    pub can_save: bool,
    pub can_record: bool,
    pub can_screenshot: bool,
    pub hotkeys: Hotkeys,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub selected: String,
    pub current: Option<Current>,
    pub amd: Option<amd::AmdStatus>,
    pub gamebar: Option<gamebar::GameBarStatus>,
    pub obs: obs::ObsStatus,
    pub nvidia: HotkeyAppStatus,
    pub medal: HotkeyAppStatus,
}

fn program_files(rel: &str) -> bool {
    std::env::var_os("ProgramFiles").is_some_and(|p| PathBuf::from(p).join(rel).exists())
}

fn nvidia() -> HotkeyAppStatus {
    HotkeyAppStatus {
        installed: program_files(r"NVIDIA Corporation\NVIDIA app") || program_files(r"NVIDIA Corporation\NVIDIA GeForce Experience"),
        running: windows_util::process_running(&["NVIDIA Overlay.exe", "NVIDIA Share.exe"]),
    }
}

fn medal() -> HotkeyAppStatus {
    HotkeyAppStatus {
        installed: std::env::var_os("LOCALAPPDATA").is_some_and(|p| PathBuf::from(p).join("Medal").is_dir()),
        running: windows_util::process_running(&["Medal.exe"]),
    }
}

pub fn name(id: &str) -> &'static str {
    match id {
        "amd" => "AMD Software",
        "gamebar" => "Xbox Game Bar",
        "obs" => "OBS Studio",
        "nvidia" => "NVIDIA App",
        "medal" => "Medal",
        _ => "Recorder",
    }
}

pub fn overview(s: &AppSettings) -> Overview {
    let amd = Some(amd::status()).filter(|a| a.installed);
    let gamebar = gamebar::status();
    let obs = if obs::installed() {
        obs::status()
    } else {
        obs::ObsStatus {
            installed: false,
            running: false,
            connection: "closed".into(),
            message: None,
            replay_available: false,
            replay_active: false,
            recording: false,
            advanced_mode: false,
            settings: None,
        }
    };
    let (nvidia, medal) = (nvidia(), medal());

    let id = match s.recorder.as_str() {
        "auto" => {
            if amd.is_some() {
                Some("amd")
            } else if nvidia.installed {
                Some("nvidia")
            } else if obs.connection == "ok" {
                Some("obs")
            } else if medal.installed {
                Some("medal")
            } else if gamebar.as_ref().is_some_and(|g| !g.disabled_by_policy) {
                Some("gamebar")
            } else if obs.installed {
                Some("obs")
            } else {
                None
            }
        }
        other => Some(other),
    };
    let current = id.map(|id| current_for(id, s, &amd, &gamebar, &obs, &nvidia, &medal));
    Overview {
        selected: s.recorder.clone(),
        current,
        amd,
        gamebar,
        obs,
        nvidia,
        medal,
    }
}

fn hotkey_current(id: &str, app: &HotkeyAppStatus, keys: &HotkeySet) -> Current {
    let key = |k: &String| Some(k.clone()).filter(|k| !k.trim().is_empty());
    Current {
        id: id.into(),
        name: name(id).into(),
        ready: app.installed,
        problem: (!app.installed).then(|| format!("{} wasn't found on this PC.", name(id))),
        replay_on: None,
        replay_seconds: None,
        recording: None,
        applying: false,
        can_toggle_replay: false,
        can_save: key(&keys.save_replay).is_some(),
        can_record: key(&keys.record).is_some(),
        can_screenshot: key(&keys.screenshot).is_some(),
        hotkeys: Hotkeys {
            save_replay: key(&keys.save_replay),
            record: key(&keys.record),
            screenshot: key(&keys.screenshot),
        },
    }
}

fn current_for(
    id: &str,
    s: &AppSettings,
    amd: &Option<amd::AmdStatus>,
    gamebar: &Option<gamebar::GameBarStatus>,
    obs: &obs::ObsStatus,
    nvidia: &HotkeyAppStatus,
    medal: &HotkeyAppStatus,
) -> Current {
    let missing = |problem: String| Current {
        id: id.into(),
        name: name(id).into(),
        ready: false,
        problem: Some(problem),
        replay_on: None,
        replay_seconds: None,
        recording: None,
        applying: false,
        can_toggle_replay: false,
        can_save: false,
        can_record: false,
        can_screenshot: false,
        hotkeys: Hotkeys::default(),
    };
    match id {
        "amd" => match amd.as_ref().and_then(|a| a.settings.as_ref().map(|st| (a, st))) {
            Some((a, st)) => Current {
                id: id.into(),
                name: name(id).into(),
                ready: a.running && !a.applying,
                problem: (!a.running).then(|| "AMD Software isn't running.".to_string()),
                replay_on: Some(st.instant_replay),
                replay_seconds: Some(st.replay_seconds),
                recording: Some(a.recording),
                applying: a.applying,
                can_toggle_replay: a.running,
                can_save: a.running && st.instant_replay,
                can_record: a.running,
                can_screenshot: a.running,
                hotkeys: Hotkeys {
                    save_replay: a.hotkeys.save_replay.clone(),
                    record: a.hotkeys.record.clone(),
                    screenshot: a.hotkeys.screenshot.clone(),
                },
            },
            None => missing("AMD Software wasn't found on this PC.".into()),
        },
        "gamebar" => match gamebar {
            Some(g) => Current {
                id: id.into(),
                name: name(id).into(),
                ready: !g.disabled_by_policy,
                problem: g
                    .disabled_by_policy
                    .then(|| "Game Bar captures are turned off by a Windows policy on this PC.".to_string()),
                replay_on: Some(g.settings.background_recording),
                replay_seconds: Some(g.settings.replay_seconds),
                recording: None,
                applying: false,
                can_toggle_replay: !g.disabled_by_policy,
                can_save: !g.disabled_by_policy && g.settings.background_recording,
                can_record: !g.disabled_by_policy,
                can_screenshot: !g.disabled_by_policy,
                hotkeys: Hotkeys {
                    save_replay: Some(g.hotkeys.save_replay.clone()),
                    record: Some(g.hotkeys.record.clone()),
                    screenshot: Some(g.hotkeys.screenshot.clone()),
                },
            },
            None => missing("Xbox Game Bar isn't available on this PC.".into()),
        },
        "obs" => {
            if !obs.installed {
                return missing("OBS Studio wasn't found on this PC.".into());
            }
            let ok = obs.connection == "ok";
            Current {
                id: id.into(),
                name: name(id).into(),
                ready: ok,
                problem: if ok {
                    None
                } else {
                    Some(obs.message.clone().unwrap_or_else(|| "OBS isn't running.".into()))
                },
                replay_on: ok.then_some(obs.replay_active),
                replay_seconds: obs.settings.as_ref().map(|st| st.replay_seconds),
                recording: ok.then_some(obs.recording),
                applying: false,
                can_toggle_replay: ok,
                can_save: ok && obs.replay_active,
                can_record: ok,
                can_screenshot: ok,
                hotkeys: Hotkeys::default(),
            }
        }
        "nvidia" => hotkey_current(id, nvidia, &s.recorder_hotkeys.nvidia),
        "medal" => hotkey_current(id, medal, &s.recorder_hotkeys.medal),
        _ => missing("Unknown recorder.".into()),
    }
}

pub fn hide_overlay_first(id: &str, action: &str, recording: Option<bool>) -> bool {
    match id {
        "gamebar" | "nvidia" | "medal" => true,
        _ => action == "screenshot" || (action == "toggleRecording" && recording != Some(true)),
    }
}

fn press(combo: &str, what: &str, recorder: &str) -> Result<(), String> {
    if combo.trim().is_empty() {
        return Err(format!("No {what} key is set for {} in Settings › Recording.", name(recorder)));
    }
    let (mods, vk) = win_hotkeys::parse_shortcut(combo).ok_or_else(|| format!("\"{combo}\" isn't a valid shortcut"))?;
    windows_util::send_chord(mods, vk)
}

pub fn run(id: &str, s: &AppSettings, action: &str, recording: Option<bool>) -> Result<Option<String>, String> {
    match (id, action) {
        ("amd", "saveReplay") => amd::run(amd::Action::SaveReplay).map(|_| None),
        ("amd", "screenshot") => amd::run(amd::Action::Screenshot).map(|_| None),
        ("amd", "toggleRecording") => amd::run(if recording == Some(true) {
            amd::Action::StopRecording
        } else {
            amd::Action::StartRecording
        })
        .map(|_| None),
        ("gamebar", "saveReplay") => gamebar::press(gamebar::Shortcut::SaveReplay).map(|_| None),
        ("gamebar", "toggleRecording") => gamebar::press(gamebar::Shortcut::Record).map(|_| None),
        ("gamebar", "screenshot") => gamebar::press(gamebar::Shortcut::Screenshot).map(|_| None),
        ("obs", "saveReplay") => obs::run(obs::Action::SaveReplay),
        ("obs", "toggleRecording") => obs::run(obs::Action::ToggleRecording),
        ("obs", "screenshot") => obs::run(obs::Action::Screenshot),
        ("nvidia" | "medal", _) => {
            let keys = if id == "nvidia" { &s.recorder_hotkeys.nvidia } else { &s.recorder_hotkeys.medal };
            match action {
                "saveReplay" => press(&keys.save_replay, "Save replay", id),
                "toggleRecording" => press(&keys.record, "Record", id),
                "screenshot" => press(&keys.screenshot, "Screenshot", id),
                _ => Err(format!("Unknown recorder action {action}")),
            }
            .map(|_| None)
        }
        _ => Err(format!("{} can't do that.", name(id))),
    }
}

pub fn set_replay(id: &str, on: bool, notify: amd::Notify) -> Result<(), String> {
    match id {
        "amd" => {
            let mut st = amd::status().settings.ok_or("AMD Software isn't installed")?;
            st.instant_replay = on;
            amd::set_settings(notify, st).map(|_| ())
        }
        "gamebar" => {
            let mut st = gamebar::status().ok_or("Game Bar isn't available")?.settings;
            st.background_recording = on;
            gamebar::set_settings(st).map(|_| ())
        }
        "obs" => obs::set_replay(on),
        _ => Err(format!("{} doesn't let other apps switch its replay on or off.", name(id))),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore]
    fn recorder_overview() {
        let o = super::overview(&crate::settings::AppSettings::default());
        println!("selected={} current={:#?}", o.selected, o.current);
        println!("amd installed={} gamebar policy-off={:?} obs connection={} ({:?}) nvidia={:?} medal={:?}",
            o.amd.is_some(), o.gamebar.as_ref().map(|g| g.disabled_by_policy), o.obs.connection, o.obs.message, o.nvidia, o.medal);
    }
}
