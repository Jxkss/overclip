import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClipEntry, ClipsPayload } from "../types/ipc";
import { oneOf, readStored, useStoredState, useTauriEvent } from "./common";

export type SortMode = "newest" | "oldest" | "favorites" | "longest" | "largest" | "name";

export type ExtensionFilter = "all" | "mp4" | "mov" | "mkv" | "webm" | "avi";

const SEEN_KEY = "overclip-clips-seen-ms";

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function matchesSearch(haystack: string, terms: string[]): boolean {
  return terms.every((t) => haystack.includes(t));
}

export function searchTerms(q: string): string[] {
  return q.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

export function useClips(active: boolean) {
  const [raw, setRaw] = useState<ClipEntry[]>([]);
  const [offlineRoots, setOfflineRoots] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const genRef = useRef<number | null>(null);

  const [search, setSearch] = useState("");
  const [sort, setSort] = useStoredState<SortMode>(
    "overclip-clip-sort",
    "newest",
    oneOf("newest", "oldest", "favorites", "longest", "largest", "name"),
  );
  const [favorites, setFavorites] = useStoredState<string[]>("overclip-favorites", [], isStringArray);
  const [favoritesOnly, setFavoritesOnly] = useStoredState<boolean>("overclip-favorites-only", false);
  const [extensionFilter, setExtensionFilter] = useStoredState<ExtensionFilter>(
    "overclip-extension-filter",
    "all",
    oneOf("all", "mp4", "mov", "mkv", "webm", "avi"),
  );
  const [gameFilter, setGameFilter] = useStoredState<string>("overclip-game-filter", "all");
  const [libraryFilter, setLibraryFilter] = useStoredState<string>("overclip-library-filter", "all");

  const refresh = useCallback(async () => {
    try {
      const res = await invoke<ClipsPayload>("get_clips", { since: genRef.current });
      setOfflineRoots((prev) => (prev.join("|") === res.offlineRoots.join("|") ? prev : res.offlineRoots));
      if (res.clips && (genRef.current == null || res.generation > genRef.current)) {
        genRef.current = res.generation;
        setRaw(res.clips);
      }
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  useTauriEvent<number>(
    "clips-updated",
    (g) => {
      if (g !== genRef.current) void refresh();
    },
    active,
  );

  const rescan = useCallback(async () => {
    await invoke("refresh_clips");
  }, []);

  const [newSince, setNewSince] = useState(Number.POSITIVE_INFINITY);
  const wasActive = useRef(false);
  useEffect(() => {
    try {
      if (active) {
        const v = Number(readStored(SEEN_KEY));
        setNewSince(v > 0 ? v : Date.now());
      } else if (wasActive.current) {
        localStorage.setItem(SEEN_KEY, String(Date.now()));
      }
    } catch {
    }
    wasActive.current = active;
  }, [active]);

  const favoritesSet = useMemo(() => new Set(favorites), [favorites]);

  const toggleFavorite = useCallback(
    (ids: string[], value?: boolean) => {
      setFavorites((prev) => {
        const set = new Set(prev);
        const target = value ?? !ids.every((id) => set.has(id));
        for (const id of ids) {
          if (target) set.add(id);
          else set.delete(id);
        }
        return Array.from(set);
      });
    },
    [setFavorites],
  );

  const renameFavorite = useCallback(
    (oldId: string, newId: string) => {
      setFavorites((prev) => (prev.includes(oldId) ? [...prev.filter((x) => x !== oldId), newId] : prev));
    },
    [setFavorites],
  );

  const games = useMemo(() => {
    const map = new Map<string, { name: string; count: number; cover: ClipEntry }>();
    for (const c of raw) {
      const g = map.get(c.gameName);
      if (g) g.count++;
      else map.set(c.gameName, { name: c.gameName, count: 1, cover: c });
    }
    return Array.from(map.values()).sort(
      (a, b) =>
        (b.cover.capturedAtMs ?? 0) - (a.cover.capturedAtMs ?? 0) || nameCollator.compare(a.name, b.name),
    );
  }, [raw]);

  const favoriteCount = useMemo(() => raw.filter((c) => favoritesSet.has(c.id)).length, [raw, favoritesSet]);

  const extensions = useMemo(() => Array.from(new Set(raw.map((c) => c.extension))).sort(), [raw]);

  const libraries = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of raw) counts.set(c.library, (counts.get(c.library) ?? 0) + 1);
    return Array.from(counts, ([path, count]) => ({ path, count }));
  }, [raw]);

  const effectiveGame = gameFilter !== "all" && games.some((g) => g.name === gameFilter) ? gameFilter : "all";
  const effectiveLibrary =
    libraryFilter !== "all" && libraries.some((l) => l.path === libraryFilter) ? libraryFilter : "all";

  const clips = useMemo(() => {
    const terms = searchTerms(search);
    let list = raw.filter((c) => {
      if (effectiveGame !== "all" && c.gameName !== effectiveGame) return false;
      if (effectiveLibrary !== "all" && c.library !== effectiveLibrary) return false;
      if (extensionFilter !== "all" && c.extension !== extensionFilter) return false;
      if (favoritesOnly && !favoritesSet.has(c.id)) return false;
      if (terms.length && !matchesSearch(`${c.fileName} ${c.gameName}`.toLowerCase(), terms)) return false;
      return true;
    });
    switch (sort) {
      case "oldest":
        list = list.reverse();
        break;
      case "favorites":
        list = [...list.filter((c) => favoritesSet.has(c.id)), ...list.filter((c) => !favoritesSet.has(c.id))];
        break;
      case "longest":
        list.sort((a, b) => (b.durationMs ?? -1) - (a.durationMs ?? -1));
        break;
      case "largest":
        list.sort((a, b) => b.sizeBytes - a.sizeBytes);
        break;
      case "name":
        list.sort((a, b) => nameCollator.compare(a.fileName, b.fileName));
        break;
      default:
        break;
    }
    return list;
  }, [raw, search, sort, extensionFilter, favoritesOnly, favoritesSet, effectiveGame, effectiveLibrary]);

  return {
    all: raw,
    clips,
    loaded,
    refresh,
    rescan,
    search,
    setSearch,
    sort,
    setSort,
    favorites: favoritesSet,
    toggleFavorite,
    renameFavorite,
    favoritesOnly,
    setFavoritesOnly,
    extensionFilter,
    setExtensionFilter,
    extensions,
    games,
    favoriteCount,
    gameFilter: effectiveGame,
    setGameFilter,
    libraries,
    libraryFilter: effectiveLibrary,
    setLibraryFilter,
    offlineRoots,
    newSince,
  };
}

export type ClipsState = ReturnType<typeof useClips>;
