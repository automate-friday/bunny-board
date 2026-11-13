// board_snapshot: a picture of a frame as a person's browser draws it, for the frame's agent.
//
// Agents read their frame as a text outline, so they could not check how it looks. The
// server has no renderer (no browser, no fonts), and the canvas already draws frames to
// images (History, Archive). So take() sends an out-of-band message to every browser that
// has the board open (not a document change: nothing is saved or put in History); the
// first one to post a PNG back answers the agent. Each canvas draws the frame in a hidden
// off-screen editor, so it works whichever page the person is looking at.
//
// With no browser connected, or none answering in time, the agent gets the last picture
// taken of the same frame (same area) with its age, or a plain statement that there is none.
// Pictures are kept in memory only: a restart forgets them.

import { randomUUID } from "node:crypto";
import { inspectImage } from "./file-intake";
import { MAX_SNAPSHOT_BYTES, SNAPSHOT_MAX_EDGE, SNAPSHOT_MESSAGE, type SnapshotArea, type SnapshotRequest } from "../shared/frame-snapshot";

export const SNAPSHOT_WAIT_MS = 10_000;
// All kept pictures together; the oldest go first.
const KEEP_BYTES = 32 * 1024 * 1024;

export interface StoredSnapshot { data: Buffer; mimeType: "image/png"; width: number; height: number; at: number; dark: boolean }
export interface SnapshotResult { image: StoredSnapshot | null; fresh: boolean; viewers: number }
// What take() needs of a board room.
export interface SnapshotRoom { id: string; broadcast(data: unknown): number }

interface Waiter { requestId: string; promise: Promise<SnapshotResult>; settle(image: StoredSnapshot | null): void }

const key = (boardId: string, frameId: string, area: SnapshotArea | null) => `${boardId}\n${frameId}\n${area ? `${area.x},${area.y},${area.w},${area.h}` : "all"}`;

export class FrameSnapshots {
  private readonly last = new Map<string, StoredSnapshot>();
  private readonly waiting = new Map<string, Waiter>();

  constructor(private readonly waitMs = SNAPSHOT_WAIT_MS, private readonly now: () => number = Date.now) {}

  // Ask the board's browsers for a picture of the frame (or of one area of it) and wait
  // for the first. Calls for the same frame and area while one is in flight share it.
  take(room: SnapshotRoom, frameId: string, area: SnapshotArea | null = null): Promise<SnapshotResult> {
    const k = key(room.id, frameId, area);
    const flying = this.waiting.get(k);
    if (flying) return flying.promise;
    const request: SnapshotRequest = { type: SNAPSHOT_MESSAGE, requestId: randomUUID(), frameId, area, maxEdge: SNAPSHOT_MAX_EDGE };
    const viewers = room.broadcast(request);
    if (!viewers) return Promise.resolve({ image: this.last.get(k) ?? null, fresh: false, viewers: 0 });
    let settle!: (image: StoredSnapshot | null) => void;
    const promise = new Promise<SnapshotResult>((resolve) => {
      const timer = setTimeout(() => settle(null), this.waitMs);
      timer.unref?.();
      settle = (image) => {
        if (this.waiting.get(k)?.requestId !== request.requestId) return;
        clearTimeout(timer);
        this.waiting.delete(k);
        resolve(image ? { image, fresh: true, viewers } : { image: this.last.get(k) ?? null, fresh: false, viewers });
      };
    });
    this.waiting.set(k, { requestId: request.requestId, promise, settle });
    return promise;
  }

  // A browser's answer. Only the first PNG for a request still being waited for is taken;
  // anything else (late, duplicate, unknown request) is refused, so this route cannot be
  // used to plant a picture nobody asked for.
  accept(boardId: string, frameId: string, requestId: string, bytes: Buffer, dark = false): StoredSnapshot {
    const found = [...this.waiting.entries()].find(([k, w]) => w.requestId === requestId && k.startsWith(`${boardId}\n${frameId}\n`));
    if (!found) throw Object.assign(new Error("No snapshot is being waited for with this request (already answered, or it timed out)"), { status: 409 });
    if (bytes.length > MAX_SNAPSHOT_BYTES) throw Object.assign(new Error(`Snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes`), { status: 413 });
    const info = inspectImage(bytes); // throws on anything that is not a complete image
    if (info.mimeType !== "image/png") throw Object.assign(new Error("Snapshot must be a PNG"), { status: 400 });
    const image: StoredSnapshot = { data: bytes, mimeType: "image/png", width: info.w, height: info.h, at: this.now(), dark };
    const [k, waiter] = found;
    this.last.delete(k);
    this.last.set(k, image);
    let total = 0;
    for (const s of this.last.values()) total += s.data.length;
    for (const [old, s] of this.last) {
      if (total <= KEEP_BYTES || old === k) break;
      this.last.delete(old);
      total -= s.data.length;
    }
    waiter.settle(image);
    return image;
  }
}
