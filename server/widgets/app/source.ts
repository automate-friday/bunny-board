// App widget data source: probes healthUrl || url every refreshSec (default 30 s) and
// reports live / stale / error with latency, plus whether the app may be framed on the
// board. One probe at a time per config; the hub shares one watch between every viewer of
// the same config, and dispose (last viewer gone) aborts the probe in flight and clears
// the timer, so nothing keeps probing an app nobody is looking at.

import { type AppConfig, type AppData, type AppFrame, appRefreshSec } from "../../../shared/widgets/app";
import type { WidgetSource } from "../types";
import { type AppPolicy, createGuard, type Guard, policyFromEnv } from "./guard";
import { frameability, mapHealth, probeApp } from "./probe";

export interface AppSourceOptions {
  policy?: AppPolicy;
  guard?: Guard;
  // Origins the canvas is served from (frame-ancestors is checked against them).
  boardOrigins?: string[];
  timeoutMs?: number;
  slowMs?: number;
  // Tests: override the probe period (ms) regardless of refreshSec.
  periodMs?: number;
  // With a separate healthUrl, re-check the app URL's framing headers every N probes.
  frameEvery?: number;
}

// The board's own origins: its public base, plus the loopback names it also answers on.
export function boardOrigins(publicBase: string): string[] {
  const out = new Set<string>();
  try {
    const u = new URL(publicBase);
    out.add(u.origin);
    for (const h of ["127.0.0.1", "localhost"]) out.add(`${u.protocol}//${h}${u.port ? `:${u.port}` : ""}`);
  } catch {
    /* no public base: host-source frame-ancestors never match */
  }
  return [...out];
}

export function appSource(opts: AppSourceOptions = {}): WidgetSource<AppConfig> & { counters: { probes: number; inflight: number } } {
  const guard = opts.guard ?? createGuard(opts.policy ?? policyFromEnv());
  const boards = opts.boardOrigins ?? [];
  const counters = { probes: 0, inflight: 0 };
  const probe = async (url: string, signal: AbortSignal) => {
    counters.probes++;
    counters.inflight++;
    try {
      return await probeApp(url, { guard, signal, timeoutMs: opts.timeoutMs });
    } finally {
      counters.inflight--;
    }
  };
  return {
    id: "app",
    counters,
    watch(config, emit) {
      const period = opts.periodMs ?? appRefreshSec(config.refreshSec) * 1000;
      const healthUrl = config.healthUrl || config.url;
      const separate = !!config.healthUrl && config.healthUrl !== config.url;
      const ctrl = new AbortController();
      let timer: ReturnType<typeof setTimeout> | null = null;
      let tick = 0;
      let frame: AppFrame = { allowed: null, reason: "not checked yet" };
      emit({ status: "connecting" });
      const run = async () => {
        timer = null;
        const checkFrame = separate && tick % (opts.frameEvery ?? 10) === 0;
        const [h, f] = await Promise.all([probe(healthUrl, ctrl.signal), checkFrame ? probe(config.url, ctrl.signal) : Promise.resolve(null)]);
        if (ctrl.signal.aborted) return;
        if (!separate) frame = h.frameHeaders ? frameability(h.frameHeaders, boards, h.finalUrl ?? config.url) : frame;
        else if (f) frame = f.frameHeaders ? frameability(f.frameHeaders, boards, f.finalUrl ?? config.url) : frame;
        const { health, reason } = mapHealth(h, opts.slowMs);
        const data: AppData = {
          target: healthUrl,
          finalUrl: h.finalUrl,
          health,
          httpStatus: h.status,
          latencyMs: h.latencyMs,
          method: h.method,
          redirects: h.redirects,
          ...(reason ? { reason } : {}),
          frame,
          checkedAt: new Date().toISOString(),
        };
        emit({ status: health, data, ...(reason ? { reason } : {}) });
        tick++;
        timer = setTimeout(() => void run(), period);
        timer.unref?.();
      };
      void run();
      return () => {
        ctrl.abort();
        if (timer) clearTimeout(timer);
        timer = null;
      };
    },
  };
}
