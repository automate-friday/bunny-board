import { MessageBody } from "./MessageBody";
import { useEffect, useRef, useState } from "react";
import type { TranscriptRow } from "../../shared/components/transcript";
import { api } from "./api";
import { HISTORY_FIRST_LIMIT, HISTORY_PAGE_SIZE } from "./historyPaging";

export type HistoryRow = TranscriptRow & { id?: string; truncated?: boolean };
type Page = { rows: HistoryRow[]; nextCursor?: string | null; hasOlder?: boolean; epoch?: string; reset?: boolean; staleCursor?: boolean; gap?: boolean; capabilities?: { older: boolean; exact: boolean } };

// Earlier history, a page at a time, for the conversation's scroll-up paging (Sidebar.tsx,
// historyPaging.ts). The first request is the tail: the live window the sidebar already shows
// plus one page older than it; each later one is the 40 entries before the oldest row held.
// The rows are a snapshot joined in front of the live rows (responseLayout.ts joinHistory).
// `onBeforeApply` runs right before new rows are set, while the old ones are still on screen,
// so the caller can note the reading position.
export function useTimelineHistory(agentId: string | undefined, enabled: boolean, onBeforeApply?: () => void) {
  const [page, setPage] = useState<Page | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const state = useRef({ agentId, generation: 0, busy: false, page: null as Page | null });
  if (state.current.agentId !== agentId) state.current = { agentId, generation: state.current.generation + 1, busy: false, page: null };
  const before = useRef(onBeforeApply);
  before.current = onBeforeApply;
  const allowed = useRef(enabled);
  allowed.current = enabled;
  const url = (limit: number, cursor?: string | null) => `/api/ui/agents/${encodeURIComponent(agentId ?? "")}/timeline?limit=${limit}${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`;
  // "ok": a page was applied; "error": it failed (`error` says why); "skip": nothing was asked
  // (one is already out, nothing older, another conversation by now).
  const loadOlder = async (): Promise<"ok" | "error" | "skip"> => {
    const target = state.current;
    if (!agentId || !allowed.current || target.busy) return "skip";
    const previous = target.page;
    if (previous && !(previous.hasOlder && previous.nextCursor)) return "skip";
    target.busy = true;
    setBusy(true);
    setError(null);
    try {
      let result = await api<Page>(previous ? url(HISTORY_PAGE_SIZE, previous.nextCursor) : url(HISTORY_FIRST_LIMIT));
      if (state.current !== target) return "skip";
      if (result.reset || result.staleCursor || result.gap || (previous && previous.epoch !== result.epoch)) {
        // Discard all old rows, even if the replacement tail fails.
        before.current?.();
        target.page = null;
        setPage(null);
        setNotice("History changed or has a gap. Reloading the recent log; older rows must be loaded again.");
        result = await api<Page>(url(HISTORY_FIRST_LIMIT));
        if (state.current !== target) return "skip";
        if (result.reset || result.staleCursor || result.gap) throw new Error("History is changing. Retry refreshing the recent log.");
        setNotice("History changed or had a gap. Recent log refreshed; scroll up to load older rows again.");
      } else if (previous) {
        const seen = new Set(result.rows.map((row) => row.id).filter(Boolean));
        result = { ...result, rows: [...result.rows, ...previous.rows.filter((row) => !row.id || !seen.has(row.id))] };
      } else setNotice(null);
      before.current?.();
      target.page = result;
      setPage(result);
      return "ok";
    } catch (e) {
      if (state.current === target) {
        setError((e as Error).message);
        setNotice(null);
        return "error";
      }
      return "skip";
    } finally {
      if (state.current === target) {
        target.busy = false;
        setBusy(false);
      }
    }
  };
  useEffect(() => {
    setPage(null);
    setBusy(false);
    setError(null);
    setNotice(null);
    return () => {
      const old = state.current;
      state.current = { ...old, generation: old.generation + 1, busy: false, page: null };
    };
  }, [agentId]);
  // A row changed under an exact-text request: drop the snapshot (back to the live rows).
  const invalidate = () => {
    before.current?.();
    state.current = { ...state.current, generation: state.current.generation + 1, busy: false, page: null };
    setPage(null);
    setBusy(false);
    setNotice("This history changed. Scroll up to load older rows again.");
  };
  const held = state.current.page === page ? page : null;
  return {
    invalidate,
    page: held,
    busy,
    error,
    notice,
    loadOlder,
    // Older history may exist: unknown until the first page, then what the server says.
    hasOlder: held ? !!(held.hasOlder && held.nextCursor) : true,
    inFlight: () => state.current.busy,
  };
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
