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
if (!browser) throw new Error("No Chrome/Edge found; set CHROME=path/to/chrome");

const here = __dirname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "overclip-logo-"));

function render(svgFile, size, outFile) {
  const svg = fs.readFileSync(path.join(here, svgFile), "utf8").replace("<svg ", `<svg width="${size}" height="${size}" `);
  const html = path.join(tmp, "logo.html");
  fs.writeFileSync(html, `<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`);
  execFileSync(browser, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--default-background-color=00000000",
    `--user-data-dir=${path.join(tmp, "profile")}`,
    `--window-size=${size},${size}`,
    `--screenshot=${path.join(here, outFile)}`,
    "file:///" + html.replace(/\\/g, "/"),
  ], { stdio: "ignore" });
  console.log("wrote", outFile);
}

render("overclip-icon.svg", 1024, "overclip-icon-1024.png");
render("overclip-mark.svg", 512, "overclip-mark-512.png");
fs.rmSync(tmp, { recursive: true, force: true });
