// The running server's half of `bunny backup`: write every open board, frame history and
// frame archive to disk now, so the backup copies what the board holds rather than whatever
// the debounced background saves had reached. Every state file is written to a temp file and
// renamed into place, so a file is never half-written; the backup skips the temp files.
//
// POST /api/backup/flush, from loopback only, with "Authorization: Bearer <backupToken>".
// The token is derived from <state>/secret: whoever can read the state directory (and so
// could copy it anyway) can ask for a flush, and nobody else.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { FrameArchive } from "../frame-archive";
import type { FrameHistory } from "../frame-history";
import type { BoardHost } from "../room-host";

export const FLUSH_PATH = "/api/backup/flush";

export function backupToken(secret: string): string {
  return createHmac("sha256", secret).update("bunny-backup:flush").digest("hex");
}

export function checkBackupToken(secret: string, header: string | undefined): boolean {
  const got = Buffer.from(String(header ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(backupToken(secret));
  return got.length === want.length && timingSafeEqual(got, want);
}

export function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/, "");
  return a === "::1" || /^127\./.test(a);
}

export interface FlushResult {
  ok: true;
  savedAt: string;
  boards: { id: string; records: number }[];
}

export async function flushForBackup(host: BoardHost, history: FrameHistory | null, archive: FrameArchive | null): Promise<FlushResult> {
  const boards: FlushResult["boards"] = [];
  for (const room of host.all()) {
    room.save();
    boards.push({ id: room.id, records: room.records.size });
  }
  history?.persistNow();
  archive?.persistNow();
  await history?.flushed();
  return { ok: true, savedAt: new Date().toISOString(), boards };
}
