// Always-on, cheap server performance gauges for GET /api/ui/debug/perf.
//
//   eventLoop: delay histogram (perf_hooks.monitorEventLoopDelay, 10 ms resolution) and
//              event-loop utilization since the last reset
//   timings:   named durations (room save, sync push handling, change listener) as a
//              bounded ring of recent samples plus totals since the last reset
//
// Recording is a Map lookup and an array write, so it stays on in production. Readers
// pass ?reset=1 to start a fresh window (the bench does, per scenario).
import { monitorEventLoopDelay, performance, type EventLoopUtilization } from "node:perf_hooks";

const RING = 1024;
// The histogram's samples include the timer's own interval; it is subtracted when reporting.
const RESOLUTION_MS = 10;

interface Series {
  ring: Float64Array;
  next: number;
  filled: number;
  count: number;
  total: number;
  max: number;
  extra: number; // a second summed quantity (bytes saved, records changed)
}

const series = new Map<string, Series>();
let histogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
let eluStart: EventLoopUtilization | null = null;
let windowStart = Date.now();

function ensureLoop() {
  if (histogram) return;
  histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  histogram.enable();
  eluStart = performance.eventLoopUtilization();
}

export function recordTiming(name: string, ms: number, extra = 0): void {
  ensureLoop();
  let s = series.get(name);
  if (!s) {
    s = { ring: new Float64Array(RING), next: 0, filled: 0, count: 0, total: 0, max: 0, extra: 0 };
    series.set(name, s);
  }
  s.ring[s.next] = ms;
  s.next = (s.next + 1) % RING;
  if (s.filled < RING) s.filled++;
  s.count++;
  s.total += ms;
  s.extra += extra;
  if (ms > s.max) s.max = ms;
}

// Time a synchronous function under `name`.
export function timed<T>(name: string, fn: () => T): T {
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    recordTiming(name, performance.now() - t0);
  }
}

function quantile(sorted: Float64Array, q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

const round = (n: number) => Math.round(n * 100) / 100;

export function perfSnapshot(reset = false) {
  ensureLoop();
  const h = histogram!;
  const ms = (ns: number) => round(Math.max(0, ns / 1e6 - RESOLUTION_MS));
  const elu = performance.eventLoopUtilization(eluStart ?? undefined);
  const timings: Record<string, unknown> = {};
  for (const [name, s] of series) {
    const sorted = s.ring.slice(0, s.filled).sort();
    timings[name] = {
      count: s.count,
      totalMs: round(s.total),
      meanMs: round(s.count ? s.total / s.count : 0),
      p50Ms: round(quantile(sorted, 0.5)),
      p95Ms: round(quantile(sorted, 0.95)),
      maxMs: round(s.max),
      ...(s.extra ? { extra: s.extra } : {}),
    };
  }
  const mem = process.memoryUsage();
  const out = {
    windowMs: Date.now() - windowStart,
    eventLoop: {
      p50Ms: ms(h.percentile(50)),
      p95Ms: ms(h.percentile(95)),
      p99Ms: ms(h.percentile(99)),
      maxMs: ms(h.max),
      meanMs: ms(h.mean),
      utilization: round(elu.utilization),
    },
    timings,
    memory: { rssMb: round(mem.rss / 1048576), heapUsedMb: round(mem.heapUsed / 1048576) },
  };
  if (reset) {
    h.reset();
    eluStart = performance.eventLoopUtilization();
    windowStart = Date.now();
    series.clear();
  }
  return out;
}
