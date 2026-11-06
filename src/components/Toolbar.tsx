import { useState } from "react";
import type { MediaEntry } from "../types/ipc";
import { thumbUrl, type Density } from "./MediaGrid";
import { Icon, type IconName } from "./ui";

export function SideItem({
  active,
  onClick,
  label,
  count,
  icon,
  cover,
  title,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  icon?: IconName;
  cover?: MediaEntry;
  title?: string;
}) {
  const [coverFailed, setCoverFailed] = useState(false);
  return (
    <button
      type="button"
      className={`side-item ${active ? "is-on" : ""}`}
      onClick={onClick}
      title={title ?? label}
      aria-pressed={active}
    >
      {cover && !coverFailed ? (
        <img
          className="side-cover"
          src={thumbUrl(cover)}
          alt=""
          decoding="async"
          draggable={false}
          onError={() => setCoverFailed(true)}
        />
      ) : (
        <span className="side-icon">
          <Icon name={icon ?? "film"} size={15} />
        </span>
      )}
      <span className="side-label">{label}</span>
      <span className="side-count">{count}</span>
    </button>
  );
}

export function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="search-box">
      <Icon name="search" size={15} />
      <input
        data-search
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.stopPropagation();
            e.nativeEvent.stopImmediatePropagation();
            onChange("");
          } else if (e.key === "ArrowDown" || e.key === "Enter") {
            const first = document.querySelector<HTMLElement>(".clip-scroll [data-idx]");
            if (first) {
              e.preventDefault();
              first.focus();
            }
          }
        }}
        aria-label={placeholder}
        spellCheck={false}
      />
      {value && (
        <button type="button" className="search-clear" onClick={() => onChange("")} aria-label="Clear search">
          <Icon name="x" size={14} />
        </button>
      )}
      {!value && <kbd className="search-hint">/</kbd>}
    </div>
  );
}

const DENSITIES: { value: Density; label: string }[] = [
  { value: "l", label: "Large thumbnails" },
  { value: "m", label: "Medium thumbnails" },
  { value: "s", label: "Small thumbnails" },
];

export function DensityToggle({ value, onChange }: { value: Density; onChange: (d: Density) => void }) {
  return (
    <div className="seg" role="radiogroup" aria-label="Thumbnail size">
      {DENSITIES.map((d) => (
        <button
          key={d.value}
          type="button"
          role="radio"
          aria-checked={value === d.value}
          className={value === d.value ? "is-on" : ""}
          onClick={() => onChange(d.value)}
          title={d.label}
        >
          {d.value.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
