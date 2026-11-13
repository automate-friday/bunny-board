// Frame timeline: a bounded list of snapshots of each frame's contents, one per settled
// burst of edits, tagged as an agent or a human edit. The frame watcher feeds it the
// changes it already filters (human edits minus derived echoes, agent writes); bursts
// settle on the same debounce as board deltas. Persisted per board under
// <state>/frame-history/<board>.json, so the timeline survives a server restart.
//
// A frame's contents are the frame (name and size) and every record under it, except a
// nested bound frame and what is inside it (that frame has its own conversation and its
// own timeline). Restoring writes those contents back as one server change; shapes
// outside the frame and the frame's binding (meta.paseo) are never touched.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { recordTiming } from "./perf";
import path from "node:path";
import { isShape, type Rec, type RecMap } from "./records";
import type { BoardRoom, ChangeSource, RecordChange } from "./room-host";
import { frameTimes } from "../shared/frame-activity";

// Snapshots kept per frame (oldest dropped first), and frames kept per board.
export const HISTORY_CAP = 50;
const FRAMES_PER_BOARD = 200;

export type HistoryKind = "start" | "human" | "agent";

export interface HistoryEntry {
  id: string;
  // When the snapshot was taken: the burst had settled (a debounce after its last edit).
  at: number;
  // When the burst's last edit happened, so "the frame as it stood at time T" (snapshotAt)
  // does not miss an edit made just before T. Absent on a "start" entry, on a restore and
  // on entries recorded before this field existed (`at` stands in).
  edited?: number;
  // "start": how the frame looked before its first recorded edit.
  kind: HistoryKind;
  // The person's name, or the agent id.
  by: string | null;
  // Set when this entry is a "Restore this version" of an older entry.
  restoredFrom?: string;
  records: Rec[];
}

export type HistorySummary = Omit<HistoryEntry, "records"> & { shapes: number };

interface Pending {
  room: BoardRoom;
  frameId: string;
  kind: "human" | "agent";
  by: string | null;
  first: number;
  last: number;
  timer: ReturnType<typeof setTimeout> | null;
}

// Wait for debounceMs of quiet, but never longer than maxWaitMs after the first edit (the
// same rule as board deltas, so steady editing still produces ticks).
export function burstDelay(firstAt: number, now: number, debounceMs: number, maxWaitMs: number): number {
  return Math.min(debounceMs, Math.max(0, firstAt + maxWaitMs - now));
}

const savedKey = (boardId: string, frameId: string) => `${boardId}\u0000${frameId}`;

const boundFrame = (r: Rec | undefined) => r?.type === "frame" && !!(r.meta?.paseo?.agentId || r.meta?.paseo?.request);

// The frame record as history keeps it: its binding and flush requests are server state.
function frameForHistory(frame: Rec): Rec {
  const meta = { ...frame.meta };
  delete meta.paseo;
  delete meta.paseoFlushAt;
  return { ...frame, meta };
}

// The frame and everything inside it (see the header), plus the bindings between those
// shapes and the assets they show.
export function frameContents(records: RecMap, frameId: string): Rec[] | null {
  const frame = records.get(frameId);
  if (frame?.type !== "frame") return null;
  const inside = new Map<string, boolean>();
  const isInside = (s: Rec): boolean => {
    const known = inside.get(s.id);
    if (known !== undefined) return known;
    inside.set(s.id, false); // cycle guard
    const parent = records.get(s.parentId);
    const yes = s.parentId === frameId || (isShape(parent) && !boundFrame(parent) && isInside(parent));
    inside.set(s.id, yes && !boundFrame(s));
    return yes && !boundFrame(s);
  };
  const shapes: Rec[] = [];
  for (const r of records.values()) if (isShape(r) && r.id !== frameId && isInside(r)) shapes.push(r);
  const ids = new Set(shapes.map((s) => s.id));
  ids.add(frameId);
  const bindings = [...records.values()].filter((r) => r.typeName === "binding" && ids.has(r.fromId) && ids.has(r.toId));
  const assets = [...new Set(shapes.map((s) => s.props?.assetId).filter((a): a is string => typeof a === "string"))].map((a) => records.get(a)).filter((a): a is Rec => !!a);
  return [frameForHistory(frame), ...shapes, ...bindings, ...assets];
}

// Records sorted so every parent comes before its children (puts and display).
function byDepth(recs: Rec[]): Rec[] {
  const byId = new Map(recs.map((r) => [r.id, r]));
  const depth = (r: Rec): number => {
    let d = 0;
    for (let p = byId.get(r.parentId); p && d < 50; p = byId.get(p.parentId)) d++;
    return d;
  };
  return [...recs].sort((a, b) => depth(a) - depth(b));
}

// A frame's colour shows its agent's status (the server sets it): not content.
const frameShape = (f: Rec) => ({ ...f, meta: null, props: { ...f.props, color: null } });
// recs[0] is the frame (frameContents).
const contentKey = (recs: Rec[]) => JSON.stringify([frameShape(recs[0]), ...recs.slice(1).sort((a, b) => (a.id < b.id ? -1 : 1))]);

// The board as it was before `changes` (for the "start" snapshot and kind switches).
function beforeView(room: BoardRoom, changes: RecordChange[]): RecMap {
  const view = new Map(room.records);
  for (const c of changes) {
    if (c.before) view.set(c.id, c.before);
    else view.delete(c.id);
  }
  return view;
}

// The frames whose contents a change touched: the nearest enclosing frame and its
// ancestors, up to and including the first bound one; a frame's own name or size.
function framesOf(records: RecMap, rec: Rec, out: Set<string>): void {
  let p = records.get(rec.parentId);
  for (let guard = 0; isShape(p) && guard < 50; guard++) {
    if (p.type === "frame") {
      out.add(p.id);
      if (boundFrame(p)) return;
    }
    p = records.get(p.parentId);
  }
}

// The entry that shows a frame as it stood at `time`: the newest one whose last edit (its
// settle time when that was not recorded) is at or before `time`. A "start" entry is the frame
// before its first recorded edit, so it also answers for every earlier time. Null when the
// history holds nothing that old: nothing was ever recorded, or the oldest entries were
// dropped at the cap.
export function snapshotAt<E extends Pick<HistoryEntry, "at" | "kind" | "edited">>(entries: readonly E[], time: number): E | null {
  let found: E | null = null;
  for (const e of entries) if (e.kind === "start" || (e.edited ?? e.at) <= time) found = e;
  return found;
}

export class FrameHistory {
  private readonly boards = new Map<string, Map<string, HistoryEntry[]>>();
  private readonly pending = new Map<string, Pending>();
  private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Each frame's list as saved ("board/frame" -> JSON), so a save serializes only the frames
  // that changed since the last one; the rest of the file is spliced from here. Dropped
  // whenever the list changes (push, forget, eviction).
  private readonly saved = new Map<string, string>();
  private seq = 0;
  private stopped = false;

  constructor(
    private readonly dir: string,
    private readonly timing: { debounceMs: number; maxWaitMs: number },
    private readonly log: (m: string) => void = () => {},
  ) {
    // Background-save temp files left by a process killed mid-write (never the live file).
    try {
      for (const f of readdirSync(dir)) {
        const m = /\.json\.bg-(\d+)-\d+\.tmp$/.exec(f);
        if (m && Number(m[1]) !== process.pid) rmSync(path.join(dir, f), { force: true });
      }
    } catch {}
  }

  private file(boardId: string): string {
    return path.join(this.dir, `${encodeURIComponent(boardId)}.json`);
  }

  private board(boardId: string): Map<string, HistoryEntry[]> {
    let b = this.boards.get(boardId);
    if (b) return b;
    b = new Map();
    const f = this.file(boardId);
    if (existsSync(f)) {
      try {
        const data = JSON.parse(readFileSync(f, "utf8")) as { frames?: Record<string, HistoryEntry[]> };
        for (const [id, list] of Object.entries(data.frames ?? {})) if (Array.isArray(list)) b.set(id, list.slice(-HISTORY_CAP));
      } catch (e) {
        const backup = `${f}.corrupt-${Date.now()}`;
        renameSync(f, backup);
        this.log(`frame history ${boardId}: unreadable, moved to ${backup} (${(e as Error).message})`);
      }
    }
    this.boards.set(boardId, b);
    return b;
  }

  // --- recording --------------------------------------------------------------------

  // Content changes from a person or an agent (the watcher drops derived echoes first).
  observe(room: BoardRoom, source: ChangeSource, changes: RecordChange[]): void {
    if (this.stopped || (source.kind !== "human" && source.kind !== "agent") || !changes.length) return;
    const frames = new Set<string>();
    for (const c of changes) {
      if (c.before) framesOf(room.records, c.before, frames);
      if (c.after) framesOf(room.records, c.after, frames);
      const f = c.after ?? c.before;
      if (f?.type === "frame" && c.before && c.after && JSON.stringify(frameShape(c.before)) !== JSON.stringify(frameShape(c.after))) frames.add(f.id);
    }
    if (!frames.size) return;
    const kind = source.kind;
    const by = source.kind === "human" ? source.name || null : source.agentId;
    let before: RecMap | null = null;
    const now = Date.now();
    for (const frameId of frames) {
      const k = `${room.id}/${frameId}`;
      const list = this.board(room.id).get(frameId);
      let p = this.pending.get(k);
      // A burst by someone else ends the current one, as it was before this change.
      if (p && (p.kind !== kind || p.by !== by)) {
        before ??= beforeView(room, changes);
        this.settle(room, frameId, before);
        p = undefined;
      }
      if (!p && !list?.length) {
        before ??= beforeView(room, changes);
        const start = frameContents(before, frameId);
        if (start) this.push(room.id, frameId, { kind: "start", by: null, at: now, records: start });
      }
      if (!p) {
        p = { room, frameId, kind, by, first: now, last: now, timer: null };
        this.pending.set(k, p);
      }
      p.last = now;
      if (p.timer) clearTimeout(p.timer);
      const pend = p;
      pend.timer = setTimeout(() => {
        pend.timer = null;
        this.settle(room, frameId);
      }, burstDelay(p.first, now, this.timing.debounceMs, this.timing.maxWaitMs));
    }
  }

  // Record the pending burst of a frame now (from `view`, default the live board).
  private settle(room: BoardRoom, frameId: string, view: RecMap = room.records): void {
    const k = `${room.id}/${frameId}`;
    const p = this.pending.get(k);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    this.pending.delete(k);
    const recs = frameContents(view, frameId);
    if (recs) this.push(room.id, frameId, { kind: p.kind, by: p.by, at: Date.now(), edited: p.last, records: recs });
  }

  // Settle every pending burst of one frame (before a restore) or of all frames (stop).
  flush(boardId?: string, frameId?: string): void {
    for (const [k, p] of this.pending)
      if ((!boardId || p.room.id === boardId) && (!frameId || p.frameId === frameId)) p.room.closed ? this.pending.delete(k) : this.settle(p.room, p.frameId);
  }

  private push(boardId: string, frameId: string, e: Omit<HistoryEntry, "id">): HistoryEntry | null {
    const board = this.board(boardId);
    const list = board.get(frameId) ?? [];
    const last = list[list.length - 1];
    // Nothing visible changed (a move put back by the layout lock, an edit undone).
    if (last && contentKey(last.records) === contentKey(e.records) && !e.restoredFrom) return null;
    const entry: HistoryEntry = { id: `${e.at.toString(36)}-${(++this.seq).toString(36)}`, ...e };
    list.push(entry);
    if (list.length > HISTORY_CAP) list.splice(0, list.length - HISTORY_CAP);
    board.delete(frameId);
    board.set(frameId, list); // most recently changed last
    this.saved.delete(savedKey(boardId, frameId));
    if (board.size > FRAMES_PER_BOARD) {
      const oldest = board.keys().next().value as string;
      board.delete(oldest);
      this.saved.delete(savedKey(boardId, oldest));
    }
    this.scheduleSave(boardId);
    return entry;
  }

  // --- reading ------------------------------------------------------------------------

  list(boardId: string, frameId: string): HistorySummary[] {
    return (this.board(boardId).get(frameId) ?? []).map(({ records, ...rest }) => ({ ...rest, shapes: records.filter((r) => isShape(r)).length - 1 }));
  }

  get(boardId: string, frameId: string, entryId: string): HistoryEntry | null {
    return this.board(boardId).get(frameId)?.find((e) => e.id === entryId) ?? null;
  }

  // The frame's contents as they stood at `time` (snapshotAt). An unsettled burst is settled
  // first, so edits made moments before `time` count.
  at(boardId: string, frameId: string, time: number): HistoryEntry | null {
    this.flush(boardId, frameId);
    return snapshotAt(this.board(boardId).get(frameId) ?? [], time);
  }

  // When the frame's contents last changed (its newest settled entry), or null if never recorded.
  lastAt(boardId: string, frameId: string): number | null {
    const list = this.board(boardId).get(frameId);
    return list?.length ? list[list.length - 1].at : null;
  }

  // Drop a frame's timeline (Archive › Delete forever).
  forget(boardId: string, frameId: string): void {
    for (const [k, p] of this.pending) if (p.room.id === boardId && p.frameId === frameId) {
      if (p.timer) clearTimeout(p.timer);
      this.pending.delete(k);
    }
    this.saved.delete(savedKey(boardId, frameId));
    if (this.board(boardId).delete(frameId)) this.scheduleSave(boardId);
  }

  // --- restore ------------------------------------------------------------------------

  // Put the frame's contents back as they were in `entryId`, as one server change, and
  // record that as a new (human) entry. Shapes outside the frame and the frame's binding
  // and position are left alone; a shape from the snapshot that now lives outside the
  // frame stays where it is (skipped).
  restore(room: BoardRoom, frameId: string, entryId: string, by: string): { entry: HistoryEntry | null; at: number; removed: number; restored: number; skipped: string[] } {
    const target = this.get(room.id, frameId, entryId);
    if (!target) throw Object.assign(new Error(`no version ${entryId} in this frame's history`), { status: 404 });
    if (room.records.get(frameId)?.type !== "frame") throw Object.assign(new Error(`frame ${frameId} is not on board ${room.id}`), { status: 404 });
    // Whatever was being edited becomes its own entry first, so the restore can be undone.
    this.flush(room.id, frameId);
    const current = frameContents(room.records, frameId) ?? [];
    const currentShapes = new Set(current.filter((r) => isShape(r) && r.id !== frameId).map((r) => r.id));
    // Plan first: which snapshot shapes go back (a parent must be placed before its child).
    const placed = new Set<string>([frameId]);
    const puts: Rec[] = [];
    const skipped: string[] = [];
    for (const s of byDepth(target.records.filter((r) => isShape(r) && r.id !== frameId))) {
      const live = room.records.get(s.id);
      if ((live && !currentShapes.has(s.id)) || !placed.has(s.parentId)) {
        skipped.push(s.id);
        continue;
      }
      placed.add(s.id);
      if (!live || JSON.stringify(live) !== JSON.stringify(s)) puts.push(s);
    }
    const remove = new Set([...currentShapes].filter((id) => !placed.has(id)));
    const wantBindings = target.records.filter((b) => b.typeName === "binding" && placed.has(b.fromId) && placed.has(b.toId));
    const wantBindingIds = new Set(wantBindings.map((b) => b.id));
    const old = target.records.find((r) => r.id === frameId);
    room.write({ kind: "server", reason: "history-restore" }, (ops) => {
      for (const r of room.records.values()) {
        if (r.typeName !== "binding" || wantBindingIds.has(r.id)) continue;
        // Bindings to removed shapes, and bindings inside the frame the version did not have.
        if (remove.has(r.fromId) || remove.has(r.toId) || (placed.has(r.fromId) && placed.has(r.toId))) ops.remove(r.id);
      }
      for (const id of remove) ops.remove(id);
      for (const a of target.records) if (a.typeName === "asset" && !ops.get(a.id)) ops.put(a);
      for (const s of puts) ops.put(s);
      for (const b of wantBindings) if (JSON.stringify(ops.get(b.id)) !== JSON.stringify(b)) ops.put(b);
      const frame = ops.get(frameId)!;
      if (old && (old.props.w !== frame.props.w || old.props.h !== frame.props.h)) ops.put({ ...frame, props: { ...frame.props, w: old.props.w, h: old.props.h } });
    });
    const restored = puts.length;
    const recs = frameContents(room.records, frameId) ?? [];
    const entry = this.push(room.id, frameId, { kind: "human", by, at: Date.now(), restoredFrom: entryId, records: recs });
    this.log(`frame history ${room.id}/${frameId}: ${by} restored ${entryId} (${restored} put back, ${remove.size} removed${skipped.length ? `, ${skipped.length} skipped: now outside the frame` : ""})`);
    return { entry, at: target.at, removed: remove.size, restored, skipped };
  }

  // --- persistence --------------------------------------------------------------------

  private scheduleSave(boardId: string): void {
    if (this.stopped || this.saveTimers.has(boardId)) return;
    this.saveTimers.set(
      boardId,
      setTimeout(() => {
        this.saveTimers.delete(boardId);
        this.saveInBackground(boardId);
      }, 500),
    );
  }

  // Per board: the generation of the newest save started, and the background write in flight.
  private readonly saveGens = new Map<string, number>();
  private readonly writing = new Map<string, Promise<void>>();

  // Timer saves: the JSON is built on the loop (one consistent state), the file is written on
  // libuv's pool, and only the rename comes back. One write per board at a time: a save due
  // while one is in flight waits for it. A write renames into place only if no later save
  // started (save() at shutdown supersedes it), so an older history never replaces a newer one.
  private saveInBackground(boardId: string): void {
    const inFlight = this.writing.get(boardId);
    if (inFlight) {
      void inFlight.then(() => this.scheduleSave(boardId));
      return;
    }
    const board = this.boards.get(boardId);
    if (!board || this.stopped) return;
    const gen = (this.saveGens.get(boardId) ?? 0) + 1;
    this.saveGens.set(boardId, gen);
    const f = this.file(boardId);
    const tmp = `${f}.bg-${process.pid}-${gen}.tmp`;
    let json: string;
    try {
      mkdirSync(this.dir, { recursive: true });
      const t0 = performance.now();
      json = this.serialize(boardId, board);
      recordTiming("history.save", performance.now() - t0, json.length);
    } catch (e) {
      this.log(`frame history ${boardId}: save failed: ${(e as Error).message}`);
      return;
    }
    const started = performance.now();
    const done = writeFile(tmp, json)
      .then(() => {
        recordTiming("history.save.write", performance.now() - started, json.length);
        if (this.saveGens.get(boardId) === gen) renameSync(tmp, f);
        else rmSync(tmp, { force: true });
      })
      .catch((e) => {
        rmSync(tmp, { force: true });
        this.log(`frame history ${boardId}: save failed: ${(e as Error).message}`);
      })
      .finally(() => this.writing.delete(boardId));
    this.writing.set(boardId, done);
  }

  // Resolves when no background write is in flight (tests).
  async flushed(): Promise<void> {
    while (this.writing.size) await Promise.all(this.writing.values());
  }

  // Synchronous save (shutdown, tests): supersedes any background write in flight.
  save(boardId: string): void {
    const t = this.saveTimers.get(boardId);
    if (t) clearTimeout(t);
    this.saveTimers.delete(boardId);
    const board = this.boards.get(boardId);
    if (!board) return;
    this.saveGens.set(boardId, (this.saveGens.get(boardId) ?? 0) + 1);
    try {
      mkdirSync(this.dir, { recursive: true });
      const f = this.file(boardId);
      const t0 = performance.now();
      const json = this.serialize(boardId, board);
      writeFileSync(`${f}.tmp`, json);
      renameSync(`${f}.tmp`, f);
      recordTiming("history.save", performance.now() - t0, json.length);
    } catch (e) {
      this.log(`frame history ${boardId}: save failed: ${(e as Error).message}`);
    }
  }

  // The file's JSON, the same text as JSON.stringify({ boardId, savedAt, frames }) (frame ids
  // are "shape:…", never integer-like keys, so the key order is the map's either way), with
  // only the frames changed since the last save serialized again.
  serialize(boardId: string, board: Map<string, HistoryEntry[]>): string {
    const frames: string[] = [];
    for (const [frameId, list] of board) {
      const k = savedKey(boardId, frameId);
      let json = this.saved.get(k);
      if (json === undefined) this.saved.set(k, (json = JSON.stringify(list)));
      frames.push(`${JSON.stringify(frameId)}:${json}`);
    }
    return `{"boardId":${JSON.stringify(boardId)},"savedAt":${JSON.stringify(new Date().toISOString())},"frames":{${frames.join(",")}}}`;
  }

  // Settle what is pending and write every board with unsaved history now, without stopping
  // (bunny backup asks for this before it copies the state directory).
  persistNow(): void {
    this.flush();
    for (const id of new Set([...this.saveTimers.keys(), ...this.writing.keys()])) this.save(id);
  }

  // Settle what is pending and write every board's history (server shutdown).
  stop(): void {
    this.flush();
    this.stopped = true;
    // A board whose background write is still in flight, or waiting behind one, is written
    // now as well (superseding it), so nothing depends on a write finishing after shutdown.
    for (const id of new Set([...this.saveTimers.keys(), ...this.writing.keys()])) this.save(id);
  }
}

// Last activity per frame (epoch ms): the newest of its History's last settled edit and the
// times the board's own records carry (shared/frame-activity.ts: binding or its copy-safe
// preview, stamps, cloud session cards, comment threads). Frames with none are left out.
export function frameActivity(records: RecMap, historyLastAt: (frameId: string) => number | null): Record<string, number> {
  const times = frameTimes(records.values());
  const out: Record<string, number> = {};
  for (const r of records.values()) {
    if (r.typeName !== "shape" || r.type !== "frame") continue;
    const at = Math.max(historyLastAt(r.id) ?? 0, times.get(r.id) ?? 0);
    if (at > 0) out[r.id] = at;
  }
  return out;
}
