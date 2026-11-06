import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useEscapeLayer } from "../hooks/common";


const ICONS = {
  star: "M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z",
  play: "M8 5.5v13l10.5-6.5z",
  folder: "M3.5 7.5a2 2 0 0 1 2-2h3.7l2 2h7.3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z",
  copy: "M9 9h10v10H9zM5 15V5h10",
  more: "M12 6.5h.01M12 12h.01M12 17.5h.01",
  trash: "M4.5 7h15M10 11v6M14 11v6M6.5 7l1 12h9l1-12M9.5 7V4.5h5V7",
  refresh: "M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4.5H15",
  search: "M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM20 20l-4.8-4.8",
  x: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  edit: "M4.5 19.5h4l10-10-4-4-10 10zM13 7l4 4",
  check: "M5 12.5l4.5 4.5L19 7.5",
  left: "M15 5.5L8.5 12l6.5 6.5",
  right: "M9 5.5l6.5 6.5L9 18.5",
  external: "M13.5 4.5h6v6M19.5 4.5l-8 8M17.5 14v5.5h-13v-13H10",
  sliders: "M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4",
  grid: "M4.5 4.5h6v6h-6zM13.5 4.5h6v6h-6zM4.5 13.5h6v6h-6zM13.5 13.5h6v6h-6z",
  film: "M4 5h16v14H4zM8 5v14M16 5v14M4 9.5h4M4 14.5h4M16 9.5h4M16 14.5h4",
  image: "M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15.5 9h.01",
  speaker: "M4 9.5h3.5L12 6v12l-4.5-3.5H4zM15.5 9.2a4 4 0 0 1 0 5.6M18 6.7a7.5 7.5 0 0 1 0 10.6",
  muted: "M4 9.5h3.5L12 6v12l-4.5-3.5H4zM15.5 9.5l5 5M20.5 9.5l-5 5",
  gear:
    "M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM19.4 13.5l1.6 1.2-2 3.4-1.9-.7a7 7 0 0 1-1.7 1l-.3 2h-4l-.3-2a7 7 0 0 1-1.7-1l-1.9.7-2-3.4 1.6-1.2a7 7 0 0 1 0-3L3 9.3l2-3.4 1.9.7a7 7 0 0 1 1.7-1l.3-2h4l.3 2a7 7 0 0 1 1.7 1l1.9-.7 2 3.4-1.6 1.2a7 7 0 0 1 0 3z",
  calendar: "M4.5 6.5h15v13h-15zM4.5 10.5h15M8.5 4v4M15.5 4v4",
  panel: "M4 5h16v14H4zM10 5v14M6.5 8.5h1.5M6.5 11.5h1.5",
  help: "M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM9.6 9.6a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.5M12 16.8h.01",
  palette:
    "M12 3.5a8.5 8.5 0 0 0 0 17c1 0 1.5-.7 1.5-1.4 0-.9-.8-1.3-.8-2.2 0-.9.7-1.4 1.6-1.4h2.2a4 4 0 0 0 4-4c0-4.4-3.8-8-8.5-8zM7.5 12h.01M9.5 8h.01M14.5 8h.01",
  layout: "M4 5h16v14H4zM4 9.5h16M9.5 9.5V19",
  bolt: "M13 3.5L5.5 13H12l-1 7.5L18.5 11H12z",
  keyboard: "M3.5 7h17v10h-17zM7 10.5h.01M10.5 10.5h.01M14 10.5h.01M17.5 10.5h.01M8 14h8",
  monitor: "M4 5h16v11H4zM9 20h6M12 16v4",
  info: "M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM12 11v5.5M12 7.8h.01",
  github:
    "M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21",
  globe: "M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM3.5 12h17M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5s1.1-6.1 3.4-8.5z",
  bug: "M8 9.5a4 4 0 0 1 8 0V15a4 4 0 0 1-8 0zM12 11v8M4 13h4M16 13h4M5 8l3 2M19 8l-3 2M5 19l3-2M19 19l-3-2M9.5 5.5L8 4M14.5 5.5L16 4",
  record: "M12 4a8 8 0 1 1 0 16 8 8 0 0 1 0-16zM12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z",
  stop: "M7 7h10v10H7z",
  camera: "M4 8h3.5L9 5.5h6L16.5 8H20v11H4zM12 10.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7z",
  replay: "M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5V9H9M12 8.5v4l2.8 1.7",
  heart: "M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.6 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z",
  sparkle: "M12 3.5l1.8 5.2L19 10.5l-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8zM18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z",
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 16, filled = false }: { name: IconName; size?: number; filled?: boolean }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={name === "more" ? 3 : 1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

export function IconButton({
  icon,
  label,
  onClick,
  active,
  disabled,
  className = "",
  filled,
}: {
  icon: IconName;
  label: string;
  onClick: (e: React.MouseEvent) => void;
  active?: boolean;
  disabled?: boolean;
  className?: string;
  filled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`icon-btn ${active ? "is-active" : ""} ${className}`}
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active}
    >
      <Icon name={icon} filled={filled} />
    </button>
  );
}


type Toast = { id: number; text: string; kind: "info" | "error" };
type ToastFn = (text: string, kind?: Toast["kind"]) => void;

const ToastCtx = createContext<ToastFn>(() => {});

export function useToast(): ToastFn {
  return useContext(ToastCtx);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback<ToastFn>((text, kind = "info") => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-2), { id, text, kind }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 5000 : 2800);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      {createPortal(
        <div className="toast-stack" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast toast--${t.kind}`}>
              {t.text}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastCtx.Provider>
  );
}


export function Modal({
  onClose,
  children,
  className = "",
  label,
}: {
  onClose: () => void;
  children: ReactNode;
  className?: string;
  label: string;
}) {
  useEscapeLayer(true, onClose);
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`modal ${className}`} role="dialog" aria-modal aria-label={label}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal onClose={onCancel} label={title} className="modal--small">
      <h2>{title}</h2>
      {body && <div className="modal-body">{body}</div>}
      <div className="modal-actions">
        <button type="button" className="ab-btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className={`ab-btn ${danger ? "ab-btn--danger" : "ab-btn--primary"}`}
          onClick={onConfirm}
          autoFocus
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

export function PromptDialog({
  title,
  initial,
  suffix,
  confirmLabel,
  onSubmit,
  onCancel,
}: {
  title: string;
  initial: string;
  suffix?: string;
  confirmLabel: string;
  onSubmit: (value: string) => Promise<void> | void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.select();
  }, []);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(value);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onCancel} label={title} className="modal--small">
      <h2>{title}</h2>
      <div className="field-row">
        <input
          ref={inputRef}
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
          spellCheck={false}
        />
        {suffix && <span className="field-suffix">{suffix}</span>}
      </div>
      {error && <div className="field-error">{error}</div>}
      <div className="modal-actions">
        <button type="button" className="ab-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="ab-btn ab-btn--primary" onClick={() => void submit()} disabled={busy}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}


export type MenuItem =
  | { label: string; hint?: string; danger?: boolean; disabled?: boolean; onSelect: () => void }
  | "separator";

export function ContextMenu({
  x,
  y,
  items,
  title,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  title?: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useEscapeLayer(true, onClose);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)),
    });
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onWheel = () => onClose();
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("wheel", onWheel, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("wheel", onWheel, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = buttons[(i + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length];
    next?.focus();
  };

  return createPortal(
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {title && <div className="ctx-title">{title}</div>}
      {items.map((it, i) =>
        it === "separator" ? (
          <div key={i} className="ctx-sep" role="separator" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={it.danger ? "is-danger" : ""}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onSelect();
            }}
          >
            <span>{it.label}</span>
            {it.hint && <kbd>{it.hint}</kbd>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
