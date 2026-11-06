import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useCallback, useMemo, useState } from "react";
import type { ScreenshotSortMode, ScreenshotsState } from "../hooks/useScreenshots";
import type { ScreenshotEntry } from "../types/ipc";
import { groupByLocalDay, groupConsecutive, type Group } from "../utils/dateGroups";
import { formatBytes, formatDate, formatDateTime, formatTime, monthLabel, plural } from "../utils/format";
import { MediaGrid, thumbUrl, type UiPrefs } from "./MediaGrid";
import { DensityToggle, SearchBox, SideItem } from "./Toolbar";
import { IconButton, useToast } from "./ui";

type Props = {
  lib: ScreenshotsState;
  active: boolean;
  prefs: UiPrefs;
  onPrefs: (p: Partial<UiPrefs>) => void;
  onOpenSettings: () => void;
  compact?: boolean;
};

function ShotImage({ shot, onMeta }: { shot: ScreenshotEntry; onMeta: (w: number, h: number) => void }) {
  const [ready, setReady] = useState(false);
  return (
    <div className="shot-stack">
      {!ready && <img className="shot-placeholder" src={thumbUrl(shot)} alt="" />}
      <img
        className={ready ? "" : "shot-loading"}
        src={convertFileSrc(shot.path)}
        alt={shot.fileName}
        decoding="async"
        onLoad={(e) => {
          setReady(true);
          onMeta(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight);
        }}
      />
    </div>
  );
}

export function ScreenshotPanel({ lib, active, prefs, onPrefs, onOpenSettings, compact = false }: Props) {
  const toast = useToast();
  const dateSorted = lib.sort === "newest" || lib.sort === "oldest";

  const group = useCallback(
    (shown: ScreenshotEntry[]): Group<ScreenshotEntry>[] =>
      dateSorted && prefs.groupByDay
        ? groupByLocalDay(shown, (s) => s.capturedAtMs)
        : groupConsecutive(shown, () => "all", () => ""),
    [dateSorted, prefs.groupByDay],
  );
  const groupMeta = useCallback((g: Group<ScreenshotEntry>) => plural(g.items.length, "screenshot"), []);
  const subtitle = useCallback(
    (s: ScreenshotEntry) =>
      `${dateSorted ? formatTime(s.capturedAtMs) : formatDate(s.capturedAtMs)} · ${formatBytes(s.sizeBytes)}`,
    [dateSorted],
  );
  const renderPreview = useCallback(
    (s: ScreenshotEntry, onMeta: (w: number, h: number) => void) => <ShotImage shot={s} onMeta={onMeta} />,
    [],
  );
  const previewDetails = useCallback(
    (s: ScreenshotEntry) => [formatDateTime(s.capturedAtMs), formatBytes(s.sizeBytes)],
    [],
  );

  const totalBytes = useMemo(() => lib.screenshots.reduce((n, s) => n + s.sizeBytes, 0), [lib.screenshots]);
  const filtered = lib.screenshots.length !== lib.all.length;

  const clearFilters = () => {
    lib.setSearch("");
    lib.setMonthFilter("all");
  };

  const grid = (
    <MediaGrid
      kind="screenshots"
      items={lib.screenshots}
      resetKey={`${lib.search}|${lib.sort}|${lib.monthFilter}`}
      active={active}
      loaded={lib.loaded}
      libraryEmpty={lib.all.length === 0}
      prefs={compact ? { ...prefs, density: "s" } : prefs}
      group={group}
      groupMeta={groupMeta}
      subtitle={subtitle}
      renderPreview={renderPreview}
      previewDetails={previewDetails}
      onClearFilters={clearFilters}
      onOpenSettings={onOpenSettings}
    />
  );

  if (compact) {
    return (
      <section className="gallery-main gallery-main--compact">
        <SearchBox value={lib.search} onChange={lib.setSearch} placeholder="Search screenshots" />
        <div className="toolbar">
          <select
            className="grow"
            value={lib.monthFilter}
            onChange={(e) => lib.setMonthFilter(e.target.value)}
            aria-label="Month"
          >
            <option value="all">All months ({lib.all.length})</option>
            {lib.months.map((m) => (
              <option key={m.name} value={m.name}>
                {monthLabel(m.name)} ({m.count})
              </option>
            ))}
          </select>
          <select
            value={lib.sort}
            onChange={(e) => lib.setSort(e.target.value as ScreenshotSortMode)}
            aria-label="Sort order"
          >
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="largest">Largest</option>
            <option value="name">Name</option>
          </select>
        </div>
        <div className="stats-line">
          {filtered
            ? `${lib.screenshots.length} of ${plural(lib.all.length, "screenshot")}`
            : plural(lib.all.length, "screenshot")}
          {" · "}
          {formatBytes(totalBytes)}
          {filtered && (
            <button type="button" className="link-btn" onClick={clearFilters}>
              Clear
            </button>
          )}
        </div>
        {grid}
      </section>
    );
  }

  return (
    <div className="gallery-body">
      <aside className="sidebar">
        <div className="side-section">Library</div>
        <SideItem
          icon="grid"
          label="All screenshots"
          count={lib.all.length}
          active={lib.monthFilter === "all"}
          onClick={() => lib.setMonthFilter("all")}
        />
        <div className="side-section">Months</div>
        {lib.months.map((m) => (
          <SideItem
            key={m.name}
            cover={prefs.showCovers ? m.cover : undefined}
            label={monthLabel(m.name)}
            count={m.count}
            active={lib.monthFilter === m.name}
            onClick={() => lib.setMonthFilter(lib.monthFilter === m.name ? "all" : m.name)}
          />
        ))}
      </aside>

      <section className="gallery-main">
        <div className="main-head">
          <div>
            <h1 className="view-title">{lib.monthFilter === "all" ? "All screenshots" : monthLabel(lib.monthFilter)}</h1>
            <div className="stats-line">
              {filtered
                ? `${lib.screenshots.length} of ${plural(lib.all.length, "screenshot")}`
                : plural(lib.all.length, "screenshot")}
              {" · "}
              {formatBytes(totalBytes)}
              {filtered && (
                <button type="button" className="link-btn" onClick={clearFilters}>
                  Clear filters
                </button>
              )}
            </div>
          </div>
          <div className="toolbar">
            <SearchBox value={lib.search} onChange={lib.setSearch} placeholder="Search screenshots" />
            <select
              value={lib.sort}
              onChange={(e) => lib.setSort(e.target.value as ScreenshotSortMode)}
              aria-label="Sort order"
            >
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
              <option value="largest">Largest</option>
              <option value="name">Name</option>
            </select>
            <DensityToggle value={prefs.density} onChange={(density) => onPrefs({ density })} />
            <IconButton
              icon="refresh"
              label="Rescan folder"
              onClick={() => {
                void lib.rescan().then(() => toast("Rescanning screenshots…"));
              }}
            />
            <IconButton
              icon="folder"
              label="Open screenshots folder"
              onClick={() =>
                void invoke("open_media_folder", { kind: "screenshots" }).catch((e) => toast(String(e), "error"))
              }
            />
          </div>
        </div>

        {grid}
      </section>
    </div>
  );
}
