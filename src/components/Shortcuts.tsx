import { useSettings } from "../settings";
import { Keys } from "./controls";
import { IconButton, Modal } from "./ui";

export function ShortcutsTable() {
  const { settings } = useSettings();
  const gallery = settings?.overlayShortcut ?? "Ctrl+Alt+P";
  const panel = settings?.panelShortcut ?? "Ctrl+P";
  const rows: [string[], string][] = [
    [[gallery], "Open / close the full gallery (from any game)"],
    [[panel], "Open / close the side panel (from any game)"],
    [["?"], "Show this list"],
    [["/", "Ctrl+F"], "Search (or just start typing)"],
    [["Ctrl+1", "Ctrl+2"], "Clips / Screenshots"],
    [["Arrows"], "Move between items"],
    [["Enter"], "Preview (← → to step through)"],
    [["Space"], "Select (also Ctrl+click, Shift+click)"],
    [["Ctrl+A"], "Select everything shown"],
    [["Ctrl+C"], "Copy file(s) — paste straight into Discord"],
    [["F"], "Favorite"],
    [["O"], "Open in your video player"],
    [["E"], "Show in File Explorer"],
    [["F2"], "Rename"],
    [["Del"], "Move to Recycle Bin (Shift+Del skips the question)"],
    [["Esc"], "Close whatever is on top"],
  ];
  return (
    <table className="shortcut-table">
      <tbody>
        {rows.map(([keys, what]) => (
          <tr key={what}>
            <td>
              {keys.map((k, i) => (
                <span key={k}>
                  {i > 0 && <span className="muted"> or </span>}
                  <Keys combo={k} />
                </span>
              ))}
            </td>
            <td>{what}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal onClose={onClose} label="Keyboard shortcuts" className="modal--shortcuts">
      <div className="dialog-head">
        <h2>Keyboard shortcuts</h2>
        <IconButton icon="x" label="Close (Esc)" onClick={onClose} />
      </div>
      <ShortcutsTable />
    </Modal>
  );
}
