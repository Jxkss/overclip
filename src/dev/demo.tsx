import { emit } from "@tauri-apps/api/event";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type {
  AmdStatus,
  AppSettings,
  AudioMixerState,
  ClipEntry,
  CurrentRecorder,
  GameBarStatus,
  ObsStatus,
  RecorderId,
  RecorderOverview,
  RecorderSettings,
  ScreenshotEntry,
} from "../types/ipc";

const DAY = 86_400_000;

const GAMES: { name: string; sky: [string, string]; ground: string; accent: string }[] = [
  { name: "Neon Drift", sky: ["#1b0b3a", "#ff2d95"], ground: "#120724", accent: "#00e5ff" },
  { name: "Skyforge Legends", sky: ["#5aa9ff", "#ffe2a8"], ground: "#2f6b3a", accent: "#ffffff" },
  { name: "Dust & Daggers", sky: ["#f4a259", "#ffd9a0"], ground: "#8c4a1e", accent: "#3b1f0e" },
  { name: "Frostline", sky: ["#0d2b45", "#9fd3ff"], ground: "#e8f4ff", accent: "#3a7bd5" },
  { name: "Pixel Kart", sky: ["#4cc9f0", "#b8f2e6"], ground: "#57cc99", accent: "#ff595e" },
  { name: "Night Shift", sky: ["#020617", "#1e293b"], ground: "#0f172a", accent: "#facc15" },
  { name: "Orbital", sky: ["#000000", "#312e81"], ground: "#1e1b4b", accent: "#a78bfa" },
];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function rand(seed: number) {
  let x = seed || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 10000) / 10000;
  };
}

function sceneSvg(gameName: string, seedText: string): string {
  const g = GAMES.find((x) => x.name === gameName) ?? GAMES[0];
  const r = rand(hash(seedText));
  const hills = Array.from({ length: 3 }, (_, layer) => {
    const base = 120 + layer * 22;
    let d = `M0 ${base}`;
    for (let x = 0; x <= 320; x += 40) d += ` L${x} ${base - r() * 40}`;
    d += " L320 180 L0 180Z";
    return `<path d="${d}" fill="${g.ground}" opacity="${0.55 + layer * 0.2}"/>`;
  }).join("");
  const sparks = Array.from({ length: 6 }, () => {
    const cx = (r() * 320).toFixed(0);
    const cy = (r() * 100).toFixed(0);
    const rr = (2 + r() * 8).toFixed(1);
    return `<circle cx="${cx}" cy="${cy}" r="${rr}" fill="${g.accent}" opacity="${(0.3 + r() * 0.6).toFixed(2)}"/>`;
  }).join("");
  const sun = `<circle cx="${(60 + r() * 200).toFixed(0)}" cy="${(40 + r() * 30).toFixed(0)}" r="${(14 + r() * 14).toFixed(0)}" fill="${g.accent}" opacity=".85"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180" width="320" height="180"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${g.sky[0]}"/><stop offset="1" stop-color="${g.sky[1]}"/></linearGradient></defs><rect width="320" height="180" fill="url(#s)"/>${sun}${sparks}${hills}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (d: Date) =>
  `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} - ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;

function makeClips(): ClipEntry[] {
  const r = rand(42);
  const now = Date.now();
  return Array.from({ length: 64 }, (_, i) => {
    const game = GAMES[Math.floor(r() * GAMES.length)];
    const at = now - Math.floor(i * 0.4 * DAY + r() * 0.35 * DAY);
    const d = new Date(at);
    const external = r() < 0.3;
    const library = external ? "D:\\Clips" : "C:\\Users\\you\\Videos\\Captures";
    const fileName = `${game.name} ${stamp(d)}.mp4`;
    return {
      id: `c${hash(fileName).toString(16).padStart(16, "0")}`,
      path: `${library}\\${game.name}\\${fileName}`,
      fileName,
      gameName: game.name,
      capturedAtMs: at,
      durationMs: Math.round((15 + r() * 105) * 1000),
      sizeBytes: Math.round((25 + r() * 380) * 1024 * 1024),
      extension: "mp4",
      library,
    };
  });
}

function makeShots(): ScreenshotEntry[] {
  const r = rand(7);
  const now = Date.now();
  return Array.from({ length: 48 }, (_, i) => {
    const at = now - Math.floor(i * 0.9 * DAY + r() * 0.5 * DAY);
    const d = new Date(at);
    const fileName = `Screenshot ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`;
    return {
      id: `s${hash(fileName).toString(16).padStart(16, "0")}`,
      path: `C:\\Users\\you\\Pictures\\Screenshots\\${fileName}`,
      fileName,
      month: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`,
      capturedAtMs: at,
      sizeBytes: Math.round((0.4 + r() * 4) * 1024 * 1024),
      extension: "png",
    };
  });
}

const DEFAULTS: AppSettings = {
  clipsDirectory: "C:\\Users\\you\\Videos\\Captures",
  extraClipDirectories: ["D:\\Clips"],
  screenshotsDirectory: "C:\\Users\\you\\Pictures\\Screenshots",
  overlayShortcut: "Ctrl+Alt+P",
  panelShortcut: "Ctrl+P",
  theme: "dark",
  startupWithWindows: true,
  setupComplete: true,
  micHotkeys: false,
  recorderControls: true,
  screenshotsFromClipFolders: true,
  recorder: "auto",
  recorderHotkeys: {
    nvidia: { saveReplay: "Alt+F10", record: "Alt+F9", screenshot: "Alt+F1" },
    medal: { saveReplay: "F8", record: "", screenshot: "" },
  },
  ui: {
    accent: "#76b900",
    scale: 1,
    dim: 0.72,
    animations: true,
    gallerySize: "comfortable",
    panelSide: "left",
    panelWidth: 460,
    density: "m",
    hoverPreview: true,
    autoplay: true,
    confirmDelete: true,
    newBadges: true,
    groupByDay: true,
    showCovers: true,
    clickOutsideCloses: true,
    trayOpens: "gallery",
    startTab: "remember",
  },
};

const MIXER: AudioMixerState = {
  outputDeviceName: "Speakers",
  masterVolume: 0.8,
  masterMuted: false,
  masterCapable: true,
  micMuted: false,
  micCapable: true,
  deafened: false,
  sessions: [
    { id: "a", name: "Neon Drift", volume: 0.9, muted: false, processId: 4120, iconDataUrl: null, controllable: true },
    { id: "b", name: "Discord", volume: 0.65, muted: false, processId: 8812, iconDataUrl: null, controllable: true },
    { id: "c", name: "Spotify", volume: 0.35, muted: false, processId: 9930, iconDataUrl: null, controllable: true },
    { id: "d", name: "System sounds", volume: 1, muted: true, processId: 0, iconDataUrl: null, controllable: true },
  ],
};

export function installDemoBackend() {
  const label = location.hash.startsWith("#/setup") ? "setup" : "overlay";
  mockWindows(label, "overlay", "setup");

  let settings: AppSettings = structuredClone(DEFAULTS);
  const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
  if (params.get("accent")) settings.ui.accent = `#${params.get("accent")}`;
  if (params.get("theme") === "black") settings.theme = "black";
  const pick = params.get("recorder");
  if (pick === "amd" || pick === "gamebar" || pick === "obs" || pick === "nvidia" || pick === "medal") settings.recorder = pick;
  let clips = makeClips();
  let shots = makeShots();
  let clipGen = 1;
  let shotGen = 1;
  const mixer = structuredClone(MIXER);
  let amd: AmdStatus = {
    installed: params.get("amd") !== "0",
    running: true,
    recording: false,
    applying: false,
    codecs: ["AVC", "HEVC"],
    hotkeys: { saveReplay: "Ctrl+Shift+S", screenshot: "Ctrl+Shift+I", record: "Ctrl+Shift+E" },
    settings: {
      instantReplay: true,
      replaySeconds: 60,
      outputFolder: "D:\\Clips",
      resolution: "InGame",
      frameRate: 60,
      bitrateKbps: 30000,
      codec: "AVC",
      systemAudio: true,
      microphone: true,
      micVolume: 80,
      stereoAudio: true,
      recordDesktop: false,
    },
  };
  let gamebar: GameBarStatus = {
    disabledByPolicy: false,
    hotkeys: { saveReplay: "Win+Alt+G", record: "Win+Alt+R", screenshot: "Win+Alt+PrtScn" },
    settings: {
      backgroundRecording: true,
      replaySeconds: 30,
      maxRecordMinutes: 120,
      frameRate: 60,
      quality: "high",
      systemAudio: true,
      microphone: false,
      captureCursor: false,
      outputFolder: "C:\Users\you\Videos\Captures",
    },
  };
  let obs: ObsStatus = {
    installed: true,
    running: true,
    connection: "ok",
    message: null,
    replayAvailable: true,
    replayActive: true,
    recording: false,
    advancedMode: false,
    settings: { replaySeconds: 30, recordFolder: "C:\Users\you\Videos", frameRate: 60, quality: "Small" },
  };
  const NAMES: Record<RecorderId, string> = {
    amd: "AMD Software",
    gamebar: "Xbox Game Bar",
    obs: "OBS Studio",
    nvidia: "NVIDIA App",
    medal: "Medal",
  };
  const overview = (): RecorderOverview => {
    const id: RecorderId = settings.recorder === "auto" ? (amd.installed ? "amd" : "obs") : settings.recorder;
    const base = { id, name: NAMES[id], ready: true, problem: null, applying: false };
    let current: CurrentRecorder;
    if (id === "amd") {
      current = {
        ...base,
        replayOn: amd.settings!.instantReplay,
        replaySeconds: amd.settings!.replaySeconds,
        recording: amd.recording,
        canToggleReplay: true,
        canSave: amd.settings!.instantReplay,
        canRecord: true,
        canScreenshot: true,
        hotkeys: amd.hotkeys,
      };
    } else if (id === "gamebar") {
      current = {
        ...base,
        replayOn: gamebar.settings.backgroundRecording,
        replaySeconds: gamebar.settings.replaySeconds,
        recording: null,
        canToggleReplay: true,
        canSave: gamebar.settings.backgroundRecording,
        canRecord: true,
        canScreenshot: true,
        hotkeys: gamebar.hotkeys,
      };
    } else if (id === "obs") {
      current = {
        ...base,
        replayOn: obs.replayActive,
        replaySeconds: obs.settings!.replaySeconds,
        recording: obs.recording,
        canToggleReplay: true,
        canSave: obs.replayActive,
        canRecord: true,
        canScreenshot: true,
        hotkeys: { saveReplay: null, record: null, screenshot: null },
      };
    } else {
      const keys = settings.recorderHotkeys[id];
      current = {
        ...base,
        replayOn: null,
        replaySeconds: null,
        recording: null,
        canToggleReplay: false,
        canSave: !!keys.saveReplay,
        canRecord: !!keys.record,
        canScreenshot: !!keys.screenshot,
        hotkeys: { saveReplay: keys.saveReplay || null, record: keys.record || null, screenshot: keys.screenshot || null },
      };
    }
    return {
      selected: settings.recorder,
      current,
      amd: amd.installed ? amd : null,
      gamebar,
      obs,
      nvidia: { installed: false, running: false },
      medal: { installed: false, running: false },
    };
  };
  const saveReplayClip = () => {
    const [newest] = makeClips();
    const at = Date.now();
    const saved = { ...newest, id: `c${at.toString(16)}`, capturedAtMs: at, fileName: `Replay ${at}.mp4` };
    byId.set(saved.id, saved.gameName);
    clips = [saved, ...clips];
    clipGen++;
    window.setTimeout(() => void emit("clips-updated", clipGen), 1200);
  };
  const byId = new Map<string, string>(clips.map((c) => [c.id, c.gameName]));
  for (const s of shots) byId.set(s.id, GAMES[hash(s.id) % GAMES.length].name);

  mockIPC(
    (cmd, raw) => {
      const args = (raw ?? {}) as Record<string, unknown>;
      switch (cmd) {
        case "get_settings":
          return settings;
        case "default_settings":
          return DEFAULTS;
        case "set_settings":
          settings = args.settings as AppSettings;
          void emit("settings-changed", settings);
          return null;
        case "get_clips":
          return { generation: clipGen, clips: args.since === clipGen ? null : clips, offlineRoots: [] };
        case "get_screenshots":
          return { generation: shotGen, screenshots: args.since === shotGen ? null : shots };
        case "get_audio_state":
          return mixer;
        case "recorder_status":
          return overview();
        case "recorder_set_replay": {
          const on = args.on as boolean;
          const id = overview().current?.id;
          if (id === "amd") amd = { ...amd, settings: { ...amd.settings!, instantReplay: on } };
          if (id === "gamebar") gamebar = { ...gamebar, settings: { ...gamebar.settings, backgroundRecording: on } };
          if (id === "obs") obs = { ...obs, replayActive: on };
          return overview();
        }
        case "amd_set_settings":
          amd = { ...amd, settings: args.settings as RecorderSettings };
          return amd;
        case "gamebar_set_settings":
          gamebar = { ...gamebar, settings: args.settings as GameBarStatus["settings"] };
          return gamebar;
        case "obs_set_settings":
          obs = { ...obs, settings: args.settings as ObsStatus["settings"] };
          return obs;
        case "recorder_action": {
          const action = args.action as string;
          const id = overview().current?.id;
          if (action === "toggleRecording") {
            if (id === "amd") amd = { ...amd, recording: !amd.recording };
            if (id === "obs") obs = { ...obs, recording: !obs.recording };
          }
          if (action === "saveReplay") saveReplayClip();
          return null;
        }
        case "detect_media_folders":
          return {
            clips: [
              { path: "C:\\Users\\you\\Videos\\Captures", label: "Xbox Game Bar", count: 41, current: false },
              { path: "D:\\Clips", label: "Other drive", count: 23, current: false },
              { path: "C:\\Users\\you\\Videos", label: "Videos (OBS default)", count: 70, current: false },
            ],
            screenshots: [
              { path: "C:\\Users\\you\\Pictures\\Screenshots", label: "Windows (Win+PrtSc)", count: 48, current: false },
              { path: "C:\\Users\\you\\Documents\\ShareX\\Screenshots", label: "ShareX", count: 312, current: false },
            ],
          };
        case "delete_media": {
          const ids = new Set(args.ids as string[]);
          const before = clips.length + shots.length;
          clips = clips.filter((c) => !ids.has(c.id));
          shots = shots.filter((s) => !ids.has(s.id));
          clipGen++;
          shotGen++;
          void emit("clips-updated", clipGen);
          void emit("screenshots-updated", shotGen);
          return before - clips.length - shots.length;
        }
        case "rename_media": {
          const id = args.id as string;
          const name = `${args.newName as string}.mp4`;
          clips = clips.map((c) => (c.id === id ? { ...c, fileName: name } : c));
          clipGen++;
          void emit("clips-updated", clipGen);
          return id;
        }
        case "copy_media_files":
          return (args.ids as string[]).length;
        case "plugin:dialog|open":
          return "E:\\More Clips";
        case "plugin:app|version":
          return "0.1.0";
        case "overlay_hide":
          void emit("overlay-close", null);
          return null;
        case "overlay_finish_hide":
          location.hash = "#/";
          return null;
        case "finish_setup":
          location.hash = "#/";
          return null;
        default:
          return null;
      }
    },
    { shouldMockEvents: true },
  );

  const internals = (window as unknown as { __TAURI_INTERNALS__: Record<string, unknown> }).__TAURI_INTERNALS__;
  internals.convertFileSrc = (path: string, protocol = "asset") =>
    protocol === "thumb" ? sceneSvg(byId.get(path) ?? "Neon Drift", path) : "";

  const backdrop = document.createElement("div");
  backdrop.id = "demo-backdrop";
  backdrop.style.cssText = `position:fixed;inset:0;z-index:-1;background:url("${sceneSvg("Skyforge Legends", "backdrop")}") center/cover`;
  document.body.prepend(backdrop);

  const autoOpen = () => {
    if (location.hash.startsWith("#/overlay")) {
      const q = new URLSearchParams(location.hash.split("?")[1] ?? "");
      window.setTimeout(
        () => void (q.has("settings") ? emit("open-settings", q.get("settings") || null) : emit("overlay-open", { panel: q.has("panel") })),
        350,
      );
    }
  };
  window.addEventListener("hashchange", autoOpen);
  autoOpen();
}

export function DemoHome() {
  return (
    <div className="demo-home">
      <h1>Overclip demo</h1>
      <p>
        Browser preview with sample data (no Tauri backend). Hotkeys, files and the tray only exist in the real app.
      </p>
      <div className="demo-links">
        <a className="ab-btn ab-btn--primary" href="#/overlay">
          Open gallery
        </a>
        <a className="ab-btn" href="#/overlay?panel">
          Open side panel
        </a>
        <a className="ab-btn" href="#/setup">
          Setup wizard
        </a>
      </div>
    </div>
  );
}
