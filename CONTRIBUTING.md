# Contributing to Overclip

Thanks for wanting to help! Bug reports, feature ideas, docs fixes and code are all welcome.

## Reporting bugs and ideas

Use the [issue templates](https://github.com/Jxkss/overclip/issues/new/choose). For bugs, the most
useful things are: what you did, what happened, your Windows version, which recorder you use
(Game Bar, ShadowPlay, OBS…), and whether the game runs fullscreen or borderless.

## Development setup

1. Install [Node.js](https://nodejs.org) 20+ and [Rust](https://rustup.rs) (stable, MSVC).
2. `npm install`
3. `npm run tauri dev` runs the real app with hot reload. It sits in the tray: press
   <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>P</kbd> or click the tray icon.

### Working on the UI in a browser

`npm run dev` and open <http://localhost:1420>. With no Tauri backend present, the app loads
`src/dev/demo.tsx`: sample clips, screenshots, settings and a volume mixer. This is the fastest
way to iterate on layout and styling, works on any OS, and is how the website screenshots are
made. Demo code is stripped from production builds.

### Before opening a pull request

```bash
npm run typecheck                       # TypeScript (strict)
cd src-tauri && cargo check && cargo clippy
```

CI runs the same checks on every pull request.

## Code guidelines

- **Keep the overlay fast.** It opens on top of games. Do heavy work (disk, COM, shell) in Rust
  on background threads, never in a synchronous Tauri command (those block the UI thread).
- **Settings** live in `src-tauri/src/settings.rs` (`AppSettings` / `UiSettings`, with defaults
  and `sanitize()`), mirrored in `src/types/ipc.ts`. New options should get a control in
  `src/components/SettingsDialog.tsx` and, if it matters on day one, the setup wizard.
- **Match the surrounding code**: small focused components, comments that explain *why*.
- **No telemetry, accounts or network calls** in the app. Overclip works fully offline.

## Releases (maintainers)

1. Update the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`,
   and add a section to `CHANGELOG.md`.
2. Tag it: `git tag v1.2.3 && git push --tags`.
3. The *Release* workflow builds the installer and opens a draft GitHub release. Review it and publish.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
