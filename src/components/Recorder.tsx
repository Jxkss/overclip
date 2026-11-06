import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { formatSeconds, type Recorder } from "../hooks/useRecorder";
import { useSettings } from "../settings";
import type { ClipEntry, HotkeySet, ObsSettings, RecorderId, RecorderOverview, RecorderSettings } from "../types/ipc";
import { FolderField, Keys, Row, Segmented, ShortcutInput, Slider, Toggle } from "./controls";
import { Icon, IconButton, useToast } from "./ui";

const REPLAY_STOPS = [15, 30, 45, 60, 90, 120, 180, 300, 600, 900, 1200];

const RESOLUTIONS: { value: RecorderSettings["resolution"]; label: string }[] = [
  { value: "InGame", label: "Native" },
  { value: "720", label: "720p" },
  { value: "1080", label: "1080p" },
  { value: "1440", label: "1440p" },
  { value: "2160", label: "4K" },
];

const CODEC_LABELS: Record<RecorderSettings["codec"], string> = {
  AVC: "H.264",
  HEVC: "HEVC",
  AV1: "AV1",
};

const RECORDER_NAMES: Record<RecorderId, string> = {
  amd: "AMD Software",
  gamebar: "Xbox Game Bar",
  obs: "OBS Studio",
  nvidia: "NVIDIA App",
  medal: "Medal",
};

const norm = (p: string) => p.toLowerCase().replace(/[\\/]+$/, "");

const withKeys = (text: string, combo: string | null | undefined) => (combo ? `${text} (${combo})` : text);

const nearestIdx = (stops: number[], v: number) =>
  stops.reduce((best, s, i) => (Math.abs(s - v) < Math.abs(stops[best] - v) ? i : best), 0);

function installed(o: RecorderOverview): Record<RecorderId, boolean> {
  return {
    amd: !!o.amd,
    gamebar: !!o.gamebar,
    obs: o.obs.installed,
    nvidia: o.nvidia.installed,
    medal: o.medal.installed,
  };
}


export function RecorderControls({ rec, clips, compact }: { rec: Recorder; clips: ClipEntry[]; compact?: boolean }) {
  const toast = useToast();
  const { settings } = useSettings();
  const cur = rec.status?.current;
  const known = useRef<{ ids: Set<string>; at: number } | null>(null);

  useEffect(() => {
    const k = known.current;
    if (!k) return;
    if (Date.now() - k.at > 60_000) {
      known.current = null;
      return;
    }
    const fresh = clips.find((c) => !k.ids.has(c.id));
    if (fresh) {
      known.current = null;
      toast(fresh.gameName ? `Replay saved to ${fresh.gameName}` : "Replay saved");
    }
  }, [clips, toast]);

  if (!cur || settings?.recorderControls === false) return null;
  const tellsReplay = cur.replayOn !== null;
  const replayOn = cur.replayOn === true;
  const seconds = cur.replaySeconds;

  const saveReplay = async () => {
    known.current = { ids: new Set(clips.map((c) => c.id)), at: Date.now() };
    const ok = await rec.run("saveReplay");
    if (ok === false) known.current = null;
    else toast(seconds ? `Saving the last ${formatSeconds(seconds)}…` : `Asked ${cur.name} to save a replay…`);
  };
  const toggleRecording = async () => {
    const path = await rec.run("toggleRecording");
    if (typeof path === "string") toast("Recording saved");
  };
  const screenshot = async () => {
    const path = await rec.run("screenshot");
    if (typeof path === "string") toast("Screenshot saved");
  };
  const toggleReplay = () => void rec.setReplay(!replayOn);

  const statusLabel = !cur.ready
    ? (cur.problem ?? `${cur.name} isn't ready`)
    : cur.applying
      ? "Restarting the replay buffer…"
      : !tellsReplay
        ? `Using ${cur.name}'s own keys`
        : replayOn
          ? `${cur.name} replay on${seconds ? `: keeping the last ${formatSeconds(seconds)}` : ""}.${cur.canToggleReplay ? " Click to turn off." : ""}`
          : `${cur.name} replay off.${cur.canToggleReplay ? " Click to turn on." : ""}`;
  const statusText = !cur.ready
    ? `${cur.name} offline`
    : !tellsReplay
      ? cur.name
      : replayOn
        ? seconds
          ? `Replay ${formatSeconds(seconds)}`
          : "Replay on"
        : "Replay off";
  const saveLabel = withKeys(seconds ? `Save the last ${formatSeconds(seconds)}` : "Save replay", cur.hotkeys.saveReplay);
  const recording = cur.recording === true;
  const recordLabel = withKeys(recording ? "Stop recording" : cur.recording === null ? "Start / stop recording" : "Start recording", cur.hotkeys.record);
  const shotLabel = withKeys("Screenshot (hides Overclip first)", cur.hotkeys.screenshot);
  const canClickStatus = cur.ready && cur.canToggleReplay && tellsReplay;

  if (compact) {
    return (
      <div className="rec-compact">
        <button
          type="button"
          className={`rec-dot-btn ${replayOn && cur.ready ? "is-on" : ""} ${cur.applying ? "is-busy" : ""}`}
          onClick={toggleReplay}
          disabled={!canClickStatus}
          title={statusLabel}
          aria-label={statusLabel}
        >
          <span className="rec-dot" />
        </button>
        <IconButton icon="replay" label={saveLabel} onClick={() => void saveReplay()} disabled={!cur.ready || !cur.canSave || cur.applying} />
        <IconButton
          icon="record"
          label={recordLabel}
          onClick={() => void toggleRecording()}
          disabled={!cur.ready || !cur.canRecord}
          active={recording}
          className={recording ? "rec-live" : ""}
        />
        <IconButton icon="camera" label={shotLabel} onClick={() => void screenshot()} disabled={!cur.ready || !cur.canScreenshot} />
      </div>
    );
  }

  return (
    <div className="rec-bar" role="group" aria-label="Recorder">
      <button
        type="button"
        className={`rec-status ${replayOn && cur.ready ? "is-on" : ""} ${cur.applying ? "is-busy" : ""}`}
        onClick={toggleReplay}
        disabled={!canClickStatus}
        title={statusLabel}
      >
        <span className="rec-dot" />
        <span className="rec-status-text">{statusText}</span>
      </button>
      <button
        type="button"
        className="rec-btn rec-btn--save"
        onClick={() => void saveReplay()}
        disabled={!cur.ready || !cur.canSave || cur.applying}
        title={saveLabel}
      >
        <Icon name="replay" size={16} />
        Save replay
      </button>
      <button
        type="button"
        className={`rec-btn ${recording ? "rec-live" : ""}`}
        onClick={() => void toggleRecording()}
        disabled={!cur.ready || !cur.canRecord}
        title={recordLabel}
      >
        <Icon name={recording ? "stop" : "record"} size={16} />
        {recording ? "Stop" : "Record"}
      </button>
      <button
        type="button"
        className="rec-btn rec-btn--icon"
        onClick={() => void screenshot()}
        disabled={!cur.ready || !cur.canScreenshot}
        title={shotLabel}
        aria-label={shotLabel}
      >
        <Icon name="camera" size={16} />
      </button>
    </div>
  );
}


function RecorderFolder({
  title,
  description,
  value,
  onChange,
  galleryFolders,
  onAddToGallery,
}: {
  title: string;
  description?: string;
  value: string;
  onChange?: (dir: string) => void;
  galleryFolders: string[];
  onAddToGallery: (dir: string) => void;
}) {
  const inGallery = galleryFolders.some((d) => norm(d) === norm(value));
  return (
    <div className="set-block set-block--flush">
      <div className="set-title">{title}</div>
      {description && <div className="set-desc">{description}</div>}
      <FolderField
        value={value}
        onChange={(dir) => {
          onChange?.(dir);
          if (!galleryFolders.some((d) => norm(d) === norm(dir))) onAddToGallery(dir);
        }}
      />
      {!inGallery && value && (
        <div className="rec-note">
          <Icon name="info" size={15} />
          <span>This folder isn't in your gallery yet, so new recordings won't show up in Overclip.</span>
          <button type="button" className="ab-btn" onClick={() => onAddToGallery(value)}>
            Add to gallery
          </button>
        </div>
      )}
    </div>
  );
}

function HotkeyList({ keys }: { keys: [string, string | null | undefined][] }) {
  return (
    <div className="rec-hotkeys">
      {keys.map(([label, combo]) =>
        combo ? (
          <span key={label} className="rec-hotkey">
            <span className="set-desc">{label}</span>
            <Keys combo={combo} />
          </span>
        ) : null,
      )}
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="hint hint--top">
      <Icon name="info" size={16} />
      <span>{children}</span>
    </div>
  );
}


export function RecorderEssentials({
  rec,
  galleryFolders,
  onAddToGallery,
}: {
  rec: Recorder;
  galleryFolders: string[];
  onAddToGallery: (dir: string) => void;
}) {
  const s = rec.status?.amd?.settings;
  if (!s) return null;
  return (
    <>
      <Row
        title="Instant Replay"
        description="Keeps the last moments of gameplay in memory so you can save them after they happen."
      >
        <Toggle label="Instant Replay" checked={s.instantReplay} onChange={(instantReplay) => rec.update("amd", { instantReplay }, true)} />
      </Row>
      <Row title="Replay length" description="How much a saved replay goes back.">
        <Slider
          label="Replay length"
          value={nearestIdx(REPLAY_STOPS, s.replaySeconds)}
          min={0}
          max={REPLAY_STOPS.length - 1}
          step={1}
          format={(i) => formatSeconds(REPLAY_STOPS[i])}
          onChange={(i) => rec.update("amd", { replaySeconds: REPLAY_STOPS[i] })}
        />
      </Row>
      <RecorderFolder
        title="Save recordings to"
        description="AMD puts each game's clips and screenshots in a subfolder named after the game."
        value={s.outputFolder}
        onChange={(outputFolder) => rec.update("amd", { outputFolder }, true)}
        galleryFolders={galleryFolders}
        onAddToGallery={onAddToGallery}
      />
    </>
  );
}

function AmdPanel({ rec, galleryFolders, onAddToGallery }: PanelProps) {
  const st = rec.status?.amd;
  if (!st?.settings) {
    return <Notice>AMD Software: Adrenalin Edition wasn't found. It comes with Radeon graphics drivers.</Notice>;
  }
  const s = st.settings;
  const mbps = Math.round(s.bitrateKbps / 1000);
  const set = (patch: Partial<RecorderSettings>) => rec.update("amd", patch);
  return (
    <>
      <Notice>
        These are AMD Software's own settings. Changing one restarts Instant Replay, so what was buffered before the change
        is dropped.
        {!st.running && " AMD Software isn't running right now: changes apply when it starts."}
        {st.applying && " Applying…"}
      </Notice>
      <div className="set-subhead">Instant Replay</div>
      <RecorderEssentials rec={rec} galleryFolders={galleryFolders} onAddToGallery={onAddToGallery} />

      <div className="set-subhead">Video</div>
      <Row title="Resolution" description="Native records at the game's own resolution.">
        <Segmented label="Resolution" value={s.resolution} onChange={(resolution) => set({ resolution })} options={RESOLUTIONS} />
      </Row>
      <Row title="Frame rate">
        <Segmented
          label="Frame rate"
          value={String(s.frameRate)}
          onChange={(v) => set({ frameRate: Number(v) })}
          options={[
            { value: "30", label: "30 fps" },
            { value: "60", label: "60 fps" },
          ]}
        />
      </Row>
      <Row title="Quality (bitrate)" description={`About ${Math.round((mbps * 60) / 8)} MB per minute of video.`}>
        <Slider label="Bitrate" value={mbps} min={5} max={100} step={1} format={(v) => `${v} Mbps`} onChange={(v) => set({ bitrateKbps: v * 1000 })} />
      </Row>
      <Row title="Codec" description="H.264 plays everywhere. HEVC and AV1 make smaller files but some apps and sites can't play them.">
        <Segmented
          label="Codec"
          value={s.codec}
          onChange={(codec) => set({ codec })}
          options={st.codecs.map((c) => ({ value: c, label: CODEC_LABELS[c] ?? c }))}
        />
      </Row>

      <div className="set-subhead">Audio</div>
      <Row title="Game and system sound">
        <Toggle label="Record system sound" checked={s.systemAudio} onChange={(systemAudio) => set({ systemAudio })} />
      </Row>
      <Row title="Microphone">
        <Toggle label="Record microphone" checked={s.microphone} onChange={(microphone) => set({ microphone })} />
      </Row>
      {s.microphone && (
        <Row title="Microphone volume">
          <Slider label="Microphone volume" value={s.micVolume} min={0} max={100} step={1} format={(v) => `${v}%`} onChange={(micVolume) => set({ micVolume })} />
        </Row>
      )}
      <Row
        title="Audio channels"
        description="Automatic copies your output device, so a 7.1 headset or virtual surround (like SteelSeries Sonar) gives 7.1 clips that Windows' Media Player and Photos can't play or trim. Restarts AMD's recorder."
      >
        <Segmented
          label="Audio channels"
          value={s.stereoAudio ? "stereo" : "auto"}
          onChange={(v) => set({ stereoAudio: v === "stereo" })}
          options={[
            { value: "stereo", label: "Stereo" },
            { value: "auto", label: "Automatic" },
          ]}
        />
      </Row>

      <div className="set-subhead">More</div>
      <Row title="Record the desktop" description="Allow recording outside of games too.">
        <Toggle label="Record the desktop" checked={s.recordDesktop} onChange={(recordDesktop) => set({ recordDesktop })} />
      </Row>
      <Row title="AMD hotkeys" description="Work in any game, even with Overclip closed. Change them in AMD Software under Settings › Hotkeys.">
        <HotkeyList
          keys={[
            ["Save replay", st.hotkeys.saveReplay],
            ["Record", st.hotkeys.record],
            ["Screenshot", st.hotkeys.screenshot],
          ]}
        />
      </Row>
    </>
  );
}


const GAMEBAR_REPLAY = [15, 30, 60, 180, 300, 600];

function GameBarPanel({ rec, galleryFolders, onAddToGallery }: PanelProps) {
  const st = rec.status?.gamebar;
  if (!st) return <Notice>Xbox Game Bar isn't available on this PC.</Notice>;
  const s = st.settings;
  const set = (patch: Partial<typeof s>, now = false) => rec.update("gamebar", patch, now);
  return (
    <>
      {st.disabledByPolicy ? (
        <Notice>
          Game Bar captures are turned off by a Windows policy on this PC (often set by "debloat" or privacy tools). Its
          settings below still change, but Game Bar won't record until that policy is removed.
        </Notice>
      ) : (
        <Notice>
          These are Windows' own Game Bar settings (Settings › Gaming › Captures). Save replay, Record and Screenshot press
          Game Bar's shortcuts for you.
        </Notice>
      )}
      <div className="set-subhead">Background recording</div>
      <Row title="Record what happened" description="Keeps the last moments of gameplay so you can save them after they happen.">
        <Toggle label="Record what happened" checked={s.backgroundRecording} onChange={(backgroundRecording) => set({ backgroundRecording }, true)} />
      </Row>
      <Row title="Record the last">
        <Segmented
          label="Record the last"
          value={String(GAMEBAR_REPLAY[nearestIdx(GAMEBAR_REPLAY, s.replaySeconds)])}
          onChange={(v) => set({ replaySeconds: Number(v) }, true)}
          options={GAMEBAR_REPLAY.map((v) => ({ value: String(v), label: v < 60 ? `${v} s` : `${v / 60} min` }))}
        />
      </Row>
      <Row title="Longest recording" description="Recordings stop by themselves after this long.">
        <Segmented
          label="Longest recording"
          value={String(s.maxRecordMinutes)}
          onChange={(v) => set({ maxRecordMinutes: Number(v) }, true)}
          options={[30, 60, 120, 240].map((m) => ({ value: String(m), label: m < 60 ? `${m} min` : `${m / 60} h` }))}
        />
      </Row>
      <div className="set-subhead">Video and sound</div>
      <Row title="Frame rate">
        <Segmented
          label="Frame rate"
          value={String(s.frameRate)}
          onChange={(v) => set({ frameRate: Number(v) }, true)}
          options={[
            { value: "30", label: "30 fps" },
            { value: "60", label: "60 fps" },
          ]}
        />
      </Row>
      <Row title="Video quality">
        <Segmented
          label="Video quality"
          value={s.quality}
          onChange={(quality) => set({ quality }, true)}
          options={[
            { value: "standard", label: "Standard" },
            { value: "high", label: "High" },
          ]}
        />
      </Row>
      <Row title="Game sound">
        <Toggle label="Record game sound" checked={s.systemAudio} onChange={(systemAudio) => set({ systemAudio }, true)} />
      </Row>
      <Row title="Microphone">
        <Toggle label="Record microphone" checked={s.microphone} onChange={(microphone) => set({ microphone }, true)} />
      </Row>
      <Row title="Mouse cursor">
        <Toggle label="Show the mouse cursor" checked={s.captureCursor} onChange={(captureCursor) => set({ captureCursor }, true)} />
      </Row>
      <RecorderFolder
        title="Captures folder"
        description="Where Game Bar saves clips and screenshots."
        value={s.outputFolder}
        onChange={(outputFolder) => set({ outputFolder }, true)}
        galleryFolders={galleryFolders}
        onAddToGallery={onAddToGallery}
      />
      <Row title="Game Bar shortcuts" description="Change them in Game Bar (Win+G) › Settings › Shortcuts.">
        <HotkeyList
          keys={[
            ["Save replay", st.hotkeys.saveReplay],
            ["Record", st.hotkeys.record],
            ["Screenshot", st.hotkeys.screenshot],
          ]}
        />
      </Row>
    </>
  );
}


const OBS_REPLAY = [10, 15, 20, 30, 45, 60, 90, 120, 180, 300, 600];
const OBS_QUALITY: { value: NonNullable<ObsSettings["quality"]>; label: string }[] = [
  { value: "Stream", label: "Same as stream" },
  { value: "Small", label: "High" },
  { value: "HQ", label: "Very high" },
  { value: "Lossless", label: "Lossless" },
];

function ObsPanel({ rec, galleryFolders, onAddToGallery }: PanelProps) {
  const toast = useToast();
  const [enabling, setEnabling] = useState(false);
  const st = rec.status?.obs;
  if (!st?.installed) return <Notice>OBS Studio wasn't found on this PC.</Notice>;

  if (st.connection !== "ok") {
    const enable = async () => {
      setEnabling(true);
      try {
        await invoke("obs_enable_remote_control");
        toast("Remote control turned on. Start OBS and Overclip connects by itself.");
        void rec.refresh();
      } catch (e) {
        toast(String(e), "error");
      } finally {
        setEnabling(false);
      }
    };
    return (
      <>
        <Notice>
          Overclip controls OBS through OBS's built-in remote control (obs-websocket), using the password from OBS's own
          settings, so there's nothing to type.
        </Notice>
        <Row
          title={st.connection === "closed" ? "OBS isn't running" : st.connection === "off" ? "Remote control is off" : "Can't connect"}
          description={
            st.connection === "closed"
              ? "Start OBS and its settings appear here."
              : (st.message ?? "Turn on OBS's remote control: in OBS, Tools › WebSocket Server Settings › Enable WebSocket server.")
          }
        >
          {st.connection !== "auth" && (
            <button type="button" className="ab-btn" disabled={enabling || st.running} onClick={() => void enable()} title={st.running ? "Close OBS first" : undefined}>
              Turn on remote control
            </button>
          )}
        </Row>
        {st.running && st.connection === "off" && (
          <div className="set-desc">
            OBS is running, so it would overwrite the change when it closes. Either close OBS and press the button, or turn it
            on inside OBS: Tools › WebSocket Server Settings › Enable WebSocket server.
          </div>
        )}
      </>
    );
  }

  const s = st.settings;
  if (!s) return null;
  const set = (patch: Partial<ObsSettings>, now = false) => rec.update("obs", patch, now);
  return (
    <>
      <Notice>
        Connected to OBS. Changes apply to your current OBS profile; replay changes restart the replay buffer.
        {st.advancedMode && " Your profile uses Advanced output mode, so recording quality stays in OBS's settings."}
      </Notice>
      <div className="set-subhead">Replay buffer</div>
      <Row title="Replay buffer" description="Keeps the last moments in memory so you can save them after they happen.">
        <Toggle label="Replay buffer" checked={st.replayActive} onChange={(on) => void rec.setReplay(on)} />
      </Row>
      <Row title="Replay length" description="Saved replays come out a little shorter: OBS trims them to keyframes.">
        <Slider
          label="Replay length"
          value={nearestIdx(OBS_REPLAY, s.replaySeconds)}
          min={0}
          max={OBS_REPLAY.length - 1}
          step={1}
          format={(i) => formatSeconds(OBS_REPLAY[i])}
          onChange={(i) => set({ replaySeconds: OBS_REPLAY[i] })}
        />
      </Row>
      <div className="set-subhead">Recording</div>
      <Row title="Frame rate" description="OBS can't change this while recording or streaming.">
        <Segmented
          label="Frame rate"
          value={String(s.frameRate)}
          onChange={(v) => set({ frameRate: Number(v) }, true)}
          options={[
            { value: "30", label: "30 fps" },
            { value: "60", label: "60 fps" },
          ]}
        />
      </Row>
      {s.quality !== null && (
        <Row title="Recording quality">
          <Segmented label="Recording quality" value={s.quality} onChange={(quality) => set({ quality }, true)} options={OBS_QUALITY} />
        </Row>
      )}
      <RecorderFolder
        title="Recording folder"
        description="OBS saves recordings and replays here; Overclip saves OBS screenshots here too."
        value={s.recordFolder}
        onChange={(recordFolder) => set({ recordFolder }, true)}
        galleryFolders={galleryFolders}
        onAddToGallery={onAddToGallery}
      />
    </>
  );
}


const HOTKEY_DEFAULTS: Record<"nvidia" | "medal", HotkeySet> = {
  nvidia: { saveReplay: "Alt+F10", record: "Alt+F9", screenshot: "Alt+F1" },
  medal: { saveReplay: "F8", record: "", screenshot: "" },
};

function HotkeyPanel({ id }: { id: "nvidia" | "medal" }) {
  const { settings, update } = useSettings();
  if (!settings) return null;
  const keys = settings.recorderHotkeys[id];
  const defaults = HOTKEY_DEFAULTS[id];
  const set = (patch: Partial<HotkeySet>) =>
    update({ recorderHotkeys: { ...settings.recorderHotkeys, [id]: { ...keys, ...patch } } });
  const row = (field: keyof HotkeySet, title: string) => (
    <Row title={title}>
      {keys[field] ? (
        <div className="shortcut-row">
          <ShortcutInput value={keys[field]} fallback={defaults[field] || undefined} onChange={(v) => set({ [field]: v })} />
          <button type="button" className="ab-btn" onClick={() => set({ [field]: "" })}>
            None
          </button>
        </div>
      ) : (
        <button type="button" className="ab-btn" onClick={() => set({ [field]: defaults[field] || "F9" })}>
          Set a key
        </button>
      )}
    </Row>
  );
  return (
    <>
      <Notice>
        {id === "nvidia"
          ? "NVIDIA App doesn't let other apps change its settings, so Overclip presses its shortcuts for you. Set its recording options in NVIDIA App (Alt+Z), and make sure the keys below match its shortcuts."
          : "Medal doesn't let other apps change its settings, so Overclip presses its clip key for you. Set clip length and quality in Medal, and make sure the keys below match Medal's hotkeys."}
      </Notice>
      <div className="set-subhead">{id === "nvidia" ? "NVIDIA App" : "Medal"} shortcuts</div>
      {row("saveReplay", id === "nvidia" ? "Save Instant Replay" : "Save clip")}
      {row("record", "Start / stop recording")}
      {row("screenshot", "Screenshot")}
    </>
  );
}


type PanelProps = { rec: Recorder; galleryFolders: string[]; onAddToGallery: (dir: string) => void };

export function RecorderPicker({ rec }: { rec: Recorder }) {
  const { settings, update } = useSettings();
  const o = rec.status;
  if (!settings || !o) return null;
  const have = installed(o);
  const choices = (Object.keys(RECORDER_NAMES) as RecorderId[]).filter((id) => have[id] || settings.recorder === id);
  return (
    <>
      <Row title="Your recorder" description="Overclip drives the recorder you already use. It never records by itself.">
        <Segmented
          label="Your recorder"
          value={settings.recorder}
          onChange={(recorder) => update({ recorder })}
          options={[
            { value: "auto" as const, label: "Automatic" },
            ...choices.map((id) => ({ value: id, label: RECORDER_NAMES[id] })),
          ]}
        />
      </Row>
      {settings.recorder === "auto" && (
        <div className="set-desc rec-auto-note">
          {o.current ? `Using ${o.current.name}.` : "No recorder was found on this PC."} Outplayed and Steam can't be
          controlled by other apps; their clips still show up in your gallery.
        </div>
      )}
    </>
  );
}

export function RecordingSettings({ rec }: { rec: Recorder }) {
  const toast = useToast();
  const { settings, update } = useSettings();
  const o = rec.status;
  if (!settings) return null;
  if (!o) return <div className="set-desc">Looking for recorders…</div>;

  const cur = o.current;
  const galleryFolders = [settings.clipsDirectory, ...settings.extraClipDirectories];
  const panel: PanelProps = {
    rec,
    galleryFolders,
    onAddToGallery: (dir) => {
      update({ extraClipDirectories: [...settings.extraClipDirectories, dir] });
      toast("Added to your clip folders");
    },
  };

  return (
    <>
      <RecorderPicker rec={rec} />
      <Row title="Recorder buttons in Overclip" description="Save replay, Record and Screenshot in the gallery and side panel.">
        <Toggle label="Recorder buttons" checked={settings.recorderControls} onChange={(recorderControls) => update({ recorderControls })} />
      </Row>

      {cur && <div className="set-subhead rec-panel-head">{cur.name}</div>}
      {cur?.id === "amd" && <AmdPanel {...panel} />}
      {cur?.id === "gamebar" && <GameBarPanel {...panel} />}
      {cur?.id === "obs" && <ObsPanel {...panel} />}
      {(cur?.id === "nvidia" || cur?.id === "medal") && <HotkeyPanel id={cur.id} />}
      {!cur && (
        <Notice>
          Overclip works with AMD Software, Xbox Game Bar, OBS Studio, NVIDIA App and Medal. None of them was found, but clips
          from any recorder still show up in your gallery.
        </Notice>
      )}
    </>
  );
}
