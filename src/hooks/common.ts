import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";

export function useTauriEvent<T>(name: string, handler: (payload: T) => void, enabled = true) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let un: (() => void) | undefined;
    void listen<T>(name, (e) => ref.current(e.payload)).then((u) => {
      if (disposed) u();
      else un = u;
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, [name, enabled]);
}

export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key) ?? localStorage.getItem(key.replace(/^overclip-/, "jutil-"));
  } catch {
    return null;
  }
}

export function useStoredState<T>(
  key: string,
  initial: T,
  validate: (v: unknown) => v is T = (v): v is T => typeof v === typeof initial,
) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = readStored(key);
      if (raw == null) return initial;
      const parsed = JSON.parse(raw) as unknown;
      return validate(parsed) ? parsed : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
    }
  }, [key, value]);
  return [value, setValue] as const;
}

export function oneOf<T extends string>(...values: T[]) {
  return (v: unknown): v is T => typeof v === "string" && (values as string[]).includes(v);
}

type Layer = { close: () => void };
const layers: Layer[] = [];

export function useEscapeLayer(active: boolean, onEscape: () => void) {
  const ref = useRef(onEscape);
  ref.current = onEscape;
  useEffect(() => {
    if (!active) return;
    const layer: Layer = { close: () => ref.current() };
    layers.push(layer);
    return () => {
      const i = layers.indexOf(layer);
      if (i >= 0) layers.splice(i, 1);
    };
  }, [active]);
}

export function popEscapeLayer(): boolean {
  const top = layers[layers.length - 1];
  if (!top) return false;
  top.close();
  return true;
}

export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

export function modalOpen(): boolean {
  return document.querySelector(".modal-backdrop") != null;
}
