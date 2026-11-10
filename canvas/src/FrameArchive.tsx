import { TLDRAW_LICENSE_KEY } from "./tldraw-license";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Box, type Editor, type TLAnyShapeUtilConstructor, type TLShapeId, TldrawImage, useValue } from "tldraw";
import { api } from "./api";
import { Emoji } from "./Emoji";
import { relTime } from "./ImportPicker";
import { BoardUiCtx } from "./ui";

// Frame Archive (server/frame-archive.ts): "Archive" on a frame's context menu takes it
// and its contents off the board (Undo in the toast); the Archive panel lists archived
// frames to restore where they were or delete forever, and the clean-up proposals agents
// file with board_archive, which a person approves (all or some) in one click.

// biome-ignore lint/suspicious/noExplicitAny: tldraw records as the server stores them.
type Rec = Record<string, any> & { id: string; typeName: string };

export interface ArchivedItem {
  id: string;
  frameId: string;
  sourceFrameId?: string;
  name: string;
  archivedAt: number;
  by: string;
  proposalId?: string;
  proposedBy?: string;
  reason?: string;
  w: number;
  h: number;
  shapes: number;
  agents: string[];
}

interface Proposal {
  id: string;
  at: number;
  by: { agentId: string; frameId: string; frameName: string };
  reason: string;
  items: Array<{ frameId: string; name: string; reasons: string[] }>;
  status: "pending" | "approved" | "dismissed";
  decidedAt?: number;
  decidedBy?: string;
  archived?: number;
  skipped?: Array<{ frameId: string; why: string }>;
}

interface Summary {
  archived: number;
  pending: Array<{ id: string; count: number; by: string }>;
  rev: number;
}

export type ArchiveTab = "archived" | "proposals";

export const ArchiveCtx = createContext<{ tab: ArchiveTab | null; open(tab?: ArchiveTab): void; close(): void; archive(frameIds: string[]): void }>({
  tab: null,
  open() {},
  close() {},
  archive() {},
});

const by = () => window.__board?.userName ?? "User";
const base = (boardId: string) => `/api/ui/boards/${encodeURIComponent(boardId)}/frame-archive`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The board's archive summary, kept in the tldraw document record by the server.
export function useArchiveSummary(editor: Editor): Summary | null {
  return useValue(
    "archive-summary",
    () => {
      // biome-ignore lint/suspicious/noExplicitAny: document meta is untyped JSON.
      const s = (editor.store.get("document:document" as never) as any)?.meta?.paseoArchive;
      return s && typeof s === "object" ? (s as Summary) : null;
    },
    [editor],
  );
}

export async function archiveFrames(boardId: string, frameIds: string[]): Promise<ArchivedItem[]> {
  const r = await api<{ items: ArchivedItem[] }>(base(boardId), { method: "POST", body: JSON.stringify({ frameIds, by: by() }) });
  return r.items;
}

export async function restoreArchived(boardId: string, ids: string[]): Promise<{ restored: ArchivedItem[]; skipped: Array<{ id: string; why: string }> }> {
  return api(`${base(boardId)}/restore`, { method: "POST", body: JSON.stringify({ ids, by: by() }) });
}

function zoomTo(editor: Editor, ids: string[]): void {
  const shapes = ids.map((id) => editor.getShape(id as TLShapeId)).filter((s) => !!s);
  if (!shapes.length) return;
  editor.select(...shapes.map((s) => s!.id));
  const bounds = shapes.map((s) => editor.getShapePageBounds(s!.id)).filter((b): b is Box => !!b);
  if (bounds.length) editor.zoomToBounds(Box.Common(bounds), { animation: { duration: 300 }, inset: 80 });
}

const btn: React.CSSProperties = { padding: "5px 10px", borderRadius: 6, border: "1px solid light-dark(#bbb, var(--bunny-line))", background: "light-dark(#f7f7f7, var(--bunny-raised))", cursor: "pointer", font: "inherit", whiteSpace: "nowrap" };
const primary: React.CSSProperties = { ...btn, background: "#2f80ed", borderColor: "light-dark(#2f80ed, hsl(214 35% 39%))", color: "white" };
const danger: React.CSSProperties = { ...btn, background: "light-dark(#fff, var(--bunny-surface))", borderColor: "light-dark(#e03131, hsl(0 35% 39%))", color: "light-dark(#c92a2a, hsl(0 65% 74%))" };
const chip: React.CSSProperties = { display: "inline-block", padding: "1px 7px", borderRadius: 10, background: "light-dark(#f1f3f5, var(--bunny-raised))", color: "light-dark(#495057, var(--bunny-muted))", fontSize: 11, marginRight: 4, marginTop: 3 };

// Archive's place in the Board menu (BoardMenu.tsx), not the header: one row with the
// archived count and how many frames wait in agents' clean-up proposals.
export function ArchiveMenuItem({ editor, onOpen }: { editor: Editor; onOpen(): void }) {
  const ctx = useContext(ArchiveCtx);
  const summary = useArchiveSummary(editor);
  const pending = summary?.pending.reduce((n, p) => n + p.count, 0) ?? 0;
  return (
    <button
      type="button"
      data-testid="archive-open"
      title="Archived frames, and clean-up proposals from agents"
      style={{ ...btn, width: "100%", minHeight: 40, display: "flex", alignItems: "center", gap: 6, textAlign: "left" }}
      onClick={() => {
        onOpen();
        ctx.open(pending ? "proposals" : "archived");
      }}
    >
      <Emoji name="archive" />
      <span style={{ flex: 1 }}>Archive{summary?.archived ? ` · ${summary.archived} frame${summary.archived === 1 ? "" : "s"}` : ""}</span>
      {pending ? (
        <span data-testid="archive-pending-dot" style={{ background: "#d9480f", color: "white", borderRadius: 9, fontSize: 11, padding: "0 6px", lineHeight: "18px" }}>
          {pending} to review
        </span>
      ) : null}
    </button>
  );
}

// For the Board menu's toggle: frames waiting in clean-up proposals.
export function usePendingArchive(editor: Editor): number {
  return useArchiveSummary(editor)?.pending.reduce((n, p) => n + p.count, 0) ?? 0;
}

// Top of the canvas while an agent's clean-up proposal waits for a decision.
export function ProposalBanner({ editor }: { editor: Editor }) {
  const ctx = useContext(ArchiveCtx);
  const summary = useArchiveSummary(editor);
  const p = summary?.pending[0];
  if (!p || ctx.tab === "proposals") return null;
  return (
    <div
      data-testid="proposal-banner"
      style={{ position: "absolute", top: 58, left: "50%", transform: "translateX(-50%)", zIndex: 400, pointerEvents: "all", display: "flex", gap: 10, alignItems: "center", background: "light-dark(#fff8e6, hsl(43 45% 21%))", border: "1px solid light-dark(#f0c36d, hsl(39 35% 39%))", borderRadius: 10, padding: "6px 8px 6px 12px", boxShadow: "0 2px 10px rgba(0,0,0,0.1)", font: "13px system-ui, sans-serif", maxWidth: "90vw" }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <Emoji name="broom" style={{ color: "light-dark(#b35c00, hsl(31 88% 74%))" }} />
      <span>
        <b>{p.by}</b> proposes archiving {plural(p.count, "frame")}
        {summary!.pending.length > 1 ? ` (+${summary!.pending.length - 1} more proposal${summary!.pending.length > 2 ? "s" : ""})` : ""}
      </span>
      <button type="button" style={primary} data-testid="proposal-review" onClick={() => ctx.open("proposals")}>
        Review
      </button>
    </div>
  );
}

// The archived frame drawn from its snapshot (the same renderer as History's overlay).
function Preview({ editor, boardId, item, shapeUtils }: { editor: Editor; boardId: string; item: ArchivedItem; shapeUtils: readonly TLAnyShapeUtilConstructor[] }) {
  const darkMode = useValue("archive-theme", () => editor.user.getIsDarkMode(), [editor]);
  const [records, setRecords] = useState<Rec[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<{ records: Rec[] }>(`${base(boardId)}/${item.id}`)
      .then((r) => setRecords(r.records))
      .catch((e) => setErr((e as Error).message));
  }, [boardId, item.id]);
  const snapshot = useMemo(() => {
    if (!records?.length) return null;
    const store: Record<string, Rec> = {
      "document:document": { id: "document:document", typeName: "document", gridSize: 10, name: "", meta: {} },
      "page:archive": { id: "page:archive", typeName: "page", name: "Archive", index: "a1", meta: {} },
    };
    const ids = new Set(records.filter((r) => r.typeName === "shape").map((r) => r.id));
    for (const r of records) if (r.typeName !== "binding" || (ids.has(r.fromId) && ids.has(r.toId))) store[r.id] = r;
    store[records[0].id] = { ...records[0], parentId: "page:archive", x: 0, y: 0, rotation: 0 };
    return { store, schema: editor.store.schema.serialize() };
  }, [records, editor]);
  const bounds = useMemo(() => new Box(0, 0, item.w, item.h), [item.w, item.h]);
  if (err) return <div style={{ color: "light-dark(#c92a2a, hsl(0 65% 74%))", fontSize: 12 }}>{err}</div>;
  if (!snapshot) return <div style={{ color: "light-dark(#888, var(--bunny-muted))", fontSize: 12, padding: 8 }}>Loading preview…</div>;
  return (
    <div data-testid="archive-preview" style={{ border: "1px solid light-dark(#e5e5e5, var(--bunny-line))", borderRadius: 6, overflow: "hidden", background: "light-dark(#fbfaf7, var(--bunny-surface))", aspectRatio: `${item.w} / ${item.h}`, maxHeight: 240 }}>
      <TldrawImage licenseKey={TLDRAW_LICENSE_KEY} snapshot={snapshot as never} shapeUtils={shapeUtils} pageId={"page:archive" as never} darkMode={darkMode} bounds={bounds} padding={8} background />
    </div>
  );
}

export function ArchivePanel({ editor, boardId, shapeUtils, sheet }: { editor: Editor; boardId: string; shapeUtils: readonly TLAnyShapeUtilConstructor[]; sheet: boolean }) {
  const ctx = useContext(ArchiveCtx);
  const ui = useContext(BoardUiCtx);
  const summary = useArchiveSummary(editor);
  const [items, setItems] = useState<ArchivedItem[] | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const tab = ctx.tab ?? "archived";

  const load = useCallback(() => {
    api<{ items: ArchivedItem[]; proposals: Proposal[] }>(base(boardId))
      .then((r) => {
        setItems(r.items);
        setProposals(r.proposals);
        setPicked((cur) => new Set([...cur].filter((id) => r.items.some((i) => i.id === id))));
      })
      .catch((e) => setErr((e as Error).message));
  }, [boardId]);
  useEffect(load, [load, summary?.rev]);

  const run = async (what: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await what();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      load();
    }
  };

  const restore = (ids: string[]) =>
    run(async () => {
      const r = await restoreArchived(boardId, ids);
      setPicked(new Set());
      ui.toast(`Restored ${plural(r.restored.length, "frame")}${r.skipped.length ? ` · ${r.skipped.length} skipped: ${r.skipped[0].why}` : ""}`);
      zoomTo(editor, r.restored.map((i) => i.frameId));
    });
  const purge = (ids: string[]) =>
    run(async () => {
      const r = await api<{ deleted: number }>(`${base(boardId)}/delete`, { method: "POST", body: JSON.stringify({ ids, by: by() }) });
      setPicked(new Set());
      setConfirmDelete(null);
      ui.toast(`Deleted ${plural(r.deleted, "frame")} forever`);
    });

  const q = query.trim().toLowerCase();
  const shown = (items ?? []).filter((i) => !q || i.name.toLowerCase().includes(q) || (i.proposedBy ?? "").toLowerCase().includes(q) || (i.reason ?? "").toLowerCase().includes(q));
  // One group per clean-up proposal; frames archived by hand group by the minute.
  const groups = useMemo(() => {
    const out = new Map<string, { title: string; items: ArchivedItem[] }>();
    for (const i of shown) {
      const key = i.proposalId ?? `m-${Math.floor(i.archivedAt / 60_000)}-${i.by}`;
      const title = i.proposalId ? `Clean-up proposed by ${i.proposedBy ?? "an agent"} · approved by ${i.by}` : `Archived by ${i.by}`;
      const g = out.get(key) ?? { title, items: [] };
      g.items.push(i);
      out.set(key, g);
    }
    return [...out.values()];
  }, [shown]);
  const pending = proposals.filter((p) => p.status === "pending");
  const decided = proposals.filter((p) => p.status !== "pending").slice(0, 5);
  const toggle = (ids: string[], on: boolean) =>
    setPicked((cur) => {
      const next = new Set(cur);
      for (const id of ids) on ? next.add(id) : next.delete(id);
      return next;
    });
  const pickedIds = [...picked];

  return (
    <div
      data-testid="archive-panel"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      style={{
        ...(sheet ? { position: "fixed", left: 0, right: 0, bottom: 0, height: "70vh", borderTop: "1px solid light-dark(#ddd, var(--bunny-line))" } : { width: 400, borderLeft: "1px solid light-dark(#ddd, var(--bunny-line))" }),
        background: "light-dark(white, var(--bunny-surface))",
        display: "flex",
        flexDirection: "column",
        font: "13px system-ui, sans-serif",
        zIndex: 1000,
        minHeight: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: "1px solid light-dark(#eee, var(--bunny-line))" }}>
        <Emoji name="archive" />
        <b style={{ flex: 1, fontSize: 15 }}>Archive</b>
        <button type="button" style={btn} data-testid="archive-close" onClick={ctx.close}>
          Close
        </button>
      </div>
      <div style={{ display: "flex", borderBottom: "1px solid light-dark(#eee, var(--bunny-line))" }}>
        {(["archived", "proposals"] as const).map((t) => (
          <button
            key={t}
            type="button"
            data-testid={`archive-tab-${t}`}
            onClick={() => ctx.open(t)}
            style={{ flex: 1, padding: "8px 0", border: "none", borderBottom: tab === t ? "2px solid light-dark(#2f80ed, hsl(214 35% 39%))" : "2px solid transparent", background: "none", cursor: "pointer", font: "inherit", fontWeight: tab === t ? 600 : 400 }}
          >
            {t === "archived" ? `Archived (${items?.length ?? summary?.archived ?? 0})` : `Clean-up proposals${pending.length ? ` (${pending.length})` : ""}`}
          </button>
        ))}
      </div>
      {err ? <div style={{ color: "light-dark(#c92a2a, hsl(0 65% 74%))", padding: "6px 12px" }}>{err}</div> : null}
      {tab === "archived" ? (
        <>
          <div style={{ padding: "8px 12px", display: "flex", gap: 6, alignItems: "center", borderBottom: "1px solid light-dark(#f1f1f1, var(--bunny-line))", flexWrap: "wrap" }}>
            <input data-testid="archive-search" placeholder="Search archived frames" value={query} onChange={(e) => setQuery(e.target.value)} style={{ flex: 1, minWidth: 140, padding: "5px 8px", border: "1px solid light-dark(#ccc, var(--bunny-line))", borderRadius: 6, font: "inherit" }} />
            {pickedIds.length ? (
              confirmDelete ? null : (
                <>
                  <button type="button" style={primary} disabled={busy} data-testid="archive-restore-selected" onClick={() => void restore(pickedIds)}>
                    Restore {pickedIds.length}
                  </button>
                  <button type="button" style={danger} disabled={busy} data-testid="archive-delete-selected" onClick={() => setConfirmDelete(pickedIds)}>
                    Delete…
                  </button>
                </>
              )
            ) : null}
          </div>
          {confirmDelete ? (
            <div data-testid="archive-confirm-delete" style={{ margin: "8px 12px", padding: 10, border: "1px solid light-dark(#ffc9c9, hsl(0 35% 39%))", background: "light-dark(#fff5f5, var(--bunny-surface))", borderRadius: 8 }}>
              Delete {plural(confirmDelete.length, "archived frame")} forever? Their contents and History go too. This cannot be undone.
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <button type="button" style={{ ...danger, background: "#e03131", color: "white" }} disabled={busy} data-testid="archive-confirm-delete-yes" onClick={() => void purge(confirmDelete)}>
                  Delete forever
                </button>
                <button type="button" style={btn} onClick={() => setConfirmDelete(null)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
          <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }} data-testid="archive-list">
            {items && !items.length ? (
              <div style={{ color: "light-dark(#777, var(--bunny-muted))", padding: 16, lineHeight: 1.5 }}>
                Nothing archived. Right-click a frame (or several) and choose <b>Archive</b> to take it off the board without losing it.
              </div>
            ) : null}
            {groups.map((g) => {
              const ids = g.items.map((i) => i.id);
              const all = ids.every((id) => picked.has(id));
              return (
                <div key={`${g.title}-${ids[0]}`} data-testid="archive-group" style={{ borderBottom: "1px solid light-dark(#f1f1f1, var(--bunny-line))" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 12px 4px", color: "light-dark(#555, var(--bunny-muted))", fontSize: 12 }}>
                    <input type="checkbox" checked={all} onChange={(e) => toggle(ids, e.target.checked)} title="Select this group" />
                    <span style={{ flex: 1 }}>
                      {g.title} · {relTime(new Date(g.items[0].archivedAt).toISOString())}
                    </span>
                    {g.items.length > 1 ? (
                      <button type="button" style={{ ...btn, padding: "2px 8px", fontSize: 12 }} disabled={busy} data-testid="archive-group-restore" onClick={() => void restore(ids)}>
                        Restore all {g.items.length}
                      </button>
                    ) : null}
                  </div>
                  {g.items[0].reason && g.items[0].proposalId ? <div style={{ padding: "0 12px 4px 34px", color: "light-dark(#777, var(--bunny-muted))", fontSize: 12, fontStyle: "italic" }}>“{g.items[0].reason}”</div> : null}
                  {g.items.map((i) => (
                    <div key={i.id} data-testid="archive-row" data-frame={i.frameId} style={{ padding: "6px 12px 6px 12px", background: picked.has(i.id) ? "light-dark(#f3f8ff, var(--bunny-surface))" : undefined }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <input type="checkbox" checked={picked.has(i.id)} onChange={(e) => toggle([i.id], e.target.checked)} />
                        <button type="button" onClick={() => setOpen(open === i.id ? null : i.id)} style={{ flex: 1, minWidth: 0, textAlign: "left", background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit" }} title="Show a preview">
                          <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i.name}</div>
                          <div style={{ color: "light-dark(#777, var(--bunny-muted))", fontSize: 12 }}>
                            {plural(i.shapes, "shape")}
                            {i.agents.length ? ` · had ${plural(i.agents.length, "conversation")}` : ""} · {relTime(new Date(i.archivedAt).toISOString())}
                          </div>
                        </button>
                        <button type="button" style={btn} disabled={busy} data-testid="archive-restore" onClick={() => void restore([i.id])}>
                          Restore
                        </button>
                      </div>
                      {i.sourceFrameId ? <button type="button" data-testid="archive-source-frame" style={{ ...btn, marginLeft: 24, marginTop: 4, fontSize: 12 }} title={i.sourceFrameId}
                        onClick={() => { zoomTo(editor, [i.sourceFrameId!]); ctx.close(); }}>Source frame · conversation kept</button> : null}
                      {open === i.id ? (
                        <div style={{ padding: "6px 0 2px 24px" }}>
                          <Preview editor={editor} boardId={boardId} item={i} shapeUtils={shapeUtils} />
                          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                            <button type="button" style={danger} disabled={busy} data-testid="archive-delete" onClick={() => setConfirmDelete([i.id])}>
                              Delete forever…
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
          <div style={{ padding: "6px 12px", color: "light-dark(#888, var(--bunny-muted))", fontSize: 11, borderTop: "1px solid light-dark(#eee, var(--bunny-line))" }}>Restored frames go back where they were. A frame that had a conversation comes back unbound, with Re-link.</div>
        </>
      ) : (
        <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }} data-testid="proposal-list">
          {!pending.length ? (
            <div style={{ color: "light-dark(#777, var(--bunny-muted))", padding: 16, lineHeight: 1.5 }}>
              No proposals waiting. Ask a frame's agent to tidy the board: it lists stale frames (board_archive_candidates) and proposes archiving them (board_archive). Nothing leaves the board until you approve it here.
            </div>
          ) : null}
          {pending.map((p) => (
            <ProposalCard key={p.id} p={p} editor={editor} boardId={boardId} busy={busy} run={run} />
          ))}
          {decided.length ? <div style={{ padding: "10px 12px 4px", color: "light-dark(#888, var(--bunny-muted))", fontSize: 12 }}>Earlier proposals</div> : null}
          {decided.map((p) => (
            <div key={p.id} style={{ padding: "4px 12px", color: "light-dark(#666, var(--bunny-muted))", fontSize: 12 }}>
              {p.by.frameName}: {plural(p.items.length, "frame")} ·{" "}
              {p.status === "approved" ? `approved by ${p.decidedBy}, ${p.archived ?? 0} archived${p.skipped?.length ? `, ${p.skipped.length} skipped` : ""}` : `dismissed${p.decidedBy && p.decidedBy !== "replaced by a newer proposal" ? ` by ${p.decidedBy}` : p.decidedBy ? ` (${p.decidedBy})` : ""}`} ·{" "}
              {relTime(new Date(p.decidedAt ?? p.at).toISOString())}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ProposalCard({ p, editor, boardId, busy, run }: { p: Proposal; editor: Editor; boardId: string; busy: boolean; run(what: () => Promise<void>): Promise<void> }) {
  const ui = useContext(BoardUiCtx);
  const ctx = useContext(ArchiveCtx);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(p.items.map((i) => i.frameId)));
  const decide = (decision: "approve" | "dismiss") =>
    run(async () => {
      const r = await api<{ proposal: Proposal; items: ArchivedItem[] }>(`${base(boardId)}/proposals/${p.id}`, { method: "POST", body: JSON.stringify({ decision, frameIds: [...chosen], by: by() }) });
      if (decision === "dismiss") return void ui.toast("Proposal dismissed; nothing was archived");
      const skipped = r.proposal.skipped?.length ?? 0;
      ui.toast(`Archived ${plural(r.items.length, "frame")}${skipped ? ` · ${skipped} skipped (changed since the proposal)` : ""}`, {
        label: "Undo",
        run: () => void restoreArchived(boardId, r.items.map((i) => i.id)).then((x) => ui.toast(`Restored ${plural(x.restored.length, "frame")}`)),
      });
      ctx.open("archived");
    });
  return (
    <div data-testid="proposal-card" style={{ margin: 10, border: "1px solid light-dark(#f0c36d, hsl(39 35% 39%))", background: "light-dark(#fffdf6, var(--bunny-surface))", borderRadius: 10 }}>
      <div style={{ padding: "10px 12px 6px" }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <Emoji name="broom" style={{ color: "light-dark(#b35c00, hsl(31 88% 74%))" }} />
          <b style={{ flex: 1 }}>
            {p.by.frameName} proposes archiving {plural(p.items.length, "frame")}
          </b>
          <span style={{ color: "light-dark(#888, var(--bunny-muted))", fontSize: 12 }}>{relTime(new Date(p.at).toISOString())}</span>
        </div>
        <div style={{ color: "light-dark(#555, var(--bunny-muted))", marginTop: 4, fontStyle: "italic" }}>“{p.reason}”</div>
      </div>
      <div style={{ display: "flex", gap: 6, padding: "0 12px 8px", alignItems: "center", fontSize: 12 }}>
        <label style={{ display: "flex", gap: 4, alignItems: "center", flex: 1 }}>
          <input type="checkbox" checked={chosen.size === p.items.length} onChange={(e) => setChosen(new Set(e.target.checked ? p.items.map((i) => i.frameId) : []))} />
          {chosen.size} of {p.items.length} selected
        </label>
        <button type="button" style={{ ...btn, padding: "2px 8px", fontSize: 12 }} data-testid="proposal-show" onClick={() => zoomTo(editor, [...chosen])}>
          Show on board
        </button>
      </div>
      <div style={{ maxHeight: 340, overflowY: "auto", borderTop: "1px solid light-dark(#f3e3bd, hsl(42 35% 39%))", borderBottom: "1px solid light-dark(#f3e3bd, hsl(42 35% 39%))" }}>
        {p.items.map((i) => (
          <label key={i.frameId} data-testid="proposal-item" style={{ display: "flex", gap: 6, padding: "5px 12px", alignItems: "flex-start", cursor: "pointer" }} onMouseEnter={() => editor.getShape(i.frameId as TLShapeId) && editor.setHoveredShape(i.frameId as TLShapeId)}>
            <input
              type="checkbox"
              checked={chosen.has(i.frameId)}
              onChange={(e) =>
                setChosen((cur) => {
                  const next = new Set(cur);
                  e.target.checked ? next.add(i.frameId) : next.delete(i.frameId);
                  return next;
                })
              }
            />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontWeight: 600 }}>{i.name}</span>
              <br />
              {i.reasons.map((r) => (
                <span key={r} style={chip}>
                  {r}
                </span>
              ))}
            </span>
          </label>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6, padding: 10 }}>
        <button type="button" style={primary} disabled={busy || !chosen.size} data-testid="proposal-approve" onClick={() => void decide("approve")}>
          Archive {plural(chosen.size, "frame")}
        </button>
        <button type="button" style={btn} disabled={busy} data-testid="proposal-dismiss" onClick={() => void decide("dismiss")}>
          Dismiss
        </button>
      </div>
      <div style={{ padding: "0 12px 10px", color: "light-dark(#888, var(--bunny-muted))", fontSize: 11 }}>Archived frames can be restored from the Archive tab. Frames edited after the proposal are left on the board.</div>
    </div>
  );
}
