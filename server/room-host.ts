import { migrateWorkspaceMeta } from "../shared/bunny-workspace";
import {randomUUID} from "node:crypto";
// In-process tldraw sync rooms, one per board, persisted as JSON snapshots.
// Ported from tldraw-room/worker/TldrawDurableObject.ts, minus Cloudflare.
//
// Every storage transaction is attributed: websocket pushes (id "TLSyncRoom.txn")
// are human, server writes carry an explicit source tag. Listeners receive the
// before/after records of each change, which is what the frame watcher diffs.

import { close as closeFd, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writev as writevFd, writeFileSync } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { InMemorySyncStorage, type RoomSnapshot, TLSocketRoom } from "@tldraw/sync-core";
import { createTLSchema, defaultBindingSchemas, defaultShapeSchemas, type TLRecord } from "@tldraw/tlschema";
import type { WebSocket } from "ws";
import { componentSchemas } from "../shared/components";
import type { Author, Rec, RecMap } from "./records";
import { recordTiming } from "./perf";

// Background save timing (see BoardRoom.scheduleSave). Mutable for tests.
export const SAVE_TIMING = { idleMs: 1500, maxMs: 3000 };
// The background save's final rename (off the loop). Replaceable by tests to order it
// against a superseding synchronous save.
export const SAVE_IO = { rename: (from: string, to: string): Promise<void> => fsp.rename(from, to) };
// Every `every`-th background save also serializes the whole snapshot with JSON.stringify
// and compares it with the incremental bytes (see BoardRoom.serialize). Mutable for tests.
export const SAVE_CHECK = { every: 25 };
let tmpSeq = 0;
const COMMA = Buffer.from(",");
// A value already serialized (BoardRoom.serialize writes it as is).
class RawJson {
  constructor(readonly json: string) {}
}
// InMemorySyncStorage fields that getSnapshot() reads (declared @internal by tldraw).
interface StorageInternals {
  documents: { values(): Iterable<object> };
  tombstones: { entries(): Iterable<[string, number]> };
  documentClock: { get(): number };
  tombstoneHistoryStartsAtClock: { get(): number };
  schema: { get(): unknown };
}
interface LogInternals {
  documents: { has(id: string): boolean; get(id: string): { state: TLRecord; lastChangedClock: number } | undefined };
  tombstones: { get(id: string): number | undefined };
  documentClock: { get(): number };
  tombstoneHistoryStartsAtClock: { get(): number };
}
// How many room change listeners are running (a listener's synchronous writes nest).
let listenerDepth = 0;

// Custom board components (shared/components) must be in the server schema too:
// the sync room validates every record and checks the client's schema against it.
export const schema = createTLSchema({ shapes: { ...defaultShapeSchemas, ...componentSchemas }, bindings: { ...defaultBindingSchemas } });

const ROOM_TXN = "TLSyncRoom.txn";

export type ChangeSource =
  | { kind: "human"; sessionId: string; userId: string; name: string }
  | { kind: "agent"; agentId: string; frameId: string }
  | { kind: "server"; reason: string };

export interface RecordChange {
  id: string;
  before: Rec | null;
  after: Rec | null;
}

export type ChangeListener = (room: BoardRoom, source: ChangeSource, changes: RecordChange[]) => void;

export interface WriteOps {
  get(id: string): Rec | undefined;
  put(record: Rec): void;
  remove(id: string): void;
}

// Bounds the change log (see TrackedStorage). Mutable for tests.
export const CHANGE_LOG = { max: 20000 };

// InMemorySyncStorage plus a change log, so "what changed since clock N" costs the number
// of changes instead of the size of the board.
//
// InMemorySyncStorage's transaction.getChangesSince(since) walks every document and every
// tombstone. It runs at least twice per write: BoardRoom.committed() diffs each commit for
// the change listeners, and TLSyncRoom.broadcastChanges() diffs every write it did not make
// itself (agent API and other server writes) to broadcast them. On a 5,000-shape board
// that is ~0.35 ms per scan, most of the server's cost of an agent write, and it grows with
// the board. Every set/delete goes through a transaction, so the transaction wrapper logs
// (clock, id) per write; getChangesSince(since) then visits only ids logged after `since`
// and reports each with its current document or tombstone, the same entries the full walk
// reports (a document whose lastChangedClock > since, a tombstone whose clock > since).
// Out of the log's reach (older than its floor, or before tombstoneHistoryStartsAtClock: a
// wipe) it falls back to tldraw's walk.
class TrackedStorage extends InMemorySyncStorage<TLRecord> {
  onCommitted?: (txnId: string | undefined, sinceClock: number) => void;
  // The @internal storage fields the log reads (also read by BoardRoom.readState).
  private get internals(): LogInternals {
    return this as unknown as LogInternals;
  }
  private logClock: number[] = [];
  private logId: string[] = [];
  // Every change with a clock above this is in the log.
  private logFloor = this.getClock();
  // Diagnostics: answers from the log vs. full walks.
  logHits = 0;
  logMisses = 0;

  // biome-ignore lint/suspicious/noExplicitAny: matching the base signature generically.
  override transaction(callback: any, opts?: any): any {
    const before = this.getClock();
    // biome-ignore lint/suspicious/noExplicitAny: storage txn typing.
    const result = super.transaction((txn: any) => callback(this.track(txn)), opts);
    if (result.documentClock > before) this.onCommitted?.(opts?.id, before);
    return result;
  }

  // biome-ignore lint/suspicious/noExplicitAny: storage txn typing.
  private track(txn: any): any {
    const set = txn.set.bind(txn);
    const del = txn.delete.bind(txn);
    const scan = txn.getChangesSince.bind(txn);
    txn.set = (id: string, record: TLRecord) => {
      set(id, record);
      this.log(id);
    };
    txn.delete = (id: string) => {
      const had = this.internals.documents.has(id);
      del(id);
      if (had) this.log(id);
    };
    txn.getChangesSince = (since: number) => this.changesSince(since) ?? scan(since);
    return txn;
  }

  private log(id: string): void {
    this.logClock.push(this.internals.documentClock.get());
    this.logId.push(id);
    if (this.logClock.length > CHANGE_LOG.max) {
      const drop = this.logClock.length - (CHANGE_LOG.max >> 1);
      this.logFloor = Math.max(this.logFloor, this.logClock[drop - 1]);
      this.logClock = this.logClock.slice(drop);
      this.logId = this.logId.slice(drop);
    }
  }

  // The log's answer to getChangesSince, or null to fall back to the full walk.
  private changesSince(since: number): { diff: { puts: Record<string, TLRecord>; deletes: string[] }; wipeAll: false } | undefined | null {
    const clock = this.internals.documentClock.get();
    if (since === clock) return undefined;
    if (since > clock || since < this.logFloor || since < this.internals.tombstoneHistoryStartsAtClock.get()) {
      this.logMisses++;
      return null;
    }
    this.logHits++;
    // First log entry with a clock above `since` (the log is in clock order).
    let lo = 0;
    let hi = this.logClock.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.logClock[mid] > since) hi = mid;
      else lo = mid + 1;
    }
    const puts: Record<string, TLRecord> = {};
    const deletes: string[] = [];
    const seen = new Set<string>();
    for (let i = lo; i < this.logId.length; i++) {
      const id = this.logId[i];
      if (seen.has(id)) continue;
      seen.add(id);
      const doc = this.internals.documents.get(id);
      if (doc) {
        if (doc.lastChangedClock > since) puts[id] = doc.state;
        continue;
      }
      const tomb = this.internals.tombstones.get(id);
      if (tomb !== undefined && tomb > since) deletes.push(id);
    }
    return { diff: { puts, deletes }, wipeAll: false };
  }
}

interface SessionInfo {
  userId: string;
  name: string;
}

export class BoardRoom {
  readonly id: string;
  readonly room: TLSocketRoom<TLRecord, void>;
  private readonly storage: TrackedStorage;
  readonly records: RecMap = new Map();
  private readonly sessions = new Map<string, SessionInfo>();
  private readonly lastPusher = new Map<string, string>();
  private readonly pendingSources = new Map<string, ChangeSource>();
  private txnSeq = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly file: string;
  private persisted=false;
  private detached=false;
  // Last document change (any source), for the board list. Starts at the snapshot's mtime.
  lastChangeAt: number;
  // Commits with changes since this room was opened (board snapshots compare it).
  changeSeq = 0;

  constructor(
    id: string,
    private readonly dir: string,
    private readonly listener: ChangeListener,
    private readonly log: (msg: string) => void,
    private readonly onDetached: (room:BoardRoom)=>void = ()=>{},
  ) {
    this.id = id;
    this.file = path.join(dir, `${encodeURIComponent(id)}.json`);
    this.lastChangeAt = existsSync(this.file) ? statSync(this.file).mtimeMs : Date.now();
    let snapshot: RoomSnapshot | undefined;
    if (existsSync(this.file)) {
      try {
        snapshot = JSON.parse(readFileSync(this.file, "utf8")).snapshot;
      } catch (e) {
        // Keep the unreadable file instead of overwriting it with an empty board.
        const backup = `${this.file}.corrupt-${Date.now()}`;
        renameSync(this.file, backup);
        log(`board ${id}: snapshot unreadable, moved to ${backup}, starting empty (${(e as Error).message})`);
      }
    }
    let migrated = false;
    for (const d of snapshot?.documents ?? []) {
      const record = d.state as unknown as Rec;
      if (record.typeName !== "document") continue;
      const meta = migrateWorkspaceMeta(record.meta);
      if (meta !== record.meta) { record.meta = meta; migrated = true; }
    }
    this.persisted=!!snapshot;
    this.storage = new TrackedStorage(snapshot ? { snapshot } : {});
    this.room = new TLSocketRoom<TLRecord, void>({
      schema,
      storage: this.storage,
      onSessionRemoved: (_room, { sessionId }) => {
        this.sessions.delete(sessionId);
      },
      // The room applies pushes asynchronously, so attribute by record id: remember
      // which session last pushed each record.
      // biome-ignore lint/suspicious/noExplicitAny: message is excluded from the public types.
      onAfterReceiveMessage: ({ sessionId, message }: any) => {
        if (message?.type === "push" && message.diff) {
        for (const id of Object.keys(message.diff)) this.lastPusher.set(id, sessionId);
        if (this.lastPusher.size > 5000) this.lastPusher.clear();
      }
      },
    });
    for (const d of this.room.getCurrentSnapshot().documents) {
      const r = d.state as unknown as Rec;
      this.records.set(r.id, r);
    }
    this.storage.onCommitted = (txnId, since) => this.committed(txnId, since);
    this.ensurePage();
    if (migrated) this.save();
  }

  private ensurePage(): void {
    const hasPage = [...this.records.values()].some((r) => r.typeName === "page");
    if (hasPage) return;
    this.write({ kind: "server", reason: "seed" }, (ops) => {
      if (!ops.get("document:document"))
        ops.put({ id: "document:document", typeName: "document", gridSize: 10, name: "", meta: {} });
      ops.put({ id: "page:page", typeName: "page", name: "Page 1", index: "a1", meta: {} });
    });
  }

  pageId(): string {
    const page = [...this.records.values()].find((r) => r.typeName === "page");
    return page?.id ?? "page:page";
  }

  // --- websocket sessions ------------------------------------------------------

  connect(socket: WebSocket, sessionId: string, userId: string, name: string): void {
    if(this.isArchived()){socket.close(4004,"BOARD_ARCHIVED");return;}
    this.sessions.set(sessionId, { userId, name });
    // Timing only (/api/ui/debug/perf): listeners run in order, so one added before the
    // room's and one after bracket the room's synchronous handling of each message
    // (validation, storage, change listeners and the broadcast to every other session).
    let t0 = 0;
    socket.addEventListener("message", () => { t0 = performance.now(); });
    // TLSocketRoom attaches its own message/close/error listeners to sockets that
    // support addEventListener (ws does). Adding ours as well would feed every
    // message to the room twice.
    this.room.handleSocketConnect({ sessionId, socket: socket as never });
    socket.addEventListener("message", (ev) => {
      const size = typeof ev.data === "string" ? ev.data.length : 0;
      recordTiming("sync.message", performance.now() - t0, size);
    });
  }

  // --- writes ------------------------------------------------------------------

  // Synchronous, attributed write. Records are validated against the schema.
  closed = false;

  write(source: ChangeSource, fn: (ops: WriteOps) => void): void {
    if(this.isArchived())throw Object.assign(Error("Board is archived; explicitly restore it before editing"),{status:410});
    if (this.closed) return;
    const txnId = `board:${++this.txnSeq}`;
    this.pendingSources.set(txnId, source);
    try {
      this.storage.transaction(
        // biome-ignore lint/suspicious/noExplicitAny: storage txn typing.
        (txn: any) => {
          fn({
            get: (id) => (txn.get(id) as Rec | undefined) ?? undefined,
            put: (input) => {
              // Drop undefined fields (tldraw meta must be JSON).
              const json = JSON.stringify(input);
              const record = JSON.parse(json) as Rec;
              if (record.typeName === "document") record.meta = migrateWorkspaceMeta(record.meta);
              // A put of exactly what is stored (same fields in the same order) is dropped:
              // otherwise it still takes a new clock, a broadcast to every tab, the change
              // listeners and a save. Counted as room.write.unchanged.
              const stored = txn.get(record.id);
              if (stored && record.typeName !== "document" && JSON.stringify(stored) === json) {
                recordTiming("room.write.unchanged", 0, 1);
                return;
              }
              const type = (schema.types as Record<string, { validate(r: unknown, before?: unknown): unknown }>)[
                record.typeName
              ];
              if (!type) throw new Error(`unknown record type ${record.typeName}`);
              const before = txn.get(record.id);
              try {
                type.validate(record, before ?? undefined);
              } catch (e) {
                throw Object.assign(new Error(`invalid ${record.typeName} ${record.id}: ${(e as Error).message}`), { status: 400 });
              }
              txn.set(record.id, record);
            },
            remove: (id) => txn.delete(id),
          });
        },
        { id: txnId },
      );
    } finally {
      this.pendingSources.delete(txnId);
    }
  }

  private committed(txnId: string | undefined, since: number): void {
    if(this.closed||this.isArchived())return;
    // biome-ignore lint/suspicious/noExplicitAny: storage txn typing.
    const result = this.storage.transaction((txn: any) => txn.getChangesSince(since), { id: "board:read" });
    const diff = result?.result?.diff ?? result?.diff;
    if (!diff) return;
    // A commit removing many shapes at once (bulk delete, clear, a restore that replaces them):
    // hand the board as it was just before to the snapshot hook (server/board-snapshots.ts).
    // this.records is still the state before this commit here.
    const deletes: string[] = diff.deletes ?? [];
    if (bulkDeleteHook && deletes.length > BULK_DELETE_SHAPES) {
      let shapes = 0;
      for (const id of deletes) if (this.records.get(id)?.typeName === "shape") shapes++;
      if (shapes > BULK_DELETE_SHAPES) {
        try {
          bulkDeleteHook(this, [...this.records.values()], shapes);
        } catch (e) {
          this.log(`board ${this.id}: pre-delete snapshot failed: ${(e as Error).message}`);
        }
      }
    }
    const changes: RecordChange[] = [];
    for (const [id, put] of Object.entries(diff.puts ?? {})) {
      const after = (Array.isArray(put) ? put[1] : put) as Rec;
      changes.push({ id, before: this.records.get(id) ?? null, after });
      this.records.set(id, after);
    }
    for (const id of diff.deletes ?? []) {
      changes.push({ id, before: this.records.get(id) ?? null, after: null });
      this.records.delete(id);
    }
    if (changes.length === 0) return;
    this.changeSeq++;
    this.lastChangeAt = Date.now();
    this.dirty = true;
    let source: ChangeSource;
    if (txnId === ROOM_TXN) {
      const sid = this.lastPusher.get(changes[0].id) ?? "unknown";
      const info = this.sessions.get(sid) ?? { userId: "unknown", name: "User" };
      source = { kind: "human", sessionId: sid, userId: info.userId, name: info.name };
    } else {
      source = (txnId && this.pendingSources.get(txnId)) || { kind: "server", reason: txnId ?? "untagged" };
    }
    this.scheduleSave();
    const t0 = performance.now();
    listenerDepth++;
    try {
      this.listener(this, source, changes);
    } catch (e) {
      this.log(`board ${this.id}: change listener failed: ${(e as Error).stack}`);
    }
    listenerDepth--;
    const listenerMs = performance.now() - t0;
    // Per source kind (human/agent/server); a listener that ran inside another listener's
    // synchronous write (a nested write) is also counted as nested, since its time is part
    // of the outer one too.
    recordTiming(`change.listener.${source.kind}`, listenerMs, changes.length);
    if (listenerDepth > 0) recordTiming("change.listener.nested", listenerMs, changes.length);
  }

  // --- persistence ---------------------------------------------------------------

  // Background saves. A change marks the room dirty; the snapshot is written SAVE_TIMING.idleMs
  // after the last change, but never later than SAVE_TIMING.maxMs after the first unsaved one
  // (agents write all day, so a pure debounce would never fire). The snapshot and its
  // serialization run on the loop (they must see one consistent state), incrementally: only
  // records changed since the last save are stringified (see serialize). The file write and
  // the rename into place run on libuv's pool. One background write at a time; changes that
  // land during it are saved by the next one.
  //
  // save() stays synchronous: callers use it as a durability point before external effects,
  // and close()/archive rely on it. Every save takes a new generation, and a background write
  // renames its file into place only if no later save started and the room is still open; a
  // synchronous save deletes the background temp file before renaming its own, so a rename
  // already on its way fails (ENOENT) or lands first. An older snapshot never replaces a
  // newer one and nothing lands after an archive.
  private scheduleSave(): void {
    const now = Date.now();
    if (!this.firstDirtyAt) this.firstDirtyAt = now;
    this.lastDirtyAt = now;
    // A running timer re-reads lastDirtyAt when it fires; a write in flight re-arms when done.
    if (!this.saveTimer && !this.writing) this.armSave();
  }

  private armSave(): void {
    const due = Math.min(this.lastDirtyAt + SAVE_TIMING.idleMs, this.firstDirtyAt + SAVE_TIMING.maxMs);
    this.saveTimer = setTimeout(() => this.onSaveTimer(), Math.max(0, due - Date.now()));
  }

  private onSaveTimer(): void {
    this.saveTimer = null;
    if (!this.dirty || this.closed || this.detached || this.writing) return;
    const due = Math.min(this.lastDirtyAt + SAVE_TIMING.idleMs, this.firstDirtyAt + SAVE_TIMING.maxMs);
    if (Date.now() < due) {
      this.armSave();
      return;
    }
    this.saveInBackground();
  }

  // --- incremental serialization ---------------------------------------------------
  //
  // The snapshot file is JSON.stringify({boardId, savedAt, snapshot}). Its bulk is
  // snapshot.documents, one {state, lastChangedClock} entry per record, and the storage
  // replaces an entry object on every write (InMemorySyncStorage txn.set) and never edits
  // one in place; BoardRoom.write deep-copies what it stores, and no server code writes to
  // a record it read from room.records or ops.get (they spread a copy and put that). So
  // an entry's JSON is cached against the entry object, and a save stringifies only the
  // entries that changed since the last one; the rest of the file (clocks, tombstones,
  // schema) is stringified whole. The bytes are written as a list of buffers (writev), so
  // the file text is never joined on the loop either. Output is byte-identical to
  // JSON.stringify of getCurrentSnapshot(): same fields in the same order (Object.entries
  // follows the same own-key order as JSON.stringify), same separators.
  //
  // Guard: synchronous saves (close, archive, save()) always write a full JSON.stringify of
  // room.getCurrentSnapshot(), and they and every SAVE_CHECK.every-th background save
  // compare it with the incremental bytes. A mismatch (a stored record edited in place, or a
  // tldraw upgrade changing the snapshot's shape) is logged, and the room serializes with
  // JSON.stringify from then on.
  private entryJson = new WeakMap<object, Buffer>();
  private incremental = true;
  private backgroundSaves = 0;

  // The storage's state as InMemorySyncStorage.getSnapshot() returns it (same fields, same
  // order), read straight from the storage with the tombstones already as JSON text:
  // getSnapshot builds a tombstone object (up to tldraw's 5,000 cap when agents create and
  // delete all day) only for JSON.stringify to walk it again.
  // These fields are @internal in tldraw's types; if they ever go missing the room falls
  // back to JSON.stringify (and the guard would catch any other drift).
  private readState(): Record<string, unknown> | null {
    const s = this.storage as unknown as StorageInternals;
    try {
      let tombstones = "";
      for (const [id, clock] of s.tombstones.entries()) tombstones += `${tombstones ? "," : "{"}${JSON.stringify(id)}:${JSON.stringify(clock)}`;
      return {
        tombstoneHistoryStartsAtClock: s.tombstoneHistoryStartsAtClock.get(),
        documentClock: s.documentClock.get(),
        documents: Array.from(s.documents.values()),
        tombstones: new RawJson(tombstones ? `${tombstones}}` : "{}"),
        schema: s.schema.get(),
      };
    } catch (e) {
      this.incremental = false;
      this.log(`board ${this.id}: cannot read the sync storage for incremental saves, saving with JSON.stringify: ${(e as Error).message}`);
      return null;
    }
  }

  private serialize(savedAt: string, snapshot: Record<string, unknown>): { parts: Buffer[]; bytes: number; hits: number; misses: number } {
    const parts: Buffer[] = [];
    let bytes = 0;
    let hits = 0;
    let misses = 0;
    const push = (b: Buffer) => {
      parts.push(b);
      bytes += b.length;
    };
    let text = `{"boardId":${JSON.stringify(this.id)},"savedAt":${JSON.stringify(savedAt)},"snapshot":{`;
    let first = true;
    for (const [key, value] of Object.entries(snapshot)) {
      if (key === "documents" && Array.isArray(value)) {
        push(Buffer.from(`${text}${first ? "" : ","}"documents":[`));
        for (let i = 0; i < value.length; i++) {
          const entry = value[i] as object;
          let b = this.entryJson.get(entry);
          if (b) hits++;
          else {
            const s = JSON.stringify(entry);
            // Unpooled: a small pooled Buffer would pin its whole 8 KB slab for as long as
            // the record stays unchanged.
            b = Buffer.allocUnsafeSlow(Buffer.byteLength(s));
            b.write(s);
            this.entryJson.set(entry, b);
            misses++;
          }
          if (i) push(COMMA);
          push(b);
        }
        text = "]";
      } else {
        const s = value instanceof RawJson ? value.json : JSON.stringify(value);
        if (s === undefined) continue;
        text += `${first ? "" : ","}${JSON.stringify(key)}:${s}`;
      }
      first = false;
    }
    push(Buffer.from(`${text}}}`));
    return { parts, bytes, hits, misses };
  }

  // Full JSON.stringify of room.getCurrentSnapshot() (what saves wrote before the cache),
  // compared with the incremental bytes when given. Returns the bytes to write.
  private checkedFull(savedAt: string, incremental: Buffer[] | null): Buffer {
    const t0 = performance.now();
    const full = Buffer.from(JSON.stringify({ boardId: this.id, savedAt, snapshot: this.room.getCurrentSnapshot() }));
    let mismatch = 0;
    if (incremental && !Buffer.concat(incremental).equals(full)) {
      mismatch = 1;
      this.incremental = false;
      this.entryJson = new WeakMap();
      this.log(`board ${this.id}: incremental snapshot differed from JSON.stringify (a stored record was edited in place); saving with JSON.stringify from now on`);
    }
    recordTiming("room.save.check", performance.now() - t0, mismatch);
    return full;
  }

  private saveInBackground(): void {
    if (this.isArchived() || this.closed) return;
    const gen = ++this.saveGen;
    this.dirty = false;
    this.firstDirtyAt = 0;
    const t0 = performance.now();
    const savedAt = new Date().toISOString();
    const state = this.incremental ? this.readState() : null;
    const t1 = performance.now();
    let data: Buffer[];
    let bytes: number;
    if (state) {
      const out = this.serialize(savedAt, state);
      data = out.parts;
      bytes = out.bytes;
      // ms: serialization time; extra: records served from the cache (misses: stringified).
      recordTiming("room.save.cached", performance.now() - t1, out.hits);
      if (out.misses) recordTiming("room.save.missed", 0, out.misses);
      if (++this.backgroundSaves % SAVE_CHECK.every === 0) {
        const full = this.checkedFull(savedAt, data);
        if (!this.incremental) {
          data = [full];
          bytes = full.length;
        }
      }
    } else {
      data = [this.checkedFull(savedAt, null)];
      bytes = data[0].length;
    }
    const t2 = performance.now();
    recordTiming("room.save.snapshot", t1 - t0);
    recordTiming("room.save.stringify", t2 - t1, bytes);
    const tmp = `${this.file}.bg-${process.pid}-${++tmpSeq}.tmp`;
    const started = performance.now();
    let onLoop = performance.now() - t0;
    // The temp file is created here, on the loop, so a superseding synchronous save (close,
    // archive, save()) can delete it at once: the write below only fills an fd it holds.
    let fd: number;
    try {
      fd = openSync(tmp, "w");
    } catch (e) {
      this.log(`board ${this.id}: background save failed, will retry: ${(e as Error).message}`);
      this.dirty = true;
      if (!this.firstDirtyAt) this.firstDirtyAt = Date.now();
      this.lastDirtyAt = Date.now();
      if (!this.saveTimer) this.armSave();
      return;
    }
    this.writingTmp = tmp;
    const superseded = () => gen !== this.saveGen || this.closed || this.detached;
    this.writing = writeAllAndClose(fd, data)
      .then(async () => {
        recordTiming("room.save.write", performance.now() - started, bytes);
        // A later synchronous save (or archive/close) owns the file now: drop this one.
        if (superseded() || this.isArchived()) {
          removeQuietly(tmp);
          return;
        }
        // The rename runs on libuv's pool too. A synchronous save (save(), close(), archive)
        // that starts before it completes deletes this temp file before writing its own
        // snapshot, and the file system orders the two: either the rename went first (and
        // the synchronous save's rename then replaces it) or the temp file is gone and the
        // rename fails with ENOENT. So an older snapshot never lands over a newer one.
        const r0 = performance.now();
        try {
          await SAVE_IO.rename(tmp, this.file);
        } catch (e) {
          if (superseded()) {
            removeQuietly(tmp);
            return;
          }
          throw e;
        }
        // Wall time of the rename, now off the loop (it was on the loop before).
        recordTiming("room.save.rename", performance.now() - r0);
        this.persisted = true;
        // The superseding save could not delete the temp file (an error other than ENOENT),
        // so this rename may have landed after its snapshot: write the current state again.
        if (superseded() && this.tmpRemoveFailed === tmp) {
          this.log(`board ${this.id}: a superseded background save may have landed late; saving again`);
          if (this.detached) return;
          if (this.closed) this.writeSync();
          else {
            this.dirty = true;
            if (!this.firstDirtyAt) this.firstDirtyAt = Date.now();
            this.lastDirtyAt = Date.now();
          }
          return;
        }
        // Event-loop time of this save (snapshot + serialization); write and rename are off-loop.
        recordTiming("room.save", onLoop, bytes);
      })
      .catch((e) => {
        this.log(`board ${this.id}: background save failed, will retry: ${(e as Error).message}`);
        removeQuietly(tmp);
        if (gen === this.saveGen && !this.closed && !this.detached) {
          this.dirty = true;
          if (!this.firstDirtyAt) this.firstDirtyAt = Date.now();
          this.lastDirtyAt = Date.now();
        }
      })
      .finally(() => {
        this.writing = null;
        this.writingTmp = null;
        if (this.dirty && !this.closed && !this.detached && !this.saveTimer) this.armSave();
      });
  }

  // Changed since the last save. A board nobody touched is not written at shutdown, so a
  // snapshot moved out of boards/ while the server runs (archiving proof boards) stays out.
  private dirty = false;
  private firstDirtyAt = 0;
  private lastDirtyAt = 0;
  private saveGen = 0;
  private writing: Promise<void> | null = null;
  private writingTmp: string | null = null;

  // Resolves when no background write is in flight (tests, orderly shutdown).
  async flushed(): Promise<void> {
    while (this.writing) await this.writing;
  }

  isArchived():boolean {
    if(this.detached)return true;
    if(existsSync(archivePaths(this.dir,this.id).marker)||(this.persisted&&!existsSync(this.file))){
      this.detached=true;this.closed=true;this.dirty=false;
      if(this.saveTimer)clearTimeout(this.saveTimer);this.saveTimer=null;
      markArchived(this.dir,this.id,'snapshot removed or explicitly archived');
      this.room.close();this.onDetached(this);this.log(`board ${this.id}: archived; later writes and shutdown will not recreate it`);return true;
    }return false;
  }

  save(): void {
    if(this.isArchived()||this.closed)return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    // Supersedes any background write in flight: it will not rename over this one, and its
    // temp file goes now, before this save renames its own (the write finishes into the
    // unlinked file, a pending rename fails with ENOENT), so nothing is left behind when
    // close() or archive returns.
    this.saveGen++;
    if (this.writingTmp && !removeQuietly(this.writingTmp)) this.tmpRemoveFailed = this.writingTmp;
    this.dirty = false;
    this.firstDirtyAt = 0;
    this.writeSync();
  }

  // A background temp file a superseding save could not delete (see saveInBackground).
  private tmpRemoveFailed: string | null = null;

  private writeSync(): void {
    const t0 = performance.now();
    const tmp = `${this.file}.tmp`;
    // Always the full JSON.stringify here (a durability point); it also checks the cache.
    const savedAt = new Date().toISOString();
    const state = this.incremental ? this.readState() : null;
    const json = this.checkedFull(savedAt, state ? this.serialize(savedAt, state).parts : null);
    writeFileSync(tmp, json);
    renameSync(tmp, this.file);
    this.persisted=true;
    recordTiming("room.save", performance.now() - t0, json.length);
    recordTiming("room.save.sync", performance.now() - t0, json.length);
  }

  stats(): { id: string; records: number; sessions: number } {
    return { id: this.id, records: this.records.size, sessions: this.sessions.size };
  }

  close(): void {
    if(this.isArchived()||this.closed)return;
    // A background write in flight may not finish before the process exits: write synchronously.
    if (this.dirty || this.saveTimer || this.writing) this.save();
    if(this.closed)return;
    this.closed = true;
    this.room.close();
  }
}

// Write all of `data` (in order) to an open fd off the event loop, then close it.
// libuv splits a writev longer than IOV_MAX itself; a short write resumes where it stopped.
function writeAllAndClose(fd: number, data: Buffer[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const step = (bufs: Buffer[]) => {
      if (!bufs.length) return closeFd(fd, (e) => (e ? reject(e) : resolve()));
      writevFd(fd, bufs, null, (e, n) => {
        if (e || n === 0) return closeFd(fd, () => reject(e ?? new Error("write made no progress")));
        let i = 0;
        while (i < bufs.length && n >= bufs[i].length) n -= bufs[i++].length;
        const rest = bufs.slice(i);
        if (n > 0) rest[0] = rest[0].subarray(n);
        step(rest);
      });
    };
    step(data.filter((b) => b.length > 0));
  });
}

// False only when the file may still be there (an error other than ENOENT).
function removeQuietly(file: string): boolean {
  try {
    unlinkSync(file);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT";
  }
  return true;
}

export function authorFor(source: ChangeSource): Author | null {
  if (source.kind === "human") return { kind: "human", userId: source.userId, name: source.name };
  if (source.kind === "agent") return { kind: "agent", agentId: source.agentId };
  return null;
}

function archivePaths(dir:string,id:string){const root=path.join(dir,'.archived');return {root,marker:path.join(root,encodeURIComponent(id)+'.marker.json'),snapshot:path.join(root,encodeURIComponent(id)+'.snapshot.json')};}
function markArchived(dir:string,id:string,reason:string){const p=archivePaths(dir,id);if(existsSync(p.marker))return;mkdirSync(p.root,{recursive:true});const tmp=p.marker+'.tmp';writeFileSync(tmp,JSON.stringify({id,reason,at:new Date().toISOString()}));renameSync(tmp,p.marker);}

// Called with a board's records as they were just before one commit deleted more than
// BULK_DELETE_SHAPES shapes (server/board-snapshots.ts writes them to a snapshot).
export const BULK_DELETE_SHAPES = 25;
let bulkDeleteHook: ((room: BoardRoom, before: Rec[], shapes: number) => void) | null = null;
export function onBulkDelete(fn: ((room: BoardRoom, before: Rec[], shapes: number) => void) | null): void {
  bulkDeleteHook = fn;
}

export class BoardHost {
  private readonly rooms = new Map<string, BoardRoom>();
  constructor(
    private readonly dir: string,
    private readonly listener: ChangeListener,
    private readonly log: (msg: string) => void,
    private readonly onDetached: (room:BoardRoom)=>void = ()=>{},
  ) {
    mkdirSync(dir, { recursive: true });
    // Background-save temp files left by a process killed mid-write (never the live snapshot).
    for (const f of readdirSync(dir)) {
      const m = /\.json\.bg-(\d+)-\d+\.tmp$/.exec(f);
      if (m && Number(m[1]) !== process.pid) try { unlinkSync(path.join(dir, f)); } catch {}
    }
  }

  static validId(id: string): boolean {
    return /^[a-zA-Z0-9_-]{1,64}$/.test(id);
  }

  private closed = false;

  exists(id: string): boolean {
    return BoardHost.validId(id) && !existsSync(archivePaths(this.dir,id).marker) && !this.rooms.get(id)?.isArchived() && (this.rooms.has(id) || existsSync(path.join(this.dir, `${encodeURIComponent(id)}.json`)));
  }

  get(id: string): BoardRoom {
    if (this.closed) throw new Error("board host is stopped");
    if (!BoardHost.validId(id)) throw new Error(`invalid board id ${id}`);
    if(existsSync(archivePaths(this.dir,id).marker))throw Object.assign(Error("Board is archived; explicitly restore it"),{status:410});
    let room = this.rooms.get(id);
    if(room?.isArchived())throw Object.assign(Error("Board is archived; explicitly restore it"),{status:410});
    if (!room) {
      room = new BoardRoom(id, this.dir, this.listener, this.log,this.onDetached);
      this.rooms.set(id, room);
    }
    return room;
  }

  // Load every persisted board so the watcher can resume bindings after a restart.
  loadAll(): BoardRoom[] {
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      const id = decodeURIComponent(f.slice(0, -5));
      if (BoardHost.validId(id)&&!existsSync(archivePaths(this.dir,id).marker)) this.get(id);
    }
    return [...this.rooms.values()].filter(r=>!r.isArchived());
  }

  all(): BoardRoom[] {
    return [...this.rooms.values()].filter(r=>!r.isArchived());
  }

  // Records of a board without opening its sync room (link cards poll other boards).
  // Loaded rooms answer live; others are read from their snapshot, cached by mtime.
  private readonly peeks = new Map<string, { mtime: number; records: RecMap }>();

  peek(id: string): RecMap | null {
    if (!BoardHost.validId(id)||existsSync(archivePaths(this.dir,id).marker)) return null;
    const room = this.rooms.get(id);
    if (room) return room.isArchived()?null:room.records;
    const file = path.join(this.dir, `${encodeURIComponent(id)}.json`);
    try {
      const mtime = statSync(file).mtimeMs;
      const hit = this.peeks.get(id);
      if (hit && hit.mtime === mtime) return hit.records;
      const snap = JSON.parse(readFileSync(file, "utf8")).snapshot as RoomSnapshot;
      const records: RecMap = new Map();
      for (const d of snap.documents) records.set((d.state as unknown as Rec).id, d.state as unknown as Rec);
      this.peeks.set(id, { mtime, records });
      if (this.peeks.size > 200) this.peeks.delete(this.peeks.keys().next().value as string);
      return records;
    } catch {
      return null;
    }
  }

  archive(id:string){
    const room=this.get(id);
    if([...room.records.values()].some(r=>r.type==='frame'&&(r.meta?.paseo?.request||r.meta?.paseo?.deltaDelivery?.status==='sending'||['running','requested','needs-permission'].includes(r.meta?.paseo?.status))))throw Object.assign(Error('Finish active frame turns and binds before archiving this board'),{status:409});
    room.save();const p=archivePaths(this.dir,id);mkdirSync(p.root,{recursive:true});
    // Keep the first archive until it is restored; never overwrite an older backup.
    if(existsSync(p.snapshot))throw Object.assign(Error('Archive backup already exists; restore or retain it explicitly first'),{status:409});
    markArchived(this.dir,id,'explicit archive');room.isArchived();renameSync(path.join(this.dir,encodeURIComponent(id)+'.json'),p.snapshot);return {boardId:id,status:'archived',agentsArchived:false};
  }

  restore(id:string){
    if(!BoardHost.validId(id))throw Object.assign(Error('Invalid board id'),{status:400});const p=archivePaths(this.dir,id);
    if(!existsSync(p.marker))throw Object.assign(Error('Board is not archived'),{status:409});
    const file=path.join(this.dir,encodeURIComponent(id)+'.json');const source=existsSync(p.snapshot)?p.snapshot:file;
    if(!existsSync(source))throw Object.assign(Error('Copy the archived snapshot back to its original board path before restoring'),{status:409});
    const raw=readFileSync(source,'utf8');const data=JSON.parse(raw);const snap=data.snapshot as RoomSnapshot;if(!snap||!Array.isArray(snap.documents))throw Object.assign(Error('Archive snapshot is invalid'),{status:409});const previous=snap.documentClock??snap.documents.reduce((n,d)=>Math.max(n,d.lastChangedClock??0),0);if(!Number.isSafeInteger(previous)||previous<0||previous>=Number.MAX_SAFE_INTEGER)throw Object.assign(Error('Archive clock is invalid'),{status:409});const clock=previous+1;
    for(const d of snap.documents){const rec=d.state as unknown as Rec;if(rec.type==='frame'&&rec.meta?.paseo){const old=rec.meta.paseo;rec.meta={...rec.meta,paseo:{...(old.agentId?{relink:{agentId:old.agentId,...(old.host?{host:old.host}:{}),reason:'restored-or-copied',requiresConfirmation:true}}:{}),error:'Restored board is unbound; explicitly re-link existing conversations.'}};rec.props={...rec.props,color:'black'};d.lastChangedClock=clock;}
      const validator=(schema.types as Record<string,{validate(r:unknown):unknown}>)[rec.typeName];if(!validator)throw Object.assign(Error('Archive schema is incompatible'),{status:409});validator.validate(rec);
    }
    snap.documentClock=clock;const probe=new TLSocketRoom<TLRecord,void>({schema,storage:new InMemorySyncStorage<TLRecord>({snapshot:snap})});try{data.snapshot=probe.getCurrentSnapshot();}finally{probe.close();}const retained=path.join(p.root,encodeURIComponent(id)+'.restored-'+randomUUID()+'.snapshot.json');writeFileSync(retained,raw,{flag:'wx'});const tmp=file+'.restore.tmp';writeFileSync(tmp,JSON.stringify(data));renameSync(tmp,file);unlinkSync(p.marker);if(existsSync(p.snapshot))unlinkSync(p.snapshot);this.rooms.delete(id);this.peeks.delete(id);this.get(id);return {boardId:id,status:'restored-unbound',agentsCreated:0};
  }

  closeAll(): void {
    this.closed = true;
    for (const r of this.rooms.values()) {
      try {
        r.close();
      } catch (e) {
        this.log(`close ${r.id} failed: ${(e as Error).message}`);
      }
    }
    this.rooms.clear();
  }
}

// Asset URLs are stored absolute (tldraw's validators want http(s) URLs). When the board
// moves host or port (8791 -> 8793 on 2026-10-27), rewrite the board's own asset links
// (images, file artifacts) to the current public base. Other URLs are left alone.
export function migrateAssetOrigins(room: BoardRoom, publicBase: string, log: (m: string) => void): number {
  const want = new URL(publicBase);
  const fix = (url: unknown): string | null => {
    if (typeof url !== "string") return null;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (!u.pathname.startsWith("/api/assets/") || u.origin === want.origin) return null;
    const ours = u.hostname === want.hostname || u.hostname === "127.0.0.1" || u.hostname === "localhost";
    return ours ? `${want.origin}${u.pathname}` : null;
  };
  const changed: Rec[] = [];
  for (const r of room.records.values()) {
    if (r.typeName === "asset") {
      const src = fix(r.props?.src);
      if (src) changed.push({ ...r, props: { ...r.props, src } });
    } else if (r.typeName === "shape" && r.type === "bookmark") {
      const url = fix(r.props?.url);
      if (url) changed.push({ ...r, props: { ...r.props, url } });
    }
  }
  if (!changed.length) return 0;
  room.write({ kind: "server", reason: "asset-origin" }, (ops) => {
    for (const r of changed) ops.put(r);
  });
  log(`board ${room.id}: moved ${changed.length} asset link(s) to ${want.origin}`);
  return changed.length;
}
