/// <reference types="vite/client" />
import "./theme";
import { createRoot } from "react-dom/client";
import { ChecklistPreview } from "./components/checklist/Preview";
import { App } from "./App";
import { isPluginsPath, PluginsApp } from "./plugins/PluginsApp";
import { PerfOverlay } from "./PerfOverlay";
import { perfOverlay, perfReport } from "./perf";
import { boardInfo } from "./info";
import "./frameLabels.css";

// ?perf=1 / ?perf=report: 10 s summaries to the server (loaded only then).
if (perfReport) void import("./perfReport").then((m) => m.startPerfReports()).catch(() => {});

// The person's default name and the start form's defaults come from /api/ui/info; wait for it
// briefly so the first render has them, but never block the board on it.
const ready = Promise.race([boardInfo().catch(() => null), new Promise((r) => setTimeout(r, 1500))]);
void ready.then(() => createRoot(document.getElementById("root") as HTMLElement).render(<>{perfOverlay ? <PerfOverlay /> : null}{import.meta.env.DEV && new URLSearchParams(location.search).get("componentPreview") === "checklist" ? <ChecklistPreview /> : isPluginsPath(location.pathname) ? <PluginsApp /> : <App />}</>));
