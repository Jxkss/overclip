import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import type { AudioMixerState } from "../types/ipc";
import { Icon, IconButton } from "./ui";

type Props = {
  state: AudioMixerState | null;
  onChange: () => void;
  onDragging: (dragging: boolean) => void;
  onClose?: () => void;
};

function DrawerHead({ onClose }: { onClose?: () => void }) {
  return (
    <div className="drawer-head">
      <h2 className="drawer-title">Volume mixer</h2>
      {onClose && <IconButton icon="x" label="Close mixer" onClick={onClose} />}
    </div>
  );
}

const SEND_EVERY_MS = 40;

function VolumeSlider({
  value,
  disabled,
  title,
  send,
  onDragging,
  onCommitted,
}: {
  value: number;
  disabled?: boolean;
  title?: string;
  send: (v: number) => Promise<unknown>;
  onDragging: (d: boolean) => void;
  onCommitted: () => void;
}) {
  const [local, setLocal] = useState<number | null>(null);
  const pending = useRef<number | null>(null);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const flush = () => {
    timer.current = 0;
    if (pending.current == null) return;
    const v = pending.current;
    pending.current = null;
    void send(v).catch(() => {});
  };

  const release = () => {
    if (local == null) return;
    window.clearTimeout(timer.current);
    flush();
    onDragging(false);
    setLocal(null);
    onCommitted();
  };

  const shown = local ?? value;
  return (
    <div className="vol">
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        className="slider"
        value={shown}
        disabled={disabled}
        title={title}
        onPointerDown={() => onDragging(true)}
        onPointerUp={release}
        onKeyUp={release}
        onBlur={release}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          setLocal(v);
          pending.current = v;
          if (!timer.current) timer.current = window.setTimeout(flush, SEND_EVERY_MS);
        }}
      />
      <span className="vol-pct">{Math.round(shown * 100)}</span>
    </div>
  );
}

export function AudioMixer({ state, onChange, onDragging, onClose }: Props) {
  if (!state) {
    return (
      <section className="audio-panel">
        <DrawerHead onClose={onClose} />
        <div className="empty">Loading mixer…</div>
      </section>
    );
  }

  return (
    <section className="audio-panel">
      <DrawerHead onClose={onClose} />
      <div className="audio-master">
        <label>
          <span>Master</span>
          <span className="audio-device" title={state.outputDeviceName ?? undefined}>
            Default output
          </span>
        </label>
        <div className="session-row session-row--master">
          <VolumeSlider
            value={state.masterVolume}
            send={(vol) => invoke("audio_set_master_volume", { vol })}
            onDragging={onDragging}
            onCommitted={onChange}
          />
          <button
            type="button"
            className={`icon-btn mute-btn ${state.masterMuted ? "is-active" : ""}`}
            aria-pressed={state.masterMuted}
            title={state.masterMuted ? "Unmute output" : "Mute output"}
            onClick={async () => {
              await invoke("audio_set_master_mute", { mute: !state.masterMuted });
              onChange();
            }}
          >
            <Icon name={state.masterMuted ? "muted" : "speaker"} />
          </button>
        </div>
      </div>
      <div className={`audio-mic ${state.micMuted ? "is-muted" : ""}`}>
        <span className="mic-dot" /> Microphone {state.micMuted ? "muted" : "live"}
        {state.micCapable ? "" : " (limited)"}
      </div>
      <div className="side-section">Apps</div>
      <div className="clip-scroll audio-scroll">
        {state.sessions.length === 0 ? (
          <div className="empty">No active sessions.</div>
        ) : (
          state.sessions.map((s) => (
            <div key={s.id} className="session-row">
              {s.iconDataUrl ? (
                <img src={s.iconDataUrl} alt="" />
              ) : (
                <div className="session-icon-placeholder" />
              )}
              <div className="session-info">
                <div className="session-name" title={s.name}>
                  {s.name}
                </div>
                <div className="session-meta">
                  PID {s.processId}
                  {!s.controllable ? " · view only" : ""}
                </div>
              </div>
              <VolumeSlider
                value={s.volume}
                disabled={!s.controllable}
                title={s.controllable ? undefined : "This session cannot be controlled here"}
                send={(vol) => invoke("audio_set_session_volume", { id: s.id, vol })}
                onDragging={onDragging}
                onCommitted={onChange}
              />
              <button
                type="button"
                className={`icon-btn mute-btn ${s.muted ? "is-active" : ""}`}
                aria-pressed={s.muted}
                disabled={!s.controllable}
                title={s.controllable ? (s.muted ? "Unmute" : "Mute") : "This session cannot be controlled here"}
                onClick={async () => {
                  await invoke("audio_set_session_mute", { id: s.id, mute: !s.muted });
                  onChange();
                }}
              >
                <Icon name={s.muted ? "muted" : "speaker"} />
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
