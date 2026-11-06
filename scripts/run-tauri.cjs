const { spawnSync } = require("child_process");
const path = require("path");

const env = { ...process.env };
if (env.CI === "1") {
  env.CI = "true";
} else if (env.CI === "0") {
  env.CI = "false";
}

const tauriJs = path.join(__dirname, "..", "node_modules", "@tauri-apps", "cli", "tauri.js");
const args = process.argv.slice(2);
const r = spawnSync(process.execPath, [tauriJs, ...args], {
  stdio: "inherit",
  env,
  windowsHide: true,
});
process.exit(r.status ?? 1);
