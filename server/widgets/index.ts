// Widget hub: the server registry of widget data sources plus status bookkeeping. One
// running watch per (widget, config) key, shared by every SSE stream and board_read that
// wants it. The hub owns the "stale" rule (no fresh data within the manifest's staleMs)
// and "last synced" time, so data sources only report what they know.

import { type AnyConfig, type WidgetState, widgetConfig, widgetKey, widgetManifest } from "../../shared/widgets";
import { appSource } from "./app/source";
import { helloSource } from "./hello";
import { slackSource } from "./slack/source";
import type { PluginRegistry } from "../plugins";
import type { WidgetOption, WidgetSource, WidgetUpdate } from "./types";

export type { WidgetSource } from "./types";

type Listener = (state: WidgetState) => void;

interface Entry {
  widgetId: string;
  config: AnyConfig;
  state: WidgetState;
  listeners: Set<Listener>;
  dispose: (() => void) | null;
  staleTimer: ReturnType<typeof setTimeout> | null;
  lingerTimer: ReturnType<typeof setTimeout> | null;
  // Keep running until then after the last hold goes (only board_widget read sets it).
  lingerUntil: number;
  holds: number;
}

// extra: sources that need other board services (claude-activity needs CloudSessions);
// an extra source replaces a default one with the same id (core passes the app source the
// board's own origin, for its frame-ancestors check).
export function defaultWidgetSources(extra: WidgetSource[] = []): WidgetSource[] {
  return [helloSource(), slackSource(), appSource(), ...extra];
}

export class WidgetHub {
  private readonly sources = new Map<string, WidgetSource>();
  private readonly entries = new Map<string, Entry>();
  // Proof counters (GET /api/ui/debug/widgets).
  readonly counters = { starts: 0, stops: 0, updates: 0 };
  // "My registry" (server/plugins.ts): which plugins the tray and board_widget list offer.
  // null: everything counts as installed (tests, embedded uses).
  plugins: PluginRegistry | null = null;

  constructor(
    sources: WidgetSource[],
    private readonly log: (m: string) => void = () => {},
    // How long a source keeps running after a board_widget read, so the agent's next
    // read is instant. Viewers (SSE streams) linger 0: the source stops the moment the
    // last one leaves. The canvas opens a stream's replacement before closing it, so a
    // reopen never restarts the sources it keeps.
    private readonly readLingerMs = 15_000,
  ) {
    for (const s of sources) this.sources.set(s.id, s);
  }

  source(widgetId: string): WidgetSource | undefined {
    return this.sources.get(widgetId);
  }

  // Validates and normalises a config; throws WidgetConfigError.
  resolve(widgetId: string, config: unknown): { key: string; config: AnyConfig } {
    const c = widgetConfig(widgetId, config);
    return { key: widgetKey(widgetId, c), config: c };
  }

  // Parses a key from the canvas ("<widgetId>:<config json>").
  parseKey(key: string): { widgetId: string; config: unknown } | null {
    const i = key.indexOf(":");
    if (i <= 0) return null;
    try {
      return { widgetId: key.slice(0, i), config: JSON.parse(key.slice(i + 1)) };
    } catch {
      return null;
    }
  }

  // Subscribe to one config's state; the listener gets the current state at once.
  watch(widgetId: string, config: unknown, listener: Listener, opts: { lingerMs?: number } = {}): () => void {
    let resolved: { key: string; config: AnyConfig };
    try {
      resolved = this.resolve(widgetId, config);
    } catch (e) {
      listener({ status: "error", data: null, reason: `invalid_config: ${(e as Error).message}`, syncedAt: null, updatedAt: Date.now() });
      return () => {};
    }
    const e = this.retain(widgetId, resolved.key, resolved.config);
    e.listeners.add(listener);
    listener(e.state);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      e.listeners.delete(listener);
      this.release(resolved.key, e, opts.lingerMs ?? 0);
    };
  }

  // Last known state for a config, or null when nothing is watching it.
  state(widgetId: string, config: AnyConfig): WidgetState | null {
    try {
      return this.entries.get(this.resolve(widgetId, config).key)?.state ?? null;
    } catch {
      return null;
    }
  }

  // State for board_widget read: starts the source if needed and waits briefly for it
  // to leave "connecting". The watch lingers afterwards, so a second read is instant.
  async read(widgetId: string, config: unknown, waitMs = 2500): Promise<WidgetState> {
    return new Promise((resolve) => {
      let stop: () => void = () => {};
      let latest: WidgetState | null = null;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        queueMicrotask(() => stop());
        resolve(latest!);
      };
      const timer = setTimeout(finish, waitMs);
      stop = this.watch(
        widgetId,
        config,
        (s) => {
          latest = s;
          if (s.status !== "connecting") finish();
        },
        { lingerMs: this.readLingerMs },
      );
      if (settled) stop();
    });
  }

  async options(widgetId: string, field: string, config: unknown): Promise<WidgetOption[]> {
    const src = this.sources.get(widgetId);
    if (!src?.options) return [];
    // Options only need the fields filled so far, so validate without requiring the rest.
    return src.options(field, this.resolve(widgetId, config).config);
  }

  async action(widgetId: string, config: unknown, action: string, input: Record<string, unknown>): Promise<unknown> {
    const src = this.sources.get(widgetId);
    if (!src?.action) throw new Error(`widget ${widgetId} has no actions`);
    return src.action(this.resolve(widgetId, config).config, action, input);
  }

  admin(widgetId: string, input: Record<string, unknown>): unknown {
    const src = this.sources.get(widgetId);
    if (!src?.admin) return null;
    return src.admin(input);
  }

  stats() {
    return {
      ...this.counters,
      running: [...this.entries.entries()].map(([key, e]) => ({ key, status: e.state.status, reason: e.state.reason ?? null, viewers: e.listeners.size, holds: e.holds, syncedAt: e.state.syncedAt, lingering: !!e.lingerTimer })),
    };
  }

  closeAll(): void {
    for (const [key, e] of this.entries) this.stop(key, e);
  }

  private retain(widgetId: string, key: string, config: AnyConfig): Entry {
    let e = this.entries.get(key);
    if (!e) {
      e = { widgetId, config, state: { status: "connecting", data: null, syncedAt: null, updatedAt: Date.now() }, listeners: new Set(), dispose: null, staleTimer: null, lingerTimer: null, lingerUntil: 0, holds: 0 };
      this.entries.set(key, e);
      this.start(key, e);
    }
    if (e.lingerTimer) {
      clearTimeout(e.lingerTimer);
      e.lingerTimer = null;
    }
    e.holds++;
    return e;
  }

  private release(key: string, e: Entry, lingerMs: number): void {
    e.holds--;
    const now = Date.now();
    if (lingerMs > 0) e.lingerUntil = Math.max(e.lingerUntil, now + lingerMs);
    if (e.holds > 0 || this.entries.get(key) !== e) return;
    const wait = e.lingerUntil - now;
    if (wait <= 0) {
      this.stop(key, e);
      return;
    }
    e.lingerTimer = setTimeout(() => this.stop(key, e), wait);
    e.lingerTimer.unref?.();
  }

  private start(key: string, e: Entry): void {
    const src = this.sources.get(e.widgetId);
    const m = widgetManifest(e.widgetId);
    if (!src || !m) {
      this.update(key, e, { status: "error", reason: `no data source for widget ${e.widgetId}` });
      return;
    }
    if (!m.configured(e.config)) {
      this.update(key, e, { status: "error", reason: "not set up yet" });
      return;
    }
    this.counters.starts++;
    try {
      const dispose = src.watch(e.config, (u) => this.update(key, e, u));
      // A source that emitted, then got stopped during its own watch() call.
      if (this.entries.get(key) === e) e.dispose = dispose;
      else dispose();
    } catch (err) {
      this.log(`widget ${key} failed to start: ${(err as Error).message}`);
      this.update(key, e, { status: "error", reason: (err as Error).message });
    }
  }

  private stop(key: string, e: Entry): void {
    if (this.entries.get(key) !== e) return;
    this.entries.delete(key);
    this.counters.stops++;
    if (e.staleTimer) clearTimeout(e.staleTimer);
    if (e.lingerTimer) clearTimeout(e.lingerTimer);
    try {
      e.dispose?.();
    } catch (err) {
      this.log(`widget ${key} failed to stop: ${(err as Error).message}`);
    }
    e.dispose = null;
  }

  private update(key: string, e: Entry, u: WidgetUpdate): void {
    if (this.entries.get(key) !== e) return;
    const now = Date.now();
    const prev = e.state;
    e.state = {
      status: u.status,
      data: u.data === undefined ? prev.data : u.data,
      ...(u.reason ? { reason: u.reason } : {}),
      syncedAt: u.status === "live" ? now : prev.syncedAt,
      updatedAt: now,
    };
    this.counters.updates++;
    if (e.staleTimer) clearTimeout(e.staleTimer);
    e.staleTimer = null;
    if (u.status === "live") {
      const m = widgetManifest(e.widgetId);
      const ms = (m?.staleMsFor ? m.staleMsFor(e.config) : m?.staleMs) ?? 30_000;
      e.staleTimer = setTimeout(() => this.update(key, e, { status: "stale", reason: `no update for ${Math.round(ms / 1000)}s` }), ms);
      e.staleTimer.unref?.();
    }
    for (const fn of e.listeners) fn(e.state);
  }
}
