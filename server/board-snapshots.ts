// Automatic board snapshots, so a board emptied by mistake can be brought back.
//
// Every 10 minutes, each open board whose records changed since its last snapshot is written
// to <state>/snapshots/<board>/<stamp>.json.gz: its records and the schema, gzipped (assets
// are content-addressed files in <state>/assets and are not copied). A commit that deletes
// more than BULK_DELETE_SHAPES shapes at once (select-all delete, clear, a restore that
// replaces them) snapshots the board as it was just before, at once.
//
// Retention: every snapshot for 48 h, then the newest of each UTC day for 30 days, then none.
// Writing is skipped (and logged) while the disk has less than MIN_FREE_BYTES free.
//
// Restore never overwrites a board: restoreCopy() makes a NEW board "<board>-restored-<stamp>"
// from a snapshot, its frames unbound (as an archive restore leaves them: a relink offer, no
// agent driven), and returns its id. The routes are in server/http.ts:
//   GET  /api/ui/boards/<id>/snapshots                       list, newest first
//   POST /api/ui/boards/<id>/snapshots/<stamp>/restore-copy  { boardId, url }
// Snapshots live under the state directory, so `bunny backup` archives them with the boards.
// Operator steps: docs/board-snapshots.md.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statfsSync, unlinkSync, writeFileSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzipSync, gzip } from "node:zlib";
import { InMemorySyncStorage, TLSocketRoom, type RoomSnapshot } from "@tldraw/sync-core";
import type { TLRecord } from "@tldraw/tlschema";
import { BoardHost, onBulkDelete, schema } from "./room-host";

const gzipAsync = promisify(gzip);

type Rec = { id: string; typeName: string; type?: string; parentId?: string; props?: Record<string, unknown>; meta?: Record<string, any> };

export const SNAPSHOT_INTERVAL_MS = 10 * 60_000;
export const KEEP_ALL_MS = 48 * 3_600_000;
export const KEEP_DAILY_MS = 30 * 86_400_000;
export const MIN_FREE_BYTES = 512 * 1024 * 1024;

// "2026-11-04T02:10:00.123Z" <-> "20261104T021000123Z" (file and URL safe, sorts by time).
export function stampOf(at: Date): string {
  return at.toISOString().replace(/[-:.]/g, "");
}
export function timeOfStamp(stamp: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/.exec(stamp);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]) : null;
}

// Which stamps retention removes at `now`: none within 48 h; between 48 h and 30 days, all but
// the newest of each UTC day; everything older.
export function stampsToPrune(stamps: string[], now: number): string[] {
  const out: string[] = [];
  const keptDay = new Set<string>();
  for (const s of [...stamps].sort().reverse()) {
    const t = timeOfStamp(s);
    if (t === null) continue;
    const age = now - t;
    if (age <= KEEP_ALL_MS) continue;
    if (age > KEEP_DAILY_MS) {
      out.push(s);
      continue;
    }
    const day = s.slice(0, 8);
    if (keptDay.has(day)) out.push(s);
    else keptDay.add(day);
  }
  return out;
}

export type SnapshotInfo = { stamp: string; at: string; reason: string; records: number; shapes: number; frames: number; bytes: number };
type SnapshotFile = { version: 1; boardId: string; at: string; reason: string; schema: unknown; records: Rec[] };

// A frame's agent binding becomes a relink offer, as BoardHost.restore() leaves an archived
// board: the copy shows the conversations but drives no agent until someone relinks.
export function unbound(rec: Rec): Rec {
  if (rec.type !== "frame" || !rec.meta?.paseo) return rec;
  const old = rec.meta.paseo as { agentId?: string; host?: string };
  return {
    ...rec,
    meta: { ...rec.meta, paseo: { ...(old.agentId ? { relink: { agentId: old.agentId, ...(old.host ? { host: old.host } : {}), reason: "restored-or-copied", requiresConfirmation: true } } : {}), error: "Restored board is unbound; explicitly re-link existing conversations." } },
    props: { ...rec.props, color: "black" },
  };
}

export class BoardSnapshots {
  private readonly last = new Map<string, number>(); // board -> changeSeq at its last snapshot
  private timer: ReturnType<typeof setInterval> | null = null;
  private writing: Promise<unknown> = Promise.resolve();

  constructor(
    readonly dir: string,
    private readonly host: BoardHost,
    private readonly boardsDir: string,
    private readonly log: (m: string) => void,
    private readonly opts: { now?: () => number; minFreeBytes?: number } = {},
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  start(intervalMs = SNAPSHOT_INTERVAL_MS): void {
    mkdirSync(this.dir, { recursive: true });
    onBulkDelete((room, before, shapes) => void this.write(room.id, before, `before deleting ${shapes} shapes`));
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    onBulkDelete(null);
  }

  // Snapshots every open board changed since its last one; then prunes. Resolves when written.
  async tick(): Promise<void> {
    for (const room of this.host.all()) {
      if (this.last.get(room.id) === room.changeSeq) continue;
      // First look since this process started: unchanged since its newest snapshot (a restart)?
      if (!this.last.has(room.id)) {
        const newest = this.stamps(room.id).at(-1);
        if (newest && (timeOfStamp(newest) ?? 0) >= room.lastChangeAt) {
          this.last.set(room.id, room.changeSeq);
          continue;
        }
      }
      this.last.set(room.id, room.changeSeq);
      await this.write(room.id, [...room.records.values()], "every 10 minutes");
    }
  }

  // Writes one snapshot (atomically: a .tmp file renamed into place), then prunes that board.
  write(boardId: string, records: Rec[], reason: string): Promise<SnapshotInfo | null> {
    const at = new Date(this.now());
    const job = this.writing.then(async () => {
      const dir = path.join(this.dir, encodeURIComponent(boardId));
      mkdirSync(dir, { recursive: true });
      const free = freeBytes(this.dir);
      const min = this.opts.minFreeBytes ?? MIN_FREE_BYTES;
      if (free !== null && free < min) {
        this.log(`board snapshots: skipped ${boardId} (${reason}): only ${Math.round(free / 1048576)} MB free, need ${Math.round(min / 1048576)} MB`);
        return null;
      }
      let stamp = stampOf(at);
      while (existsSync(path.join(dir, `${stamp}.json.gz`))) stamp = stampOf(new Date((timeOfStamp(stamp) ?? at.getTime()) + 1));
      const body: SnapshotFile = { version: 1, boardId, at: new Date(timeOfStamp(stamp)!).toISOString(), reason, schema: schema.serialize(), records };
      const gz = await gzipAsync(JSON.stringify(body));
      const file = path.join(dir, `${stamp}.json.gz`);
      await writeFile(`${file}.tmp`, gz);
      await rename(`${file}.tmp`, file);
      const info: SnapshotInfo = { stamp, at: body.at, reason, ...counts(records), bytes: gz.length };
      writeFileSync(path.join(dir, `${stamp}.meta.json`), JSON.stringify(info));
      this.prune(boardId);
      return info;
    });
    this.writing = job.catch((e) => this.log(`board snapshots: ${boardId} (${reason}) failed: ${(e as Error).message}`));
    return job;
  }

  // Resolves once every snapshot asked for so far is written (tests, shutdown).
  flushed(): Promise<unknown> {
    return this.writing;
  }

  prune(boardId: string): string[] {
    const dir = path.join(this.dir, encodeURIComponent(boardId));
    const stamps = this.stamps(boardId);
    const gone = stampsToPrune(stamps, this.now());
    for (const s of gone) {
      for (const f of [`${s}.json.gz`, `${s}.meta.json`]) try { unlinkSync(path.join(dir, f)); } catch {}
    }
    return gone;
  }

  private stamps(boardId: string): string[] {
    const dir = path.join(this.dir, encodeURIComponent(boardId));
    if (!existsSync(dir)) return [];
    return readdirSync(dir).map((f) => /^(\d{8}T\d{9}Z)\.json\.gz$/.exec(f)?.[1]).filter((s): s is string => !!s).sort();
  }

  // Snapshots of a board, newest first.
  list(boardId: string): SnapshotInfo[] {
    const dir = path.join(this.dir, encodeURIComponent(boardId));
    return this.stamps(boardId)
      .reverse()
      .map((stamp) => {
        try {
          return JSON.parse(readFileSync(path.join(dir, `${stamp}.meta.json`), "utf8")) as SnapshotInfo;
        } catch {
          // No side file (copied in by hand): read the snapshot itself.
          const body = this.read(boardId, stamp);
          return { stamp, at: body.at, reason: body.reason, ...counts(body.records), bytes: 0 };
        }
      });
  }

  read(boardId: string, stamp: string): SnapshotFile {
    if (timeOfStamp(stamp) === null) throw Object.assign(new Error("invalid snapshot"), { status: 400 });
    const file = path.join(this.dir, encodeURIComponent(boardId), `${stamp}.json.gz`);
    if (!existsSync(file)) throw Object.assign(new Error("no such snapshot"), { status: 404 });
    return JSON.parse(gunzipSync(readFileSync(file)).toString("utf8")) as SnapshotFile;
  }

  // A new board "<board>-restored-<stamp>" from a snapshot (frames unbound); the board the
  // snapshot came from is not touched. Returns the new board's id.
  restoreCopy(boardId: string, stamp: string): string {
    const body = this.read(boardId, stamp);
    const suffix = `-restored-${stamp.slice(0, 15)}`; // ...-restored-20261104T021000
    let id = `${boardId.slice(0, 64 - suffix.length - 3)}${suffix}`;
    for (let n = 2; this.host.exists(id) || existsSync(path.join(this.boardsDir, `${encodeURIComponent(id)}.json`)); n++) id = `${boardId.slice(0, 64 - suffix.length - 3)}${suffix}-${n}`;
    if (!BoardHost.validId(id)) throw Object.assign(new Error("cannot name the copy"), { status: 400 });
    const records = body.records.map(unbound);
    const snapshot = { documents: records.map((state) => ({ state, lastChangedClock: 0 })), documentClock: 0, tombstones: {}, schema: body.schema } as unknown as RoomSnapshot;
    // Through a room: migrates records written by an older schema, and validates them.
    const probe = new TLSocketRoom<TLRecord, void>({ schema, storage: new InMemorySyncStorage<TLRecord>({ snapshot }) });
    let migrated: RoomSnapshot;
    try {
      migrated = probe.getCurrentSnapshot();
    } finally {
      probe.close();
    }
    mkdirSync(this.boardsDir, { recursive: true });
    const file = path.join(this.boardsDir, `${encodeURIComponent(id)}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify({ boardId: id, savedAt: new Date(this.now()).toISOString(), restoredFrom: { boardId, snapshot: stamp, at: body.at }, snapshot: migrated }), { flag: "wx" });
    renameSync(`${file}.tmp`, file);
    this.host.get(id);
    this.log(`board snapshots: restored ${boardId} @ ${body.at} as a new board ${id} (${counts(records).shapes} shapes, frames unbound)`);
    return id;
  }
}

function counts(records: Rec[]): { records: number; shapes: number; frames: number } {
  let shapes = 0, frames = 0;
  for (const r of records) {
    if (r.typeName !== "shape") continue;
    shapes++;
    if (r.type === "frame") frames++;
  }
  return { records: records.length, shapes, frames };
}

function freeBytes(dir: string): number | null {
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}
