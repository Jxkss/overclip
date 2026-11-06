
use crate::windows_util;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant};
use tungstenite::{Message, WebSocket};

pub const QUALITIES: &[&str] = &["Stream", "Small", "HQ", "Lossless"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ObsSettings {
    pub replay_seconds: u32,
    pub record_folder: String,
    pub frame_rate: u32,
    pub quality: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObsStatus {
    pub installed: bool,
    pub running: bool,
    pub connection: String,
    pub message: Option<String>,
    pub replay_available: bool,
    pub replay_active: bool,
    pub recording: bool,
    pub advanced_mode: bool,
    pub settings: Option<ObsSettings>,
}

fn obs_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("OVERCLIP_OBS_DIR") {
        return Some(PathBuf::from(dir));
    }
    std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("obs-studio"))
}

fn ws_config_path() -> Option<PathBuf> {
    obs_dir().map(|d| d.join(r"plugin_config\obs-websocket\config.json"))
}

struct WsConfig {
    enabled: bool,
    port: u16,
    password: Option<String>,
}

fn ws_config() -> Option<WsConfig> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(ws_config_path()?).ok()?).ok()?;
    let auth = v["auth_required"].as_bool().unwrap_or(true);
    Some(WsConfig {
        enabled: v["server_enabled"].as_bool().unwrap_or(false),
        port: v["server_port"].as_u64().unwrap_or(4455) as u16,
        password: auth.then(|| v["server_password"].as_str().unwrap_or_default().to_string()),
    })
}

pub fn installed() -> bool {
    let program = std::env::var_os("ProgramFiles").map(|p| PathBuf::from(p).join(r"obs-studio\bin\64bit\obs64.exe"));
    program.is_some_and(|p| p.is_file()) || obs_dir().is_some_and(|d| d.join("basic").is_dir())
}

pub fn running() -> bool {
    windows_util::process_running(&["obs64.exe"])
}

pub fn enable_remote_control() -> Result<(), String> {
    if running() {
        return Err(
            "Close OBS first, or turn it on in OBS: Tools › WebSocket Server Settings › Enable WebSocket server.".into(),
        );
    }
    let path = ws_config_path().ok_or("OBS's settings folder wasn't found")?;
    let mut v: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}));
    v["server_enabled"] = json!(true);
    if v["server_port"].as_u64().is_none() {
        v["server_port"] = json!(4455);
    }
    let auth = v["auth_required"].as_bool().unwrap_or(true);
    v["auth_required"] = json!(auth);
    if auth && v["server_password"].as_str().unwrap_or_default().is_empty() {
        v["server_password"] = json!(random_password());
    }
    if v["first_load"].is_null() {
        v["first_load"] = json!(false);
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(&v).unwrap_or_default()).map_err(|e| e.to_string())
}

fn random_password() -> String {
    const ABC: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    let mut bytes = [0u8; 20];
    let _ = getrandom::getrandom(&mut bytes);
    bytes.iter().map(|b| ABC[*b as usize % ABC.len()] as char).collect()
}

enum ConnError {
    Closed,
    Off,
    Auth,
    Other(String),
}

struct Obs {
    ws: WebSocket<TcpStream>,
    next: u32,
}

fn b64_sha256(s: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(Sha256::digest(s.as_bytes()))
}

impl Obs {
    fn connect() -> Result<Self, ConnError> {
        if !running() {
            return Err(ConnError::Closed);
        }
        let cfg = ws_config().ok_or(ConnError::Off)?;
        if !cfg.enabled {
            return Err(ConnError::Off);
        }
        let addr = SocketAddr::from(([127, 0, 0, 1], cfg.port));
        let stream = TcpStream::connect_timeout(&addr, Duration::from_millis(500)).map_err(|_| ConnError::Off)?;
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let url = format!("ws://127.0.0.1:{}", cfg.port);
        let (ws, _) = tungstenite::client(url.as_str(), stream).map_err(|e| ConnError::Other(e.to_string()))?;
        let mut obs = Obs { ws, next: 0 };
        let hello = obs.read_op(0).map_err(ConnError::Other)?;
        let mut identify = json!({ "rpcVersion": 1, "eventSubscriptions": 0 });
        if let Some(a) = hello.get("authentication") {
            let password = cfg.password.unwrap_or_default();
            let secret = b64_sha256(&format!("{password}{}", a["salt"].as_str().unwrap_or_default()));
            identify["authentication"] = json!(b64_sha256(&format!("{secret}{}", a["challenge"].as_str().unwrap_or_default())));
        }
        obs.send(json!({ "op": 1, "d": identify })).map_err(ConnError::Other)?;
        obs.read_op(2).map_err(|_| ConnError::Auth)?;
        Ok(obs)
    }

    fn send(&mut self, v: Value) -> Result<(), String> {
        self.ws.send(Message::Text(v.to_string())).map_err(|e| e.to_string())
    }

    fn read_op(&mut self, op: u64) -> Result<Value, String> {
        loop {
            match self.ws.read().map_err(|e| e.to_string())? {
                Message::Text(t) => {
                    let v: Value = serde_json::from_str(&t).map_err(|e| e.to_string())?;
                    if v["op"].as_u64() == Some(op) {
                        return Ok(v["d"].clone());
                    }
                }
                Message::Close(_) => return Err("OBS closed the connection".into()),
                _ => {}
            }
        }
    }

    fn call(&mut self, kind: &str, data: Value) -> Result<Value, (u64, String)> {
        self.next += 1;
        let id = self.next.to_string();
        self.send(json!({ "op": 6, "d": { "requestType": kind, "requestId": id, "requestData": data } }))
            .map_err(|e| (0, e))?;
        loop {
            let d = self.read_op(7).map_err(|e| (0, e))?;
            if d["requestId"].as_str() != Some(id.as_str()) {
                continue;
            }
            let st = &d["requestStatus"];
            if st["result"].as_bool() == Some(true) {
                return Ok(d.get("responseData").cloned().unwrap_or(Value::Null));
            }
            let code = st["code"].as_u64().unwrap_or(0);
            let comment = st["comment"].as_str().unwrap_or("OBS refused the request").to_string();
            return Err((code, comment));
        }
    }

    fn get(&mut self, kind: &str) -> Value {
        self.call(kind, json!({})).unwrap_or(Value::Null)
    }

    fn profile_param(&mut self, category: &str, name: &str) -> Option<String> {
        let v = self
            .call("GetProfileParameter", json!({ "parameterCategory": category, "parameterName": name }))
            .ok()?;
        v["parameterValue"].as_str().map(str::to_string)
    }

    fn set_profile_param(&mut self, category: &str, name: &str, value: &str) -> Result<(), String> {
        self.call(
            "SetProfileParameter",
            json!({ "parameterCategory": category, "parameterName": name, "parameterValue": value }),
        )
        .map(|_| ())
        .map_err(|(_, e)| e)
    }

    fn advanced(&mut self) -> bool {
        self.profile_param("Output", "Mode").as_deref() == Some("Advanced")
    }

    fn output_section(&mut self) -> &'static str {
        if self.advanced() {
            "AdvOut"
        } else {
            "SimpleOutput"
        }
    }

    fn replay_state(&mut self) -> (bool, bool) {
        match self.call("GetReplayBufferStatus", json!({})) {
            Ok(v) => (true, v["outputActive"].as_bool().unwrap_or(false)),
            Err(_) => (false, false),
        }
    }

    fn recording(&mut self) -> bool {
        self.get("GetRecordStatus")["outputActive"].as_bool().unwrap_or(false)
    }

    fn streaming(&mut self) -> bool {
        self.get("GetStreamStatus")["outputActive"].as_bool().unwrap_or(false)
    }

    fn wait_replay(&mut self, active: bool) {
        let until = Instant::now() + Duration::from_secs(6);
        while Instant::now() < until && self.replay_state().1 != active {
            thread::sleep(Duration::from_millis(150));
        }
    }

    fn settings(&mut self) -> ObsSettings {
        let section = self.output_section();
        let video = self.get("GetVideoSettings");
        let num = video["fpsNumerator"].as_f64().unwrap_or(30.0);
        let den = video["fpsDenominator"].as_f64().unwrap_or(1.0).max(1.0);
        ObsSettings {
            replay_seconds: self.profile_param(section, "RecRBTime").and_then(|v| v.parse().ok()).unwrap_or(20),
            record_folder: self.get("GetRecordDirectory")["recordDirectory"].as_str().unwrap_or_default().to_string(),
            frame_rate: (num / den).round() as u32,
            quality: if section == "SimpleOutput" {
                Some(self.profile_param("SimpleOutput", "RecQuality").unwrap_or_else(|| "Stream".into()))
            } else {
                None
            },
        }
    }

    fn create_replay_buffer(&mut self) -> Result<(), String> {
        if self.recording() || self.streaming() {
            return Err("Turn on the replay buffer in OBS (Settings › Output › Replay Buffer), or stop recording and streaming first so Overclip can.".into());
        }
        let section = self.output_section();
        self.set_profile_param(section, "RecRB", "true")?;
        let list = self.get("GetProfileList");
        let current = list["currentProfileName"].as_str().unwrap_or_default().to_string();
        let other = list["profiles"]
            .as_array()
            .and_then(|p| p.iter().filter_map(Value::as_str).find(|p| *p != current).map(str::to_string));
        let switch = |obs: &mut Obs, name: &str| obs.call("SetCurrentProfile", json!({ "profileName": name })).map_err(|(_, e)| e);
        match other {
            Some(other) => {
                switch(self, &other)?;
                switch(self, &current)?;
            }
            None => {
                let tmp = "Overclip (temporary)";
                self.call("CreateProfile", json!({ "profileName": tmp })).map_err(|(_, e)| e)?;
                switch(self, &current)?;
                let _ = self.call("RemoveProfile", json!({ "profileName": tmp }));
            }
        }
        if self.replay_state().0 {
            Ok(())
        } else {
            Err("OBS didn't create the replay buffer. Turn it on in OBS: Settings › Output › Replay Buffer.".into())
        }
    }
}

fn conn_error(e: ConnError) -> String {
    match e {
        ConnError::Closed => "OBS isn't running.".into(),
        ConnError::Off => "OBS's remote control is off. Turn it on in Settings › Recording.".into(),
        ConnError::Auth => "OBS rejected the password from its own settings file. Restart OBS and try again.".into(),
        ConnError::Other(e) => format!("Couldn't talk to OBS: {e}"),
    }
}

pub fn status() -> ObsStatus {
    let installed = installed();
    let running = installed && running();
    let mut st = ObsStatus {
        installed,
        running,
        connection: "closed".into(),
        message: None,
        replay_available: false,
        replay_active: false,
        recording: false,
        advanced_mode: false,
        settings: None,
    };
    if !running {
        return st;
    }
    match Obs::connect() {
        Ok(mut obs) => {
            st.connection = "ok".into();
            (st.replay_available, st.replay_active) = obs.replay_state();
            st.recording = obs.recording();
            st.advanced_mode = obs.advanced();
            st.settings = Some(obs.settings());
        }
        Err(e) => {
            st.connection = match e {
                ConnError::Off => "off",
                ConnError::Auth => "auth",
                ConnError::Closed => "closed",
                ConnError::Other(_) => "error",
            }
            .into();
            st.message = Some(conn_error(e));
        }
    }
    st
}

pub fn set_replay(on: bool) -> Result<(), String> {
    let mut obs = Obs::connect().map_err(conn_error)?;
    let (available, active) = obs.replay_state();
    if on == active {
        return Ok(());
    }
    if on {
        if !available {
            obs.create_replay_buffer()?;
        }
        obs.call("StartReplayBuffer", json!({})).map_err(|(_, e)| e)?;
    } else {
        obs.call("StopReplayBuffer", json!({})).map_err(|(_, e)| e)?;
    }
    Ok(())
}

pub fn set_settings(next: ObsSettings) -> Result<ObsStatus, String> {
    let mut obs = Obs::connect().map_err(conn_error)?;
    let cur = obs.settings();
    let section = obs.output_section();
    let (_, replay_was_on) = obs.replay_state();
    let mut restart_replay = false;

    let folder = next.record_folder.trim().trim_end_matches(['\\', '/']).to_string();
    if !folder.is_empty() && folder != cur.record_folder.trim_end_matches(['\\', '/']) {
        std::fs::create_dir_all(&folder).map_err(|e| format!("Can't use that folder: {e}"))?;
        obs.call("SetRecordDirectory", json!({ "recordDirectory": folder })).map_err(|(_, e)| e)?;
        restart_replay = true;
    }
    if next.replay_seconds != cur.replay_seconds {
        let secs = next.replay_seconds.clamp(5, 21_600);
        obs.set_profile_param(section, "RecRBTime", &secs.to_string())?;
        restart_replay = true;
    }
    if let Some(q) = next.quality.as_deref().filter(|q| Some(*q) != cur.quality.as_deref()) {
        if section == "SimpleOutput" && QUALITIES.contains(&q) {
            obs.set_profile_param("SimpleOutput", "RecQuality", q)?;
            restart_replay = true;
        }
    }
    if next.frame_rate != cur.frame_rate {
        if obs.recording() || obs.streaming() {
            return Err("OBS can't change the frame rate while recording or streaming.".into());
        }
        if replay_was_on {
            let _ = obs.call("StopReplayBuffer", json!({}));
            obs.wait_replay(false);
        }
        let res = obs.call("SetVideoSettings", json!({ "fpsNumerator": next.frame_rate.clamp(10, 240), "fpsDenominator": 1 }));
        if replay_was_on {
            let _ = obs.call("StartReplayBuffer", json!({}));
        }
        res.map_err(|(_, e)| e)?;
        restart_replay = false;
    }
    if restart_replay && replay_was_on {
        let _ = obs.call("StopReplayBuffer", json!({}));
        obs.wait_replay(false);
        obs.call("StartReplayBuffer", json!({})).map_err(|(_, e)| e)?;
    }
    drop(obs);
    Ok(status())
}

pub enum Action {
    SaveReplay,
    ToggleRecording,
    Screenshot,
}

pub fn run(action: Action) -> Result<Option<String>, String> {
    let mut obs = Obs::connect().map_err(conn_error)?;
    match action {
        Action::SaveReplay => {
            if !obs.replay_state().1 {
                return Err("OBS's replay buffer is off. Turn it on first.".into());
            }
            obs.call("SaveReplayBuffer", json!({})).map_err(|(_, e)| e)?;
            Ok(None)
        }
        Action::ToggleRecording => {
            if obs.recording() {
                let v = obs.call("StopRecord", json!({})).map_err(|(_, e)| e)?;
                Ok(v["outputPath"].as_str().map(str::to_string))
            } else {
                obs.call("StartRecord", json!({})).map_err(|(_, e)| e)?;
                Ok(None)
            }
        }
        Action::Screenshot => {
            let scene = obs.get("GetCurrentProgramScene")["currentProgramSceneName"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            let dir = obs.settings().record_folder;
            if scene.is_empty() || dir.is_empty() {
                return Err("OBS has no scene or recording folder to take a screenshot with.".into());
            }
            let path = PathBuf::from(dir).join(format!("Screenshot {}.png", chrono::Local::now().format("%Y-%m-%d %H-%M-%S")));
            obs.call(
                "SaveSourceScreenshot",
                json!({ "sourceName": scene, "imageFormat": "png", "imageFilePath": path.to_string_lossy() }),
            )
            .map_err(|(_, e)| e)?;
            Ok(Some(path.to_string_lossy().into_owned()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn newest_in(dir: &str, ext: &str) -> Option<PathBuf> {
        std::fs::read_dir(dir)
            .ok()?
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case(ext)))
            .max_by_key(|p| p.metadata().and_then(|m| m.modified()).ok())
    }

    fn seconds(p: &PathBuf) -> f64 {
        let out = std::process::Command::new("ffprobe")
            .args(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0"])
            .arg(p)
            .output()
            .expect("ffprobe");
        String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0.0)
    }

    #[test]
    #[ignore]
    fn obs_live() {
        assert!(std::env::var_os("OVERCLIP_OBS_DIR").is_some(), "set OVERCLIP_OBS_DIR to a test OBS");
        let st = status();
        println!("{st:#?}");
        assert_eq!(st.connection, "ok");
        let orig = st.settings.clone().unwrap();

        set_replay(false).unwrap();
        let mut next = orig.clone();
        next.replay_seconds = 25;
        let after = set_settings(next).unwrap();
        assert_eq!(after.settings.as_ref().unwrap().replay_seconds, 25);
        set_replay(true).unwrap();
        assert!(status().replay_active, "replay buffer should be running");
        thread::sleep(Duration::from_secs(30));
        run(Action::SaveReplay).unwrap();
        thread::sleep(Duration::from_secs(4));
        let clip = newest_in(&orig.record_folder, "mp4").expect("replay file");
        println!("replay: {} ({:.1} s)", clip.display(), seconds(&clip));
        assert!(seconds(&clip) > 15.0);

        run(Action::ToggleRecording).unwrap();
        thread::sleep(Duration::from_secs(3));
        assert!(status().recording);
        let rec = run(Action::ToggleRecording).unwrap();
        println!("recording: {rec:?}");
        assert!(rec.is_some());

        let shot = run(Action::Screenshot).unwrap().expect("screenshot path");
        assert!(PathBuf::from(&shot).is_file(), "{shot}");
        println!("screenshot: {shot}");

        set_replay(false).unwrap();
        set_settings(orig.clone()).unwrap();
        assert_eq!(status().settings.unwrap(), orig);
    }
}
