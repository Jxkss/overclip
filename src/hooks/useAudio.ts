import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AudioMixerState } from "../types/ipc";
import { useTauriEvent } from "./common";

const POLL_MS = 2000;
const FIRST_POLL_DELAY_MS = 380;

export function useAudio(active: boolean) {
  const [mixer, setMixer] = useState<AudioMixerState | null>(null);
  const inFlight = useRef(false);
  const paused = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const s = await invoke<AudioMixerState>("get_audio_state");
      if (!paused.current) setMixer(s);
    } catch {
      setMixer(null);
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    let interval = 0;
    const first = window.setTimeout(() => {
      void refresh();
      interval = window.setInterval(() => void refresh(), POLL_MS);
    }, FIRST_POLL_DELAY_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(interval);
    };
  }, [refresh, active]);

  useTauriEvent("mic-state", () => void refresh(), active);
  useTauriEvent("deafen-state", () => void refresh(), active);

  const setPaused = useCallback((v: boolean) => {
    paused.current = v;
  }, []);

  return { mixer, refresh, setPaused };
}
