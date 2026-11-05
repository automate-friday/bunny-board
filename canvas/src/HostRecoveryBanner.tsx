import { perfCount } from "./perf";
import { useEffect, useState } from "react";
import { type Computed, computed, type Editor, useValue } from "tldraw";
import { api } from "./api";

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
  const replies = Number.isFinite(state.queue?.replies) ? state.queue!.replies! : 0;
  const queued = state.queue ? state.queue.deltas + state.queue.intros + replies + binds : null;
  return <div role="status" aria-live="polite" data-testid="host-recovery-banner" data-fallback={state.fallback ? "1" : "0"} style={{ flexShrink: 0, background: "#fff1c8", color: "#593a00", borderBottom: "1px solid #d2a34a", padding: "7px 12px", font: "13px system-ui", overflowWrap: "anywhere" }}>
    <strong>{state.health?.queueing ? `Paseo host reconnecting, ${queued === null ? "queue count unavailable" : `${queued} queued`}` : "Paseo host status unavailable"}</strong>
    <span data-testid="host-observed-state"> {state.health ? `${state.health.state}: ${state.health.message}` : "No health result yet."}{observedAt !== null ? ` · observed ${Math.max(0, Math.floor((now - observedAt) / 1000))}s` : ""}</span>
    <span> · Start and Link remain available. Requests wait for recovery.</span>
    {state.queue ? <span style={{ fontSize: 11 }}> {replies} replies, {state.queue.deltas} edits, {state.queue.intros} introductions, {binds} bind requests on this board.</span> : null}
    {state.fallback ? <span style={{ fontSize: 11 }}> Legacy availability fallback; transport state unavailable.</span> : null}
    {state.error ? <span role="alert"> Status check failed: {state.error}. Last known state shown.</span> : null}
    {state.queueError ? <span> Queue count could not be refreshed.</span> : null}
  </div>;
}
