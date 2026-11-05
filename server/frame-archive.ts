// Frame Archive: archiving a frame takes it and everything inside it off the canvas and
// keeps a snapshot here, like Figma's trash or Notion's archive. From the Archive panel a
// person restores it to where it was, or deletes it forever. Agents never archive or
// delete directly: board_archive files a clean-up proposal that the person approves (all
// or some of it) in one click, and everything an approval archives can be restored.
//
// Persisted per board under <state>/frame-archive/<board>.json. The canvas learns about
// changes from a small summary in the tldraw document record (meta.paseoArchive), the same
// way it learns about the board locks.
//
// Archiving a bound frame releases its agent like deleting the frame does (the frame
// watcher does that); the agent is not archived in Paseo. A restored frame comes back
// unbound with a "Re-link existing conversation" offer, as a restored board does.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DOCUMENT_ID } from "../shared/locks";
import type { FrameHistory } from "./frame-history";
import { absPos, ancestors, baseShape, nextIndex, isShape, type Rec, type RecMap } from "./records";
import type { BoardRoom } from "./room-host";

export const ARCHIVE_KEY = "paseoArchive";
// Most frames one archive call or proposal may name.
export const ARCHIVE_BATCH_MAX = 500;
const DAY = 86_400_000;

export interface ArchivedFrame {
  id: string;
  frameId: string;
  sourceFrameId?: string;
  name: string;
  archivedAt: number;
  // The person who archived it (or approved the proposal that did).
  by: string;
  // Set when a clean-up proposal archived it: which one, and the agent that proposed it.
  proposalId?: string;
  proposedBy?: string;
  reason?: string;
  // Where it was: its parent (the page, or a frame that stays on the board) and its
  // page-space top-left, for a restore whose parent has gone since.
  parentId: string;
  page: { x: number; y: number };
  w: number;
  h: number;
  shapes: number;
  // Agents bound to this frame or frames inside it when it was archived.
  agents: string[];
  records: Rec[];
}

export type ArchiveSummary = Omit<ArchivedFrame, "records">;

export interface ProposalItem {
  frameId: string;
  name: string;
  reasons: string[];
}

export interface CleanupProposal {
  id: string;
  at: number;
  by: { agentId: string; frameId: string; frameName: string };
  reason: string;
  items: ProposalItem[];
  status: "pending" | "approved" | "dismissed";
  decidedAt?: number;
  decidedBy?: string;
  archived?: number;
  skipped?: Array<{ frameId: string; why: string }>;
}

export interface Candidate {
  frameId: string;
  name: string;
  reasons: string[];
  lastEditAt: number | null;
  idleDays: number | null;
  shapes: number;
  agent: { id: string; status: string } | null;
}

interface BoardArchive {
  items: ArchivedFrame[];
  proposals: CleanupProposal[];
}

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });
const isFrame = (r: Rec | undefined): r is Rec => isShape(r) && r.type === "frame";

// Every shape under the frame (nested frames, bound or not, included).
export function subtree(records: RecMap, frameId: string): Rec[] {
  const out: Rec[] = [];
  for (const r of records.values()) if (isShape(r) && ancestors(records, r).includes(frameId)) out.push(r);
  return out;
}

// Records sorted so every parent comes before its children.
function byDepth(recs: Rec[], records: RecMap): Rec[] {
  const depth = (r: Rec) => ancestors(records, r).length;
  return [...recs].sort((a, b) => depth(a) - depth(b));
}

const ago = (ms: number) => {
  const d = Math.floor(ms / DAY);
  return d >= 1 ? `${d} day${d === 1 ? "" : "s"}` : `${Math.max(1, Math.floor(ms / 3_600_000))} h`;
};

export class FrameArchive {
  private readonly boards = new Map<string, BoardArchive>();
  private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private seq = 0;

  constructor(
    private readonly dir: string,
    private readonly history: FrameHistory | null,
    private readonly log: (m: string) => void = () => {},
  ) {}

  private file(boardId: string): string {
    return path.join(this.dir, `${encodeURIComponent(boardId)}.json`);
  }

  private board(boardId: string): BoardArchive {
    let b = this.boards.get(boardId);
    if (b) return b;
    b = { items: [], proposals: [] };
    const f = this.file(boardId);
    if (existsSync(f)) {
      try {
        const data = JSON.parse(readFileSync(f, "utf8")) as Partial<BoardArchive>;
        if (Array.isArray(data.items)) b.items = data.items;
        if (Array.isArray(data.proposals)) b.proposals = data.proposals;
      } catch (e) {
        const backup = `${f}.corrupt-${Date.now()}`;
        renameSync(f, backup);
        this.log(`frame archive ${boardId}: unreadable, moved to ${backup} (${(e as Error).message})`);
      }
    }
    this.boards.set(boardId, b);
    return b;
  }

  private newId(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${(++this.seq).toString(36)}`;
  }

  // --- reading ------------------------------------------------------------------------

  list(boardId: string): ArchiveSummary[] {
    return this.board(boardId)
      .items.map(({ records, ...rest }) => rest)
      .sort((a, b) => b.archivedAt - a.archivedAt);
  }

  get(boardId: string, id: string): ArchivedFrame | null {
    return this.board(boardId).items.find((i) => i.id === id) ?? null;
  }

  proposals(boardId: string): CleanupProposal[] {
    return [...this.board(boardId).proposals].sort((a, b) => b.at - a.at);
  }

  // --- archive, restore, delete forever ----------------------------------------------

  // Take the frames (and everything inside them) off the board as one server change.
  // A frame inside another frame of the same call goes with its parent. Returns the
  // archive entries and the agents whose frames went (the watcher releases them).
  archive(room: BoardRoom, frameIds: string[], opts: { by: string; reason?: string; proposalId?: string; proposedBy?: string }): { items: ArchiveSummary[]; released: Rec[] } {
    if (!frameIds.length) throw httpError(400, "no frames to archive");
    if (frameIds.length > ARCHIVE_BATCH_MAX) throw httpError(400, `at most ${ARCHIVE_BATCH_MAX} frames at a time`);
    const records = room.records;
    for (const id of frameIds) if (!isFrame(records.get(id))) throw httpError(404, `frame ${id} is not on board ${room.id}`);
    const wanted = new Set(frameIds);
    const tops = [...wanted].filter((id) => !ancestors(records, records.get(id)!).some((a) => wanted.has(a)));
    const now = Date.now();
    const entries: ArchivedFrame[] = [];
    const removeShapes: Rec[] = [];
    const released: Rec[] = [];
    for (const frameId of tops) {
      // The last burst of edits becomes its own History entry before the frame goes.
      this.history?.flush(room.id, frameId);
      const frame = records.get(frameId)!;
      const inner = subtree(records, frameId);
      const ids = new Set([frameId, ...inner.map((s) => s.id)]);
      const bindings = [...records.values()].filter((r) => r.typeName === "binding" && (ids.has(r.fromId) || ids.has(r.toId)));
      const assets = [...new Set(inner.map((s) => s.props?.assetId).filter((a): a is string => typeof a === "string"))].map((a) => records.get(a)).filter((a): a is Rec => !!a);
      const frames = [frame, ...inner.filter((s) => s.type === "frame")];
      const bound = frames.filter((f) => f.meta?.paseo?.agentId || f.meta?.paseo?.request);
      released.push(...bound);
      entries.push({
        id: this.newId("arch"),
        frameId,
        name: String(frame.props?.name || "Frame"),
        archivedAt: now,
        by: opts.by,
        ...(opts.proposalId ? { proposalId: opts.proposalId } : {}),
        ...(opts.proposedBy ? { proposedBy: opts.proposedBy } : {}),
        ...(opts.reason ? { reason: opts.reason.slice(0, 500) } : {}),
        parentId: frame.parentId,
        page: absPos(records, frame),
        w: frame.props.w,
        h: frame.props.h,
        shapes: inner.length,
        agents: bound.map((f) => f.meta?.paseo?.agentId).filter((a): a is string => typeof a === "string"),
        records: [frame, ...byDepth(inner, records), ...bindings, ...assets],
      });
      removeShapes.push(frame, ...inner);
    }
    const gone = new Set(removeShapes.map((s) => s.id));
    room.write({ kind: "server", reason: "archive" }, (ops) => {
      for (const r of room.records.values()) if (r.typeName === "binding" && (gone.has(r.fromId) || gone.has(r.toId))) ops.remove(r.id);
      // Children before parents.
      for (const s of byDepth(removeShapes, records).reverse()) ops.remove(s.id);
    });
    const board = this.board(room.id);
    board.items.push(...entries);
    this.changed(room);
    this.log(`frame archive ${room.id}: ${opts.by} archived ${entries.length} frame(s)${opts.proposalId ? ` (proposal ${opts.proposalId})` : ""}: ${entries.map((e) => e.name).join(", ")}`);
    return { items: entries.map(({ records: _r, ...rest }) => rest), released };
  }

  // Compression archives a detached snapshot container; the original conversation frame
  // stays bound. Restoring creates this separate container beside it, avoiding overlap
  // with the summary and preserving every original shape ID, asset and binding.
  archiveContents(room: BoardRoom, frameId: string, shapeIds: string[], by: string): ArchiveSummary {
    const frame = room.records.get(frameId);
    if (!isFrame(frame)) throw httpError(404, "Frame no longer exists");
    const inner = shapeIds.map(id => room.records.get(id)).filter(isShape);
    if (!inner.length) throw httpError(409, "There are no original shapes left to compress");
    if (inner.some(s => s.type === "frame" && (s.meta?.paseo?.agentId || s.meta?.paseo?.request)))
      throw httpError(409, "Move nested agent frames out before compressing; their conversations must stay bound");
    const ids = new Set(inner.map(s => s.id));
    const origin = absPos(room.records, frame);
    const roots = inner.filter(s => !ids.has(s.parentId));
    const positions = roots.map(s => ({ s, at: absPos(room.records, s) }));
    const w = Math.max(frame.props.w, ...positions.map(({s,at}) => at.x-origin.x + (s.props?.w ?? 220)));
    const h = Math.max(frame.props.h, ...positions.map(({s,at}) => at.y-origin.y + (s.props?.h ?? 220)));
    const wrapper = baseShape("frame", frame.parentId, nextIndex(room.records, frame.parentId), frame.x + frame.props.w + 80, frame.y,
      { name: `${frame.props.name || "Frame"} · before compression`, w, h, color: "grey" }, { sourceFrameId: frameId });
    const offsets = new Map(positions.map(({s,at}) => [s.id, at]));
    const shapes = inner.map(s => offsets.has(s.id) ? { ...s, parentId: wrapper.id, x: offsets.get(s.id)!.x-origin.x, y: offsets.get(s.id)!.y-origin.y } : s);
    const bindings = [...room.records.values()].filter(r => r.typeName === "binding" && (ids.has(r.fromId) || ids.has(r.toId)));
    const assets = [...new Set(inner.map(s => s.props?.assetId).filter(Boolean))].map(id => room.records.get(id)).filter((r): r is Rec => !!r);
    const entry: ArchivedFrame = { id: this.newId("arch"), frameId: wrapper.id, sourceFrameId: frameId,
      name: wrapper.props.name, archivedAt: Date.now(), by, reason: `Compressed contents of ${frameId}`,
      parentId: wrapper.parentId, page: { x: origin.x + frame.props.w + 80, y: origin.y }, w, h,
      shapes: shapes.length, agents: [], records: [wrapper, ...byDepth(shapes, new Map([ ...room.records, [wrapper.id, wrapper] ])), ...bindings, ...assets] };
    const board = this.board(room.id);
    board.items.push(entry);
    // Fail closed: a disk error must never remove the only copy of the originals.
    try {
      mkdirSync(this.dir, { recursive: true });
      const file = this.file(room.id);
      writeFileSync(`${file}.tmp`, JSON.stringify(board));
      renameSync(`${file}.tmp`, file);
    } catch (e) { board.items.pop(); throw e; }
    room.write({ kind: "server", reason: "compress-archive" }, ops => {
      for (const b of bindings) ops.remove(b.id);
      for (const s of byDepth(inner, room.records).reverse()) ops.remove(s.id);
    });
    this.changed(room);
    const { records: _, ...summary } = entry;
    return summary;
  }

  // Put archived frames back where they were. Bound frames come back unbound, offering to
  // re-link their conversation. A frame whose id is on the board again is refused.
  restore(room: BoardRoom, ids: string[], by: string): { restored: ArchiveSummary[]; skipped: Array<{ id: string; why: string }> } {
    const board = this.board(room.id);
    const restored: ArchiveSummary[] = [];
    const skipped: Array<{ id: string; why: string }> = [];
    const todo: ArchivedFrame[] = [];
    for (const id of ids) {
      const item = board.items.find((i) => i.id === id);
      if (!item) skipped.push({ id, why: "not in the archive" });
      else if (item.records.some(r => isShape(r) && room.records.has(r.id))) skipped.push({ id, why: "a frame with this id is on the board again" });
      else todo.push(item);
    }
    if (!todo.length) return { restored, skipped };
    room.write({ kind: "server", reason: "archive-restore" }, (ops) => {
      for (const item of todo) {
        const [frame, ...rest] = item.records;
        const parent = ops.get(item.parentId);
        const top = parent && (parent.typeName === "page" || isShape(parent))
          ? { ...frame }
          : { ...frame, parentId: room.pageId(), x: item.page.x, y: item.page.y };
        const shapes = [unbind(top), ...rest.filter((r) => isShape(r)).map((s) => (s.type === "frame" ? unbind(s) : s))];
        for (const a of rest) if (a.typeName === "asset" && !ops.get(a.id)) ops.put(a);
        for (const s of shapes) ops.put(s);
        for (const b of rest) if (b.typeName === "binding" && ops.get(b.fromId) && ops.get(b.toId)) ops.put(b);
      }
    });
    const done = new Set(todo.map((i) => i.id));
    board.items = board.items.filter((i) => !done.has(i.id));
    this.changed(room);
    for (const { records: _r, ...rest } of todo) restored.push(rest);
    this.log(`frame archive ${room.id}: ${by} restored ${todo.length} frame(s): ${todo.map((i) => i.name).join(", ")}`);
    return { restored, skipped };
  }

  // Delete forever: the snapshot and the frame's History go. People only (http.ts).
  purge(room: BoardRoom, ids: string[], by: string): { deleted: number } {
    const board = this.board(room.id);
    const gone = board.items.filter((i) => ids.includes(i.id));
    board.items = board.items.filter((i) => !ids.includes(i.id));
    for (const item of gone) {
      for (const f of item.records.filter((r) => r.type === "frame")) this.history?.forget(room.id, f.id);
    }
    if (gone.length) {
      this.changed(room);
      this.log(`frame archive ${room.id}: ${by} deleted ${gone.length} archived frame(s) forever: ${gone.map((i) => i.name).join(", ")}`);
    }
    return { deleted: gone.length };
  }

  // --- stale frames and clean-up proposals ------------------------------------------

  // Top-level frames that look finished, with why. A frame whose agent is working, starting
  // or waiting for permission is never a candidate. `exclude` is the asking agent's frame.
  candidates(room: BoardRoom, opts: { idleDays?: number; exclude?: string; now?: number } = {}): { candidates: Candidate[]; active: number; recent: number; idleDays: number } {
    const idleDays = Math.max(0, Math.min(365, Number.isFinite(opts.idleDays) ? Number(opts.idleDays) : 7));
    const now = opts.now ?? Date.now();
    const out: Candidate[] = [];
    let active = 0;
    let recent = 0;
    for (const f of room.records.values()) {
      if (!isFrame(f) || f.id === opts.exclude || isShape(room.records.get(f.parentId))) continue;
      const c = this.assess(room, f, idleDays, now);
      if (c === "active") active++;
      else if (!c.reasons.length) recent++;
      else out.push(c);
    }
    out.sort((a, b) => (a.lastEditAt ?? 0) - (b.lastEditAt ?? 0));
    return { candidates: out, active, recent, idleDays };
  }

  private assess(room: BoardRoom, f: Rec, idleDays: number, now: number): Candidate | "active" {
    const p = f.meta?.paseo ?? {};
    const status = typeof p.status === "string" ? p.status : null;
    if (p.request || status === "running" || status === "requested" || status === "needs-permission" || p.deltaDelivery?.status === "sending" || (p.cloudSessions ?? 0) > 0) return "active";
    const inner = subtree(room.records, f.id);
    const nested = inner.filter((s) => s.type === "frame" && ["running", "requested", "needs-permission"].includes(s.meta?.paseo?.status));
    if (nested.length) return "active";
    const times = [this.history?.lastAt(room.id, f.id), p.lastDeltaAt, p.boundAt].filter((t): t is number => typeof t === "number" && t > 0);
    const lastEditAt = times.length ? Math.max(...times) : null;
    const idle = lastEditAt === null ? null : now - lastEditAt;
    const stale = idle !== null && idle >= idleDays * DAY;
    const reasons: string[] = [];
    if (!inner.length) reasons.push("empty frame");
    if (stale) reasons.push(`last edited ${ago(idle!)} ago`);
    else if (lastEditAt === null && !p.agentId) reasons.push("no edits recorded");
    if (p.agentId && (status === "archived" || status === "error")) reasons.push(`agent ${status}`);
    else if (p.agentId && status === "idle" && stale) reasons.push("agent idle");
    if (!p.agentId && p.relink?.agentId) reasons.push("conversation unlinked");
    // Recent work keeps a frame unless it is empty or its agent is gone.
    const keep = !stale && lastEditAt !== null && !reasons.some((r) => r === "empty frame" || r.startsWith("agent "));
    return {
      frameId: f.id,
      name: String(f.props?.name || "Frame"),
      reasons: keep ? [] : reasons,
      lastEditAt,
      idleDays: idle === null ? null : Math.floor(idle / DAY),
      shapes: inner.length,
      agent: typeof p.agentId === "string" ? { id: p.agentId, status: status ?? "unknown" } : null,
    };
  }

  // board_archive: an agent's list of frames becomes a pending proposal (it replaces that
  // agent's earlier pending one). Nothing leaves the board until a person approves it.
  propose(room: BoardRoom, by: CleanupProposal["by"], frameIds: string[], reason: string): { proposal: CleanupProposal; skipped: Array<{ frameId: string; why: string }> } {
    const ids = [...new Set(frameIds.map(String))];
    if (!ids.length) throw httpError(400, "frameIds must list at least one frame");
    if (ids.length > ARCHIVE_BATCH_MAX) throw httpError(400, `at most ${ARCHIVE_BATCH_MAX} frames per proposal`);
    const missing = ids.filter((id) => !isFrame(room.records.get(id)));
    if (missing.length) throw httpError(404, `not frames on board ${room.id}: ${missing.slice(0, 10).join(", ")}`);
    const now = Date.now();
    const items: ProposalItem[] = [];
    const skipped: Array<{ frameId: string; why: string }> = [];
    for (const id of ids) {
      const f = room.records.get(id)!;
      if (isShape(room.records.get(f.parentId)) && ids.some((o) => ancestors(room.records, f).includes(o))) {
        skipped.push({ frameId: id, why: "inside another proposed frame (it goes with it)" });
        continue;
      }
      const c = this.assess(room, f, 0, now);
      if (c === "active") skipped.push({ frameId: id, why: "an agent is at work in it" });
      else items.push({ frameId: id, name: c.name, reasons: c.reasons.length ? c.reasons : [c.lastEditAt ? `last edited ${ago(now - c.lastEditAt)} ago` : "no edits recorded"] });
    }
    if (!items.length) throw httpError(409, `nothing to propose: ${skipped.map((s) => `${s.frameId} ${s.why}`).join("; ")}`);
    const board = this.board(room.id);
    for (const p of board.proposals) if (p.status === "pending" && p.by.agentId === by.agentId) {
      p.status = "dismissed";
      p.decidedAt = now;
      p.decidedBy = "replaced by a newer proposal";
    }
    const proposal: CleanupProposal = { id: this.newId("prop"), at: now, by, reason: reason.trim().slice(0, 500) || "Clean-up", items, status: "pending" };
    board.proposals.push(proposal);
    // Decided proposals are kept for a while as a record, not forever.
    const decided = board.proposals.filter((p) => p.status !== "pending");
    if (decided.length > 50) board.proposals = board.proposals.filter((p) => p.status === "pending" || decided.slice(-50).includes(p));
    this.changed(room);
    this.log(`frame archive ${room.id}: agent ${by.agentId} proposed archiving ${items.length} frame(s) (${proposal.id})`);
    return { proposal, skipped };
  }

  // Approve (all, or only `frameIds`) or dismiss a pending proposal. A frame that has
  // gone, become active, or been edited since the proposal is skipped, not archived.
  decide(room: BoardRoom, proposalId: string, decision: "approve" | "dismiss", by: string, frameIds?: string[]): { proposal: CleanupProposal; items: ArchiveSummary[]; released: Rec[] } {
    const p = this.board(room.id).proposals.find((x) => x.id === proposalId);
    if (!p) throw httpError(404, `no proposal ${proposalId}`);
    if (p.status !== "pending") throw httpError(409, `proposal ${proposalId} was already ${p.status}`);
    p.decidedAt = Date.now();
    p.decidedBy = by;
    if (decision === "dismiss") {
      p.status = "dismissed";
      this.changed(room);
      return { proposal: p, items: [], released: [] };
    }
    const chosen = frameIds ? p.items.filter((i) => frameIds.includes(i.frameId)) : p.items;
    const skipped: Array<{ frameId: string; why: string }> = [];
    const go: string[] = [];
    for (const it of chosen) {
      const f = room.records.get(it.frameId);
      if (!isFrame(f)) skipped.push({ frameId: it.frameId, why: "no longer on the board" });
      else if (this.assess(room, f, 0, Date.now()) === "active") skipped.push({ frameId: it.frameId, why: "its agent is at work" });
      else if ((this.history?.lastAt(room.id, f.id) ?? 0) > p.at) skipped.push({ frameId: it.frameId, why: "edited since the proposal" });
      else go.push(it.frameId);
    }
    p.status = "approved";
    p.skipped = skipped;
    const out = go.length ? this.archive(room, go, { by, reason: p.reason, proposalId: p.id, proposedBy: p.by.frameName || p.by.agentId }) : { items: [], released: [] };
    p.archived = out.items.length;
    this.changed(room);
    return { proposal: p, ...out };
  }

  // --- persistence and the canvas summary -------------------------------------------

  // The canvas summary (document meta) and a save.
  private changed(room: BoardRoom): void {
    const b = this.board(room.id);
    const summary = {
      archived: b.items.length,
      pending: b.proposals.filter((p) => p.status === "pending").map((p) => ({ id: p.id, count: p.items.length, by: p.by.frameName || p.by.agentId })),
      rev: Date.now(),
    };
    room.write({ kind: "server", reason: "archive-summary" }, (ops) => {
      const doc = ops.get(DOCUMENT_ID) ?? { id: DOCUMENT_ID, typeName: "document", gridSize: 10, name: "", meta: {} };
      ops.put({ ...doc, meta: { ...doc.meta, [ARCHIVE_KEY]: summary } });
    });
    room.save();
    this.scheduleSave(room.id);
  }

  private scheduleSave(boardId: string): void {
    if (this.saveTimers.has(boardId)) return;
    this.saveTimers.set(
      boardId,
      setTimeout(() => {
        this.saveTimers.delete(boardId);
        this.save(boardId);
      }, 200),
    );
  }

  save(boardId: string): void {
    const t = this.saveTimers.get(boardId);
    if (t) clearTimeout(t);
    this.saveTimers.delete(boardId);
    const board = this.boards.get(boardId);
    if (!board) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      const f = this.file(boardId);
      writeFileSync(`${f}.tmp`, JSON.stringify({ boardId, savedAt: new Date().toISOString(), ...board }));
      renameSync(`${f}.tmp`, f);
    } catch (e) {
      this.log(`frame archive ${boardId}: save failed: ${(e as Error).message}`);
    }
  }

  // Write every board with an unsaved archive now (shutdown, bunny backup).
  persistNow(): void {
    for (const id of [...this.saveTimers.keys()]) this.save(id);
  }

  stop(): void {
    this.persistNow();
  }
}

// A restored frame is unbound: its conversation is offered for re-linking, not reattached.
function unbind(frame: Rec): Rec {
  const p = frame.meta?.paseo;
  if (!p) return frame;
  const meta = { ...frame.meta };
  delete meta.paseoFlushAt;
  meta.paseo = typeof p.agentId === "string"
    ? { relink: { agentId: p.agentId, ...(typeof p.host === "string" ? { host: p.host } : {}), reason: "restored-or-copied", requiresConfirmation: true } }
    : p.relink ? { relink: p.relink } : {};
  return { ...frame, props: { ...frame.props, color: "black" }, meta };
}
