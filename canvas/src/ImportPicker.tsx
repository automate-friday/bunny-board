// Import picker: find existing Paseo conversations and put them on the board.
// Search (title or workspace name), status and scope filters, multi-select, keyboard
// (type to search, arrows, Enter selects, ⌘/Ctrl+Enter imports, Esc closes). Data comes
// from /api/ui/agents/list, which searches a short server-side cache.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { STATUS_DOT } from "./agents";
import { readDirectoryPage, useDirectoryPages } from "./useDirectoryPages";
import { api } from "./api";
import { useNarrow } from "./BoardControls";
import { boardInfo } from "./info";
import { isTouchDevice } from "./locks";
import { Emoji } from "./Emoji";

export type PickerTarget = { kind: "grid"; at: { x: number; y: number } | null } | { kind: "frame"; frameId: string; frameName: string };

export interface PickerRow {
  id: string;
  title: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  provider: string;
  model: string | null;
  status: string;
  attention: string | null;
  needsAttention: boolean;
  lastActivityAt: string;
  archived: boolean;
  bound: { boardId: string; frameId: string } | null;
  // Another Mac's agent (af-network host), from the "Other Macs" source.
  host?: string | null;
}

export interface ListResponse {
  rows: PickerRow[];
  total: number;
  matched: number;
  ms: number;
  routeMs: number;
  stale: boolean;
  scope: string;
  boardWorkspaceId: string | null;
  truncated?: boolean;
  source?: string;
  disabled?: boolean;
  errors?: Record<string, string>;
  cacheAgeMs?: number | null;
  hasSnapshot?: boolean;
  directoryState?: "asking" | "ready" | "partial" | "error" | "disabled";
  refreshing?: boolean;
  retryAfterMs?: number | null;
  message?: string;
}

export interface ImportResponse {
  boardId: string;
  created: Array<{ agentId: string; frameId: string; cardId: string | null; title: string; url: string }>;
  skipped: Array<{ agentId: string; reason: string; boardId?: string; frameId?: string }>;
  url: string | null;
}

const STATUS_FILTERS = [
  { id: "running", label: "Running" },
  { id: "idle", label: "Idle" },
  { id: "attention", label: "Needs attention" },
] as const;

const STATUS_WORD: Record<string, string> = { running: "working", idle: "idle", "needs-permission": "needs permission", error: "error", archived: "archived" };

export function relTime(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d} d ago` : new Date(iso).toLocaleDateString();
}

const newRequestId = () => `imp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const chip = (on: boolean): React.CSSProperties => ({
  padding: "3px 9px",
  borderRadius: 999,
  border: `1px solid ${on ? "light-dark(#2f80ed, hsl(214 35% 39%))" : "light-dark(#ccc, var(--bunny-line))"}`,
  background: on ? "light-dark(#eef4ff, var(--bunny-raised))" : "light-dark(#fff, var(--bunny-surface))",
  color: on ? "light-dark(#1d5fbf, hsl(216 74% 74%))" : "light-dark(#444, var(--bunny-ink))",
  cursor: "pointer",
  font: "12px system-ui, sans-serif",
  whiteSpace: "nowrap",
  flexShrink: 0,
});

export function ImportPicker({
  boardId,
  target,
  onClose,
  onDone,
  onShowFrame,
  measure,
}: {
  measure: () => Array<{ x: number; y: number; w: number; h: number }>;
  boardId: string;
  target: PickerTarget;
  onClose: () => void;
  onDone: (result: ImportResponse) => void;
  onShowFrame: (frameId: string) => void;
}) {
  const single = target.kind === "frame";
  const narrow = useNarrow();
  const [source, setSource] = useState<"local" | "remote">("local");
  const [remoteOn, setRemoteOn] = useState(false);
  const [scanAvailable, setScanAvailable] = useState(false);
  useEffect(() => {
    void boardInfo()
      .then((i) => {setRemoteOn(!!(i as { remote?: boolean }).remote);setScanAvailable(!!i.capabilities?.directoryCursorScan);})
      .catch(() => undefined);
  }, []);
  const [q, setQ] = useState("");
  const [statuses, setStatuses] = useState<Set<string>>(new Set());
  const [scope, setScope] = useState<"all" | "board">("all");
  const [includeBound, setIncludeBound] = useState(false);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hi, setHi] = useState(0);
  const [selected, setSelected] = useState<Map<string, PickerRow>>(new Map());
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const requestId = useRef(newRequestId());
  const destinationPage = useRef(window.__editor?.getCurrentPageId() ?? null);
  const placement = useRef<Array<{ x: number; y: number; w: number; h: number }> | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const query = useMemo(() => {
    const sp = new URLSearchParams({ board: boardId, scope, limit: "200" });
    if (q.trim()) sp.set("q", q.trim());
    if (statuses.size) sp.set("status", [...statuses].join(","));
    if (includeBound) sp.set("bound", "1");
    if (includeArchived && source === "local") sp.set("archived", "1");
    if (source === "remote") sp.set("source", "remote");
    return sp.toString();
  }, [boardId, q, statuses, scope, includeBound, includeArchived, source]);

  const directory = useDirectoryPages(query, source === "remote");
  const { data, loading } = directory;
  const rows = data?.rows ?? [];
  const asking = source === "remote" && data?.directoryState === "asking";
  const firstSnapshotPending = source === "remote" && data?.hasSnapshot === false;
  const remoteFailed = source === "remote" && (data?.directoryState === "error" || data?.directoryState === "partial");
  useEffect(() => { setHi(0); setErr(null); }, [query]);

  useEffect(() => {
    setHi((h) => Math.min(h, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  // Phones: no autofocus (the keyboard would cover half the sheet).
  useEffect(() => {
    if (!isTouchDevice()) input.current?.focus();
  }, []);

  useEffect(() => {
    list.current?.querySelector(`[data-index="${hi}"]`)?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  const selectable = (r: PickerRow | undefined) => !!r && !r.bound;

  const toggle = useCallback(
    (r: PickerRow) => {
      if (!selectable(r)) return;
      setSelected((cur) => {
        const next = new Map(cur);
        if (next.has(r.id)) next.delete(r.id);
        else next.set(r.id, r);
        return next;
      });
    },
    [],
  );

  const submit = useCallback(
    async (ids: string[]) => {
      if (!ids.length || submitting.current) return;
      submitting.current = true;
      setBusy(true);
      setErr(null);
      let attempted = false;
      try {
        const editor = window.__editor;
        const pageId = destinationPage.current;
        if (!editor || !pageId || !editor.getPages().some(page => page.id === pageId)) throw Error("Destination page was deleted. Close this picker and choose a page.");
        if (target.kind === "grid" && !placement.current) {
          if (editor.getCurrentPageId() !== pageId) throw Error("Return to the destination page before importing, or close this picker and reopen on this page.");
          placement.current = measure();
        }
        // One request per machine: this Mac's agents, and each other Mac's (af-network host).
        const groups = new Map<string, string[]>();
        for (const id of ids) {
          const h = selected.get(id)?.host ?? rows.find((r) => r.id === id)?.host ?? "";
          groups.set(h, [...(groups.get(h) ?? []), id]);
        }
        const all: ImportResponse = { boardId, created: [], skipped: [], url: null };
        for (const [h, group] of groups) {
          const body = {
            agentIds: group,
            pageId,
            requestId: `${requestId.current}${h ? `-${h}` : ""}`,
            by: window.__board?.userName,
            ...(h ? { host: h } : {}),
            ...(target.kind === "frame" ? { frameId: target.frameId } : { at: target.at, occupied: placement.current ?? [] }),
          };
          attempted = true;
          const res = await api<ImportResponse>(`/api/ui/boards/${encodeURIComponent(boardId)}/import`, { method: "POST", body: JSON.stringify(body) });
          all.created.push(...res.created);
          all.skipped.push(...res.skipped);
          all.url ??= res.url;
        }
        requestId.current = newRequestId();
        onDone(all);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        submitting.current = false;
        setBusy(false);
        // Read immediately even if onDone closed/unmounted the picker. Imports may
        // have partly succeeded; the server invalidates its directory on success.
        if (attempted) { void readDirectoryPage(query).catch(() => undefined); directory.refresh(); }
      }
    },
    [boardId, target, onDone, measure, selected, rows, query, directory.refresh],
  );

  const importSelection = () => {
    const ids = selected.size ? [...selected.keys()] : selectable(rows[hi]) ? [rows[hi].id] : [];
    void submit(ids);
  };

  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if ((e.target as HTMLElement).closest("button, a")) {
      return;
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (hi >= rows.length - 1 && data && !directory.ended) {
        void directory.loadMore();
      } else setHi((h) => Math.max(0, Math.min(rows.length - 1, h + 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (single || e.metaKey || e.ctrlKey) importSelection();
      else if (rows[hi]) toggle(rows[hi]);
    }
  };

  const flip = (id: string) =>
    setStatuses((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const count = selected.size;

  return (
    <div
      data-testid="import-picker-backdrop"
      onPointerDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={onKey}
      onWheel={(e) => e.stopPropagation()}
      style={{ position: "fixed", inset: 0, background: "light-dark(rgba(20,24,32,0.28), color-mix(in srgb, #2b303b 28%, transparent))", zIndex: 1000, display: "flex", justifyContent: "center", alignItems: narrow ? "flex-end" : "flex-start", font: narrow ? "14px system-ui, sans-serif" : "13px system-ui, sans-serif" }}
    >
      <div
        data-testid="import-picker"
        role="dialog"
        aria-label={single ? "Use a conversation in this frame" : "Import conversations"}
        style={{
          marginTop: narrow ? 0 : 64,
          width: narrow ? "100%" : "min(760px, 96vw)",
          // Phones: a bottom sheet that never runs under Safari's bars (dvh), with the
          // list as the only scrolling part.
          height: narrow ? "86dvh" : undefined,
          maxHeight: narrow ? "86dvh" : "min(78vh, 760px)",
          background: "light-dark(#fff, var(--bunny-surface))",
          borderRadius: narrow ? "16px 16px 0 0" : 12,
          boxShadow: "0 12px 40px rgba(0,0,0,0.22)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          color: "light-dark(#222, var(--bunny-ink))",
        }}
      >
        <div style={{ padding: narrow ? "6px 12px 8px" : "12px 14px 8px", borderBottom: "1px solid light-dark(#eee, var(--bunny-line))", display: "flex", flexDirection: "column", gap: 8, flexShrink: 0 }}>
          {narrow ? <span style={{ alignSelf: "center", width: 44, height: 5, borderRadius: 3, background: "light-dark(#ccc, var(--bunny-raised))" }} /> : null}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <b style={{ fontSize: 15, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{single ? `Use a conversation in "${target.frameName || "this frame"}"` : narrow ? "Import conversations" : "Import conversations onto the board"}</b>
            <button type="button" onClick={onClose} aria-label="Close" style={{ border: "none", background: "none", fontSize: 20, cursor: "pointer", color: "light-dark(#666, var(--bunny-muted))" }}>
              ×
            </button>
          </div>
          <div data-testid="picker-purpose" style={{fontSize:12,lineHeight:1.4}}>{single ? "Bind this existing frame to one conversation. Its agent receives frame changes and your replies; no new frame is created. This is not a card-only link." : "Create a bound frame for each selected conversation. Use this to bring existing conversations onto the board; their agents receive frame changes and replies."}</div>
          {source === "remote" ? <div data-testid="picker-host-purpose" style={{fontSize:12}}>Other Macs: import existing conversations only. Starting a new conversation runs on this board's Mac.</div> : null}
          <input
            ref={input}
            data-testid="import-search"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setHi(0);
            }}
            placeholder={source === "remote" ? "Search other Macs' conversations…" : "Search by title or workspace…"}
            // 16 px: iOS zooms the whole page into smaller inputs on focus.
            style={{ padding: narrow ? "10px 12px" : "8px 10px", fontSize: narrow ? 16 : 14, border: "1px solid light-dark(#ccc, var(--bunny-line))", borderRadius: 8, outline: "none", minWidth: 0 }}
          />
          {remoteOn && !single ? (
            <div style={{ display: "flex", gap: 6 }} data-testid="import-source">
              <button type="button" data-testid="source-local" style={chip(source === "local")} onClick={() => (setSource("local"), setSelected(new Map()), setHi(0))}>
                This Mac
              </button>
              <button type="button" data-testid="source-remote" style={chip(source === "remote")} onClick={() => (setSource("remote"), setSelected(new Map()), setHi(0))} title="Conversations on your other Macs, listed with af-network over the Paseo relay (cached for a minute)">
                Other Macs
              </button>
            </div>
          ) : null}
          <div style={{ display: "flex", flexWrap: narrow ? "nowrap" : "wrap", overflowX: narrow ? "auto" : undefined, gap: 6, alignItems: "center", paddingBottom: narrow ? 2 : 0 }}>
            {STATUS_FILTERS.map((f) => (
              <button key={f.id} type="button" data-testid={`filter-${f.id}`} style={chip(statuses.has(f.id))} onClick={() => flip(f.id)}>
                {f.label}
              </button>
            ))}
            {source === "remote" ? null : <><span style={{ width: 1, height: 18, background: "light-dark(#ddd, var(--bunny-raised))", margin: "0 2px", flexShrink: 0 }} />
            <button type="button" data-testid="scope-board" style={chip(scope === "board")} onClick={() => setScope("board")} title="Agents in this board's Paseo workspace">
              This board's workspace
            </button>
            <button type="button" data-testid="scope-all" style={chip(scope === "all")} onClick={() => setScope("all")}>
              All
            </button></>}
            <span style={{ width: 1, height: 18, background: "light-dark(#ddd, var(--bunny-raised))", margin: "0 2px" }} />
            <label style={{ display: "inline-flex", gap: 4, alignItems: "center", color: "light-dark(#555, var(--bunny-muted))", fontSize: 12, whiteSpace: "nowrap" }}>
              <input type="checkbox" data-testid="toggle-bound" style={{ flexShrink: 0 }} checked={includeBound} onChange={(e) => setIncludeBound(e.target.checked)} /> on a board
            </label>
            {source === "remote" ? null : (
              <label style={{ display: "inline-flex", gap: 4, alignItems: "center", color: "light-dark(#555, var(--bunny-muted))", fontSize: 12, whiteSpace: "nowrap" }}>
                <input type="checkbox" data-testid="toggle-archived" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} /> archived
              </label>
            )}
          </div>
        </div>
        <div data-testid="picker-source-status" style={{ padding: "6px 14px", fontSize: 11, color: "light-dark(#666, var(--bunny-muted))" }}>{source === "remote" ? "Remote directory · cached relay status; message-only history coverage." : `Local directory · this host${remoteOn ? " · other Macs available in source switch" : " · other Macs disabled in board settings"}.`}</div>
        {data && !firstSnapshotPending ? <div data-testid="picker-updated" style={{ padding: "0 14px 6px", fontSize: 11, color: "light-dark(#666, var(--bunny-muted))" }}>{directory.updatedSeconds === null ? "Update age unavailable" : `${directory.scan ? "Preview updated" : "Updated"} ${directory.updatedSeconds} s ago`}{directory.refreshing && !asking ? " · refreshing server cache…" : ""}</div> : null}
        <div ref={list} data-testid="import-list" data-directory-query={data ? query : undefined} style={{ flex: 1, overflowY: "auto", minHeight: 120, overscrollBehavior: "contain", WebkitOverflowScrolling: "touch", touchAction: "pan-y" } as React.CSSProperties}>
          {loading && !data ? <div data-testid="picker-loading" style={{ padding: 16, color: "light-dark(#888, var(--bunny-muted))" }}>Loading conversations…</div> : null}
          {directory.slow && !data ? <div data-testid="picker-waiting" role="status" style={{ padding: 16, color: "light-dark(#886000, hsl(42 88% 74%))" }}>No conversations received yet for this filter. The directory is still responding; results will appear here. <button type="button" onClick={directory.refresh}>Retry now</button></div> : null}
          {source === "remote" && !directory.error && (!data || asking) ? <div data-testid="remote-directory-pending" role="status" style={{ padding: 16, color: "light-dark(#886000, hsl(42 88% 74%))" }}>Still asking the other Macs…{rows.length ? firstSnapshotPending ? " Conversations received so far are available." : " Cached conversations remain available." : " Conversations will appear when a snapshot arrives."}</div> : null}
          {source === "remote" && data?.directoryState === "disabled" ? <div role="status" style={{ padding: 16 }}>Other Macs are disabled in board settings.</div> : null}
          {source === "remote" && data?.errors && Object.keys(data.errors).length ? (
            <div data-testid="remote-errors" style={{ padding: "8px 14px", color: "light-dark(#b35c00, hsl(31 88% 74%))", fontSize: 12 }}>
              {Object.entries(data.errors).map(([h, e]) => `${h}: ${e}`).join(" · ")} {!asking ? <button type="button" onClick={directory.retry}>Retry other Macs</button> : null}
            </div>
          ) : null}
          {data && !rows.length && !asking && !firstSnapshotPending && !remoteFailed && data.directoryState !== "disabled" ? (
            <div data-testid="picker-empty" style={{ padding: 16, color: "light-dark(#888, var(--bunny-muted))" }}>
              {scope === "board" && !data.boardWorkspaceId ? "This board has no Paseo workspace yet (it gets one with its first started conversation)." : directory.scan && !directory.ended ? "No matches loaded yet. Continue scanning later pages." : "No conversations match."}
            </div>
          ) : null}
          {data?.stale && !asking && rows.length > 0 ? <div role="status" style={{ padding: "8px 14px", color: "light-dark(#9c4b00, hsl(29 88% 74%))" }}>Cached results; {directory.refreshing ? "refresh pending" : "use Refresh list to check again"}.</div> : null}
          {rows.map((r, i) => {
            const on = selected.has(r.id);
            const can = selectable(r);
            const dot = STATUS_DOT[r.status] ?? "#ccc";
            return (
              <div
                key={r.id}
                data-index={i}
                data-testid="import-row"
                data-agent-id={r.id}
                data-picker-agent-id={r.id}
                data-selected={on ? "1" : "0"}
                onPointerEnter={() => setHi(i)}
                onClick={() => (single ? can && void submit([r.id]) : toggle(r))}
                style={{
                  display: "flex",
                  gap: 10,
                  alignItems: "center",
                  padding: narrow ? "11px 12px" : "8px 14px",
                  cursor: can ? "pointer" : "default",
                  background: i === hi ? "light-dark(#f3f7fd, var(--bunny-surface))" : on ? "light-dark(#f8fbff, var(--bunny-surface))" : "light-dark(#fff, var(--bunny-surface))",
                  borderLeft: `3px solid ${on ? "light-dark(#2f80ed, hsl(214 35% 39%))" : "transparent"}`,
                  opacity: can ? 1 : 0.6,
                }}
              >
                {single ? null : <input type="checkbox" checked={on} disabled={!can} readOnly tabIndex={-1} style={{ pointerEvents: "none" }} />}
                <span title={STATUS_WORD[r.status] ?? r.status} style={{ width: 9, height: 9, borderRadius: 5, background: dot, flexShrink: 0 }} />
                {r.host ? (
                  <span data-testid="host-badge" style={{ flexShrink: 0, font: "600 10px system-ui, sans-serif", color: "#fff", background: "#7b5ea7", borderRadius: 4, padding: "2px 5px" }} title={`Runs on ${r.host}`}>
                    {r.host}
                  </span>
                ) : null}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div data-testid="import-row-title" style={{ fontWeight: 600, whiteSpace: "normal", overflowWrap: "anywhere" }}>
                    {r.title || `agent ${r.id.slice(0, 8)}`}
                  </div>
                  <div style={{ color: "light-dark(#777, var(--bunny-muted))", fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {r.host ? `Remote · ${r.host}` : "Local · this host"} · {r.workspaceName ?? "no workspace"} · {r.model ? `${r.provider}/${r.model}` : r.provider} · {STATUS_WORD[r.status] ?? r.status}
                    {r.needsAttention && r.status === "idle" ? ` · ${r.attention === "finished" ? "unread reply" : (r.attention ?? "attention")}` : ""} · {relTime(r.lastActivityAt)}
                    {r.archived ? " · archived" : ""}
                  </div>
                </div>
                {r.bound ? (
                  r.bound.boardId === boardId ? (
                    <button
                      type="button"
                      style={chip(false)}
                      onClick={(e) => {
                        e.stopPropagation();
                        onShowFrame(r.bound!.frameId);
                      }}
                    >
                      On this board · show
                    </button>
                  ) : (
                    <a href={`/?board=${encodeURIComponent(r.bound.boardId)}&frame=${encodeURIComponent(r.bound.frameId)}`} onClick={(e) => e.stopPropagation()} style={{ ...chip(false), textDecoration: "none" }}>
                      On board {r.bound.boardId} <Emoji name="open" />
                    </a>
                  )
                ) : null}
              </div>
            );
          })}
          {data && !directory.ended && !firstSnapshotPending ? <button type="button" data-testid="picker-load-more" disabled={directory.moreBusy || asking} onClick={() => void directory.loadMore()} style={{ ...chip(false), margin: 12 }}>{directory.moreBusy ? "Loading older matches…" : directory.scan ? "Scan next page (up to 200 conversations)" : "Load next 200 matches"}</button> : null}
          {directory.error ? <div role="alert" data-testid="picker-page-error" style={{ padding: 12, color: "light-dark(#b00, hsl(0 88% 74%))" }}>{source === "remote" ? "Remote directory check stopped. Retry to check again. " : ""}{directory.error} <button type="button" onClick={directory.retry}>Retry</button></div> : null}
          {data && scanAvailable && source === "local" && !directory.scan ? <button type="button" data-testid="picker-scan" disabled={directory.moreBusy} onClick={() => void directory.startScan()} style={{...chip(false),margin:12}}>Scan full directory beyond cached results</button> : null}
          {directory.scan ? <div data-testid="picker-scan-status" style={{padding:12}}>Native scan: {directory.scanned} examined · {rows.length} unique matches loaded · {directory.ended ? "scan complete" : "more pages may contain matches"}. Total unknown; page order is not a global sort. Previously loaded preview rows retained.</div> : null}
          {data?.truncated ? <div data-testid="picker-server-cap" style={{ padding: 12, color: "light-dark(#9c4b00, hsl(29 88% 74%))" }}>Directory refresh reached its 10,000-row bound. Counts cover that cached prefix; older uncached work remains in Paseo.</div> : null}
          {data && !directory.scan && directory.ended && rows.length < data.matched ? <div style={{ padding: 12 }}>Matches moved while paging. Refresh to reconcile the list.</div> : null}
          {data ? <div style={{ padding: 12, fontSize: 11, color: "light-dark(#666, var(--bunny-muted))" }}>{directory.scan ? "Live pages can shift as conversations change." : "Recent-first cached pages. New activity can shift page boundaries."} <button type="button" data-testid="picker-refresh" onClick={directory.refresh}>Refresh list</button></div> : null}

        </div>
        <div style={{ padding: narrow ? "8px 12px calc(10px + env(safe-area-inset-bottom))" : "10px 14px", borderTop: "1px solid light-dark(#eee, var(--bunny-line))", display: "flex", alignItems: "center", gap: narrow ? 8 : 10, flexWrap: "wrap", flexShrink: 0 }}>
          <span data-testid="import-count" style={{ color: "light-dark(#666, var(--bunny-muted))", fontSize: 12, flex: 1, minWidth: narrow ? 0 : 200 }}>
            {data ? firstSnapshotPending ? "Waiting for the first remote snapshot" : directory.scan ? `${rows.length} loaded · total unknown` : `${data.matched} of ${data.total} conversation${data.total === 1 ? "" : "s"}${data.matched > rows.length ? ` (first ${rows.length} shown)` : ""}` : ""}
            {single ? "" : ` · ${count} selected`}
            {narrow ? "" : single ? " · ↑↓ Enter to link · Esc" : " · ↑↓ Enter selects · ⌘↵ imports · Esc"}
          </span>
          {err ? (
            <span data-testid="import-error" style={{ color: "light-dark(#c00, hsl(0 88% 74%))", fontSize: 12 }}>
              {err}
            </span>
          ) : null}
          {single ? null : (
            <>
              {count ? (
                <button type="button" style={chip(false)} onClick={() => setSelected(new Map())}>
                  Clear
                </button>
              ) : null}
              <button
                type="button"
                data-testid="import-go"
                disabled={busy || !count}
                onClick={importSelection}
                style={{ padding: narrow ? "13px 14px" : "7px 14px", width: narrow ? "100%" : undefined, borderRadius: narrow ? 10 : 8, border: "1px solid light-dark(#2f80ed, hsl(214 35% 39%))", background: busy || !count ? "light-dark(#9bbcf0, hsl(217 45% 21%))" : "#2f80ed", color: "#fff", cursor: busy || !count ? "default" : "pointer", font: narrow ? "600 16px system-ui, sans-serif" : "13px system-ui, sans-serif" }}
              >
                {busy ? "Importing…" : `Import ${count || ""} ${count === 1 ? "conversation" : "conversations"}`.replace("  ", " ")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
