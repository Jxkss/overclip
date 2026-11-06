import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { ISSUES_URL, RELEASES_URL, REPO_URL, WEBSITE_URL } from "../links";
import { useSettings } from "../settings";
import type { AppSettings, UiSettings } from "../types/ipc";
import logo from "../assets/logo.png";
import {
  AccentPicker,
  FolderField,
  FolderSuggestions,
  Keys,
  pickFolder,
  Row,
  Segmented,
  ShortcutInput,
  Slider,
  Toggle,
} from "./controls";
import { RecordingSettings } from "./Recorder";
import { ShortcutsTable } from "./Shortcuts";
import type { Recorder } from "../hooks/useRecorder";
import { ConfirmDialog, Icon, IconButton, Modal, useToast, type IconName } from "./ui";

type Section = "appearance" | "layout" | "behavior" | "shortcuts" | "recording" | "folders" | "system" | "about";

const SECTIONS: { id: Section; label: string; icon: IconName }[] = [
  { id: "appearance", label: "Appearance", icon: "palette" },
  { id: "layout", label: "Layout", icon: "layout" },
  { id: "behavior", label: "Behavior", icon: "bolt" },
  { id: "shortcuts", label: "Shortcuts", icon: "keyboard" },
  { id: "recording", label: "Recording", icon: "record" },
  { id: "folders", label: "Folders", icon: "folder" },
  { id: "system", label: "System", icon: "monitor" },
  { id: "about", label: "About", icon: "info" },
];

const SECTION_UI_KEYS: Partial<Record<Section, (keyof UiSettings)[]>> = {
  appearance: ["accent", "scale", "dim", "animations"],
  layout: ["gallerySize", "panelSide", "panelWidth", "density", "showCovers", "groupByDay"],
  behavior: ["hoverPreview", "autoplay", "newBadges", "confirmDelete", "clickOutsideCloses", "trayOpens", "startTab"],
};

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function SettingsDialog({
  rec,
  initialSection,
  onClose,
}: {
  rec: Recorder;
  initialSection?: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const { settings: s, defaults, update, updateUi } = useSettings();
  const [section, setSection] = useState<Section>(
    () => SECTIONS.find((x) => x.id === initialSection)?.id ?? "appearance",
  );
  const [confirmReset, setConfirmReset] = useState(false);
  const [version, setVersion] = useState("");
  useEffect(() => {
    void getVersion().then(setVersion, () => {});
  }, []);

  if (!s) return null;
  const ui = s.ui;

  const resetSection = () => {
    if (!defaults) return;
    if (section === "appearance") update({ theme: defaults.theme });
    if (section === "shortcuts") {
      update({ overlayShortcut: defaults.overlayShortcut, panelShortcut: defaults.panelShortcut });
    }
    const keys = SECTION_UI_KEYS[section];
    if (keys) {
      const patch: Partial<UiSettings> = {};
      for (const k of keys) (patch as Record<string, unknown>)[k] = defaults.ui[k];
      updateUi(patch);
    }
    toast("Restored defaults for this page");
  };

  const resetAll = () => {
    if (!defaults) return;
    const keep: Partial<AppSettings> = {
      clipsDirectory: s.clipsDirectory,
      extraClipDirectories: s.extraClipDirectories,
      screenshotsDirectory: s.screenshotsDirectory,
      setupComplete: true,
    };
    update({ ...defaults, ...keep });
    toast("All settings restored to defaults");
  };

  const openLink = (url: string) => void invoke("open_external", { url }).catch((e) => toast(String(e), "error"));
  const resettable = section in SECTION_UI_KEYS || section === "shortcuts";

  let body: React.ReactNode;
  switch (section) {
    case "appearance":
      body = (
        <>
          <Row title="Accent colour" description="Used for highlights, selection and buttons.">
            <AccentPicker value={ui.accent} onChange={(accent) => updateUi({ accent })} />
          </Row>
          <Row title="Theme" description="OLED black turns every surface fully black.">
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
          <Row title="Interface size" description="Makes everything bigger or smaller.">
            <Slider label="Interface size" value={ui.scale} min={0.8} max={1.4} step={0.05} format={pct} onChange={(scale) => updateUi({ scale })} />
          </Row>
          <Row title="Background dimming" description="How much the game behind the overlay is darkened.">
            <Slider label="Background dimming" value={ui.dim} min={0} max={0.95} step={0.01} format={pct} onChange={(dim) => updateUi({ dim })} />
          </Row>
          <Row title="Animations" description="Turn off for instant open/close.">
            <Toggle label="Animations" checked={ui.animations} onChange={(animations) => updateUi({ animations })} />
          </Row>
        </>
      );
      break;
    case "layout":
      body = (
        <>
          <Row title="Gallery size" description="How much of the screen the full gallery covers.">
            <Segmented
              label="Gallery size"
              value={ui.gallerySize}
              onChange={(gallerySize) => updateUi({ gallerySize })}
              options={[
                { value: "comfortable", label: "Comfortable" },
                { value: "large", label: "Large" },
                { value: "full", label: "Full screen" },
              ]}
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
          <Row title="Side panel width">
            <Slider label="Side panel width" value={ui.panelWidth} min={340} max={760} step={10} format={(v) => `${v}px`} onChange={(panelWidth) => updateUi({ panelWidth })} />
          </Row>
          <Row title="Thumbnail size">
            <Segmented
              label="Thumbnail size"
              value={ui.density}
              onChange={(density) => updateUi({ density })}
              options={[
                { value: "s", label: "Small" },
                { value: "m", label: "Medium" },
                { value: "l", label: "Large" },
              ]}
            />
          </Row>
          <Row title="Game covers in the sidebar" description="Shows each game's latest clip as its picture.">
            <Toggle label="Game covers" checked={ui.showCovers} onChange={(showCovers) => updateUi({ showCovers })} />
          </Row>
          <Row title="Group by day" description="Today, Yesterday, … headings in the grid.">
            <Toggle label="Group by day" checked={ui.groupByDay} onChange={(groupByDay) => updateUi({ groupByDay })} />
          </Row>
        </>
      );
      break;
    case "behavior":
      body = (
        <>
          <Row title="Play clips on hover" description="Silent preview when you rest the mouse on a clip.">
            <Toggle label="Play clips on hover" checked={ui.hoverPreview} onChange={(hoverPreview) => updateUi({ hoverPreview })} />
          </Row>
          <Row title="Autoplay previews" description="Start playing as soon as a clip opens.">
            <Toggle label="Autoplay previews" checked={ui.autoplay} onChange={(autoplay) => updateUi({ autoplay })} />
          </Row>
          <Row title='"NEW" badges' description="Mark clips recorded since you last opened Overclip.">
            <Toggle label="New badges" checked={ui.newBadges} onChange={(newBadges) => updateUi({ newBadges })} />
          </Row>
          <Row title="Ask before deleting" description="Files always go to the Recycle Bin either way.">
            <Toggle label="Ask before deleting" checked={ui.confirmDelete} onChange={(confirmDelete) => updateUi({ confirmDelete })} />
          </Row>
          <Row title="Click outside to close">
            <Toggle label="Click outside to close" checked={ui.clickOutsideCloses} onChange={(clickOutsideCloses) => updateUi({ clickOutsideCloses })} />
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
          <Row title="Open on">
            <Segmented
              label="Open on"
              value={ui.startTab}
              onChange={(startTab) => updateUi({ startTab })}
              options={[
                { value: "remember", label: "Last used" },
                { value: "clips", label: "Clips" },
                { value: "screenshots", label: "Screenshots" },
              ]}
            />
          </Row>
        </>
      );
      break;
    case "shortcuts":
      body = (
        <>
          <Row title="Full gallery" description="Works everywhere, including in games.">
            <ShortcutInput value={s.overlayShortcut} fallback={defaults?.overlayShortcut} onChange={(overlayShortcut) => update({ overlayShortcut })} />
          </Row>
          <Row
            title="Side panel"
            description="While Overclip runs this combo is taken over in every app (Ctrl+P is normally Print)."
          >
            <ShortcutInput value={s.panelShortcut} fallback={defaults?.panelShortcut} onChange={(panelShortcut) => update({ panelShortcut })} />
          </Row>
          <Row
            title="Mic & output mute keys"
            description={
              <>
                <Keys combo="Ctrl+Alt+Shift+U" /> toggles your microphone, <Keys combo="Ctrl+Alt+Shift+H" /> mutes all
                sound. Applies after restarting Overclip.
              </>
            }
          >
            <Toggle label="Mic and output mute keys" checked={s.micHotkeys} onChange={(micHotkeys) => update({ micHotkeys })} />
          </Row>
          <div className="set-subhead">Inside Overclip</div>
          <ShortcutsTable />
        </>
      );
      break;
    case "recording":
      body = <RecordingSettings rec={rec} />;
      break;
    case "folders": {
      const allClipDirs = [s.clipsDirectory, ...s.extraClipDirectories];
      body = (
        <>
          <div className="set-block">
            <div className="set-title">Clips</div>
            <div className="set-desc">
              Clips are grouped by the folder they're in (e.g. <code>Clips\Valorant\clip.mp4</code> shows under
              Valorant). Extra folders, like an external drive, work the same way.
            </div>
            <FolderField value={s.clipsDirectory} onChange={(clipsDirectory) => update({ clipsDirectory })} />
            {s.extraClipDirectories.map((dir, i) => (
              <FolderField
                key={dir + i}
                value={dir}
                onChange={(v) =>
                  update({ extraClipDirectories: s.extraClipDirectories.map((d, j) => (j === i ? v : d)) })
                }
                onRemove={() =>
                  update({ extraClipDirectories: s.extraClipDirectories.filter((_, j) => j !== i) })
                }
              />
            ))}
            <button
              type="button"
              className="ab-btn"
              onClick={async () => {
                const dir = await pickFolder();
                if (dir && !allClipDirs.includes(dir)) update({ extraClipDirectories: [...s.extraClipDirectories, dir] });
              }}
            >
              <Icon name="folder" /> Add another clips folder…
            </button>
            <div className="set-subhead">Found on this PC</div>
            <FolderSuggestions
              kind="clips"
              existing={allClipDirs}
              onPick={(dir) => update({ extraClipDirectories: [...s.extraClipDirectories, dir] })}
            />
          </div>
          <div className="set-block">
            <div className="set-title">Screenshots</div>
            <FolderField value={s.screenshotsDirectory} onChange={(screenshotsDirectory) => update({ screenshotsDirectory })} />
            <Row
              title="Include screenshots from clip folders"
              description="AMD Software and some other recorders save screenshots next to their clips."
            >
              <Toggle
                label="Include screenshots from clip folders"
                checked={s.screenshotsFromClipFolders}
                onChange={(screenshotsFromClipFolders) => update({ screenshotsFromClipFolders })}
              />
            </Row>
            <div className="set-subhead">Found on this PC</div>
            <FolderSuggestions
              kind="screenshots"
              existing={[s.screenshotsDirectory]}
              onPick={(screenshotsDirectory) => update({ screenshotsDirectory })}
            />
          </div>
        </>
      );
      break;
    }
    case "system":
      body = (
        <>
          <Row title="Start with Windows" description="Overclip waits quietly in the tray until you press your shortcut.">
            <Toggle label="Start with Windows" checked={s.startupWithWindows} onChange={(startupWithWindows) => update({ startupWithWindows })} />
          </Row>
          <Row title="Setup wizard" description="Walk through the first-run setup again.">
            <button type="button" className="ab-btn" onClick={() => void invoke("open_setup")}>
              <Icon name="sparkle" /> Run setup
            </button>
          </Row>
          <Row title="Thumbnails" description="Clears cached thumbnails; they rebuild as you browse.">
            <button
              type="button"
              className="ab-btn"
              onClick={() =>
                void invoke("clear_thumbnail_cache")
                  .then(() => toast("Thumbnail cache cleared"))
                  .catch((e) => toast(String(e), "error"))
              }
            >
              <Icon name="refresh" /> Rebuild thumbnails
            </button>
          </Row>
          <Row title="Reset everything" description="Restores every setting except your folders.">
            <button type="button" className="ab-btn ab-btn--danger" onClick={() => setConfirmReset(true)}>
              Reset all settings
            </button>
          </Row>
        </>
      );
      break;
    case "about":
      body = (
        <div className="about">
          <img src={logo} alt="" className="about-logo" />
          <div className="about-name">Overclip</div>
          <div className="set-desc">Version {version || "—"} · Free and open source (MIT) · Made by Jxkss</div>
          <p className="about-text">
            A fast in-game overlay for your clips and screenshots. Overclip runs entirely on your PC: no account, no
            uploads, no tracking.
          </p>
          <div className="about-links">
            <button type="button" className="ab-btn" onClick={() => openLink(WEBSITE_URL)}>
              <Icon name="globe" /> Website
            </button>
            <button type="button" className="ab-btn" onClick={() => openLink(REPO_URL)}>
              <Icon name="github" /> Source code
            </button>
            <button type="button" className="ab-btn" onClick={() => openLink(RELEASES_URL)}>
              <Icon name="sparkle" /> What's new
            </button>
            <button type="button" className="ab-btn" onClick={() => openLink(ISSUES_URL)}>
              <Icon name="bug" /> Report a bug
            </button>
          </div>
        </div>
      );
      break;
  }

  return (
    <Modal onClose={onClose} label="Settings" className="modal--settings-xl">
      <nav className="set-nav">
        <div className="set-nav-title">Settings</div>
        {SECTIONS.map((sec) => (
          <button
            key={sec.id}
            type="button"
            className={`set-nav-item ${section === sec.id ? "is-on" : ""}`}
            onClick={() => setSection(sec.id)}
          >
            <Icon name={sec.icon} size={16} />
            {sec.label}
          </button>
        ))}
      </nav>
      <section className="set-main">
        <div className="set-head">
          <h2>{SECTIONS.find((x) => x.id === section)?.label}</h2>
          <div className="set-head-actions">
            {resettable && (
              <button type="button" className="link-btn" onClick={resetSection}>
                Reset this page
              </button>
            )}
            <IconButton icon="x" label="Close (Esc)" onClick={onClose} />
          </div>
        </div>
        <div className="set-body">{body}</div>
        <div className="set-foot">Changes are saved automatically.</div>
      </section>

      {confirmReset && (
        <ConfirmDialog
          title="Reset all settings?"
          body="Appearance, layout, behavior and shortcuts go back to their defaults. Your folders stay."
          confirmLabel="Reset"
          danger
          onCancel={() => setConfirmReset(false)}
          onConfirm={() => {
            setConfirmReset(false);
            resetAll();
          }}
        />
      )}
    </Modal>
  );
}
