const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BROWSERS = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];
const browser = process.env.CHROME || BROWSERS.find((p) => fs.existsSync(p));
if (!browser) {
  console.error("No Chrome/Edge found; set CHROME=path/to/chrome");
  process.exit(1);
}

const BASE = process.env.DEMO_URL || "http://localhost:1420/";
const OUT = path.join(__dirname, "..", "website", "assets");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "overclip-shots-"));

const shots = [
  { file: "screenshot-gallery.png", hash: "#/overlay", size: "1600,900" },
  { file: "screenshot-panel.png", hash: "#/overlay?panel", size: "1600,900" },
  { file: "screenshot-settings.png", hash: "#/overlay?settings&accent=8b5cf6", size: "1600,900" },
  { file: "screenshot-recording.png", hash: "#/overlay?settings=recording", size: "1600,1000" },
  { file: "screenshot-gamebar.png", hash: "#/overlay?settings=recording&recorder=gamebar", size: "1600,1000" },
  { file: "screenshot-obs.png", hash: "#/overlay?settings=recording&recorder=obs", size: "1600,1000" },
  { file: "screenshot-setup.png", hash: "#/setup", size: "1000,680" },
  { file: "screenshot-black.png", hash: "#/overlay?theme=black&accent=ef4444", size: "1600,900" },
];

fs.mkdirSync(OUT, { recursive: true });
for (const s of shots) {
  const target = path.join(OUT, s.file);
  execFileSync(browser, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--user-data-dir=${profile}`,
    `--window-size=${s.size}`,
    "--virtual-time-budget=6000",
    `--screenshot=${target}`,
    BASE + s.hash,
  ]);
  console.log("wrote", path.relative(process.cwd(), target));
}
fs.rmSync(profile, { recursive: true, force: true });
