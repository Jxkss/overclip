import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { readStored } from "../hooks/common";
import type { ClipsState, ExtensionFilter, SortMode } from "../hooks/useClips";
import type { ClipEntry } from "../types/ipc";
import { groupByLocalDay, groupConsecutive, type Group } from "../utils/dateGroups";
import {
  formatBytes,
  formatDate,
  formatDateTime,
  formatDur,
  formatTime,
  formatTotalDur,
  libraryLabel,
  plural,
} from "../utils/format";
import { MediaGrid, thumbUrl, type UiPrefs } from "./MediaGrid";
import { Icon, IconButton, useToast } from "./ui";
import { DensityToggle, SearchBox, SideItem } from "./Toolbar";

type Props = {
  lib: ClipsState;
  active: boolean;
  prefs: UiPrefs;
  onPrefs: (p: Partial<UiPrefs>) => void;
  onOpenSettings: () => void;
  compact?: boolean;
};

const SORTS: { value: SortMode; label: string }[] = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "favorites", label: "Favorites first" },
  { value: "longest", label: "Longest" },
  { value: "largest", label: "Largest" },
  { value: "name", label: "Name" },
];

const PREVIEW_VOLUME_KEY = "overclip-preview-volume";

function ClipVideo({
  clip,
  onMeta,
  autoplay,
}: {
  clip: ClipEntry;
  onMeta: (w: number, h: number) => void;
  autoplay: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    try {
      const saved = JSON.parse(readStored(PREVIEW_VOLUME_KEY) ?? "null") as {
        volume: number;
        muted: boolean;
      } | null;
      if (saved) {
        v.volume = Math.min(1, Math.max(0, saved.volume));
        v.muted = saved.muted;
      }
    } catch {
    }
  }, []);
  return (
    <video
      ref={ref}
      src={convertFileSrc(clip.path)}
      poster={thumbUrl(clip)}
      controls
      controlsList="nofullscreen"
      disablePictureInPicture
      autoPlay={autoplay}
      playsInline
      onLoadedMetadata={(e) => onMeta(e.currentTarget.videoWidth, e.currentTarget.videoHeight)}
      onVolumeChange={(e) => {
        try {
          localStorage.setItem(
            PREVIEW_VOLUME_KEY,
            JSON.stringify({ volume: e.currentTarget.volume, muted: e.currentTarget.muted }),
          );
        } catch {
        }
      }}
    />
  );
}

export function ClipPanel({ lib, active, prefs, onPrefs, onOpenSettings, compact = false }: Props) {
  const toast = useToast();

  const dateSorted = lib.sort === "newest" || lib.sort === "oldest";
  const favSorted = lib.sort === "favorites";
  const favs = lib.favorites;

  const group = useCallback(
    (shown: ClipEntry[]): Group<ClipEntry>[] => {
      if (dateSorted && prefs.groupByDay) return groupByLocalDay(shown, (c) => c.capturedAtMs);
      if (favSorted)
        return groupConsecutive(
          shown,
          (c) => (favs.has(c.id) ? "fav" : "rest"),
          (k) => (k === "fav" ? "Favorites" : "Everything else"),
        );
      return groupConsecutive(shown, () => "all", () => "");
    },
    [dateSorted, favSorted, favs, prefs.groupByDay],
  );

  const groupMeta = useCallback((g: Group<ClipEntry>) => {
    const dur = g.items.reduce((n, c) => n + (c.durationMs ?? 0), 0);
    return `${plural(g.items.length, "clip")}${dur ? ` · ${formatTotalDur(dur)}` : ""}`;
  }, []);

  const subtitle = useCallback(
    (c: ClipEntry) =>
      `${c.gameName} · ${dateSorted ? formatTime(c.capturedAtMs) : formatDate(c.capturedAtMs)} · ${formatBytes(c.sizeBytes)}`,
    [dateSorted],
  );
  const badge = useCallback((c: ClipEntry) => (c.durationMs != null ? formatDur(c.durationMs) : null), []);
  const isNew = useCallback(
    (c: ClipEntry) => prefs.newBadges && (c.capturedAtMs ?? 0) > lib.newSince,
    [lib.newSince, prefs.newBadges],
  );

  const favorites = useMemo(
    () => ({ has: (id: string) => favs.has(id), toggle: lib.toggleFavorite, rename: lib.renameFavorite }),
    [favs, lib.toggleFavorite, lib.renameFavorite],
  );

  const renderPreview = useCallback(
    (c: ClipEntry, onMeta: (w: number, h: number) => void, autoplay: boolean) => (
      <ClipVideo clip={c} onMeta={onMeta} autoplay={autoplay} />
    ),
    [],
  );
  const multiLibrary = lib.libraries.length > 1;
  const previewDetails = useCallback(
    (c: ClipEntry) => [
      ...(multiLibrary ? [libraryLabel(c.library)] : []),
      c.gameName,
      formatDateTime(c.capturedAtMs),
      formatDur(c.durationMs),
      formatBytes(c.sizeBytes),
    ],
    [multiLibrary],
  );

  const totalBytes = useMemo(() => lib.clips.reduce((n, c) => n + c.sizeBytes, 0), [lib.clips]);
  const totalDur = useMemo(() => lib.clips.reduce((n, c) => n + (c.durationMs ?? 0), 0), [lib.clips]);
  const filtered = lib.clips.length !== lib.all.length;

  const clearFilters = () => {
    lib.setSearch("");
    lib.setGameFilter("all");
    lib.setLibraryFilter("all");
    lib.setFavoritesOnly(false);
    lib.setExtensionFilter("all");
  };

  const resetKey = `${lib.search}|${lib.sort}|${lib.gameFilter}|${lib.libraryFilter}|${lib.favoritesOnly}|${lib.extensionFilter}`;

  const viewTitle =
    lib.gameFilter !== "all"
      ? lib.gameFilter
      : lib.favoritesOnly
        ? "Favorites"
        : lib.libraryFilter !== "all"
          ? libraryLabel(lib.libraryFilter)
          : "All clips";
  const allSelected = lib.gameFilter === "all" && lib.libraryFilter === "all" && !lib.favoritesOnly;

  const grid = (
    <MediaGrid
      kind="clips"
      items={lib.clips}
      resetKey={resetKey}
      active={active}
      loaded={lib.loaded}
      libraryEmpty={lib.all.length === 0}
      prefs={compact ? { ...prefs, density: "s" } : prefs}
      group={group}
      groupMeta={groupMeta}
      subtitle={subtitle}
      badge={badge}
      isNew={isNew}
      favorites={favorites}
      hoverVideo
      renderPreview={renderPreview}
      previewDetails={previewDetails}
      onClearFilters={clearFilters}
      onOpenSettings={onOpenSettings}
    />
  );

  if (compact) {
    return (
      <section className="gallery-main gallery-main--compact">
        <SearchBox value={lib.search} onChange={lib.setSearch} placeholder="Search clips or games" />
        <div className="toolbar">
          <select
            className="grow"
            value={lib.gameFilter}
            onChange={(e) => lib.setGameFilter(e.target.value)}
            aria-label="Game"
          >
            <option value="all">All games ({lib.all.length})</option>
            {lib.games.map((g) => (
              <option key={g.name} value={g.name}>
                {g.name} ({g.count})
              </option>
            ))}
          </select>
          <select value={lib.sort} onChange={(e) => lib.setSort(e.target.value as SortMode)} aria-label="Sort order">
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <IconButton
            icon="star"
            label={lib.favoritesOnly ? "Show all clips" : "Favorites only"}
            active={lib.favoritesOnly}
            filled={lib.favoritesOnly}
            onClick={() => lib.setFavoritesOnly(!lib.favoritesOnly)}
          />
        </div>
        <div className="stats-line">
          {filtered ? `${lib.clips.length} of ${plural(lib.all.length, "clip")}` : plural(lib.all.length, "clip")}
          {" · "}
          {formatBytes(totalBytes)}
          {filtered && (
            <button type="button" className="link-btn" onClick={clearFilters}>
              Clear
            </button>
          )}
          {lib.offlineRoots.map((r) => (
            <span key={r} className="offline-note" title={r}>
              {libraryLabel(r)} not connected
            </span>
          ))}
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
          label="All clips"
          count={lib.all.length}
          active={allSelected}
          onClick={() => {
            lib.setGameFilter("all");
            lib.setLibraryFilter("all");
            lib.setFavoritesOnly(false);
          }}
        />
        <SideItem
          icon="star"
          label="Favorites"
          count={lib.favoriteCount}
          active={lib.favoritesOnly}
          onClick={() => lib.setFavoritesOnly(!lib.favoritesOnly)}
        />
        {(multiLibrary || lib.offlineRoots.length > 0) && (
          <>
            <div className="side-section">Locations</div>
            {lib.libraries.map((l) => (
              <SideItem
                key={l.path}
                icon="folder"
                label={libraryLabel(l.path)}
                title={l.path}
                count={l.count}
                active={lib.libraryFilter === l.path}
                onClick={() => lib.setLibraryFilter(lib.libraryFilter === l.path ? "all" : l.path)}
              />
            ))}
            {lib.offlineRoots.map((r) => (
              <div key={r} className="side-offline" title={r}>
                <Icon name="folder" size={15} /> {libraryLabel(r)} <span>not connected</span>
              </div>
            ))}
          </>
        )}
        <div className="side-section">Games</div>
        {lib.games.map((g) => (
          <SideItem
            key={g.name}
            cover={prefs.showCovers ? g.cover : undefined}
            label={g.name}
            count={g.count}
            active={lib.gameFilter === g.name}
            onClick={() => lib.setGameFilter(lib.gameFilter === g.name ? "all" : g.name)}
          />
        ))}
      </aside>

      <section className="gallery-main">
        <div className="main-head">
          <div>
            <h1 className="view-title">{viewTitle}</h1>
            <div className="stats-line">
              {filtered ? `${lib.clips.length} of ${plural(lib.all.length, "clip")}` : plural(lib.all.length, "clip")}
              {" · "}
              {formatBytes(totalBytes)}
              {totalDur > 0 && ` · ${formatTotalDur(totalDur)}`}
              {filtered && (
                <button type="button" className="link-btn" onClick={clearFilters}>
                  Clear filters
                </button>
              )}
            </div>
          </div>
          <div className="toolbar">
            <SearchBox value={lib.search} onChange={lib.setSearch} placeholder="Search clips or games" />
            <select value={lib.sort} onChange={(e) => lib.setSort(e.target.value as SortMode)} aria-label="Sort order">
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            {lib.extensions.length > 1 && (
              <select
                value={lib.extensionFilter}
                onChange={(e) => lib.setExtensionFilter(e.target.value as ExtensionFilter)}
                aria-label="File type"
              >
                <option value="all">All types</option>
                {lib.extensions.map((x) => (
                  <option key={x} value={x}>
                    {x.toUpperCase()}
                  </option>
                ))}
              </select>
            )}
            <DensityToggle value={prefs.density} onChange={(density) => onPrefs({ density })} />
            <IconButton
              icon="refresh"
              label="Rescan folders"
              onClick={() => {
                void lib.rescan().then(() => toast("Rescanning clips…"));
              }}
            />
            <IconButton
              icon="folder"
              label="Open clips folder"
              onClick={() =>
                void invoke("open_media_folder", { kind: "clips" }).catch((e) => toast(String(e), "error"))
              }
            />
          </div>
        </div>

        {grid}
      </section>
    </div>
  );
}
