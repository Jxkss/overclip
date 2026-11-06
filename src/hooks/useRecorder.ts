import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "../components/ui";
import type { GameBarSettings, ObsSettings, RecorderOverview, RecorderSettings } from "../types/ipc";
import { useTauriEvent } from "./common";

export type RecorderAction = "saveReplay" | "toggleRecording" | "screenshot";

type Editable = { amd: RecorderSettings; gamebar: GameBarSettings; obs: ObsSettings };
type Kind = keyof Editable;

const COMMANDS: Record<Kind, string> = {
  amd: "amd_set_settings",
  gamebar: "gamebar_set_settings",
  obs: "obs_set_settings",
};

const APPLY_DELAY_MS = 700;
const POLL_MS = 2500;

export type Recorder = ReturnType<typeof useRecorder>;

function settingsOf<K extends Kind>(o: RecorderOverview, kind: K): Editable[K] | null {
  if (kind === "amd") return (o.amd?.settings ?? null) as Editable[K] | null;
  if (kind === "gamebar") return (o.gamebar?.settings ?? null) as Editable[K] | null;
  return (o.obs.settings ?? null) as Editable[K] | null;
}

function withSettings<K extends Kind>(o: RecorderOverview, kind: K, next: Editable[K]): RecorderOverview {
  if (kind === "amd" && o.amd) return { ...o, amd: { ...o.amd, settings: next as RecorderSettings } };
  if (kind === "gamebar" && o.gamebar) return { ...o, gamebar: { ...o.gamebar, settings: next as GameBarSettings } };
  if (kind === "obs") return { ...o, obs: { ...o.obs, settings: next as ObsSettings } };
  return o;
}

export function useRecorder(active: boolean) {
  const toast = useToast();
  const [status, setStatus] = useState<RecorderOverview | null>(null);
  const pending = useRef<Partial<{ [K in Kind]: Editable[K] }>>({});
  const timers = useRef<Partial<Record<Kind, number>>>({});
  const busy = () => Object.keys(pending.current).length > 0;

  const refresh = useCallback(async () => {
    try {
      const s = await invoke<RecorderOverview>("recorder_status");
      if (!busy()) setStatus(s);
    } catch {
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void refresh();
    const id = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(id);
  }, [active, refresh]);

  useTauriEvent<RecorderOverview>("recorder-changed", (s) => {
    if (!busy()) setStatus(s);
  });

  const send = useCallback(
    async (kind: Kind) => {
      window.clearTimeout(timers.current[kind]);
      const next = pending.current[kind];
      if (!next) return;
      try {
        await invoke(COMMANDS[kind], { settings: next });
      } catch (e) {
        toast(String(e), "error");
      }
      if (pending.current[kind] === next) delete pending.current[kind];
      void refresh();
    },
    [refresh, toast],
  );

  const update = useCallback(
    <K extends Kind>(kind: K, patch: Partial<Editable[K]>, immediate = false) => {
      setStatus((cur) => {
        const base = cur && ((pending.current[kind] as Editable[K] | undefined) ?? settingsOf(cur, kind));
        if (!cur || !base) return cur;
        const next = { ...base, ...patch } as Editable[K];
        (pending.current as Record<Kind, unknown>)[kind] = next;
        return withSettings(cur, kind, next);
      });
      window.clearTimeout(timers.current[kind]);
      timers.current[kind] = window.setTimeout(() => void send(kind), immediate ? 0 : APPLY_DELAY_MS);
    },
    [send],
  );

  useEffect(
    () => () => {
      for (const k of Object.keys(pending.current) as Kind[]) void send(k);
    },
    [send],
  );

  const setReplay = useCallback(
    async (on: boolean) => {
      try {
        setStatus(await invoke<RecorderOverview>("recorder_set_replay", { on }));
      } catch (e) {
        toast(String(e), "error");
        void refresh();
      }
    },
    [refresh, toast],
  );

  const run = useCallback(
    async (action: RecorderAction): Promise<string | null | false> => {
      try {
        return await invoke<string | null>("recorder_action", { action });
      } catch (e) {
        toast(String(e), "error");
        return false;
      } finally {
        window.setTimeout(() => void refresh(), 800);
      }
    },
    [refresh, toast],
  );

  return { status, update, setReplay, run, refresh };
}

export function formatSeconds(sec: number): string {
  if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m} min ${s} s` : `${m} min`;
}
