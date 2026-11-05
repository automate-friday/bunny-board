// Live widget states for the whole page: one refcounted entry per widget key, fed by ONE
// EventSource for every widget on screen (GET /api/ui/widgets/events?ids=k1&ids=k2).
// Browsers cap HTTP/1.1 at ~6 connections per origin, so a stream per widget would hang
// the page at six widgets (same reasoning as ../agents.ts for transcript cards).

import { useEffect, useSyncExternalStore } from "react";
import type { WidgetState } from "../../../shared/widgets";

type Notify = () => void;

const CONNECTING: WidgetState = { status: "connecting", data: null, syncedAt: null, updatedAt: 0 };

export class WidgetStore {
  private readonly refs = new Map<string, number>();
  private readonly states = new Map<string, WidgetState>();
  private readonly listeners = new Map<string, Set<Notify>>();
  private es: EventSource | null = null;
  private openKey = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  // Proof counters (window.__widgetStore.stats).
  readonly stats = { opens: 0, messages: 0, errors: 0 };

  // Streams replaced by a newer one, closed once the newer one is open (make-before-break:
  // the server never sees a gap, so the sources this page keeps are not restarted).
  private readonly retiring = new Map<EventSource, ReturnType<typeof setTimeout>>();

  // Mounts and unmounts within one frame share one stream reopen.
  static readonly BATCH_MS = 16;

  retain(key: string): () => void {
    const n = this.refs.get(key) ?? 0;
    this.refs.set(key, n + 1);
    if (n === 0) this.schedule();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const left = (this.refs.get(key) ?? 1) - 1;
      if (left > 0) this.refs.set(key, left);
      else {
        this.refs.delete(key);
        this.schedule();
      }
    };
  }

  subscribe(key: string, fn: Notify): () => void {
    let set = this.listeners.get(key);
    if (!set) this.listeners.set(key, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (!set.size) this.listeners.delete(key);
    };
  }

  get(key: string): WidgetState {
    return this.states.get(key) ?? CONNECTING;
  }

  keys(): string[] {
    return [...this.refs.keys()];
  }

  // Leak check (window.__widgetStore.debug()): all zero once no widget is mounted.
  debug() {
    return { refs: this.refs.size, states: this.states.size, listeners: this.listeners.size, streams: (this.es ? 1 : 0) + this.retiring.size, pendingReopen: !!this.timer };
  }

  // Page going away (tab closed, board switched): close everything now.
  closeAll(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const es of [...this.retiring.keys()]) this.retire(es);
    this.es?.close();
    this.es = null;
    this.openKey = "";
  }

  reopen(): void {
    this.openKey = "";
    this.schedule();
  }

  private notify(key: string): void {
    for (const fn of this.listeners.get(key) ?? []) fn();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.open();
    }, WidgetStore.BATCH_MS);
  }

  private retire(es: EventSource): void {
    clearTimeout(this.retiring.get(es));
    this.retiring.delete(es);
    es.close();
  }

  private open(): void {
    const keys = [...this.refs.keys()].sort();
    const k = keys.join("\n");
    if (k === this.openKey && (this.es || !keys.length)) return;
    this.openKey = k;
    for (const key of [...this.states.keys()]) if (!this.refs.has(key)) this.states.delete(key);
    const old = this.es;
    this.es = null;
    if (!keys.length) {
      // Last widget gone: close at once, so the server stops its sources now.
      if (old) this.retire(old);
      return;
    }
    const es = new EventSource(`/api/ui/widgets/events?${keys.map((x) => `ids=${encodeURIComponent(x)}`).join("&")}`);
    this.stats.opens++;
    if (old) {
      this.retiring.set(old, setTimeout(() => this.retire(old), 1000));
      es.addEventListener("open", () => this.retiring.has(old) && this.retire(old), { once: true });
    }
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as { key: string; state: WidgetState };
        if (!this.refs.has(msg.key)) return;
        this.stats.messages++;
        this.states.set(msg.key, msg.state);
        this.notify(msg.key);
      } catch {
        /* ignore a malformed packet */
      }
    };
    es.onerror = () => {
      if (this.es !== es) return;
      // EventSource retries by itself; meanwhile the board, not the source, is the problem.
      this.stats.errors++;
      for (const key of keys) {
        const s = this.states.get(key);
        if (s && s.status !== "error") {
          this.states.set(key, { ...s, status: "connecting", reason: "reconnecting to the board" });
          this.notify(key);
        }
      }
    };
    this.es = es;
  }
}

export const widgetStore = new WidgetStore();
if (typeof window !== "undefined") {
  (window as unknown as { __widgetStore: WidgetStore }).__widgetStore = widgetStore;
  window.addEventListener("pagehide", () => widgetStore.closeAll());
  // Back from the back/forward cache: the widgets are still mounted, reopen their stream.
  window.addEventListener("pageshow", (e) => e.persisted && widgetStore.reopen());
}

// The live state for a widget key (null: not configured, nothing to watch).
export function useWidgetState(key: string | null): WidgetState | null {
  useEffect(() => (key ? widgetStore.retain(key) : undefined), [key]);
  return useSyncExternalStore(
    (cb) => (key ? widgetStore.subscribe(key, cb) : () => undefined),
    () => (key ? widgetStore.get(key) : null),
  );
}
