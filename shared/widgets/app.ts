// "App window" widget: a self-hosted (or any http/https) web app in a sandboxed iframe, with
// a server-side health probe (live / stale / error with latency) and a frameability check.
// When the app refuses to be framed (X-Frame-Options or CSP frame-ancestors), the canvas
// shows a status card with an Open button instead of a blank iframe.
//
// The probe runs on the board server (server/widgets/app), behind SSRF guards: only
// http/https, at most 3 redirects (each re-checked), no response body ever reaches the
// canvas, cloud metadata and link-local addresses always blocked. Spec:
// specs/plugin-widgets.md, "Plugin: app".

import { T } from "@tldraw/validate";
import type { WidgetManifest, WidgetState } from "./types";

export interface AppConfig {
  url: string;
  title?: string;
  // Probed instead of url when set (e.g. /api/heartbeat); the iframe always shows url.
  healthUrl?: string;
  // Seconds between probes (5 to 600, default 30). A number or a numeric string.
  refreshSec?: number | string;
}

export type AppHealth = "live" | "stale" | "error";

export interface AppFrame {
  // null: not known yet (the app has not answered).
  allowed: boolean | null;
  // One line: "no framing headers", "X-Frame-Options: DENY", "CSP frame-ancestors 'none'".
  reason: string;
}

export interface AppData {
  // What was probed (healthUrl || url) and where redirects ended.
  target: string;
  finalUrl: string | null;
  health: AppHealth;
  httpStatus: number | null;
  // Time to response headers, ms; null when unreachable.
  latencyMs: number | null;
  method: "HEAD" | "GET" | null;
  redirects: number;
  // Only on stale/error: "slow (2.4s)", "HTTP 503", "unreachable: ECONNREFUSED", "dns: ENOTFOUND".
  reason?: string;
  frame: AppFrame;
  checkedAt: string;
}

export const APP_DEFAULT_REFRESH_SEC = 30;
export const APP_SLOW_MS = 2000;
export const APP_TIMEOUT_MS = 5000;
export const APP_MAX_REDIRECTS = 3;

// Throws with a one-line reason; returns the parsed URL.
export function checkAppUrl(v: string, what = "url"): URL {
  if (v.length > 2000) throw new Error(`${what} must be at most 2000 characters`);
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error(`${what} must be an absolute http(s) URL like https://umami.example.com`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`${what} must use http or https (got ${u.protocol.replace(/:$/, "")})`);
  if (u.username || u.password) throw new Error(`${what} must not carry a username or password`);
  if (!u.hostname) throw new Error(`${what} has no host`);
  return u;
}

const url = (what: string) =>
  T.string.check((v) => {
    if (v !== "") checkAppUrl(v, what);
  });

const title = T.string.check((v) => {
  if (v.length > 80) throw new Error("title must be at most 80 characters");
  if (/[\r\n]/.test(v)) throw new Error("title must be one line");
});

export function appRefreshSec(v: AppConfig["refreshSec"]): number {
  const n = v === undefined || v === "" ? APP_DEFAULT_REFRESH_SEC : Number(v);
  return Number.isFinite(n) ? Math.round(n) : APP_DEFAULT_REFRESH_SEC;
}

const refreshSec = new T.Validator<number | string>((v) => {
  if (typeof v !== "number" && typeof v !== "string") throw new Error("refreshSec must be a number of seconds");
  if (typeof v === "string" && !/^\d{1,4}$/.test(v)) throw new Error("refreshSec must be a whole number of seconds");
  const n = Number(v);
  if (!Number.isInteger(n) || n < 5 || n > 600) throw new Error("refreshSec must be between 5 and 600 seconds");
  return v;
});

export function appHost(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

export function appTitle(c: AppConfig): string {
  return c.title?.trim() || (c.url ? appHost(c.url) : "");
}

const ms = (n: number) => (n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`);

export const appWidget: WidgetManifest<AppConfig, AppData> = {
  id: "app",
  label: "App window",
  icon: "app",
  description: "A web app (e.g. a self-hosted Umami or Plane) in a window, with live health and latency.",
  tagline: "Any web app in a window on the board, with a live health light.",
  about: "Shows a web app at the address you give it inside a window on the board, scaled down so a desktop page fits. The board server checks the app every 30 seconds and lights the dot green, amber or red with the response time. Apps that refuse to be shown inside other pages get a card with an Open button instead of a blank window.",
  whyItMatters: "Keep the tools a project depends on in view where the work happens: the analytics dashboard next to the launch frame, the issue tracker next to the planning frame, your self-hosted service with a light that turns red when it goes down.",
  category: "Apps",
  permissions: [
    { kind: "network", text: "The board server requests the address you enter (and its health URL) every 30 s by default: HEAD, then GET if needed. It keeps only the status, response time and framing headers, never the page." },
    { kind: "network", text: "It will not probe cloud metadata or link-local addresses, follows at most 3 redirects, and does not probe the board's own machine unless the operator allows it (BUNNY_APP_WIDGET_ALLOW)." },
    { kind: "browser", text: "Your browser loads the app directly in a sandboxed window that cannot navigate the board away." },
  ],
  media: [
    { kind: "image", src: "/plugin-media/app/framed.png", caption: "An app shown in the window, green with its response time (local stand-in page)." },
    { kind: "image", src: "/plugin-media/app/card.png", caption: "An app that refuses framing gets a card with Open (local stand-in page)." },
    { kind: "image", src: "/plugin-media/app/down.png", caption: "Nothing answers at the address: red, with the reason." },
    { kind: "video", src: "/plugin-media/app/clip.webm", poster: "/plugin-media/app/framed.png", caption: "Added by an agent, framed vs blocked, then a dead address (local stand-in pages)." },
  ],
  version: "1.0.0",
  size: { w: 640, h: 440 },
  // Fallback only; staleMsFor follows the config's refresh interval.
  staleMs: Math.round(APP_DEFAULT_REFRESH_SEC * 2.5 * 1000) + APP_TIMEOUT_MS,
  staleMsFor: (c) => Math.round(appRefreshSec(c.refreshSec) * 2.5 * 1000) + APP_TIMEOUT_MS,
  fields: [
    { key: "url", label: "URL", kind: "text", required: true, placeholder: "https://umami.example.com", help: "The app's address (http or https); shown in the window" },
    { key: "title", label: "Title", kind: "text", placeholder: "Umami", help: "Name in the title bar (default: the host)" },
    { key: "healthUrl", label: "Health URL", kind: "text", placeholder: "https://umami.example.com/api/heartbeat", help: "Probed for health instead of the URL" },
    { key: "refreshSec", label: "Probe every (s)", kind: "text", placeholder: "30", help: "Seconds between health probes, 5 to 600 (default 30)" },
  ],
  configProps: { url: url("url"), title: T.optional(title), healthUrl: T.optional(url("healthUrl")), refreshSec: T.optional(refreshSec) },
  defaults: () => ({ url: "" }),
  configured: (c) => !!c.url,
  summary: (c) => appTitle(c) || "not set up",
  statusDetail: (_c, s) => (s?.data && s.data.latencyMs !== null ? ms(s.data.latencyMs) : ""),
  describe: (c, s: WidgetState<AppData> | null) => {
    const d = s?.data;
    if (!d) return c.url;
    const parts = [c.url];
    if (d.httpStatus !== null) parts.push(`HTTP ${d.httpStatus}`);
    if (d.reason) parts.push(d.reason);
    if (d.frame.allowed === false) parts.push(`blocks framing (${d.frame.reason}); shown as a status card`);
    else if (d.frame.allowed) parts.push("framed");
    return parts.join(" · ");
  },
};
