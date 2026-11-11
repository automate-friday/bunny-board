// Launch timings from real devices (canvas/src/launchTiming.ts): one small POST per page load
// to /api/ui/debug/launch with how long each step took, so a slow launch on a phone can be read
// from the server (GET /api/ui/debug/launches, newest first) instead of guessed from a bench.
// In memory only: the last MAX_LAUNCHES, every field clamped or truncated on the way in.

export const CLIENT_LAUNCH = { maxBodyBytes: 4096, maxLaunches: 100, maxMs: 120_000 };

// Milliseconds from navigation start; absent when the step did not happen on this launch.
export const LAUNCH_STEPS = ["html", "js", "dcl", "render", "cacheRead", "cacheLoaded", "serverFirst", "editor", "shown"] as const;
export type LaunchStep = (typeof LAUNCH_STEPS)[number];

export interface ClientLaunch {
  at: string;
  device: string;
  board: string;
  source: "cache" | "server" | "";
  view: "tiles" | "frame" | "board" | "";
  appCache: boolean;
  standalone: boolean;
  shapes: number;
  steps: Partial<Record<LaunchStep, number>>;
}

export function launchDevice(ua: string): string {
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Macintosh|Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "unknown";
  const v = /OS (\d+)_\d+/.exec(ua)?.[1];
  return v && (os === "iPhone" || os === "iPad") ? `${os} iOS ${v}` : os;
}

export function sanitizeLaunch(body: unknown, ua: string, now: Date): ClientLaunch | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const raw = (b.steps ?? {}) as Record<string, unknown>;
  const steps: ClientLaunch["steps"] = {};
  for (const k of LAUNCH_STEPS) {
    const v = raw[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) steps[k] = Math.min(CLIENT_LAUNCH.maxMs, Math.round(v));
  }
  if (!Object.keys(steps).length) return null;
  const pick = <T extends string>(v: unknown, ok: readonly T[]): T | "" => (ok.includes(v as T) ? (v as T) : "");
  return {
    at: now.toISOString(),
    device: launchDevice(ua.slice(0, 300)),
    board: typeof b.board === "string" ? b.board.slice(0, 80) : "",
    source: pick(b.source, ["cache", "server"] as const),
    view: pick(b.view, ["tiles", "frame", "board"] as const),
    appCache: b.appCache === true,
    standalone: b.standalone === true,
    shapes: typeof b.shapes === "number" && Number.isFinite(b.shapes) ? Math.max(0, Math.min(1_000_000, Math.round(b.shapes))) : 0,
    steps,
  };
}

export class ClientLaunchStore {
  private launches: ClientLaunch[] = [];
  add(l: ClientLaunch): void {
    this.launches.unshift(l);
    this.launches.length = Math.min(this.launches.length, CLIENT_LAUNCH.maxLaunches);
  }
  list(limit = CLIENT_LAUNCH.maxLaunches): ClientLaunch[] {
    return this.launches.slice(0, Math.max(0, limit));
  }
}

// One line for the server log: "launch iPhone iOS 18 main cache tiles 1210 ms (js 30, editor 1080)".
export function launchLogLine(l: ClientLaunch): string {
  const s = l.steps;
  return `launch ${l.device} ${l.board} ${l.source || "?"} ${l.view || "?"} ${s.shown ?? "?"} ms (html ${s.html ?? "?"}, js ${s.js ?? "?"}, dcl ${s.dcl ?? "?"}, editor ${s.editor ?? "?"}${l.appCache ? ", app cache" : ""}${l.standalone ? ", home screen" : ""}, ${l.shapes} shapes)`;
}
