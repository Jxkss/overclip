import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AudioMixer } from "./components/AudioMixer";
import { ClipPanel } from "./components/ClipPanel";
import { RecorderControls } from "./components/Recorder";
import type { UiPrefs } from "./components/MediaGrid";
import { ScreenshotPanel } from "./components/ScreenshotPanel";
import { SettingsDialog } from "./components/SettingsDialog";
import { ShortcutsDialog } from "./components/Shortcuts";
import { Icon, IconButton, useToast } from "./components/ui";
import { FALLBACK_UI, useApplyAppearance, useSettings } from "./settings";
import {
  isTypingTarget,
  modalOpen,
  oneOf,
  popEscapeLayer,
  useEscapeLayer,
  useStoredState,
  useTauriEvent,
} from "./hooks/common";
import { useAudio } from "./hooks/useAudio";
import { useClips } from "./hooks/useClips";
import { useRecorder } from "./hooks/useRecorder";
import { useScreenshots } from "./hooks/useScreenshots";
import logo from "./assets/logo.png";

const OPEN_MS = 220;
const CLOSE_MS = 150;
const OPEN_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const CLOSE_EASE = "cubic-bezier(0.4, 0, 1, 1)";
const WINDOW_HIDDEN = "translateY(14px) scale(0.985)";
const PANEL_HIDDEN_LEFT = "translateX(calc(-100% - 24px))";
const PANEL_HIDDEN_RIGHT = "translateX(calc(100% + 24px))";

type PanelTab = "clips" | "screenshots" | "volume";

export default function Overlay() {
  const toast = useToast();
  const { settings, updateUi } = useSettings();
  useApplyAppearance(settings);
  const ui = settings?.ui ?? FALLBACK_UI;
  const uiRef = useRef(ui);
  uiRef.current = ui;
  const [overlayVisible, setOverlayVisible] = useState(false);
  const [shell, setShell] = useState(false);
  const shellRef = useRef(false);
  shellRef.current = shell;
  const [openCycle, setOpenCycle] = useState(0);
  const [panel, setPanel] = useState(false);
  const panelRef = useRef(false);
  panelRef.current = panel;
  const [panelTab, setPanelTab] = useStoredState<PanelTab>(
    "overclip-panel-tab",
    "clips",
    oneOf("clips", "screenshots", "volume"),
  );

  const [mediaMode, setMediaMode] = useStoredState<"clips" | "screenshots">(
    "overclip-media-mode",
    "clips",
    oneOf("clips", "screenshots"),
  );
  const prefs: UiPrefs = {
    density: ui.density,
    hoverPreview: ui.hoverPreview,
    confirmDelete: ui.confirmDelete,
    autoplay: ui.autoplay,
    newBadges: ui.newBadges,
    groupByDay: ui.groupByDay,
    showCovers: ui.showCovers,
  };
  const setPrefs = useCallback((p: Partial<UiPrefs>) => updateUi(p), [updateUi]);
  const [helpOpen, setHelpOpen] = useState(false);

  const clips = useClips(overlayVisible);
  const shots = useScreenshots(overlayVisible);
  const rec = useRecorder(overlayVisible);
  const [audioOpen, setAudioOpen] = useStoredState<boolean>("overclip-audio-open", false);
  const mixerShown = panel ? panelTab === "volume" : audioOpen;
  const { mixer, refresh: refreshAudio, setPaused: setAudioPaused } = useAudio(overlayVisible && mixerShown);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<string | undefined>();
  useEscapeLayer(shell && !panel && audioOpen, () => setAudioOpen(false));

  const suppressClickawayUntilRef = useRef(0);
  const scrimRef = useRef<HTMLDivElement>(null);
  const windowRef = useRef<HTMLDivElement>(null);
  const anims = useRef<Animation[]>([]);

  useEffect(() => {
    const onFs = () => {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  useEffect(() => {
    if (!overlayVisible) {
      setSettingsOpen(false);
      setHelpOpen(false);
    }
  }, [overlayVisible]);

  const hiddenPose = useCallback(
    (isPanel: boolean) =>
      !isPanel ? WINDOW_HIDDEN : uiRef.current.panelSide === "right" ? PANEL_HIDDEN_RIGHT : PANEL_HIDDEN_LEFT,
    [],
  );

  const [leaving, setLeaving] = useState<boolean | null>(null);
  const leavingRef = useRef<HTMLDivElement>(null);
  const leaveAnim = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    if (leaving === null) return;
    const el = leavingRef.current;
    if (!el) {
      setLeaving(null);
      return;
    }
    const from = getComputedStyle(el);
    leaveAnim.current?.cancel();
    const anim = el.animate(
      [
        { opacity: from.opacity, transform: from.transform },
        { opacity: 0, transform: hiddenPose(leaving) },
      ],
      { duration: uiRef.current.animations ? OPEN_MS : 1, easing: OPEN_EASE, fill: "forwards" },
    );
    leaveAnim.current = anim;
    anim.finished.then(
      () => setLeaving((cur) => (cur === leaving ? null : cur)),
      () => {},
    );
  }, [leaving, hiddenPose]);

  const runAnimation = useCallback((open: boolean) => {
    const scrim = scrimRef.current;
    const win = windowRef.current;
    if (!scrim || !win) return Promise.resolve(true);
    const scrimFrom = getComputedStyle(scrim).opacity;
    const winStyle = getComputedStyle(win);
    const winFrom = { opacity: winStyle.opacity, transform: winStyle.transform };
    anims.current.forEach((a) => a.cancel());
    const timing: KeyframeAnimationOptions = {
      duration: uiRef.current.animations ? (open ? OPEN_MS : CLOSE_MS) : 1,
      easing: open ? OPEN_EASE : CLOSE_EASE,
      fill: "forwards",
    };
    const hidden = hiddenPose(panelRef.current);
    anims.current = [
      scrim.animate([{ opacity: scrimFrom }, { opacity: open ? 1 : 0 }], timing),
      win.animate([winFrom, open ? { opacity: 1, transform: "none" } : { opacity: 0, transform: hidden }], timing),
    ];
    return Promise.all(anims.current.map((a) => a.finished)).then(
      () => true,
      () => false,
    );
  }, [hiddenPose]);

  useLayoutEffect(() => {
    if (!overlayVisible) return;
    if (shell) {
      void runAnimation(true);
      return;
    }
    let cancelled = false;
    void runAnimation(false).then((done) => {
      if (!done || cancelled || shellRef.current) return;
      void invoke("overlay_finish_hide");
      setOverlayVisible(false);
    });
    return () => {
      cancelled = true;
    };
  }, [shell, overlayVisible, openCycle, panel, runAnimation]);

  const close = useCallback(() => {
    setShell(false);
    void invoke("overlay_hide");
  }, []);

  const open = useCallback(
    (asPanel: boolean) => {
      (document.activeElement as HTMLElement | null)?.blur?.();
      const start = uiRef.current.startTab;
      if (start !== "remember" && !shellRef.current) {
        setMediaMode(start);
        setPanelTab(start);
      }
      if (shellRef.current && panelRef.current !== asPanel) setLeaving(panelRef.current);
      setPanel(asPanel);
      setOverlayVisible(true);
      setShell(true);
      setOpenCycle((c) => c + 1);
    },
    [setMediaMode, setPanelTab],
  );

  const switchView = useCallback(
    (asPanel: boolean) => {
      if (!asPanel && panelTab !== "volume") setMediaMode(panelTab);
      if (asPanel) setPanelTab(mediaMode);
      void invoke("overlay_set_mode", { panel: asPanel });
      open(asPanel);
    },
    [open, panelTab, mediaMode, setMediaMode, setPanelTab],
  );

  useTauriEvent<{ panel: boolean }>("overlay-open", (p) => open(!!p?.panel));
  useTauriEvent("overlay-close", () => setShell(false));
  useTauriEvent<string | null>("open-settings", (section) => {
    suppressClickawayUntilRef.current = Date.now() + 650;
    open(false);
    setSettingsSection(section ?? undefined);
    setSettingsOpen(true);
  });
  useTauriEvent<string>("hotkey-error", (msg) => toast(msg, "error"));

  useEffect(() => {
    const focusSearch = (selectAll: boolean) => {
      const input = document.querySelector<HTMLInputElement>("[data-search]");
      if (!input) return;
      input.focus();
      if (selectAll) input.select();
      else input.setSelectionRange(input.value.length, input.value.length);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!shellRef.current) return;
      if (e.key === "Escape") {
        e.preventDefault();
        if (!popEscapeLayer()) close();
        return;
      }
      if (modalOpen()) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const target = e.target as HTMLElement | null;
      if (ctrl && (e.code === "Digit1" || e.code === "Digit2" || (panelRef.current && e.code === "Digit3"))) {
        e.preventDefault();
        const next = e.code === "Digit1" ? "clips" : e.code === "Digit2" ? "screenshots" : "volume";
        if (panelRef.current) setPanelTab(next);
        else if (next !== "volume") setMediaMode(next);
        return;
      }
      if (e.key === "?" && !isTypingTarget(target)) {
        e.preventDefault();
        setHelpOpen(true);
        return;
      }
      if ((ctrl && e.key.toLowerCase() === "f") || (e.key === "/" && !isTypingTarget(target))) {
        e.preventDefault();
        focusSearch(true);
        return;
      }
      const onCard = target?.closest?.("[data-idx]");
      if (
        !ctrl &&
        !e.altKey &&
        e.key.length === 1 &&
        e.key !== " " &&
        !isTypingTarget(target) &&
        !onCard &&
        !target?.closest?.(".audio-panel")
      ) {
        focusSearch(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, setMediaMode, setPanelTab]);

  const openSettings = () => {
    setSettingsSection(undefined);
    setSettingsOpen(true);
  };

  const tab = (mode: "clips" | "screenshots", icon: "film" | "image", label: string, count: number, hint: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={mediaMode === mode}
      className={`header-tab ${mediaMode === mode ? "is-on" : ""}`}
      onClick={() => setMediaMode(mode)}
      title={hint}
    >
      <Icon name={icon} size={17} />
      {label}
      <span className="tab-count">{count}</span>
    </button>
  );

  return (
    <div className={`overlay-stage ${overlayVisible ? "is-visible" : ""}`}>
      <div
        ref={scrimRef}
        className={`scrim ${panel ? `scrim--panel scrim--${ui.panelSide}` : ""}`}
        aria-hidden
        onMouseDown={(e) => {
          if (Date.now() < suppressClickawayUntilRef.current) return;
          if (e.target === e.currentTarget && uiRef.current.clickOutsideCloses) close();
        }}
      />
      {(panel || leaving === true) && (
        <div
          key="panel"
          ref={panel ? windowRef : leavingRef}
          className={`side-panel ${ui.panelSide === "right" ? "is-right" : ""} ${panel ? "" : "is-leaving"}`}
          role="dialog"
          aria-label="Overclip side panel"
        >
          <header className="panel-header">
            <div className="brand">
              <img src={logo} alt="" />
              <span className="brand-name" aria-label="Overclip">
                over<b>clip</b>
              </span>
            </div>
            <div className="header-actions">
              <RecorderControls rec={rec} clips={clips.all} compact />
              <IconButton icon="grid" label="Open full gallery (Ctrl+Alt+P)" onClick={() => switchView(false)} />
              <IconButton icon="gear" label="Settings" onClick={openSettings} />
              <IconButton icon="x" label="Close (Esc)" onClick={close} className="header-close" />
            </div>
          </header>
          <nav className="panel-tabs" role="tablist">
            {(
              [
                ["clips", "film", "Clips", clips.all.length],
                ["screenshots", "image", "Shots", shots.all.length],
                ["volume", "speaker", "Volume", null],
              ] as const
            ).map(([id, icon, label, count], i) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={panelTab === id}
                className={`panel-tab ${panelTab === id ? "is-on" : ""}`}
                onClick={() => setPanelTab(id)}
                title={`Ctrl+${i + 1}`}
              >
                <Icon name={icon} size={18} />
                <span>{label}</span>
                {count != null && <span className="tab-count">{count}</span>}
              </button>
            ))}
          </nav>
          <div className="panel-body">
            {panelTab === "clips" && (
              <ClipPanel
                compact
                lib={clips}
                active={overlayVisible}
                prefs={prefs}
                onPrefs={setPrefs}
                onOpenSettings={openSettings}
              />
            )}
            {panelTab === "screenshots" && (
              <ScreenshotPanel
                compact
                lib={shots}
                active={overlayVisible}
                prefs={prefs}
                onPrefs={setPrefs}
                onOpenSettings={openSettings}
              />
            )}
            {panelTab === "volume" && (
              <AudioMixer state={mixer} onChange={refreshAudio} onDragging={setAudioPaused} />
            )}
          </div>
        </div>
      )}
      {(!panel || leaving === false) && (
        <div
          key="gallery"
          ref={panel ? leavingRef : windowRef}
          className={`gallery-window ${panel ? "is-leaving" : ""}`}
          role="dialog"
          aria-label="Overclip gallery"
        >
          <header className="gallery-header">
            <div className="brand">
              <img src={logo} alt="" />
              <span className="brand-name" aria-label="Overclip">
                over<b>clip</b>
              </span>
              <span className="brand-by">Jxkss</span>
            </div>
            <nav className="header-tabs" role="tablist">
              {tab("clips", "film", "Clips", clips.all.length, "Ctrl+1")}
              {tab("screenshots", "image", "Screenshots", shots.all.length, "Ctrl+2")}
            </nav>
            <div className="header-actions">
              <RecorderControls rec={rec} clips={clips.all} />
              <IconButton icon="panel" label="Side panel (Ctrl+P)" onClick={() => switchView(true)} />
              <IconButton
                icon="speaker"
                label="Volume mixer"
                active={audioOpen}
                onClick={() => setAudioOpen(!audioOpen)}
              />
              <IconButton icon="gear" label="Settings" onClick={openSettings} />
              <IconButton icon="x" label="Close (Esc)" onClick={close} className="header-close" />
            </div>
          </header>

          <div className="gallery-content">
            {mediaMode === "clips" ? (
              <ClipPanel
                lib={clips}
                active={overlayVisible}
                prefs={prefs}
                onPrefs={setPrefs}
                onOpenSettings={openSettings}
              />
            ) : (
              <ScreenshotPanel
                lib={shots}
                active={overlayVisible}
                prefs={prefs}
                onPrefs={setPrefs}
                onOpenSettings={openSettings}
              />
            )}
            {audioOpen && (
              <aside className="audio-drawer">
                <AudioMixer
                  state={mixer}
                  onChange={refreshAudio}
                  onDragging={setAudioPaused}
                  onClose={() => setAudioOpen(false)}
                />
              </aside>
            )}
          </div>
        </div>
      )}

      {overlayVisible && settingsOpen && <SettingsDialog rec={rec} initialSection={settingsSection} onClose={() => setSettingsOpen(false)} />}
      {overlayVisible && helpOpen && <ShortcutsDialog onClose={() => setHelpOpen(false)} />}
    </div>
  );
}
