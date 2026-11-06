import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter, Route, Routes } from "react-router-dom";
import Overlay from "./App";
import { Setup } from "./components/Setup";
import { ToastProvider } from "./components/ui";
import { SettingsProvider } from "./settings";
import "./styles/global.css";

async function boot() {
  let home: React.ReactNode = null;
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    const demo = await import("./dev/demo");
    demo.installDemoBackend();
    home = <demo.DemoHome />;
  }

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <ToastProvider>
        <SettingsProvider>
          <HashRouter>
            <Routes>
              <Route path="/overlay" element={<Overlay />} />
              <Route path="/setup" element={<Setup />} />
              <Route path="*" element={home} />
            </Routes>
          </HashRouter>
        </SettingsProvider>
      </ToastProvider>
    </React.StrictMode>,
  );
}

void boot();
