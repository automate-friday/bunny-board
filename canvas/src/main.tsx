/// <reference types="vite/client" />
import "./theme";
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { infoNow } from "./info";
import { NAVIGATE_EVENT, placeKey, restoreLastPlace, standalone } from "./places";
import { registerAppCache } from "./appCache";
import { readBoardCache } from "./boardCache";
import { boardSource } from "./cachedSync";
import { markLaunch, startLaunchTiming } from "./launchTiming";
import { ChecklistPreview } from "./components/checklist/Preview";
import { App } from "./App";
import { isPluginsPath, PluginsApp } from "./plugins/PluginsApp";
import { PerfOverlay } from "./PerfOverlay";
import { perfOverlay, perfReport } from "./perf";
import { boardInfo } from "./info";
import "./frameLabels.css";

// ?perf=1 / ?perf=report: 10 s summaries to the server (loaded only then).
if (perfReport) void import("./perfReport").then((m) => m.startPerfReports()).catch(() => {});

// Home-screen app: reopen the last board and frame (places.ts), and keep the app's own files
// on the phone (appCache.ts).
restoreLastPlace();
if (standalone()) registerAppCache();
// Start reading the board's saved copy now, while the rest of the app starts (boardCache.ts).
const launchBoard = new URLSearchParams(location.search).get("board") || "main";
void readBoardCache(launchBoard);
// How long this launch takes to show the board, for this device and the server (launchTiming.ts).
if (!isPluginsPath(location.pathname)) startLaunchTiming({ board: launchBoard, standalone: standalone(), source: () => boardSource.get() });

// Switching boards in the canvas changes the URL without a reload (places.openPlace); a new
// board or frame there, or the browser's back and forward, mounts a fresh App for it.
function Board() {
  const [key, setKey] = useState(placeKey);
  useEffect(() => {
    const update = () => setKey(placeKey());
    window.addEventListener(NAVIGATE_EVENT, update);
    window.addEventListener("popstate", update);
    return () => {
      window.removeEventListener(NAVIGATE_EVENT, update);
      window.removeEventListener("popstate", update);
    };
  }, []);
  return <App key={key} />;
}

// The person's default name and the start form's defaults come from /api/ui/info. With the
// last launch's copy (info.ts) render at once and let the fetch refresh it; without one wait
// for it briefly so the first render has them, but never block the board on it.
const info = boardInfo().catch(() => null);
const ready = infoNow() ? Promise.resolve() : Promise.race([info, new Promise((r) => setTimeout(r, 1500))]);
void ready.then(() => {
  markLaunch("bunny:render");
  createRoot(document.getElementById("root") as HTMLElement).render(<>{perfOverlay ? <PerfOverlay /> : null}{import.meta.env.DEV && new URLSearchParams(location.search).get("componentPreview") === "checklist" ? <ChecklistPreview /> : isPluginsPath(location.pathname) ? <PluginsApp /> : <Board />}</>);
});
