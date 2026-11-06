import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ScreenshotEntry, ScreenshotsPayload } from "../types/ipc";
import { oneOf, useStoredState, useTauriEvent } from "./common";
import { matchesSearch, searchTerms } from "./useClips";

export type ScreenshotSortMode = "newest" | "oldest" | "largest" | "name";

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function useScreenshots(active: boolean) {
  const [raw, setRaw] = useState<ScreenshotEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const genRef = useRef<number | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useStoredState<ScreenshotSortMode>(
    "overclip-shot-sort",
    "newest",
    oneOf("newest", "oldest", "largest", "name"),
  );
  const [monthFilter, setMonthFilter] = useStoredState<string>("overclip-shot-month", "all");

  const refresh = useCallback(async () => {
    try {
      const res = await invoke<ScreenshotsPayload>("get_screenshots", { since: genRef.current });
      if (res.screenshots && (genRef.current == null || res.generation > genRef.current)) {
        genRef.current = res.generation;
        setRaw(res.screenshots);
      }
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  useTauriEvent<number>(
    "screenshots-updated",
    (g) => {
      if (g !== genRef.current) void refresh();
    },
    active,
  );

  const rescan = useCallback(async () => {
    await invoke("refresh_screenshots");
  }, []);

  const months = useMemo(() => {
    const map = new Map<string, { name: string; count: number; cover: ScreenshotEntry }>();
    for (const s of raw) {
      const m = map.get(s.month);
      if (m) m.count++;
      else map.set(s.month, { name: s.month, count: 1, cover: s });
    }
    return Array.from(map.values()).sort((a, b) =>
      a.name === "Unknown" ? 1 : b.name === "Unknown" ? -1 : b.name.localeCompare(a.name),
    );
  }, [raw]);

  const effectiveMonth = monthFilter !== "all" && months.some((m) => m.name === monthFilter) ? monthFilter : "all";

  const screenshots = useMemo(() => {
    const terms = searchTerms(search);
    let list = raw.filter(
      (s) =>
        (effectiveMonth === "all" || s.month === effectiveMonth) &&
        (!terms.length || matchesSearch(`${s.fileName} ${s.month}`.toLowerCase(), terms)),
    );
    switch (sort) {
      case "oldest":
        list = list.reverse();
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
  }, [raw, search, sort, effectiveMonth]);

  return {
    all: raw,
    screenshots,
    loaded,
    refresh,
    rescan,
    search,
    setSearch,
    sort,
    setSort,
    months,
    monthFilter: effectiveMonth,
    setMonthFilter,
  };
}

export type ScreenshotsState = ReturnType<typeof useScreenshots>;
