import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState, type ReactNode } from "react";
import { ACCENT_PRESETS } from "../settings";
import type { FolderCandidate } from "../types/ipc";
import { plural } from "../utils/format";
import { Icon, type IconName } from "./ui";

export function Row({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-text">
        <div className="set-title">{title}</div>
        {description && <div className="set-desc">{description}</div>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`toggle ${checked ? "is-on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-knob" />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string; icon?: IconName }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={value === o.value ? "is-on" : ""}
          onClick={() => onChange(o.value)}
        >
          {o.icon && <Icon name={o.icon} size={15} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Slider({
  value,
  min,
  max,
  step,
  format,
  onChange,
  label,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
  label: string;
}) {
  return (
    <div className="range">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      <span className="range-value">{format(value)}</span>
    </div>
  );
}

export function AccentPicker({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const isPreset = ACCENT_PRESETS.some((p) => p.value === value);
  return (
    <div className="swatches" role="radiogroup" aria-label="Accent colour">
      {ACCENT_PRESETS.map((p) => (
        <button
          key={p.value}
          type="button"
          role="radio"
          aria-checked={value === p.value}
          className={`swatch ${value === p.value ? "is-on" : ""}`}
          style={{ background: p.value }}
          title={p.name}
          onClick={() => onChange(p.value)}
        />
      ))}
      <label className={`swatch swatch--custom ${isPreset ? "" : "is-on"}`} title="Custom colour">
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
        {!isPreset && <span style={{ background: value }} />}
      </label>
    </div>
  );
}

export async function pickFolder(current?: string): Promise<string | null> {
  const dir = await open({ directory: true, multiple: false, defaultPath: current || undefined });
  return typeof dir === "string" ? dir : null;
}

export function FolderField({
  value,
  onChange,
  onRemove,
}: {
  value: string;
  onChange: (v: string) => void;
  onRemove?: () => void;
}) {
  return (
    <div className="folder-field">
      <Icon name="folder" size={16} />
      <span className="folder-path" title={value}>
        {value || "Not set"}
      </span>
      <button
        type="button"
        className="ab-btn"
        onClick={async () => {
          const dir = await pickFolder(value);
          if (dir) onChange(dir);
        }}
      >
        Change…
      </button>
      {onRemove && (
        <button type="button" className="ab-btn ab-btn--danger" onClick={onRemove}>
          Remove
        </button>
      )}
    </div>
  );
}

export function FolderSuggestions({
  kind,
  existing,
  onPick,
}: {
  kind: "clips" | "screenshots";
  existing: string[];
  onPick: (path: string) => void;
}) {
  const [found, setFound] = useState<FolderCandidate[] | null>(null);
  useEffect(() => {
    void invoke<{ clips: FolderCandidate[]; screenshots: FolderCandidate[] }>("detect_media_folders").then((d) =>
      setFound(kind === "clips" ? d.clips : d.screenshots),
    );
  }, [kind]);
  const lower = existing.map((e) => e.toLowerCase());
  const fresh = (found ?? []).filter((f) => !f.current && !lower.includes(f.path.toLowerCase()));
  if (found == null) return <div className="set-desc">Looking for recorder folders…</div>;
  if (!fresh.length) return <div className="set-desc">No other {kind} folders found on this PC.</div>;
  return (
    <div className="suggestions">
      {fresh.map((f) => (
        <div key={f.path} className="suggestion">
          <div className="suggestion-text">
            <div className="set-title">{f.label}</div>
            <div className="set-desc" title={f.path}>
              {f.path} · {plural(f.count, kind === "clips" ? "video" : "image")}
              {f.count >= 5000 ? "+" : ""}
            </div>
          </div>
          <button type="button" className="ab-btn" onClick={() => onPick(f.path)}>
            Use
          </button>
        </div>
      ))}
    </div>
  );
}

const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta", "AltGraph"]);

function shortcutFromEvent(e: React.KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const c = e.code;
  let key: string | null = null;
  if (/^[a-z]$/i.test(e.key)) key = e.key.toUpperCase();
  else if (/^Key[A-Z]$/.test(c)) key = c.slice(3);
  else if (/^Digit\d$/.test(c)) key = c.slice(5);
  else if (/^F\d{1,2}$/.test(c)) key = c;
  else if (/^Numpad\d$/.test(c)) key = `Num${c.slice(6)}`;
  else {
    const named: Record<string, string> = {
      Space: "Space",
      Tab: "Tab",
      Backquote: "Backquote",
      Insert: "Insert",
      Delete: "Delete",
      Home: "Home",
      End: "End",
      PageUp: "PageUp",
      PageDown: "PageDown",
      ArrowUp: "Up",
      ArrowDown: "Down",
      ArrowLeft: "Left",
      ArrowRight: "Right",
      Pause: "Pause",
      ScrollLock: "ScrollLock",
    };
    key = named[c] ?? null;
  }
  if (!key) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Win");
  if (!parts.length && !/^F\d/.test(key) && key !== "Pause" && key !== "ScrollLock") return null;
  parts.push(key);
  return parts.join("+");
}

export function Keys({ combo }: { combo: string }) {
  return (
    <span className="keys">
      {combo.split("+").map((k, i) => (
        <kbd key={i}>{k}</kbd>
      ))}
    </span>
  );
}

export function ShortcutInput({
  value,
  onChange,
  fallback,
}: {
  value: string;
  onChange: (v: string) => void;
  fallback?: string;
}) {
  const [recording, setRecording] = useState(false);
  return (
    <div className="shortcut-row">
      <button
        type="button"
        className={`shortcut-input ${recording ? "is-recording" : ""}`}
        onClick={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        title="Click, then press the keys you want"
        onKeyDown={(e) => {
          if (!recording) return;
          e.preventDefault();
          e.stopPropagation();
          if (e.key === "Escape") {
            setRecording(false);
            return;
          }
          const s = shortcutFromEvent(e);
          if (s) {
            onChange(s);
            setRecording(false);
          }
        }}
      >
        {recording ? <span>Press your keys…</span> : <Keys combo={value} />}
        <Icon name="edit" size={14} />
      </button>
      {fallback && value !== fallback && (
        <button type="button" className="ab-btn" onClick={() => onChange(fallback)}>
          Reset
        </button>
      )}
    </div>
  );
}
