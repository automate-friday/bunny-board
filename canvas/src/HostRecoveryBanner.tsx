import { perfCount } from "./perf";
import { useEffect, useState } from "react";
import { type Computed, computed, type Editor, useValue } from "tldraw";
import { api } from "./api";

const BANNER_GRACE_MS = 4000;
interface Health { state: string; message: string; queueing: boolean; retryAfterMs: number }
interface Queue { deltas: number; frames: number; intros: number; replies?: number }
async function hostHealth(signal: AbortSignal): Promise<{ health: Health; fallback: boolean }> {
  const response = await fetch("/api/ui/health", { signal });
  if (response.ok) {
    const health = await response.json() as Health;
    if (typeof health.queueing === "boolean" && typeof health.state === "string") return { health, fallback: false };
    // A successful old endpoint without the documented shape lacks this contract.
  } else if (response.status !== 404 && response.status !== 405) {
    throw Error(`Host health check returned HTTP ${response.status}`);
  }
  const legacy = await api<{ paseo: boolean }>("/api/health", { signal });
  if (typeof legacy.paseo !== "boolean") throw Error("Host health unavailable");
  return { health: { state: legacy.paseo ? "connected" : "disconnected", message: "Legacy plugin API availability; bridge transport health unavailable", queueing: !legacy.paseo, retryAfterMs: 2000 }, fallback: true };
}
// Frames on any page with a queued bind request. The store's incremental index of frame
// ids (all pages) means the count depends on frame records only, not on every record
// (presence, camera and pointer included) as a scan of allRecords() did.
const queuedBindCounts = new WeakMap<Editor, Computed<number>>();
function queuedBinds(editor: Editor): Computed<number> {
  let c = queuedBindCounts.get(editor);
  if (!c) {
    const frameIds = editor.store.query.ids("shape", () => ({ type: { eq: "frame" } }));
    c = computed("queued-bind-count", () => {
      let n = 0;
      for (const id of frameIds.get()) {
        const paseo = editor.store.get(id)?.meta.paseo as { status?: string; request?: unknown } | undefined;
        if (paseo?.status === "requested" && paseo.request) n++;
      }
      return n;
    });
    queuedBindCounts.set(editor, c);
  }
  return c;
}
export function HostRecoveryBanner({ boardId, editor }: { boardId: string; editor: Editor | null }) {
  const [state, setState] = useState<{ health: Health | null; queue: Queue | null; error: string | null; queueError: boolean; fallback: boolean }>({ health: null, queue: null, error: null, queueError: false, fallback: false });
  const [observedAt, setObservedAt] = useState<number | null>(null), [now, setNow] = useState(Date.now());
  const waiting = !!state.health?.queueing || !!state.error;
  useEffect(() => { if (!waiting) { setObservedAt(null); return; } setObservedAt(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [waiting]);
  const binds = useValue("queued-bind-requests", () => (perfCount("queued-bind-requests"), editor) ? queuedBinds(editor).get() : 0, [editor]);
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const poll = async () => {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]);
      const [health, queue] = await Promise.allSettled([
        hostHealth(signal),
        api<{ queued: Queue }>(`/api/ui/boards/${encodeURIComponent(boardId)}/locks`, { signal }),
      ]);
      if (!alive) return;
      const queued = queue.status === "fulfilled" && queue.value.queued && [queue.value.queued.deltas, queue.value.queued.intros].every(n => Number.isFinite(n) && n >= 0) ? queue.value.queued : null;
      setState(old => ({ health: health.status === "fulfilled" ? health.value.health : old.health, fallback: health.status === "fulfilled" ? health.value.fallback : old.fallback, queue: queued, error: health.status === "rejected" ? String(health.reason?.message ?? "Health check failed") : null, queueError: !queued }));
      const delay = health.status === "fulfilled" ? Math.max(1000, Math.min(10000, Number(health.value.health.retryAfterMs) || 2000)) : 2000;
      timer = setTimeout(() => void poll(), delay);
    };
    void poll();
    return () => { alive = false; controller.abort(); clearTimeout(timer); };
  }, [boardId]);
  if (!state.health?.queueing && !state.error) return null;
  // A blip that clears within the grace period never shows: most failed checks recover on the next poll.
  if (observedAt === null || now - observedAt < BANNER_GRACE_MS) return null;
  const replies = Number.isFinite(state.queue?.replies) ? state.queue!.replies! : 0;
  const queued = state.queue ? state.queue.deltas + state.queue.intros + replies + binds : null;
  const headline = state.health?.queueing ? "Reconnecting…" : "Connection check delayed";
  const sub = state.health?.queueing ? (queued ? `${queued} change${queued === 1 ? "" : "s"} saved, will send` : "Your changes are saved") : null;
  // Floats over the board at a fixed height so nothing below it moves (no layout shift).
  // The one-line summary is all most people need; diagnostics stay one click away.
  return <details role="status" aria-live="polite" data-testid="host-recovery-banner" data-fallback={state.fallback ? "1" : "0"} style={{ position: "absolute", top: 10, left: "50%", transform: "translateX(-50%)", zIndex: 400, maxWidth: "min(520px, calc(100vw - 24px))", font: "13px system-ui", color: "light-dark(#593a00, hsl(39 88% 74%))" }}>
    <summary style={{ height: 32, boxSizing: "border-box", display: "flex", alignItems: "center", gap: 8, padding: "0 12px", borderRadius: 16, background: "light-dark(#fff6dc, hsl(45 45% 21%))", border: "1px solid light-dark(#e6c67a, hsl(39 35% 39%))", boxShadow: "0 2px 8px light-dark(#0000001a, #0006)", cursor: "pointer", listStyle: "none", whiteSpace: "nowrap" }}>
      <span aria-hidden style={{ width: 8, height: 8, borderRadius: 4, background: "light-dark(#d08a00, hsl(39 88% 60%))", flexShrink: 0 }} />
      <strong style={{ fontWeight: 600 }}>{headline}</strong>
      {sub ? <span style={{ opacity: 0.8, overflow: "hidden", textOverflow: "ellipsis" }}>{sub}</span> : null}
      <span style={{ opacity: 0.6, fontSize: 12 }}>Details</span>
    </summary>
    <div style={{ marginTop: 6, padding: "8px 12px", borderRadius: 8, background: "light-dark(#fffdf6, hsl(45 30% 16%))", border: "1px solid light-dark(#e6c67a, hsl(39 35% 39%))", fontSize: 12, lineHeight: 1.45, overflowWrap: "anywhere" }}>
      <div data-testid="host-observed-state">{state.health ? `${state.health.state}: ${state.health.message}` : "No health result yet."}{` · ${Math.max(0, Math.floor((now - observedAt) / 1000))}s`}</div>
      <div>Starting and linking still work. Requests send once the host is back.</div>
      {state.queue ? <div>{replies} replies, {state.queue.deltas} edits, {state.queue.intros} introductions, {binds} bind requests waiting.</div> : null}
      {state.fallback ? <div>Legacy availability fallback; transport state unavailable.</div> : null}
      {state.error ? <div role="alert">Status check failed: {state.error}. Last known state shown.</div> : null}
      {state.queueError ? <div>Queue count could not be refreshed.</div> : null}
    </div>
  </details>;
}
