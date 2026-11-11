// How long this page load took to show the board, step by step, from navigation start. Sent once
// per page load to the server (POST /api/ui/debug/launch, server/client-launch.ts; read back with
// GET /api/ui/debug/launches) and kept for this device (the Canvas version panel shows the last
// one), so a slow launch on a real phone can be measured instead of guessed from a bench.
// Steps come from Navigation/Resource Timing and these marks:
//   bunny:render        main.tsx renders the app
//   bunny:cache-read    the board's saved copy was read (cachedSync.ts; phones only)
//   bunny:cache-loaded  …and loaded into the store
//   bunny:server-first-message  the first sync message arrived
//   bunny:editor        tldraw mounted (App onMount)
//   shown               the phone's frame tiles or open frame, or the desktop canvas, on screen
// Never throws; nothing here waits on the network.

export type LaunchRecord = {
  at: number;
  board: string;
  source: "cache" | "server" | "";
  view: "tiles" | "frame" | "board" | "";
  appCache: boolean;
  standalone: boolean;
  shapes: number;
  steps: Partial<Record<"html" | "js" | "dcl" | "render" | "cacheRead" | "cacheLoaded" | "serverFirst" | "editor" | "shown", number>>;
};

const KEY = "bunny-launches";
const GIVE_UP_MS = 30_000;

export function markLaunch(name: string): void {
  try {
    if (!performance.getEntriesByName(name, "mark").length) performance.mark(name);
  } catch {
    /* no User Timing */
  }
}

const at = (name: string) => {
  try {
    const e = performance.getEntriesByName(name, "mark")[0];
    return e ? Math.round(e.startTime) : undefined;
  } catch {
    return undefined;
  }
};

export function recentLaunches(): LaunchRecord[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? (v as LaunchRecord[]) : [];
  } catch {
    return [];
  }
}

// "1.2 s to frames · saved copy · app cache", for the Canvas version panel.
export function launchSummary(l: LaunchRecord | undefined): string {
  if (!l || l.steps.shown === undefined) return "";
  const what = l.view === "frame" ? "frame" : l.view === "tiles" ? "frames" : "board";
  return [`${(l.steps.shown / 1000).toFixed(1)} s to ${what}`, l.source === "cache" ? "saved copy" : l.source === "server" ? "from server" : "", l.appCache ? "app cache" : ""].filter(Boolean).join(" · ");
}

function shownView(): LaunchRecord["view"] | null {
  const shell = document.querySelector(".bm-root");
  if (shell) {
    const mode = shell.getAttribute("data-mode");
    if (mode === "frame" && document.querySelector('[data-testid="mobile-frame-title"]')) return "frame";
    if (mode === "tiles" && document.querySelector('[data-testid="mobile-frame-card"], [data-testid="mobile-tiles"]')) return "tiles";
    return null;
  }
  const ed = (window as { __editor?: { getCurrentPageShapeIds(): Set<string> } }).__editor;
  return ed && document.querySelector(".tl-canvas") && !document.documentElement.classList.contains("bunny-mobile") ? "board" : null;
}

export function startLaunchTiming(opts: { board: string; standalone: boolean; source: () => "cache" | "server" | null }): void {
  try {
    const t0 = performance.now();
    const done = (view: LaunchRecord["view"], shown: number | undefined) => {
      const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      const js = performance.getEntriesByType("resource").find((e) => /\/assets\/index-[^/]*\.js$/.test(e.name)) as PerformanceResourceTiming | undefined;
      const ed = (window as { __editor?: { getCurrentPageShapeIds(): Set<string> } }).__editor;
      const r = (n: number | undefined) => (n === undefined || !Number.isFinite(n) || n <= 0 ? undefined : Math.round(n));
      const record: LaunchRecord = {
        at: Date.now(),
        board: opts.board,
        source: opts.source() ?? "",
        view,
        appCache: !!nav && nav.workerStart > 0,
        standalone: opts.standalone,
        shapes: ed?.getCurrentPageShapeIds().size ?? 0,
        steps: { html: r(nav?.responseEnd), js: r(js?.responseEnd), dcl: r(nav?.domContentLoadedEventEnd), render: at("bunny:render"), cacheRead: at("bunny:cache-read"), cacheLoaded: at("bunny:cache-loaded"), serverFirst: at("bunny:server-first-message"), editor: at("bunny:editor"), shown: r(shown) },
      };
      try {
        localStorage.setItem(KEY, JSON.stringify([record, ...recentLaunches()].slice(0, 10)));
      } catch {
        /* private mode */
      }
      void fetch("/api/ui/debug/launch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(record), keepalive: true, credentials: "same-origin" }).catch(() => undefined);
    };
    // A launch in the background (opened, then switched away) is not a launch time.
    if (document.visibilityState === "hidden") return;
    const tick = () => {
      if (document.visibilityState === "hidden") return;
      const view = shownView();
      if (view) {
        const shown = performance.now();
        // The board's own sync message may land after the copy was drawn: report it too.
        setTimeout(() => done(view, shown), 3000);
        return;
      }
      if (performance.now() - t0 > GIVE_UP_MS) return done("", undefined);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  } catch {
    /* timing is best effort */
  }
}
