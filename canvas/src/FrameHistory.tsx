import { TLDRAW_LICENSE_KEY } from "./tldraw-license";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Box, type Editor, type TLAnyShapeUtilConstructor, type TLFrameShape, type TLShapeId, TldrawImage, useValue } from "tldraw";
import { agentStore } from "./agents";
import { api } from "./api";
import { Emoji } from "./Emoji";
import { BoardUiCtx } from "./ui";

// Frame History: a slider over the snapshots the server keeps of a frame's contents
// (server/frame-history.ts). Scrubbing draws the chosen version over the frame, read-only
// and only in this tab; "Restore this version" asks the server to put it back as a new
// change. Closing returns to the live frame.

type Kind = "start" | "human" | "agent";
interface Summary {
  id: string;
  at: number;
  kind: Kind;
  by: string | null;
  restoredFrom?: string;
  shapes: number;
}
// biome-ignore lint/suspicious/noExplicitAny: tldraw records as the server stores them.
type Rec = Record<string, any> & { id: string; typeName: string };

export const HISTORY_COLOR: Record<Kind, string> = { human: "#2f80ed", agent: "#d9480f", start: "#9e9e9e" };
// Agent edits are square, the rest round (ticks, legend, label).
const swatch = (kind: Kind): React.CSSProperties => ({ borderRadius: kind === "agent" ? 2 : 5, background: HISTORY_COLOR[kind] });

export const HistoryCtx = createContext<{ frameId: string | null; open(frameId: string): void; close(): void }>({ frameId: null, open() {}, close() {} });

const btn: React.CSSProperties = { padding: "6px 10px", borderRadius: 6, border: "1px solid light-dark(#bbb, var(--bunny-line))", background: "light-dark(#f7f7f7, var(--bunny-raised))", cursor: "pointer", font: "inherit" };

// The toolbar button (FramePanel).
export function HistoryButton({ frameId, style, className }: { frameId: string; style?: React.CSSProperties; className?: string }) {
  const history = useContext(HistoryCtx);
  const on = history.frameId === frameId;
  return (
    <button type="button" className={className} style={{ ...(style ?? btn), ...(on ? { background: "light-dark(#fff4e6, hsl(34 45% 21%))", borderColor: HISTORY_COLOR.agent } : {}) }} data-testid="frame-history" title="Scrub through this frame's past versions (read-only), and restore one" onClick={() => (on ? history.close() : history.open(frameId))}>
      <Emoji name="history" /> History
    </button>
  );
}

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function who(e: Summary): string {
  if (e.kind === "start") return "Before the first recorded edit";
  if (e.kind === "agent") {
    const title = e.by ? agentStore.get(e.by)?.title : null;
    return `Agent edit · ${title || (e.by ? `agent ${e.by.slice(0, 8)}` : "agent")}`;
  }
  return e.restoredFrom ? `Restored an older version · ${e.by ?? "someone"}` : `Human edit · ${e.by ?? "someone"}`;
}

export function FrameHistoryView({ editor, boardId, frameId, shapeUtils }: { editor: Editor; boardId: string; frameId: string; shapeUtils: readonly TLAnyShapeUtilConstructor[] }) {
  const history = useContext(HistoryCtx);
  const ui = useContext(BoardUiCtx);
  const base = `/api/ui/boards/${encodeURIComponent(boardId)}/frames/${encodeURIComponent(frameId)}/history`;
  const [entries, setEntries] = useState<Summary[] | null>(null);
  // Position on the slider: an entry index, or null for "now" (the live frame).
  const [pos, setPos] = useState<number | null>(null);
  const [versions, setVersions] = useState<Record<string, Rec[]>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const frame = useValue("history-frame", () => editor.getShape(frameId as TLShapeId) as TLFrameShape | undefined, [editor, frameId]);

  const load = useCallback(async () => {
    setEntries((await api<{ entries: Summary[] }>(base)).entries);
  }, [base]);
  useEffect(() => {
    load().catch((e: Error) => setErr(e.message));
    const t = setInterval(() => void load().catch(() => undefined), 2000);
    return () => clearInterval(t);
  }, [load]);
  // The frame went away (deleted, or this tab moved board): nothing to show.
  useEffect(() => {
    if (!frame) history.close();
  }, [frame, history]);

  const n = entries?.length ?? 0;
  const at = pos ?? n;
  const entry = entries && at < n ? entries[at] : null;
  useEffect(() => {
    if (!entry || versions[entry.id]) return;
    api<{ records: Rec[] }>(`${base}/${entry.id}`)
      .then((v) => setVersions((all) => ({ ...all, [entry.id]: v.records })))
      .catch((e: Error) => setErr(e.message));
  }, [entry, base, versions]);

  const restore = async () => {
    if (!entry || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ restored: number; removed: number; skipped: string[] }>(`${base}/${entry.id}/restore`, { method: "POST", body: JSON.stringify({ by: window.__board?.userName ?? "User" }) });
      ui.toast(`Restored the version from ${clock(entry.at)} as a new change${r.skipped.length ? ` (${r.skipped.length} shape${r.skipped.length === 1 ? "" : "s"} now outside the frame left where they are)` : ""}.`);
      await load();
      setPos(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!frame) return null;
  const records = entry ? versions[entry.id] : undefined;
  return (
    <>
      {entry ? <VersionOverlay editor={editor} frame={frame} records={records} entry={entry} shapeUtils={shapeUtils} /> : null}
      <div
        data-testid="history-bar"
        style={{ position: "absolute", left: "50%", bottom: 64, transform: "translateX(-50%)", width: "min(640px, 94vw)", pointerEvents: "all", background: "light-dark(white, var(--bunny-surface))", border: "1px solid light-dark(#ddd, var(--bunny-line))", borderRadius: 10, boxShadow: "0 4px 18px rgba(0,0,0,0.14)", padding: "10px 12px", font: "13px system-ui, sans-serif", zIndex: 310, display: "flex", flexDirection: "column", gap: 6 }}
        onPointerDown={(e) => e.stopPropagation()}
        // Arrow keys move the slider here, not the selected shapes.
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <b>History · {frame.props.name || "Frame"}</b>
          <span style={{ color: "light-dark(#888, var(--bunny-muted))" }}>{n} version{n === 1 ? "" : "s"}</span>
          <span style={{ flex: 1 }} />
          <Legend kind="human" label="Human" />
          <Legend kind="agent" label="Agent" />
          <Legend kind="start" label="Start" />
          <button type="button" style={btn} data-testid="history-close" onClick={() => history.close()}>
            Close
          </button>
        </div>
        <div style={{ position: "relative", padding: "0 6px" }}>
          <input
            type="range"
            aria-label="Frame version"
            data-testid="history-slider"
            min={0}
            max={n}
            step={1}
            value={Math.min(at, n)}
            disabled={!n}
            onChange={(e) => {
              const v = Number(e.target.value);
              setPos(v >= n ? null : v);
            }}
            style={{ width: "100%", margin: 0 }}
          />
          <div style={{ position: "relative", height: 14 }}>
            {entries?.map((e, i) => (
              <button
                type="button"
                key={e.id}
                data-testid="history-tick"
                data-kind={e.kind}
                title={`${clock(e.at)} · ${who(e)}`}
                onClick={() => setPos(i)}
                style={{ position: "absolute", left: `calc(${(i / Math.max(1, n)) * 100}% - 5px)`, top: 2, width: 10, height: 10, padding: 0, ...swatch(e.kind), border: i === at ? "2px solid light-dark(#222, var(--bunny-line))" : "1px solid light-dark(white, var(--bunny-line))", cursor: "pointer" }}
              />
            ))}
            <span style={{ position: "absolute", right: -2, top: 0, fontSize: 11, color: at >= n ? "light-dark(#222, var(--bunny-ink))" : "light-dark(#999, var(--bunny-muted))", fontWeight: at >= n ? 600 : 400 }}>now</span>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 30 }}>
          {entry ? (
            <>
              <span data-testid="history-label">
                <span style={{ display: "inline-block", width: 9, height: 9, ...swatch(entry.kind), marginRight: 6 }} />
                v{at + 1} · {clock(entry.at)} · {who(entry)} · <i>read-only</i>
              </span>
              <span style={{ flex: 1 }} />
              <button type="button" style={{ ...btn, background: "#2f80ed", color: "white", borderColor: "light-dark(#2f80ed, hsl(214 35% 39%))" }} data-testid="history-restore" disabled={busy || !records} onClick={() => void restore()}>
                {busy ? "Restoring…" : "Restore this version"}
              </button>
            </>
          ) : (
            <span data-testid="history-label" style={{ color: "light-dark(#555, var(--bunny-muted))" }}>
              {n ? "Now: the live frame. Drag the slider back to see an earlier version." : "No versions yet: edits in this frame are recorded as they settle."}
            </span>
          )}
          {err ? <span style={{ color: "light-dark(#c00, hsl(0 88% 74%))" }}>{err}</span> : null}
        </div>
      </div>
    </>
  );
}

function Legend({ kind, label }: { kind: Kind; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "light-dark(#555, var(--bunny-muted))" }}>
      <span style={{ width: 9, height: 9, ...swatch(kind) }} />
      {label}
    </span>
  );
}

// The chosen version drawn over the live frame (covering it), in this tab only. The frame
// sits at the live frame's position; its size is the version's.
function VersionOverlay({ editor, frame, records, entry, shapeUtils }: { editor: Editor; frame: TLFrameShape; records: Rec[] | undefined; entry: Summary; shapeUtils: readonly TLAnyShapeUtilConstructor[] }) {
  const darkMode = useValue("history-theme", () => editor.user.getIsDarkMode(), [editor]);
  const old = records?.find((r) => r.id === frame.id);
  const w = (old?.props.w as number | undefined) ?? frame.props.w;
  const h = (old?.props.h as number | undefined) ?? frame.props.h;
  const rect = useValue(
    "history-overlay-rect",
    () => {
      const b = editor.getShapePageBounds(frame.id);
      if (!b) return null;
      const tl = editor.pageToViewport({ x: b.x, y: b.y });
      return { x: tl.x, y: tl.y, z: editor.getZoomLevel(), lw: b.w, lh: b.h };
    },
    [editor, frame.id],
  );
  const snapshot = useMemo(() => {
    if (!records || !old) return null;
    const store: Record<string, Rec> = {
      "document:document": { id: "document:document", typeName: "document", gridSize: 10, name: "", meta: {} },
      "page:history": { id: "page:history", typeName: "page", name: "History", index: "a1", meta: {} },
    };
    for (const r of records) store[r.id] = r;
    store[old.id] = { ...old, parentId: "page:history", x: 0, y: 0, rotation: 0 };
    return { store, schema: editor.store.schema.serialize() };
  }, [records, old, editor]);
  const bounds = useMemo(() => new Box(0, 0, w, h), [w, h]);
  const lastGood = useRef<React.ReactNode>(null);
  if (!rect) return null;
  const image = snapshot ? <TldrawImage key={entry.id} licenseKey={TLDRAW_LICENSE_KEY} snapshot={snapshot as never} shapeUtils={shapeUtils} pageId={"page:history" as never} darkMode={darkMode} bounds={bounds} padding={0} background /> : lastGood.current;
  if (snapshot) lastGood.current = image;
  return (
    <div
      data-testid="history-overlay"
      data-version={entry.id}
      onPointerDown={(e) => e.stopPropagation()}
      style={{ position: "absolute", left: rect.x, top: rect.y, width: Math.max(w, rect.lw) * rect.z, height: Math.max(h, rect.lh) * rect.z, pointerEvents: "all", background: "light-dark(#fbfaf7, var(--bunny-surface))", zIndex: 5, outline: `2px dashed ${HISTORY_COLOR[entry.kind]}`, outlineOffset: 2 }}
    >
      <div style={{ position: "absolute", left: 0, top: 0, width: w * rect.z, height: h * rect.z }}>{image}</div>
      <div style={{ position: "absolute", left: 6, bottom: 6, background: HISTORY_COLOR[entry.kind], color: "white", borderRadius: 6, padding: "2px 8px", font: "600 12px system-ui, sans-serif", whiteSpace: "nowrap" }}>
        Read-only · {clock(entry.at)}
      </div>
    </div>
  );
}
