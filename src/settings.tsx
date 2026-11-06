import { invoke } from "@tauri-apps/api/core";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useToast } from "./components/ui";
import { useTauriEvent } from "./hooks/common";
import type { AppSettings, UiSettings } from "./types/ipc";

type SettingsApi = {
  settings: AppSettings | null;
  defaults: AppSettings | null;
  update: (patch: Partial<AppSettings>) => void;
  updateUi: (patch: Partial<UiSettings>) => void;
  flush: () => Promise<void>;
};

const Ctx = createContext<SettingsApi | null>(null);

const SAVE_DELAY_MS = 250;

export function SettingsProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [defaults, setDefaults] = useState<AppSettings | null>(null);
  const latest = useRef<AppSettings | null>(null);
  const dirty = useRef(false);
  const timer = useRef(0);

  const reload = useCallback(async () => {
    const s = await invoke<AppSettings>("get_settings");
    latest.current = s;
    setSettings(s);
  }, []);

  useEffect(() => {
    void reload();
    void invoke<AppSettings>("default_settings").then(setDefaults);
  }, [reload]);

  useTauriEvent<AppSettings>("settings-changed", (s) => {
    if (dirty.current) return;
    latest.current = s;
    setSettings(s);
  });

  const save = useCallback(async () => {
    window.clearTimeout(timer.current);
    timer.current = 0;
    if (!dirty.current || !latest.current) return;
    const snapshot = latest.current;
    dirty.current = false;
    try {
      await invoke("set_settings", { settings: snapshot });
    } catch (e) {
      toast(String(e), "error");
      await reload();
    }
  }, [reload, toast]);

  const update = useCallback(
    (patch: Partial<AppSettings>) => {
      if (!latest.current) return;
      const next = { ...latest.current, ...patch };
      latest.current = next;
      dirty.current = true;
      setSettings(next);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void save(), SAVE_DELAY_MS);
    },
    [save],
  );

  const updateUi = useCallback(
    (patch: Partial<UiSettings>) => {
      if (!latest.current) return;
      update({ ui: { ...latest.current.ui, ...patch } });
    },
    [update],
  );

  useEffect(() => {
    const onHide = () => void save();
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [save]);

  return (
    <Ctx.Provider value={{ settings, defaults, update, updateUi, flush: save }}>{children}</Ctx.Provider>
  );
}

export function useSettings(): SettingsApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSettings outside SettingsProvider");
  return v;
}

export const FALLBACK_UI: UiSettings = {
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
};

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(rgb: [number, number, number], target: number, amount: number): string {
  const c = rgb.map((v) => Math.round(v + (target - v) * amount));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

function onAccent([r, g, b]: [number, number, number]): string {
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.55 ? "#000000" : "#ffffff";
}

export function useApplyAppearance(settings: AppSettings | null) {
  const ui = settings?.ui;
  const theme = settings?.theme;
  useEffect(() => {
    if (!ui || !theme) return;
    const root = document.documentElement;
    const rgb = hexToRgb(ui.accent);
    root.dataset.theme = theme;
    root.dataset.motion = ui.animations ? "on" : "off";
    root.dataset.gallerySize = ui.gallerySize;
    root.style.setProperty("--accent", ui.accent);
    root.style.setProperty("--accent-hover", mix(rgb, 255, 0.18));
    root.style.setProperty("--accent-dim", `rgba(${rgb.join(", ")}, 0.15)`);
    root.style.setProperty("--accent-line", `rgba(${rgb.join(", ")}, 0.55)`);
    root.style.setProperty("--on-accent", onAccent(rgb));
    root.style.setProperty("--dim", String(ui.dim));
    root.style.setProperty("--panel-width", `${ui.panelWidth}px`);
  }, [ui, theme]);
}

export const ACCENT_PRESETS: { name: string; value: string }[] = [
  { name: "Green", value: "#76b900" },
  { name: "Blue", value: "#3b82f6" },
  { name: "Cyan", value: "#06b6d4" },
  { name: "Purple", value: "#8b5cf6" },
  { name: "Pink", value: "#ec4899" },
  { name: "Red", value: "#ef4444" },
  { name: "Orange", value: "#f97316" },
  { name: "Gold", value: "#eab308" },
  { name: "White", value: "#e5e5e5" },
];
