// Client perf reports from real devices (canvas ?perf=1 or ?perf=report): each tab POSTs a
// compact 10 s summary to /api/ui/debug/perf/client; GET /api/ui/debug/perf/clients reads
// them back. In memory only, bounded: per device a ring of the last 30 minutes (at most
// MAX_SAMPLES), at most MAX_DEVICES devices, every field clamped or truncated on the way in.

export const CLIENT_PERF = {
  maxBodyBytes: 16 * 1024,
  windowMs: 30 * 60 * 1000,
  maxSamples: 200, // 30 min of 10 s reports, with slack
  maxDevices: 50,
  maxCounters: 10,
  maxScripts: 5,
};

export interface ClientPerfSample {
  at: number; // server receive time
  board: string;
  windowMs: number;
  frames: { n: number; p50: number; p95: number; max: number };
  longTasks: { n: number; ms: number };
  counters: { name: string; perSec: number }[];
  shapes: { page: number; rendered: number; culled: number };
  zoom: number;
  agents: { working: number; streamingCards: number };
  activity: "idle" | "hover" | "pan" | "drag" | "zoom";
  input: { wheel: number; dragMoves: number; pointerMoves: number };
  visibility: "visible" | "hidden";
  hiddenMs: number;
  loaf?: { n: number; ms: number; blockingMs: number; scripts: { source: string; fn: string; invoker: string; ms: number; n: number }[] };
}

interface Device {
  id: string;
  label: string;
  firstAt: number;
  lastAt: number;
  samples: ClientPerfSample[];
}

const ACTIVITIES = new Set(["idle", "hover", "pan", "drag", "zoom"]);

const num = (v: unknown, max = 1e9): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(0, Math.round(n * 10) / 10)) : 0;
};
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// Accepts an untrusted report body; returns the device and a sanitized sample, or null.
export function sanitizeClientReport(body: unknown, at: number): { id: string; label: string; sample: ClientPerfSample } | null {
  const b = obj(body);
  const id = str(b.id, 40).replace(/[^\w-]/g, "");
  if (!id) return null;
  const f = obj(b.frames);
  const lt = obj(b.longTasks);
  const sh = obj(b.shapes);
  const ag = obj(b.agents);
  const inp = obj(b.input);
  const sample: ClientPerfSample = {
    at,
    board: str(b.board, 64),
    windowMs: num(b.windowMs, 600_000),
    frames: { n: num(f.n, 100_000), p50: num(f.p50, 60_000), p95: num(f.p95, 60_000), max: num(f.max, 600_000) },
    longTasks: { n: num(lt.n, 100_000), ms: num(lt.ms, 600_000) },
    counters: arr(b.counters)
      .slice(0, CLIENT_PERF.maxCounters)
      .map((c) => ({ name: str(obj(c).name, 64), perSec: num(obj(c).perSec, 1e7) }))
      .filter((c) => c.name),
    shapes: { page: num(sh.page, 1e7), rendered: num(sh.rendered, 1e7), culled: num(sh.culled, 1e7) },
    zoom: num(b.zoom, 1000),
    agents: { working: num(ag.working, 10_000), streamingCards: num(ag.streamingCards, 10_000) },
    activity: (ACTIVITIES.has(b.activity as string) ? b.activity : "idle") as ClientPerfSample["activity"],
    input: { wheel: num(inp.wheel, 1e6), dragMoves: num(inp.dragMoves, 1e6), pointerMoves: num(inp.pointerMoves, 1e6) },
    visibility: b.visibility === "hidden" ? "hidden" : "visible",
    hiddenMs: num(b.hiddenMs, 600_000),
  };
  if (b.loaf && typeof b.loaf === "object") {
    const l = obj(b.loaf);
    sample.loaf = {
      n: num(l.n, 100_000),
      ms: num(l.ms, 600_000),
      blockingMs: num(l.blockingMs, 600_000),
      scripts: arr(l.scripts)
        .slice(0, CLIENT_PERF.maxScripts)
        .map((s) => {
          const o = obj(s);
          return { source: str(o.source, 200), fn: str(o.fn, 120), invoker: str(o.invoker, 120), ms: num(o.ms, 600_000), n: num(o.n, 100_000) };
        }),
    };
  }
  return { id, label: str(b.label, 120), sample };
}

export class ClientPerfStore {
  private readonly devices = new Map<string, Device>();
  constructor(private readonly now: () => number = Date.now) {}

  add(body: unknown): boolean {
    const at = this.now();
    const r = sanitizeClientReport(body, at);
    if (!r) return false;
    this.prune(at);
    let d = this.devices.get(r.id);
    if (!d) {
      if (this.devices.size >= CLIENT_PERF.maxDevices) {
        // Drop the device heard from least recently.
        let oldest: Device | null = null;
        for (const x of this.devices.values()) if (!oldest || x.lastAt < oldest.lastAt) oldest = x;
        if (oldest) this.devices.delete(oldest.id);
      }
      d = { id: r.id, label: r.label, firstAt: at, lastAt: at, samples: [] };
      this.devices.set(r.id, d);
    }
    d.label = r.label || d.label;
    d.lastAt = at;
    d.samples.push(r.sample);
    if (d.samples.length > CLIENT_PERF.maxSamples) d.samples.splice(0, d.samples.length - CLIENT_PERF.maxSamples);
    return true;
  }

  private prune(at: number): void {
    const cutoff = at - CLIENT_PERF.windowMs;
    for (const [id, d] of this.devices) {
      while (d.samples.length && d.samples[0].at < cutoff) d.samples.shift();
      if (!d.samples.length) this.devices.delete(id);
    }
  }

  // Devices heard from in the window, most recent first, each with its samples (oldest first)
  // and a summary of the last 5 minutes.
  list(sinceMs = CLIENT_PERF.windowMs) {
    const at = this.now();
    this.prune(at);
    const out = [];
    for (const d of this.devices.values()) {
      const samples = d.samples.filter((s) => s.at >= at - sinceMs);
      if (!samples.length) continue;
      const recent = d.samples.filter((s) => s.at >= at - 5 * 60_000);
      const worst = (f: (s: ClientPerfSample) => number) => recent.reduce((m, s) => Math.max(m, f(s)), 0);
      out.push({
        id: d.id,
        label: d.label,
        firstAt: d.firstAt,
        lastAt: d.lastAt,
        last5min: {
          reports: recent.length,
          worstFrameP95: worst((s) => s.frames.p95),
          worstFrameMax: worst((s) => s.frames.max),
          longTaskMs: Math.round(recent.reduce((t, s) => t + s.longTasks.ms, 0)),
          activity: Object.fromEntries([...ACTIVITIES].map((a) => [a, recent.filter((s) => s.activity === a).length])),
        },
        samples,
      });
    }
    return out.sort((a, b) => b.lastAt - a.lastAt);
  }
}

// The two routes, kept apart from http.ts so they can be tested without a server.
// POST bodies arrive as raw text (capped before parsing).
export function clientPerfRoute(store: ClientPerfStore, method: string, path: string, raw: string | null, query: URLSearchParams): { status: number; body: unknown } | null {
  if (path === "/api/ui/debug/perf/client") {
    if (method !== "POST") return { status: 405, body: { error: "POST a report" } };
    if (raw === null || Buffer.byteLength(raw) > CLIENT_PERF.maxBodyBytes) return { status: 413, body: { error: `report over ${CLIENT_PERF.maxBodyBytes} bytes` } };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: 400, body: { error: "report must be JSON" } };
    }
    return store.add(parsed) ? { status: 204, body: null } : { status: 400, body: { error: "report needs an id" } };
  }
  if (path === "/api/ui/debug/perf/clients") {
    if (method !== "GET") return { status: 405, body: { error: "GET only" } };
    const minutes = Number(query.get("minutes"));
    const since = Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes, 30) * 60_000 : CLIENT_PERF.windowMs;
    return { status: 200, body: { windowMs: CLIENT_PERF.windowMs, devices: store.list(since) } };
  }
  return null;
}

// Reads a request body as text, giving up (null) past `max` bytes.
export async function readCappedText(req: AsyncIterable<unknown>, max: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) return null;
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
