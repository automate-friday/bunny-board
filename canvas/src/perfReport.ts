// ?perf=1 / ?perf=report: every 10 s, one small POST of what this device saw to
// /api/ui/debug/perf/client, so slowness on a real Mac or phone can be read from the server
// (GET /api/ui/debug/perf/clients). Never throws; nothing runs unless perf reporting is on.
import { perfDrainWindow } from "./perf";

const PERIOD_MS = 10_000;
const MAX_BODY = 15_000; // the server takes 16 KB

type Editor = {
  getCurrentPageShapeIds(): Set<string>;
  getCurrentPageShapes(): { id: string; type: string; meta?: Record<string, unknown> }[];
  getRenderingShapes(): unknown[];
  getCulledShapes(): Set<string>;
  getZoomLevel(): number;
};

export function deviceLabel(ua: string, platform = ""): string {
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile/.test(ua)) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : platform || "unknown";
  const m = /Edg\/(\d+)/.exec(ua) ?? /Firefox\/(\d+)/.exec(ua) ?? /(?:Chrome|CriOS)\/(\d+)/.exec(ua) ?? /Version\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari/.exec(ua);
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\/|CriOS\//.test(ua) ? (/HeadlessChrome/.test(ua) ? "HeadlessChrome" : "Chrome") : /Safari\//.test(ua) ? "Safari" : "browser";
  return `${os} · ${browser}${m ? ` ${m[1]}` : ""}`;
}

function tabId(): string {
  const fresh = () => Math.random().toString(36).slice(2, 10);
  try {
    const have = sessionStorage.getItem("bunny-perf-tab");
    if (have) return have;
    const id = fresh();
    sessionStorage.setItem("bunny-perf-tab", id);
    return id;
  } catch {
    return fresh();
  }
}

const q = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
const r1 = (n: number) => Math.round(n * 10) / 10;

type LoafScript = { sourceURL?: string; sourceFunctionName?: string; invoker?: string; duration?: number };
type LoafEntry = PerformanceEntry & { blockingDuration?: number; scripts?: LoafScript[] };

export function startPerfReports(): void {
  try {
    const id = tabId();
    const label = deviceLabel(navigator.userAgent, navigator.platform);
    const board = new URLSearchParams(location.search).get("board") ?? "";
    // Input activity in the current window.
    let wheel = 0,
      zoomWheel = 0,
      dragMoves = 0,
      pointerMoves = 0;
    const opts = { capture: true, passive: true } as const;
    addEventListener("wheel", (e) => (e.ctrlKey || e.metaKey ? zoomWheel++ : wheel++), opts);
    addEventListener("pointermove", (e) => (e.buttons ? dragMoves++ : pointerMoves++), opts);
    // Time hidden in the current window.
    let hiddenMs = 0;
    let hiddenSince = document.visibilityState === "hidden" ? performance.now() : 0;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") hiddenSince = performance.now();
      else if (hiddenSince) {
        hiddenMs += performance.now() - hiddenSince;
        hiddenSince = 0;
      }
    });
    // Long Animation Frames (Chromium): which scripts made the slow frames.
    let loaf: LoafEntry[] = [];
    const loafOn = typeof PerformanceObserver !== "undefined" && (PerformanceObserver.supportedEntryTypes ?? []).includes("long-animation-frame");
    if (loafOn) {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (loaf.length < 500) loaf.push(e as LoafEntry);
      }).observe({ type: "long-animation-frame", buffered: false });
    }
    let prevCounters = new Map<string, number>();
    let windowStart = performance.now();

    const report = () => {
      try {
        const now = performance.now();
        const windowMs = now - windowStart;
        windowStart = now;
        const w = perfDrainWindow();
        const frames = [...w.frames].sort((a, b) => a - b);
        const secs = Math.max(windowMs / 1000, 0.001);
        const counters = [...w.counters]
          .map(([name, total]) => ({ name, perSec: r1((total - (prevCounters.get(name) ?? 0)) / secs) }))
          .filter((c) => c.perSec > 0)
          .sort((a, b) => b.perSec - a.perSec)
          .slice(0, 10);
        prevCounters = w.counters;
        if (hiddenSince) {
          hiddenMs += now - hiddenSince;
          hiddenSince = now;
        }
        const activity = dragMoves > 0 ? "drag" : wheel > 0 ? "pan" : zoomWheel > 0 ? "zoom" : pointerMoves > 0 ? "hover" : "idle";
        const body: Record<string, unknown> = {
          id,
          label,
          board,
          windowMs: Math.round(windowMs),
          frames: { n: frames.length, p50: r1(q(frames, 0.5)), p95: r1(q(frames, 0.95)), max: r1(frames[frames.length - 1] ?? 0) },
          longTasks: { n: w.longTasks.length, ms: Math.round(w.longTasks.reduce((a, b) => a + b, 0)) },
          counters,
          activity,
          input: { wheel: wheel + zoomWheel, dragMoves, pointerMoves },
          visibility: document.visibilityState === "hidden" ? "hidden" : "visible",
          hiddenMs: Math.round(hiddenMs),
        };
        wheel = zoomWheel = dragMoves = pointerMoves = 0;
        hiddenMs = 0;
        const editor = (window as unknown as { __editor?: Editor }).__editor;
        if (editor) {
          const culled = editor.getCulledShapes();
          let working = 0,
            streamingCards = 0;
          for (const s of editor.getCurrentPageShapes()) {
            if (s.type === "frame" && (s.meta?.paseo as { status?: string } | undefined)?.status === "running") working++;
            else if (s.type === "transcript" && !culled.has(s.id)) streamingCards++;
          }
          body.shapes = { page: editor.getCurrentPageShapeIds().size, rendered: editor.getRenderingShapes().length, culled: culled.size };
          body.zoom = r1(editor.getZoomLevel() * 100) / 100;
          body.agents = { working, streamingCards };
        }
        if (loafOn) {
          const entries = loaf;
          loaf = [];
          const by = new Map<string, { source: string; fn: string; invoker: string; ms: number; n: number }>();
          for (const e of entries)
            for (const s of e.scripts ?? []) {
              const source = (s.sourceURL ?? "").replace(/^[a-z]+:\/\/[^/]+/i, "").replace(/[?#].*$/, "");
              const key = `${source}|${s.sourceFunctionName ?? ""}|${s.invoker ?? ""}`;
              const g = by.get(key) ?? { source, fn: s.sourceFunctionName ?? "", invoker: (s.invoker ?? "").slice(0, 120), ms: 0, n: 0 };
              g.ms += s.duration ?? 0;
              g.n++;
              by.set(key, g);
            }
          body.loaf = {
            n: entries.length,
            ms: Math.round(entries.reduce((t, e) => t + e.duration, 0)),
            blockingMs: Math.round(entries.reduce((t, e) => t + (e.blockingDuration ?? 0), 0)),
            scripts: [...by.values()]
              .sort((a, b) => b.ms - a.ms)
              .slice(0, 5)
              .map((g) => ({ ...g, ms: Math.round(g.ms) })),
          };
        }
        let text = JSON.stringify(body);
        if (text.length > MAX_BODY) {
          delete body.loaf;
          body.counters = counters.slice(0, 3);
          text = JSON.stringify(body);
        }
        void fetch("/api/ui/debug/perf/client", { method: "POST", headers: { "content-type": "application/json" }, body: text, keepalive: true, credentials: "same-origin" }).catch(() => {});
      } catch {
        // A report is best effort; the board must never notice it.
      }
    };
    setInterval(report, PERIOD_MS);
  } catch {
    // Same: never break the page for a debug report.
  }
}
