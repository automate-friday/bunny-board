// Client performance gauges. Off unless the URL has ?perf=1 (overlay and reports to the
// server), ?perf=report (reports only) or ?perf=counters (counters only, for the bench).
// When off, perfCount is one boolean check.
//
//   perfCount("name")         count a hook recompute / listener run
//   window.__bunnyPerf        { counters(), reset(), frames(), longTasks() } for harnesses
const mode = typeof location !== "undefined" ? new URLSearchParams(location.search).get("perf") : null;
export const perfOverlay = mode === "1";
// Send a 10 s summary to the server (perfReport.ts), readable at /api/ui/debug/perf/clients.
export const perfReport = perfOverlay || mode === "report";
export const perfOn = perfReport || mode === "counters";

const counters = new Map<string, number>();

export function perfCount(name: string): void {
  if (!perfOn) return;
  counters.set(name, (counters.get(name) ?? 0) + 1);
}

// Rolling frame times (last 240 frames) and long tasks (last 30 s), collected only when on.
const frames: number[] = [];
const longTasks: { at: number; ms: number }[] = [];
// Everything since the last report (perfReport), bounded.
let windowFrames: number[] = [];
let windowLongTasks: number[] = [];
if (perfOn) {
  let last = 0;
  const loop = (t: number) => {
    if (last) {
      frames.push(t - last);
      if (frames.length > 240) frames.shift();
      if (windowFrames.length < 5000) windowFrames.push(t - last);
    }
    last = t;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  try {
    new PerformanceObserver((list) => {
      const now = performance.now();
      for (const e of list.getEntries()) {
        longTasks.push({ at: e.startTime, ms: e.duration });
        if (windowLongTasks.length < 1000) windowLongTasks.push(e.duration);
      }
      while (longTasks.length && longTasks[0].at < now - 30000) longTasks.shift();
    }).observe({ type: "longtask", buffered: true });
  } catch {
    // longtask is Chromium-only; the overlay shows frame times without it.
  }
  (window as unknown as { __bunnyPerf: unknown }).__bunnyPerf = {
    counters: () => Object.fromEntries(counters),
    reset: () => counters.clear(),
    frames: () => [...frames],
    longTasks: () => [...longTasks],
  };
}

export function perfSample() {
  const sorted = [...frames].sort((a, b) => a - b);
  const q = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
  const now = performance.now();
  const recent = longTasks.filter((l) => l.at > now - 10000);
  return {
    p50: q(0.5),
    p95: q(0.95),
    longTasks10s: recent.length,
    longTaskMs10s: recent.reduce((a, b) => a + b.ms, 0),
    counters: [...counters.entries()].sort((a, b) => b[1] - a[1]),
  };
}

// Frame times, long-task durations and counter totals since the previous call.
export function perfDrainWindow(): { frames: number[]; longTasks: number[]; counters: Map<string, number> } {
  const out = { frames: windowFrames, longTasks: windowLongTasks, counters: new Map(counters) };
  windowFrames = [];
  windowLongTasks = [];
  return out;
}
