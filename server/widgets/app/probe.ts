// One health probe of an app URL: HEAD, falling back to GET when HEAD is refused, at most
// 3 redirects (each hop re-checked by the SSRF guard), a hard timeout, and no body read:
// a GET response is destroyed as soon as its headers arrive. Only the status, latency,
// redirect count, final URL and the framing headers leave this file.

import http from "node:http";
import https from "node:https";
import { APP_MAX_REDIRECTS, APP_SLOW_MS, APP_TIMEOUT_MS, type AppFrame, type AppHealth, checkAppUrl } from "../../../shared/widgets/app";
import type { Guard } from "./guard";

export interface ProbeResult {
  status: number | null;
  latencyMs: number | null;
  method: "HEAD" | "GET" | null;
  redirects: number;
  finalUrl: string | null;
  // Only the framing headers of the final response.
  frameHeaders: { xfo: string | null; csp: string[] } | null;
  error?: { kind: "blocked" | "dns" | "tls" | "timeout" | "unreachable" | "redirect" | "url"; code: string; message: string };
}

export interface ProbeOptions {
  guard: Guard;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxRedirects?: number;
}

const TLS_CODE = /^(ERR_TLS|ERR_SSL|CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|HOSTNAME_MISMATCH|ERR_TLS_CERT)/;

function classify(err: NodeJS.ErrnoException & { code?: string }): NonNullable<ProbeResult["error"]> {
  const code = err.code ?? err.name ?? "ERROR";
  if (code === "BLOCKED") return { kind: "blocked", code, message: err.message };
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_FAIL" || code === "EAI_NODATA" || code === "EAI_NONAME") return { kind: "dns", code, message: `dns: ${code}` };
  if (TLS_CODE.test(code) || /certificate|ssl|tls/i.test(err.message)) return { kind: "tls", code, message: `tls: ${code}` };
  if (code === "TIMEOUT" || code === "ABORT_ERR" || code === "ETIMEDOUT") return { kind: "timeout", code, message: "timeout" };
  return { kind: "unreachable", code, message: `unreachable: ${code}` };
}

interface Hop {
  status: number;
  location: string | null;
  xfo: string | null;
  csp: string[];
}

function request(u: URL, method: "HEAD" | "GET", guard: Guard, signal: AbortSignal): Promise<Hop> {
  return new Promise((resolve, reject) => {
    try {
      guard.checkHost(u.hostname);
    } catch (e) {
      reject(e);
      return;
    }
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      u.toString(),
      {
        method,
        lookup: guard.lookup,
        // No keep-alive: the socket closes with the request, so teardown leaves nothing open.
        agent: false,
        signal,
        headers: { "user-agent": "BunnyBoard-AppWidget/1 (health probe)", accept: "text/html,*/*;q=0.5" },
      },
      (res) => {
        const h = res.headers;
        const csp = h["content-security-policy"];
        const hop: Hop = {
          status: res.statusCode ?? 0,
          location: typeof h.location === "string" ? h.location : null,
          xfo: typeof h["x-frame-options"] === "string" ? h["x-frame-options"] : null,
          csp: csp === undefined ? [] : Array.isArray(csp) ? csp : [csp],
        };
        // The body is never read: not for HEAD, and a GET is cut off here.
        res.destroy();
        resolve(hop);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const REDIRECT = new Set([301, 302, 303, 307, 308]);

async function follow(start: URL, method: "HEAD" | "GET", o: Required<Pick<ProbeOptions, "guard" | "maxRedirects">>, signal: AbortSignal): Promise<{ hop: Hop; url: URL; redirects: number }> {
  let url = start;
  for (let redirects = 0; ; redirects++) {
    const hop = await request(url, method, o.guard, signal);
    if (!REDIRECT.has(hop.status) || !hop.location) return { hop, url, redirects };
    if (redirects >= o.maxRedirects) throw Object.assign(new Error(`more than ${o.maxRedirects} redirects`), { code: "TOO_MANY_REDIRECTS" });
    let next: URL;
    try {
      next = checkAppUrl(new URL(hop.location, url).toString(), "redirect");
    } catch (e) {
      throw Object.assign(new Error((e as Error).message), { code: "BAD_REDIRECT" });
    }
    url = next;
  }
}

export async function probeApp(target: string, opts: ProbeOptions): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? APP_TIMEOUT_MS;
  const o = { guard: opts.guard, maxRedirects: opts.maxRedirects ?? APP_MAX_REDIRECTS };
  const base = { status: null, latencyMs: null, method: null, redirects: 0, finalUrl: null, frameHeaders: null } as ProbeResult;
  let start: URL;
  try {
    start = checkAppUrl(target);
  } catch (e) {
    return { ...base, error: { kind: "url", code: "BAD_URL", message: (e as Error).message } };
  }
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  timer.unref?.();
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const t0 = performance.now();
  const done = (r: { hop: Hop; url: URL; redirects: number }, method: "HEAD" | "GET"): ProbeResult => ({
    status: r.hop.status,
    latencyMs: Math.round(performance.now() - t0),
    method,
    redirects: r.redirects,
    finalUrl: r.url.toString(),
    frameHeaders: { xfo: r.hop.xfo, csp: r.hop.csp },
  });
  try {
    let head: { hop: Hop; url: URL; redirects: number } | null = null;
    try {
      head = await follow(start, "HEAD", o, ctrl.signal);
    } catch (e) {
      const c = classify(e as NodeJS.ErrnoException);
      // Network-level failures would fail GET too; only a protocol-level HEAD failure
      // (reset, parse error) falls through to GET.
      if (timedOut || ctrl.signal.aborted || c.kind !== "unreachable" || ["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "TOO_MANY_REDIRECTS", "BAD_REDIRECT"].includes(c.code)) throw e;
    }
    // Servers that refuse HEAD answer 405/501 (some 404/403): ask again with GET.
    if (head && head.hop.status < 400) return done(head, "HEAD");
    try {
      return done(await follow(start, "GET", o, ctrl.signal), "GET");
    } catch (e) {
      if (head && !timedOut && !ctrl.signal.aborted) return done(head, "HEAD");
      throw e;
    }
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (timedOut) return { ...base, error: { kind: "timeout", code: "TIMEOUT", message: `timeout (${Math.round(timeoutMs / 1000)}s)` } };
    if (err.code === "TOO_MANY_REDIRECTS" || err.code === "BAD_REDIRECT") return { ...base, error: { kind: "redirect", code: err.code, message: err.message } };
    return { ...base, error: classify(err) };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

// Probe result -> widget health: 2xx/3xx fast is live; slow (> 2 s) or 4xx/5xx is stale;
// anything that never got a response (unreachable, DNS, TLS, timeout, blocked) is error.
export function mapHealth(r: Pick<ProbeResult, "status" | "latencyMs" | "error">, slowMs = APP_SLOW_MS): { health: AppHealth; reason?: string } {
  if (r.error || r.status === null) return { health: "error", reason: r.error?.message ?? "no response" };
  if (r.status >= 400) return { health: "stale", reason: `HTTP ${r.status}` };
  if (r.latencyMs !== null && r.latencyMs > slowMs) return { health: "stale", reason: `slow (${(r.latencyMs / 1000).toFixed(1)}s)` };
  return { health: "live" };
}

// --- Frameability: may a page on the board's origin show this response in an iframe? ---

function hostMatches(pattern: string, origin: URL): boolean {
  // pattern: [scheme://]host[:port][/path]; host may be "*" or start with "*.".
  const m = pattern.match(/^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|(?:\*\.)?[^/:]+)(?::(\*|\d+))?(?:\/.*)?$/i);
  if (!m) return false;
  const [, scheme, host, port] = m;
  const oScheme = origin.protocol.replace(/:$/, "");
  if (scheme && scheme.toLowerCase() !== oScheme && !(scheme.toLowerCase() === "http" && oScheme === "https")) return false;
  // A scheme-less source matches the protected resource's scheme; the board is http, and
  // an https app's "example.com" source does not match http://board.
  const h = origin.hostname.toLowerCase();
  const ph = host.toLowerCase();
  if (ph !== "*" && !(ph.startsWith("*.") ? h.endsWith(ph.slice(1)) : h === ph)) return false;
  const oPort = origin.port || (oScheme === "https" ? "443" : "80");
  const pPort = port ?? (scheme ? (scheme.toLowerCase() === "https" ? "443" : "80") : null);
  if (port === "*") return true;
  return pPort === null ? oPort === (oScheme === "https" ? "443" : "80") : pPort === oPort;
}

// frame-ancestors decides when present (CSP Level 2+ browsers ignore X-Frame-Options then);
// otherwise X-Frame-Options DENY / SAMEORIGIN block (the board is never the app's origin),
// and the obsolete ALLOW-FROM is ignored, as browsers do.
export function frameability(h: { xfo: string | null; csp: string[] } | null, boardOrigins: string[], appUrl?: string): AppFrame {
  if (!h) return { allowed: null, reason: "not checked (no response)" };
  const boards = boardOrigins.flatMap((o) => {
    try {
      return [new URL(o)];
    } catch {
      return [];
    }
  });
  const app = appUrl ? new URL(appUrl) : null;
  const policies = h.csp.flatMap((v) => v.split(","));
  let sawAncestors = false;
  for (const pol of policies) {
    const d = pol
      .split(";")
      .map((s) => s.trim())
      .find((s) => /^frame-ancestors(\s|$)/i.test(s));
    if (!d) continue;
    sawAncestors = true;
    const sources = d.split(/\s+/).slice(1).filter(Boolean);
    const label = `CSP frame-ancestors ${sources.join(" ") || "'none'"}`;
    if (!sources.length || sources.some((s) => s.toLowerCase() === "'none'")) return { allowed: false, reason: label };
    const ok = boards.some((b) =>
      sources.some((s) => {
        const sl = s.toLowerCase();
        if (sl === "*") return true;
        if (sl === "'self'") return !!app && app.origin === b.origin;
        if (/^[a-z][a-z0-9+.-]*:$/.test(sl)) return sl === b.protocol || (sl === "http:" && b.protocol === "https:");
        return hostMatches(sl, b);
      }),
    );
    if (!ok) return { allowed: false, reason: label };
  }
  if (sawAncestors) return { allowed: true, reason: "CSP frame-ancestors allows the board" };
  if (h.xfo) {
    const vals = h.xfo.split(",").map((s) => s.trim().toUpperCase());
    if (vals.includes("DENY")) return { allowed: false, reason: "X-Frame-Options: DENY" };
    if (vals.includes("SAMEORIGIN")) {
      if (app && boards.some((b) => b.origin === app.origin)) return { allowed: true, reason: "X-Frame-Options: SAMEORIGIN (same origin)" };
      return { allowed: false, reason: "X-Frame-Options: SAMEORIGIN" };
    }
  }
  return { allowed: true, reason: "no framing headers" };
}
