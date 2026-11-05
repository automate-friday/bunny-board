import { MessageBody } from "./MessageBody";
import { useEffect, useRef, useState } from "react";
import type { TranscriptRow } from "../../shared/components/transcript";
import { api } from "./api";

export type HistoryRow = TranscriptRow & { id?: string; truncated?: boolean };
type Page = { rows: HistoryRow[]; nextCursor?: string | null; hasOlder?: boolean; epoch?: string; reset?: boolean; staleCursor?: boolean; gap?: boolean; capabilities?: { older: boolean; exact: boolean } };

// An opened history is a snapshot. Never merge live cards from an unknown epoch.
export function useTimelineHistory(agentId: string | undefined, open: boolean, allowOlder = false) {
  const [page, setPage] = useState<Page | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const state = useRef({ agentId, generation: 0, busy: false, page: null as Page | null, failedOlder: false });
  if (state.current.agentId !== agentId) state.current = { agentId, generation: state.current.generation + 1, busy: false, page: null, failedOlder: false };
  const olderAllowed = useRef(allowOlder); olderAllowed.current = allowOlder;
  const load = async (older = false) => {
    if (older && !olderAllowed.current) { setError(null); setNotice("Older history is unavailable for this agent. Refresh recent messages instead."); return; }
    const target = state.current;
    if (!agentId || target.busy) return;
    target.busy = true; target.failedOlder = older; setBusy(true); setError(null);
    const previous = target.page;
    const cursor = older ? previous?.nextCursor : null;
    try {
      let result = await api<Page>(`/api/ui/agents/${encodeURIComponent(agentId)}/timeline?limit=80${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`);
      if (state.current !== target) return;
      if (result.reset || result.staleCursor || result.gap || (older && previous?.epoch !== result.epoch)) {
        // Discard all old rows immediately, even if the replacement tail fails.
        target.page = null; setPage(null);
        setNotice("History changed or has a gap. Reloading the recent log; older rows must be loaded again.");
        target.failedOlder = false;
        result = await api<Page>(`/api/ui/agents/${encodeURIComponent(agentId)}/timeline?limit=80`);
        if (state.current !== target) return;
        if (result.reset || result.staleCursor || result.gap) throw new Error("History is changing. Retry refreshing the recent log.");
        setNotice("History changed or had a gap. Recent log refreshed; load older rows again.");
      } else if (older && previous && cursor) {
        const seen = new Set(result.rows.map(row => row.id).filter(Boolean));
        result = { ...result, rows: [...result.rows, ...previous.rows.filter(row => !row.id || !seen.has(row.id))] };
      } else setNotice(null);
      target.page = result; setPage(result);
    } catch (e) {
      if (state.current === target) { setError((e as Error).message); setNotice(null); }
    } finally {
      if (state.current === target) { target.busy = false; setBusy(false); }
    }
  };
  useEffect(() => {
    setPage(null); setBusy(false); setError(null); setNotice(null);
    if (open) void load();
    return () => { const old = state.current; state.current = { ...old, generation: old.generation + 1, busy: false }; };
  }, [agentId, open]);
  const invalidate = () => {
    state.current = { ...state.current, generation: state.current.generation + 1, busy: false, page: null };
    setPage(null); setBusy(false);
    setNotice("This history changed. Refreshing the recent log.");
    void load();
  };
  return { invalidate, page: state.current.page === page ? page : null, busy, error, notice, load, retry: () => load(state.current.failedOlder) };
}

export function ExactRow({ agentId, row, onChanged }: { agentId: string; row: HistoryRow; onChanged: () => void }) {
  const [detail, setDetail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = async () => {
    if (busy || !row.id) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/ui/agents/${encodeURIComponent(agentId)}/timeline/rows/${encodeURIComponent(row.id)}`);
      const result = await response.json();
      if (!alive.current) return;
      if (response.status === 409 || response.status === 404) { onChanged(); throw new Error("This row changed or is no longer available. Refresh the log."); }
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      if (result.id !== row.id || result.truncated !== false || typeof result.text !== "string") throw new Error("Exact text was not supplied by the server.");
      setDetail(result.text);
    } catch (e) { if (alive.current) setError((e as Error).message); }
    finally { if (alive.current) setBusy(false); }
  };
  return <div data-testid="exact-row">
    <button type="button" disabled={busy} onClick={() => detail === null ? void load() : setDetail(null)}>{busy ? "Loading full text…" : detail !== null ? "Hide full text" : row.kind === "tool" ? "Full tool details" : "Exact full text"}</button>
    {error ? <div role="alert">{error} <button type="button" onClick={() => void load()}>Retry</button></div> : null}
    {detail !== null ? <div><small>Full source text · secrets redacted</small><div data-testid="exact-text">{row.kind === "tool" ? <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{detail}</pre> : <MessageBody text={detail} />}</div></div> : null}
  </div>;
}
