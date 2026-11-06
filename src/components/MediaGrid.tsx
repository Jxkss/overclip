import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isTypingTarget, modalOpen, useEscapeLayer } from "../hooks/common";
import type { MediaEntry } from "../types/ipc";
import type { Group } from "../utils/dateGroups";
import { formatBytes, plural, stem } from "../utils/format";
import { ConfirmDialog, ContextMenu, Icon, IconButton, Modal, PromptDialog, useToast, type MenuItem } from "./ui";

export type Density = "s" | "m" | "l";

export type UiPrefs = {
  density: Density;
  hoverPreview: boolean;
  confirmDelete: boolean;
  autoplay: boolean;
  newBadges: boolean;
  groupByDay: boolean;
  showCovers: boolean;
};

export function thumbUrl(item: MediaEntry): string {
  const base = convertFileSrc(item.id, "thumb");
  return base.startsWith("data:") ? base : `${base}?v=${item.sizeBytes}-${item.capturedAtMs ?? 0}`;
}

const PAGE = 36;

type Favorites = {
  has: (id: string) => boolean;
  toggle: (ids: string[], value?: boolean) => void;
  rename: (oldId: string, newId: string) => void;
};

type Props<T extends MediaEntry> = {
  kind: "clips" | "screenshots";
  items: T[];
  resetKey: string;
  active: boolean;
  loaded: boolean;
  libraryEmpty: boolean;
  prefs: UiPrefs;
  group: (shown: T[]) => Group<T>[];
  groupMeta?: (g: Group<T>) => string;
  subtitle: (item: T) => string;
  badge?: (item: T) => string | null;
  isNew?: (item: T) => boolean;
  favorites?: Favorites;
  hoverVideo?: boolean;
  renderPreview: (item: T, onMeta: (w: number, h: number) => void, autoplay: boolean) => ReactNode;
  previewDetails: (item: T) => string[];
  onClearFilters: () => void;
  onOpenSettings: () => void;
};

type CardEvent = "click" | "menu" | "more" | "select" | "fav" | "open" | "reveal" | "copy";

type CardProps = {
  item: MediaEntry;
  index: number;
  selected: boolean;
  selecting: boolean;
  favorite: boolean | null;
  isNew: boolean;
  badge: string | null;
  subtitle: string;
  hoverVideo: boolean;
  compact: boolean;
  openLabel: string;
  onEvent: (type: CardEvent, index: number, e: React.MouseEvent) => void;
};

const Thumb = memo(function Thumb({ item }: { item: MediaEntry }) {
  const src = thumbUrl(item);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  if (failed === src) {
    return (
      <div className="thumb-fallback">
        <span>{item.extension.toUpperCase()}</span>
      </div>
    );
  }
  return (
    <img
      ref={(img) => {
        if (img && img.complete && img.naturalWidth > 0 && loaded !== src) setLoaded(src);
      }}
      className={loaded === src ? "is-loaded" : ""}
      src={src}
      alt=""
      decoding="async"
      draggable={false}
      onLoad={() => setLoaded(src)}
      onError={() => setFailed(src)}
    />
  );
});

const Card = memo(function Card(p: CardProps) {
  const [hoverPlay, setHoverPlay] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const ev = (t: CardEvent) => (e: React.MouseEvent) => {
    e.stopPropagation();
    p.onEvent(t, p.index, e);
  };

  return (
    <div
      className={`media-card ${p.selected ? "is-selected" : ""} ${p.selecting ? "is-selecting" : ""}`}
      data-idx={p.index}
      tabIndex={0}
      role="button"
      aria-selected={p.selected}
      onClick={(e) => p.onEvent("click", p.index, e)}
      onContextMenu={(e) => {
        e.preventDefault();
        p.onEvent("menu", p.index, e);
      }}
      onMouseEnter={
        p.hoverVideo
          ? () => {
              timer.current = window.setTimeout(() => setHoverPlay(true), 450);
            }
          : undefined
      }
      onMouseLeave={
        p.hoverVideo
          ? () => {
              window.clearTimeout(timer.current);
              setHoverPlay(false);
            }
          : undefined
      }
    >
      <div className="card-thumb">
        <Thumb item={p.item} />
        {hoverPlay && (
          <video className="card-hover-video" src={convertFileSrc(p.item.path)} muted autoPlay loop playsInline />
        )}
        <button
          type="button"
          className="card-check"
          onClick={ev("select")}
          aria-label={p.selected ? "Deselect" : "Select"}
          title="Select (Ctrl+click, Shift+click for a range)"
        >
          {p.selected && <Icon name="check" size={14} />}
        </button>
        {p.favorite !== null && (
          <button
            type="button"
            className={`card-fav ${p.favorite ? "is-on" : ""}`}
            onClick={ev("fav")}
            aria-label={p.favorite ? "Remove from favorites" : "Add to favorites"}
            title={p.favorite ? "Unfavorite (F)" : "Favorite (F)"}
          >
            <Icon name="star" size={15} filled={p.favorite} />
          </button>
        )}
        {p.isNew && <span className="badge badge--new">NEW</span>}
        {p.badge && <span className="badge badge--dur">{p.badge}</span>}
      </div>
      <div className="card-meta">
        <div className="card-title-row">
          <div className="card-title" title={p.item.fileName}>
            {p.item.fileName}
          </div>
          {!p.compact && (
            <div className="card-actions">
              <IconButton icon="play" label={`${p.openLabel} (O)`} onClick={ev("open")} />
              <IconButton icon="folder" label="Show in folder (E)" onClick={ev("reveal")} />
              <IconButton icon="copy" label="Copy file (Ctrl+C)" onClick={ev("copy")} />
              <IconButton icon="more" label="More" onClick={ev("more")} />
            </div>
          )}
        </div>
        <div className="card-sub">{p.subtitle}</div>
      </div>
    </div>
  );
});

function neighborCard(container: HTMLElement, current: HTMLElement, dir: "up" | "down"): HTMLElement | null {
  const cards = Array.from(container.querySelectorAll<HTMLElement>("[data-idx]"));
  const r = current.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const rects = cards.map((c) => [c, c.getBoundingClientRect()] as const);
  const cand = rects.filter(([, cr]) => (dir === "down" ? cr.top >= r.bottom - 1 : cr.bottom <= r.top + 1));
  if (!cand.length) return null;
  const rowTop =
    dir === "down" ? Math.min(...cand.map(([, cr]) => cr.top)) : Math.max(...cand.map(([, cr]) => cr.top));
  const row = cand.filter(([, cr]) => Math.abs(cr.top - rowTop) < 4);
  row.sort((a, b) => Math.abs(a[1].left + a[1].width / 2 - cx) - Math.abs(b[1].left + b[1].width / 2 - cx));
  return row[0][0];
}

export function MediaGrid<T extends MediaEntry>(props: Props<T>) {
  const { kind, items, active, prefs, favorites } = props;
  const toast = useToast();
  const noun = kind === "clips" ? "clip" : "screenshot";
  const openLabel = kind === "clips" ? "Open in player" : "Open";

  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const anchor = useRef<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; ids: string[] } | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [confirmIds, setConfirmIds] = useState<string[] | null>(null);
  const [renaming, setRenaming] = useState<T | null>(null);

  const indexById = useMemo(() => new Map(items.map((it, i) => [it.id, i])), [items]);

  useEffect(() => {
    setLimit(PAGE);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [props.resetKey]);

  useEffect(() => {
    if (active) return;
    setLimit(PAGE);
    setMenu(null);
    setPreviewId(null);
    setConfirmIds(null);
    setRenaming(null);
    setSelected(new Set());
  }, [active]);

  useEffect(() => {
    setSelected((prev) => {
      if (!prev.size) return prev;
      const next = new Set([...prev].filter((id) => indexById.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [indexById]);

  useEscapeLayer(selected.size > 0, () => setSelected(new Set()));

  const shown = useMemo(() => items.slice(0, limit), [items, limit]);
  const hasMore = shown.length < items.length;
  const groups = useMemo(() => props.group(shown), [props.group, shown]);

  useEffect(() => {
    const root = scrollRef.current;
    const el = sentinelRef.current;
    if (!root || !el || !hasMore || !active) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setLimit((l) => l + PAGE);
      },
      { root, rootMargin: "900px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, active, limit]);

  const awaitingId = useRef<string | null>(null);
  const lastPreview = useRef<{ index: number; item: T | null }>({ index: 0, item: null });
  const previewIndex = previewId != null ? indexById.get(previewId) ?? -1 : -1;
  if (previewIndex >= 0) lastPreview.current = { index: previewIndex, item: items[previewIndex] };
  useEffect(() => {
    if (previewId == null || indexById.has(previewId)) {
      if (previewId === awaitingId.current) awaitingId.current = null;
      return;
    }
    if (previewId === awaitingId.current) return;
    const fallback = items[Math.min(lastPreview.current.index, items.length - 1)];
    setPreviewId(fallback?.id ?? null);
  }, [indexById, previewId, items]);
  const previewItem = previewIndex >= 0 ? items[previewIndex] : previewId ? lastPreview.current.item : null;

  const attempt = useCallback(
    async (fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        toast(String(e), "error");
      }
    },
    [toast],
  );

  const byIds = (ids: string[]) =>
    ids.map((id) => items[indexById.get(id) ?? -1]).filter((x): x is T => x != null);

  const openItem = (id: string) => attempt(() => invoke("open_media", { id }));
  const revealItem = (id: string) => attempt(() => invoke("reveal_media", { id }));
  const copyFiles = (ids: string[]) =>
    attempt(async () => {
      const n = await invoke<number>("copy_media_files", { ids });
      toast(`Copied ${plural(n, "file")} — paste into Discord, a browser or a folder`);
    });
  const copyText = (text: string, what: string) =>
    attempt(async () => {
      await navigator.clipboard.writeText(text);
      toast(`Copied ${what}`);
    });

  const doDelete = (ids: string[]) =>
    attempt(async () => {
      const n = await invoke<number>("delete_media", { ids });
      toast(`Moved ${plural(n, noun)} to the Recycle Bin`);
      setSelected((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => next.delete(id));
        return next;
      });
    });

  const requestDelete = (ids: string[], skipConfirm = false) => {
    if (!ids.length) return;
    if (prefs.confirmDelete && !skipConfirm) setConfirmIds(ids);
    else void doDelete(ids);
  };

  const toggleFav = (ids: string[]) => {
    if (!favorites || !ids.length) return;
    const allFav = ids.every((id) => favorites.has(id));
    favorites.toggle(ids, !allFav);
    if (ids.length > 1) toast(allFav ? `Removed ${ids.length} from favorites` : `Added ${ids.length} to favorites`);
  };

  const targetsFor = (index: number): string[] => {
    const id = items[index]?.id;
    if (!id) return [];
    return selected.has(id) ? [...selected] : [id];
  };

  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectRange = (from: number, to: number, additive: boolean) => {
    const [a, b] = from < to ? [from, to] : [to, from];
    setSelected((prev) => {
      const next = additive ? new Set(prev) : new Set<string>();
      for (let i = a; i <= b; i++) if (items[i]) next.add(items[i].id);
      return next;
    });
  };

  const menuItems = (ids: string[]): MenuItem[] => {
    const list = byIds(ids);
    if (!list.length) return [];
    const multi = list.length > 1;
    const first = list[0];
    const out: MenuItem[] = [];
    if (!multi) {
      out.push(
        { label: "Preview", hint: "Enter", onSelect: () => setPreviewId(first.id) },
        { label: openLabel, hint: "O", onSelect: () => void openItem(first.id) },
        { label: "Show in folder", hint: "E", onSelect: () => void revealItem(first.id) },
        "separator",
      );
    }
    out.push(
      {
        label: multi ? `Copy ${list.length} files` : "Copy file",
        hint: "Ctrl+C",
        onSelect: () => void copyFiles(ids),
      },
      {
        label: multi ? "Copy paths" : "Copy path",
        onSelect: () => void copyText(list.map((x) => x.path).join("\n"), multi ? "paths" : "path"),
      },
    );
    if (!multi) out.push({ label: "Copy name", onSelect: () => void copyText(first.fileName, "name") });
    if (favorites) {
      const allFav = ids.every((id) => favorites.has(id));
      out.push({ label: allFav ? "Remove from favorites" : "Add to favorites", hint: "F", onSelect: () => toggleFav(ids) });
    }
    if (!multi) out.push({ label: "Rename…", hint: "F2", onSelect: () => setRenaming(first) });
    out.push("separator", {
      label: multi ? `Move ${list.length} to Recycle Bin` : "Move to Recycle Bin",
      hint: "Del",
      danger: true,
      onSelect: () => requestDelete(ids),
    });
    return out;
  };

  const handleCardEvent = (type: CardEvent, index: number, e: React.MouseEvent) => {
    const item = items[index];
    if (!item) return;
    switch (type) {
      case "click":
        if (e.shiftKey && anchor.current != null) {
          selectRange(anchor.current, index, e.ctrlKey || e.metaKey);
          return;
        }
        if (e.ctrlKey || e.metaKey || selected.size > 0) {
          toggleSelected(item.id);
          anchor.current = index;
          return;
        }
        anchor.current = index;
        setPreviewId(item.id);
        return;
      case "select":
        if (e.shiftKey && anchor.current != null) selectRange(anchor.current, index, true);
        else toggleSelected(item.id);
        anchor.current = index;
        return;
      case "menu":
        setMenu({ x: e.clientX, y: e.clientY, ids: targetsFor(index) });
        return;
      case "more": {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setMenu({ x: r.left, y: r.bottom + 4, ids: targetsFor(index) });
        return;
      }
      case "fav":
        toggleFav([item.id]);
        return;
      case "open":
        void openItem(item.id);
        return;
      case "reveal":
        void revealItem(item.id);
        return;
      case "copy":
        void copyFiles(targetsFor(index));
        return;
    }
  };
  const handlerRef = useRef(handleCardEvent);
  handlerRef.current = handleCardEvent;
  const onCardEvent = useCallback((t: CardEvent, i: number, e: React.MouseEvent) => handlerRef.current(t, i, e), []);

  const focusIndex = (i: number) => {
    const clamped = Math.max(0, Math.min(i, items.length - 1));
    if (clamped >= limit) setLimit(clamped + PAGE);
    requestAnimationFrame(() => {
      const el = scrollRef.current?.querySelector<HTMLElement>(`[data-idx="${clamped}"]`);
      el?.focus();
      el?.scrollIntoView({ block: "nearest" });
    });
    return clamped;
  };

  const onGridKeyDown = (e: React.KeyboardEvent) => {
    if (modalOpen() || isTypingTarget(e.target)) return;
    const card = (e.target as HTMLElement).closest<HTMLElement>("[data-idx]");
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSelected(new Set(items.map((x) => x.id)));
      return;
    }
    if (!card) return;
    const index = Number(card.dataset.idx);
    const item = items[index];
    if (!item) return;

    const move = (to: number | null) => {
      if (to == null) return;
      e.preventDefault();
      const landed = focusIndex(to);
      if (e.shiftKey) {
        if (anchor.current == null) anchor.current = index;
        selectRange(anchor.current, landed, false);
      } else {
        anchor.current = landed;
      }
    };
    const vertical = (dir: "up" | "down") => {
      const n = scrollRef.current && neighborCard(scrollRef.current, card, dir);
      return n ? Number(n.dataset.idx) : null;
    };

    switch (e.key) {
      case "ArrowLeft":
        return move(index > 0 ? index - 1 : null);
      case "ArrowRight":
        return move(index < items.length - 1 ? index + 1 : null);
      case "ArrowUp":
        return move(vertical("up"));
      case "ArrowDown":
        return move(vertical("down"));
      case "Home":
        return move(0);
      case "End":
        return move(items.length - 1);
      case "Enter":
        e.preventDefault();
        setPreviewId(item.id);
        return;
      case " ":
        e.preventDefault();
        toggleSelected(item.id);
        anchor.current = index;
        return;
      case "Delete":
        e.preventDefault();
        requestDelete(targetsFor(index), e.shiftKey);
        return;
      case "F2":
        e.preventDefault();
        setRenaming(item);
        return;
    }
    if (ctrl && e.key.toLowerCase() === "c") {
      e.preventDefault();
      void copyFiles(targetsFor(index));
      return;
    }
    if (ctrl || e.altKey) return;
    switch (e.key.toLowerCase()) {
      case "f":
        e.preventDefault();
        toggleFav(targetsFor(index));
        return;
      case "o":
        e.preventDefault();
        void openItem(item.id);
        return;
      case "e":
        e.preventDefault();
        void revealItem(item.id);
        return;
    }
  };

  const selectedItems = useMemo(() => byIds([...selected]), [selected, items, indexById]);
  const selectedBytes = selectedItems.reduce((n, x) => n + x.sizeBytes, 0);

  const compact = prefs.density === "s";

  let body: ReactNode;
  if (!props.loaded) {
    body = <div className="empty">Loading…</div>;
  } else if (props.libraryEmpty) {
    body = (
      <div className="empty">
        <div>No {noun}s found in this folder yet.</div>
        <button type="button" className="ab-btn" onClick={props.onOpenSettings}>
          Choose folder…
        </button>
      </div>
    );
  } else if (!items.length) {
    body = (
      <div className="empty">
        <div>Nothing matches your search or filters.</div>
        <button type="button" className="ab-btn" onClick={props.onClearFilters}>
          Clear filters
        </button>
      </div>
    );
  } else {
    body = (
      <>
        {groups.map((g) => (
          <section key={`${g.key}-${g.start}`} className="date-group">
            {g.label && (
              <div className="date-head" role="separator" aria-label={g.label}>
                <span>{g.label}</span>
                {props.groupMeta && <span className="date-meta">{props.groupMeta(g)}</span>}
              </div>
            )}
            <div className="media-grid">
              {g.items.map((it, j) => (
                <Card
                  key={it.id}
                  item={it}
                  index={g.start + j}
                  selected={selected.has(it.id)}
                  selecting={selected.size > 0}
                  favorite={favorites ? favorites.has(it.id) : null}
                  isNew={props.isNew?.(it) ?? false}
                  badge={props.badge?.(it) ?? null}
                  subtitle={props.subtitle(it)}
                  hoverVideo={!!props.hoverVideo && prefs.hoverPreview}
                  compact={compact}
                  openLabel={openLabel}
                  onEvent={onCardEvent}
                />
              ))}
            </div>
          </section>
        ))}
        {hasMore && (
          <div ref={sentinelRef} className="grid-sentinel">
            <button type="button" className="ab-btn" onClick={() => setLimit((l) => l + PAGE)}>
              Load more ({items.length - shown.length} left)
            </button>
          </div>
        )}
      </>
    );
  }

  return (
    <>
      {selected.size > 0 && (
        <div className="bulk-bar">
          <span>
            {selected.size} selected · {formatBytes(selectedBytes)}
          </span>
          <div className="bulk-actions">
            <button type="button" className="ab-btn" onClick={() => void copyFiles([...selected])}>
              <Icon name="copy" /> Copy files
            </button>
            {favorites && (
              <button type="button" className="ab-btn" onClick={() => toggleFav([...selected])}>
                <Icon name="star" /> Favorite
              </button>
            )}
            <button type="button" className="ab-btn ab-btn--danger" onClick={() => requestDelete([...selected])}>
              <Icon name="trash" /> Delete
            </button>
            <button
              type="button"
              className="ab-btn"
              onClick={() => setSelected(new Set(items.map((x) => x.id)))}
              disabled={selected.size === items.length}
            >
              All
            </button>
            <IconButton icon="x" label="Clear selection (Esc)" onClick={() => setSelected(new Set())} />
          </div>
        </div>
      )}

      <div
        ref={scrollRef}
        className={`clip-scroll density-${prefs.density}`}
        onKeyDown={onGridKeyDown}
        data-grid={kind}
      >
        {body}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.ids)}
          title={menu.ids.length > 1 ? `${menu.ids.length} selected` : undefined}
          onClose={() => setMenu(null)}
        />
      )}

      {previewItem && (
        <Preview
          item={previewItem}
          index={previewIndex}
          total={items.length}
          autoplay={prefs.autoplay}
          favorite={favorites ? favorites.has(previewItem.id) : null}
          details={props.previewDetails(previewItem)}
          openLabel={openLabel}
          renderMedia={props.renderPreview}
          onClose={() => setPreviewId(null)}
          onStep={(d) => {
            const next = items[previewIndex + d];
            if (next) setPreviewId(next.id);
          }}
          onFav={() => toggleFav([previewItem.id])}
          onOpen={() => void openItem(previewItem.id)}
          onReveal={() => void revealItem(previewItem.id)}
          onCopy={() => void copyFiles([previewItem.id])}
          onRename={() => setRenaming(previewItem)}
          onDelete={(skip) => requestDelete([previewItem.id], skip)}
        />
      )}

      {confirmIds && (
        <ConfirmDialog
          title={confirmIds.length > 1 ? `Delete ${confirmIds.length} ${noun}s?` : `Delete this ${noun}?`}
          body={
            <>
              {confirmIds.length === 1 && <div className="confirm-name">{byIds(confirmIds)[0]?.fileName}</div>}
              <div className="muted">
                {confirmIds.length > 1 ? "They go" : "It goes"} to the Recycle Bin, so you can restore{" "}
                {confirmIds.length > 1 ? "them" : "it"}. Tip: Shift+Delete skips this prompt.
              </div>
            </>
          }
          confirmLabel="Move to Recycle Bin"
          danger
          onCancel={() => setConfirmIds(null)}
          onConfirm={() => {
            const ids = confirmIds;
            setConfirmIds(null);
            void doDelete(ids);
          }}
        />
      )}

      {renaming && (
        <PromptDialog
          title={`Rename ${noun}`}
          initial={stem(renaming.fileName)}
          suffix={`.${renaming.extension}`}
          confirmLabel="Rename"
          onCancel={() => setRenaming(null)}
          onSubmit={async (value) => {
            const oldId = renaming.id;
            const newId = await invoke<string>("rename_media", { id: oldId, newName: value });
            favorites?.rename(oldId, newId);
            if (previewId === oldId) {
              awaitingId.current = newId;
              setPreviewId(newId);
            }
            setSelected((prev) => (prev.has(oldId) ? new Set([...prev].filter((x) => x !== oldId)) : prev));
            setRenaming(null);
            toast("Renamed");
          }}
        />
      )}
    </>
  );
}

function Preview<T extends MediaEntry>(p: {
  item: T;
  index: number;
  total: number;
  autoplay: boolean;
  favorite: boolean | null;
  details: string[];
  openLabel: string;
  renderMedia: (item: T, onMeta: (w: number, h: number) => void, autoplay: boolean) => ReactNode;
  onClose: () => void;
  onStep: (delta: number) => void;
  onFav: () => void;
  onOpen: () => void;
  onReveal: () => void;
  onCopy: () => void;
  onRename: () => void;
  onDelete: (skipConfirm: boolean) => void;
}) {
  const [dims, setDims] = useState<string | null>(null);
  const mediaRef = useRef<HTMLDivElement>(null);
  useEffect(() => setDims(null), [p.item.id]);

  const latest = useRef(p);
  latest.current = p;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelectorAll(".modal-backdrop").length > 1) return;
      if (isTypingTarget(e.target)) return;
      const t = e.target as HTMLElement;
      const onVideo = t.tagName === "VIDEO";
      const c = latest.current;
      const ctrl = e.ctrlKey || e.metaKey;
      if (e.key === "ArrowLeft" && !onVideo) {
        e.preventDefault();
        c.onStep(-1);
      } else if (e.key === "ArrowRight" && !onVideo) {
        e.preventDefault();
        c.onStep(1);
      } else if (e.key === " " && !onVideo && t.tagName !== "BUTTON") {
        e.preventDefault();
        const v = mediaRef.current?.querySelector("video");
        if (v) void (v.paused ? v.play() : v.pause());
      } else if (e.key === "Delete") {
        e.preventDefault();
        c.onDelete(e.shiftKey);
      } else if (e.key === "F2") {
        e.preventDefault();
        c.onRename();
      } else if (ctrl && e.key.toLowerCase() === "c") {
        e.preventDefault();
        c.onCopy();
      } else if (!ctrl && !e.altKey && e.key.toLowerCase() === "f" && c.favorite !== null) {
        e.preventDefault();
        c.onFav();
      } else if (!ctrl && !e.altKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        c.onOpen();
      } else if (!ctrl && !e.altKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        c.onReveal();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const details = dims ? [...p.details, dims] : p.details;

  return (
    <Modal onClose={p.onClose} label="Preview" className="modal--preview">
      <div className="preview-head">
        <div className="preview-title" title={p.item.fileName}>
          {p.item.fileName}
        </div>
        <div className="preview-count">
          {p.index >= 0 ? p.index + 1 : "–"} / {p.total}
        </div>
        <IconButton icon="x" label="Close (Esc)" onClick={p.onClose} />
      </div>
      <div className="preview-stage" ref={mediaRef}>
        <button
          type="button"
          className="preview-nav preview-nav--prev"
          onClick={() => p.onStep(-1)}
          disabled={p.index <= 0}
          aria-label="Previous (←)"
          title="Previous (←)"
        >
          <Icon name="left" size={22} />
        </button>
        <div className="preview-media" key={p.item.id}>
          {p.renderMedia(p.item, (w, h) => setDims(`${w}×${h}`), p.autoplay)}
        </div>
        <button
          type="button"
          className="preview-nav preview-nav--next"
          onClick={() => p.onStep(1)}
          disabled={p.index < 0 || p.index >= p.total - 1}
          aria-label="Next (→)"
          title="Next (→)"
        >
          <Icon name="right" size={22} />
        </button>
      </div>
      <div className="preview-foot">
        <div className="preview-details">{details.join(" · ")}</div>
        <div className="preview-actions">
          {p.favorite !== null && (
            <button type="button" className={`ab-btn ${p.favorite ? "is-active" : ""}`} onClick={p.onFav}>
              <Icon name="star" filled={p.favorite} /> {p.favorite ? "Favorited" : "Favorite"}
            </button>
          )}
          <button type="button" className="ab-btn" onClick={p.onCopy} title="Ctrl+C">
            <Icon name="copy" /> Copy file
          </button>
          <button type="button" className="ab-btn" onClick={p.onOpen} title="O">
            <Icon name="external" /> {p.openLabel}
          </button>
          <button type="button" className="ab-btn" onClick={p.onReveal} title="E">
            <Icon name="folder" /> Folder
          </button>
          <button type="button" className="ab-btn" onClick={p.onRename} title="F2">
            <Icon name="edit" /> Rename
          </button>
          <button type="button" className="ab-btn ab-btn--danger" onClick={() => p.onDelete(false)} title="Delete">
            <Icon name="trash" /> Delete
          </button>
        </div>
      </div>
    </Modal>
  );
}
