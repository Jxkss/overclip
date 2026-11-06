export interface ClipEntry {
  id: string;
  path: string;
  fileName: string;
  gameName: string;
  capturedAtMs: number | null;
  durationMs: number | null;
  sizeBytes: number;
  extension: string;
  library: string;
}

export interface ScreenshotEntry {
  id: string;
  path: string;
  fileName: string;
  month: string;
  capturedAtMs: number | null;
  sizeBytes: number;
  extension: string;
}

export type MediaEntry = ClipEntry | ScreenshotEntry;

export interface ClipsPayload {
  generation: number;
  clips: ClipEntry[] | null;
  offlineRoots: string[];
}

export interface ScreenshotsPayload {
  generation: number;
  screenshots: ScreenshotEntry[] | null;
}

export interface UiSettings {
  accent: string;
  scale: number;
  dim: number;
  animations: boolean;
  gallerySize: "comfortable" | "large" | "full";
  panelSide: "left" | "right";
  panelWidth: number;
  density: "s" | "m" | "l";
  hoverPreview: boolean;
  autoplay: boolean;
  confirmDelete: boolean;
  newBadges: boolean;
  groupByDay: boolean;
  showCovers: boolean;
  clickOutsideCloses: boolean;
  trayOpens: "gallery" | "panel";
  startTab: "remember" | "clips" | "screenshots";
}

export interface AppSettings {
  clipsDirectory: string;
  extraClipDirectories: string[];
  screenshotsDirectory: string;
  overlayShortcut: string;
  panelShortcut: string;
  theme: "dark" | "black";
  startupWithWindows: boolean;
  setupComplete: boolean;
  micHotkeys: boolean;
  recorderControls: boolean;
  screenshotsFromClipFolders: boolean;
  recorder: RecorderId | "auto";
  recorderHotkeys: { nvidia: HotkeySet; medal: HotkeySet };
  ui: UiSettings;
}

export type RecorderId = "amd" | "gamebar" | "obs" | "nvidia" | "medal";

export interface HotkeySet {
  saveReplay: string;
  record: string;
  screenshot: string;
}

export interface FolderCandidate {
  path: string;
  label: string;
  count: number;
  current: boolean;
}

export interface DetectedFolders {
  clips: FolderCandidate[];
  screenshots: FolderCandidate[];
}

export interface AudioSessionInfo {
  id: string;
  name: string;
  volume: number;
  muted: boolean;
  processId: number;
  iconDataUrl: string | null;
  controllable: boolean;
}

export interface AudioMixerState {
  outputDeviceName: string | null;
  masterVolume: number;
  masterMuted: boolean;
  masterCapable: boolean;
  sessions: AudioSessionInfo[];
  micMuted: boolean;
  micCapable: boolean;
  deafened: boolean;
}

export interface RecorderSettings {
  instantReplay: boolean;
  replaySeconds: number;
  outputFolder: string;
  resolution: "InGame" | "720" | "1080" | "1440" | "2160";
  frameRate: number;
  bitrateKbps: number;
  codec: "AVC" | "HEVC" | "AV1";
  systemAudio: boolean;
  microphone: boolean;
  micVolume: number;
  stereoAudio: boolean;
  recordDesktop: boolean;
}

export interface AmdStatus {
  installed: boolean;
  running: boolean;
  recording: boolean;
  applying: boolean;
  settings: RecorderSettings | null;
  codecs: RecorderSettings["codec"][];
  hotkeys: { saveReplay: string | null; screenshot: string | null; record: string | null };
}

export interface GameBarSettings {
  backgroundRecording: boolean;
  replaySeconds: number;
  maxRecordMinutes: number;
  frameRate: number;
  quality: "standard" | "high";
  systemAudio: boolean;
  microphone: boolean;
  captureCursor: boolean;
  outputFolder: string;
}

export interface GameBarStatus {
  disabledByPolicy: boolean;
  settings: GameBarSettings;
  hotkeys: { saveReplay: string; record: string; screenshot: string };
}

export interface ObsSettings {
  replaySeconds: number;
  recordFolder: string;
  frameRate: number;
  quality: "Stream" | "Small" | "HQ" | "Lossless" | null;
}

export interface ObsStatus {
  installed: boolean;
  running: boolean;
  connection: "ok" | "off" | "auth" | "error" | "closed";
  message: string | null;
  replayAvailable: boolean;
  replayActive: boolean;
  recording: boolean;
  advancedMode: boolean;
  settings: ObsSettings | null;
}

export interface HotkeyAppStatus {
  installed: boolean;
  running: boolean;
}

export interface CurrentRecorder {
  id: RecorderId;
  name: string;
  ready: boolean;
  problem: string | null;
  replayOn: boolean | null;
  replaySeconds: number | null;
  recording: boolean | null;
  applying: boolean;
  canToggleReplay: boolean;
  canSave: boolean;
  canRecord: boolean;
  canScreenshot: boolean;
  hotkeys: { saveReplay: string | null; record: string | null; screenshot: string | null };
}

export interface RecorderOverview {
  selected: RecorderId | "auto";
  current: CurrentRecorder | null;
  amd: AmdStatus | null;
  gamebar: GameBarStatus | null;
  obs: ObsStatus;
  nvidia: HotkeyAppStatus;
  medal: HotkeyAppStatus;
}
