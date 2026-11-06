import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useApplyAppearance, useSettings } from "../settings";
import type { DetectedFolders, FolderCandidate } from "../types/ipc";
import { plural } from "../utils/format";
import logo from "../assets/logo.png";
import { AccentPicker, Keys, pickFolder, Row, Segmented, ShortcutInput, Slider, Toggle } from "./controls";
import { RecorderEssentials, RecorderPicker } from "./Recorder";
import { useRecorder } from "../hooks/useRecorder";
import { Icon, useToast, type IconName } from "./ui";

type StepId = "welcome" | "clips" | "screenshots" | "recording" | "shortcuts" | "look" | "behavior" | "finish";

const STEPS: { id: StepId; title: string; icon: IconName }[] = [
  { id: "welcome", title: "Welcome", icon: "sparkle" },
  { id: "clips", title: "Clips", icon: "film" },
  { id: "screenshots", title: "Screenshots", icon: "image" },
  { id: "recording", title: "Recording", icon: "record" },
  { id: "shortcuts", title: "Shortcuts", icon: "keyboard" },
  { id: "look", title: "Look", icon: "palette" },
  { id: "behavior", title: "Behavior", icon: "bolt" },
  { id: "finish", title: "Finish", icon: "check" },
];

const isInside = (child: string, parent: string) =>
  child.toLowerCase().startsWith(parent.toLowerCase().replace(/[\\/]+$/, "") + "\\");

function specific(list: FolderCandidate[]): FolderCandidate[] {
  return list.filter((c) => !list.some((o) => o !== c && o.count > 0 && isInside(o.path, c.path)));
}

function bestGuess(list: FolderCandidate[]): string | null {
  const current = list.filter((c) => c.current).map((c) => c.path);
  if (current.length) return current[0];
  const sorted = specific(list).sort((a, b) => b.count - a.count);
  return sorted[0]?.path ?? null;
}

function FolderOption({
  candidate,
  selected,
  onToggle,
  radio,
  kind,
}: {
  candidate: FolderCandidate;
  selected: boolean;
  onToggle: () => void;
  radio?: boolean;
  kind: "video" | "image";
}) {
  return (
    <button type="button" className={`folder-option ${selected ? "is-on" : ""}`} onClick={onToggle} aria-pressed={selected}>
      <span className={`folder-check ${radio ? "is-radio" : ""}`}>{selected && <Icon name="check" size={13} />}</span>
      <span className="folder-option-text">
        <span className="set-title">
          {candidate.label}
          {candidate.current && <span className="pill">current</span>}
        </span>
        <span className="set-desc" title={candidate.path}>
          {candidate.path}
        </span>
      </span>
      <span className="folder-count">
        {candidate.count >= 5000 ? "5000+" : candidate.count} {plural(candidate.count, kind).replace(/^\d+ /, "")}
      </span>
    </button>
  );
}

function StepHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="step-head">
      <h1>{title}</h1>
      {children && <p>{children}</p>}
    </div>
  );
}

function LookPreview() {
  return (
    <div className="look-preview" aria-hidden>
      <div className="lp-header">
        <span className="lp-logo" />
        <span className="lp-tab is-on">Clips</span>
        <span className="lp-tab">Screenshots</span>
      </div>
      <div className="lp-body">
        <div className="lp-side">
          <span className="lp-side-item is-on" />
          <span className="lp-side-item" />
          <span className="lp-side-item" />
          <span className="lp-side-item" />
        </div>
        <div className="lp-grid">
          {Array.from({ length: 6 }, (_, i) => (
            <span key={i} className={`lp-tile lp-tile--${i} ${i === 1 ? "is-on" : ""}`} />
          ))}
        </div>
      </div>
      <span className="lp-button">Open in player</span>
    </div>
  );
}

export function Setup() {
  const toast = useToast();
  const { settings: s, update, updateUi, flush } = useSettings();
  useApplyAppearance(s);
  const [step, setStep] = useState(0);
  const [detected, setDetected] = useState<DetectedFolders | null>(null);
  const [clipChoice, setClipChoice] = useState<string[] | null>(null);
  const [shotChoice, setShotChoice] = useState<string | null>(null);
  const [version, setVersion] = useState("");
  const rec = useRecorder(true);
  const steps = STEPS.filter((st) => st.id !== "recording" || rec.status?.current);
  const stepId = steps[Math.min(step, steps.length - 1)].id;

  useEffect(() => {
    void getVersion().then(setVersion, () => {});
    void invoke<DetectedFolders>("detect_media_folders")
      .then(setDetected)
      .catch(() => setDetected({ clips: [], screenshots: [] }));
  }, []);

  useEffect(() => {
    if (!s || !detected || clipChoice !== null) return;
    const current = detected.clips.filter((c) => c.current).map((c) => c.path);
    const found = specific(detected.clips)
      .sort((a, b) => b.count - a.count)
      .map((c) => c.path);
    setClipChoice(current.length ? current : found);
    setShotChoice(bestGuess(detected.screenshots));
  }, [s, detected, clipChoice]);

  const [manualClips, setManualClips] = useState<FolderCandidate[]>([]);
  const [manualShots, setManualShots] = useState<FolderCandidate[]>([]);
  const clipOptions = useMemo(() => [...(detected?.clips ?? []), ...manualClips], [detected, manualClips]);
  const shotOptions = useMemo(() => [...(detected?.screenshots ?? []), ...manualShots], [detected, manualShots]);

  const commitFolders = () => {
    if (!s) return;
    const patch: Partial<typeof s> = {};
    if (clipChoice && clipChoice.length) {
      patch.clipsDirectory = clipChoice[0];
      patch.extraClipDirectories = clipChoice.slice(1);
    }
    if (shotChoice) patch.screenshotsDirectory = shotChoice;
    if (Object.keys(patch).length) update(patch);
  };

  const finish = async (openGallery: boolean) => {
    commitFolders();
    await flush();
    try {
      await invoke("finish_setup", { openGallery });
    } catch (e) {
      toast(String(e), "error");
    }
  };

  const go = (to: number) => {
    if (stepId === "clips" || stepId === "screenshots") commitFolders();
    setStep(Math.max(0, Math.min(steps.length - 1, to)));
  };

  if (!s) {
    return <div className="setup setup--loading">Loading…</div>;
  }
  const ui = s.ui;

  let content: ReactNode;
  switch (stepId) {
    case "welcome":
      content = (
        <div className="welcome">
          <img src={logo} alt="" className="welcome-logo" />
          <h1>Welcome to Overclip</h1>
          <p className="welcome-sub">
            A fast, free overlay for your game clips and screenshots. Let's set it up. It takes about a minute, and
            you can change everything later in Settings.
          </p>
          <div className="welcome-cards">
            <div className="welcome-card">
              <Icon name="bolt" size={22} />
              <div className="set-title">Instant gallery</div>
              <div className="set-desc">One shortcut, in any game. Your clips are already there.</div>
            </div>
            <div className="welcome-card">
              <Icon name="copy" size={22} />
              <div className="set-title">Share in a click</div>
              <div className="set-desc">Ctrl+C a clip, Ctrl+V it into Discord. Done.</div>
            </div>
            <div className="welcome-card">
              <Icon name="palette" size={22} />
              <div className="set-title">Make it yours</div>
              <div className="set-desc">Colours, layout, shortcuts: almost everything is adjustable.</div>
            </div>
          </div>
        </div>
      );
      break;
    case "clips":
      content = (
        <>
          <StepHead title="Where are your clips?">
            Pick every folder your recorder saves to. Overclip groups clips by the folder they're in, so{" "}
            <code>Clips\Valorant\…</code> shows up under Valorant.
          </StepHead>
          {detected == null ? (
            <div className="detecting">
              <span className="spinner" /> Looking for clips on this PC…
            </div>
          ) : (
            <div className="folder-options">
              {clipOptions.length === 0 && (
                <div className="set-desc">No clips found automatically. Choose the folder your recorder uses.</div>
              )}
              {clipOptions.map((c) => {
                const selected = clipChoice?.includes(c.path) ?? false;
                return (
                  <FolderOption
                    key={c.path}
                    kind="video"
                    candidate={c}
                    selected={selected}
                    onToggle={() =>
                      setClipChoice((prev) => {
                        const list = prev ?? [];
                        return selected ? list.filter((p) => p !== c.path) : [...list, c.path];
                      })
                    }
                  />
                );
              })}
              <button
                type="button"
                className="ab-btn folder-browse"
                onClick={async () => {
                  const dir = await pickFolder();
                  if (!dir) return;
                  if (!clipOptions.some((c) => c.path === dir)) {
                    setManualClips((m) => [...m, { path: dir, label: "Chosen folder", count: 0, current: false }]);
                  }
                  setClipChoice((prev) => (prev?.includes(dir) ? prev : [...(prev ?? []), dir]));
                }}
              >
                <Icon name="folder" /> Choose another folder…
              </button>
            </div>
          )}
        </>
      );
      break;
    case "screenshots":
      content = (
        <>
          <StepHead title="And your screenshots?">Pick the folder your screenshot tool saves to.</StepHead>
          {detected == null ? (
            <div className="detecting">
              <span className="spinner" /> Looking for screenshots…
            </div>
          ) : (
            <div className="folder-options">
              {shotOptions.map((c) => (
                <FolderOption
                  key={c.path}
                  kind="image"
                  radio
                  candidate={c}
                  selected={shotChoice === c.path}
                  onToggle={() => setShotChoice(c.path)}
                />
              ))}
              <button
                type="button"
                className="ab-btn folder-browse"
                onClick={async () => {
                  const dir = await pickFolder();
                  if (!dir) return;
                  if (!shotOptions.some((c) => c.path === dir)) {
                    setManualShots((m) => [...m, { path: dir, label: "Chosen folder", count: 0, current: false }]);
                  }
                  setShotChoice(dir);
                }}
              >
                <Icon name="folder" /> Choose another folder…
              </button>
            </div>
          )}
        </>
      );
      break;
    case "recording": {
      const cur = rec.status?.current;
      const amd = rec.status?.amd;
      content = (
        <>
          <StepHead title="Record with the app you already use">
            Overclip adds Save replay, Record and Screenshot buttons that drive your recorder: AMD Software, Xbox Game Bar,
            OBS Studio, NVIDIA App or Medal. Where the recorder allows it, its settings move into Overclip's Settings too.
          </StepHead>
          <RecorderPicker rec={rec} />
          <Row title="Recorder buttons in Overclip" description="You can always turn these off later.">
            <Toggle
              label="Recorder buttons"
              checked={s.recorderControls}
              onChange={(recorderControls) => update({ recorderControls })}
            />
          </Row>
          {cur?.id === "amd" && (
            <RecorderEssentials
              rec={rec}
              galleryFolders={clipChoice ?? []}
              onAddToGallery={(dir) => setClipChoice((prev) => (prev?.includes(dir) ? prev : [...(prev ?? []), dir]))}
            />
          )}
          {cur?.id === "amd" && amd?.hotkeys.saveReplay && (
            <div className="hint">
              <Icon name="info" size={16} />
              <span>
                In any game, press <Keys combo={amd.hotkeys.saveReplay} /> to save a replay, even with Overclip closed.
                {!amd.running && " AMD Software isn't running right now; your choices apply when it starts."}
              </span>
            </div>
          )}
          {cur && cur.id !== "amd" && (
            <div className="hint">
              <Icon name="info" size={16} />
              <span>
                {cur.problem ? `${cur.problem} ` : ""}Fine-tune {cur.name} any time in Settings › Recording.
              </span>
            </div>
          )}
        </>
      );
      break;
    }
    case "shortcuts":
      content = (
        <>
          <StepHead title="Your shortcuts">
            These work anywhere, even in fullscreen games. Click one and press the keys you want.
          </StepHead>
          <div className="shortcut-cards">
            <div className="shortcut-card">
              <div className="shortcut-art shortcut-art--gallery" aria-hidden />
              <div className="set-title">Full gallery</div>
              <div className="set-desc">Everything: games sidebar, big grid, search.</div>
              <ShortcutInput value={s.overlayShortcut} fallback="Ctrl+Alt+P" onChange={(overlayShortcut) => update({ overlayShortcut })} />
            </div>
            <div className="shortcut-card">
              <div className="shortcut-art shortcut-art--panel" aria-hidden />
              <div className="set-title">Side panel</div>
              <div className="set-desc">A slim strip for a quick look without leaving the game.</div>
              <ShortcutInput value={s.panelShortcut} fallback="Ctrl+P" onChange={(panelShortcut) => update({ panelShortcut })} />
            </div>
          </div>
          <div className="hint">
            <Icon name="info" size={16} /> While Overclip runs, these combos belong to Overclip in every app. If you print a
            lot, use something like <Keys combo="Ctrl+Shift+P" /> for the side panel.
          </div>
        </>
      );
      break;
    case "look":
      content = (
        <>
          <StepHead title="Make it look right">Changes show up instantly.</StepHead>
          <div className="look-layout">
            <div>
              <Row title="Accent colour">
                <AccentPicker value={ui.accent} onChange={(accent) => updateUi({ accent })} />
              </Row>
              <Row title="Theme">
                <Segmented
                  label="Theme"
                  value={s.theme}
                  onChange={(theme) => update({ theme })}
                  options={[
                    { value: "dark", label: "Dark" },
                    { value: "black", label: "OLED black" },
                  ]}
                />
              </Row>
              <Row title="Interface size">
                <Slider
                  label="Interface size"
                  value={ui.scale}
                  min={0.8}
                  max={1.4}
                  step={0.05}
                  format={(v) => `${Math.round(v * 100)}%`}
                  onChange={(scale) => updateUi({ scale })}
                />
              </Row>
              <Row title="Side panel position">
                <Segmented
                  label="Side panel position"
                  value={ui.panelSide}
                  onChange={(panelSide) => updateUi({ panelSide })}
                  options={[
                    { value: "left", label: "Left" },
                    { value: "right", label: "Right" },
                  ]}
                />
              </Row>
            </div>
            <LookPreview />
          </div>
        </>
      );
      break;
    case "behavior":
      content = (
        <>
          <StepHead title="How should it behave?">Sensible defaults are already on.</StepHead>
          <Row title="Play clips on hover" description="Silent preview when you rest the mouse on a clip.">
            <Toggle label="Play clips on hover" checked={ui.hoverPreview} onChange={(hoverPreview) => updateUi({ hoverPreview })} />
          </Row>
          <Row title="Autoplay previews" description="Start playing as soon as a clip opens.">
            <Toggle label="Autoplay previews" checked={ui.autoplay} onChange={(autoplay) => updateUi({ autoplay })} />
          </Row>
          <Row title='"NEW" badges' description="Highlight clips recorded since you last looked.">
            <Toggle label="New badges" checked={ui.newBadges} onChange={(newBadges) => updateUi({ newBadges })} />
          </Row>
          <Row title="Ask before deleting" description="Deleted files go to the Recycle Bin either way.">
            <Toggle label="Ask before deleting" checked={ui.confirmDelete} onChange={(confirmDelete) => updateUi({ confirmDelete })} />
          </Row>
          <Row title="Tray icon opens">
            <Segmented
              label="Tray icon opens"
              value={ui.trayOpens}
              onChange={(trayOpens) => updateUi({ trayOpens })}
              options={[
                { value: "gallery", label: "Gallery" },
                { value: "panel", label: "Side panel" },
              ]}
            />
          </Row>
        </>
      );
      break;
    default:
      content = (
        <div className="finish">
          <div className="finish-badge">
            <Icon name="check" size={34} />
          </div>
          <h1>You're all set</h1>
          <p className="welcome-sub">
            Overclip lives in your system tray. Press <Keys combo={s.overlayShortcut} /> in any game for the gallery, or{" "}
            <Keys combo={s.panelShortcut} /> for the side panel. Press <Keys combo="?" /> inside Overclip to see every
            shortcut.
          </p>
          <div className="finish-options">
            <Row title="Start with Windows" description="Recommended, so your shortcuts always work.">
              <Toggle
                label="Start with Windows"
                checked={s.startupWithWindows}
                onChange={(startupWithWindows) => update({ startupWithWindows })}
              />
            </Row>
          </div>
        </div>
      );
  }

  const last = stepId === "finish";
  const appWindow = (() => {
    try {
      return getCurrentWindow();
    } catch {
      return null;
    }
  })();

  return (
    <div className="setup">
      <header className="setup-titlebar" data-tauri-drag-region>
        <img src={logo} alt="" data-tauri-drag-region />
        <span data-tauri-drag-region>Overclip Setup</span>
        <div className="setup-window-buttons">
          <button type="button" aria-label="Minimize" onClick={() => void appWindow?.minimize()}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
              <path d="M1 5h8" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </button>
          <button type="button" aria-label="Close" className="is-close" onClick={() => void appWindow?.close()}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
              <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </button>
        </div>
      </header>
      <div className="setup-main">
        <aside className="setup-rail">
          <ol className="setup-steps">
            {steps.map((st, i) => (
              <li key={st.id}>
                <button
                  type="button"
                  className={`setup-step ${i === step ? "is-current" : ""} ${i < step ? "is-done" : ""}`}
                  onClick={() => go(i)}
                >
                  <span className="setup-step-num">{i < step ? <Icon name="check" size={13} /> : i + 1}</span>
                  {st.title}
                </button>
              </li>
            ))}
          </ol>
          <div className="setup-rail-foot">
            Overclip {version && `v${version}`}
            <br />
            Free &amp; open source
          </div>
        </aside>
        <section className="setup-content">
          <div className="setup-scroll" key={step}>
            {content}
          </div>
          <footer className="setup-footer">
            {step === 0 ? (
              <button type="button" className="link-btn" onClick={() => void finish(false)}>
                Skip, use recommended settings
              </button>
            ) : (
              <button type="button" className="ab-btn" onClick={() => go(step - 1)}>
                Back
              </button>
            )}
            <div className="setup-footer-right">
              <span className="setup-progress">
                Step {step + 1} of {steps.length}
              </span>
              {last ? (
                <>
                  <button type="button" className="ab-btn" onClick={() => void finish(false)}>
                    Finish
                  </button>
                  <button type="button" className="ab-btn ab-btn--primary" onClick={() => void finish(true)}>
                    Open my gallery
                  </button>
                </>
              ) : (
                <button type="button" className="ab-btn ab-btn--primary" onClick={() => go(step + 1)}>
                  {step === 0 ? "Get started" : "Next"}
                </button>
              )}
            </div>
          </footer>
        </section>
      </div>
    </div>
  );
}
