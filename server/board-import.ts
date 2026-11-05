import { withDaemonRead } from './daemon-health';
// Importing existing Paseo conversations onto a board: one frame per agent on a
// 4-wide grid, each bound to its agent through the link flow and holding a compact
// transcript card at its top-left. Used by the canvas picker (/api/ui/boards/:id/import)
// and by the Paseo app's "Add to board" (plugin RPC board.add-agent).

import { getIndexAbove } from "@tldraw/utils";
import { TRANSCRIPT_TYPE, transcriptDefaults } from "../shared/components/transcript";
import type { AgentDirectory } from "./agent-directory";
import type { BoardConfig } from "./config";
import type { FrameWatcher } from "./frame-watcher";
import { createHash } from "node:crypto";
import { type Box, gridSlots, IMPORT_FRAME, topLevelBounds } from "./layout";
import type { PaseoBridge } from "./paseo-bridge";
import type { RemoteAgents } from "./remote";
import { baseShape, type FrameStatus, nextIndex, type Rec } from "./records";
import type { BoardHost } from "./room-host";

export const MAX_IMPORT = 48;

export interface ImportInput {
  pageId?: string | null;
  agentIds: string[];
  // Page point where the grid starts (the right-click point). Else below the content.
  at?: { x: number; y: number } | null;
  // Bind one agent to this existing, unbound frame instead of creating frames.
  frameId?: string | null;
  // The agents run on this other machine (af-network host, e.g. "mac-2").
  host?: string | null;
  // Idempotency key: a repeated request (double click, retry) returns the first result.
  requestId?: string | null;
  by?: string | null;
  // Page bounds the canvas measured (text, drawings): kept clear as well as the
  // server's own estimates.
  occupied?: Array<{ x: number; y: number; w: number; h: number }> | null;
}

export interface ImportedFrame {
  agentId: string;
  frameId: string;
  cardId: string | null;
  pending?: boolean;
  title: string;
  url: string;
}

export interface ImportResult {
  boardId: string;
  created: ImportedFrame[];
  skipped: Array<{ agentId: string; reason: string; boardId?: string; frameId?: string }>;
  url: string | null;
}

const CARD_INSET = 20;
const REQUEST_TTL_MS = 10 * 60_000;

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

export class BoardImporter {
  private readonly requests = new Map<string, { at: number; result: Promise<ImportResult> }>();

  constructor(
    private readonly cfg: BoardConfig,
    private readonly host: BoardHost,
    private readonly watcher: FrameWatcher,
    private readonly directory: AgentDirectory,
    private readonly bridge: PaseoBridge,
    private readonly log: (m: string) => void,
    private readonly remote: RemoteAgents | null = null,
  ) {}

  import(boardId: string, input: ImportInput): Promise<ImportResult> {
    const now = Date.now();
    for (const [k, v] of this.requests) if (now - v.at > REQUEST_TTL_MS) this.requests.delete(k);
    // Keyed on the request too: a retry with the same id but another selection is a new import.
    const sig = createHash("sha1")
      .update(JSON.stringify([[...(input.agentIds ?? [])].sort(), input.frameId ?? null, input.at ?? null, input.host ?? null, input.pageId ?? null]))
      .digest("hex")
      .slice(0, 12);
    const rk = input.requestId ? `${boardId}/${input.requestId}/${sig}` : null;
    const seen = rk ? this.requests.get(rk) : undefined;
    if (seen) return seen.result;
    const result = this.run(boardId, input);
    if (rk) {
      this.requests.set(rk, { at: now, result });
      // A failed request may be retried with the same key.
      result.catch(() => this.requests.delete(rk));
    }
    return result;
  }

  private async run(boardId: string, input: ImportInput): Promise<ImportResult> {
    const ids = [...new Set((input.agentIds ?? []).map((x) => String(x).trim()).filter(Boolean))];
    if (!ids.length) throw httpError(400, "agentIds is empty");
    if (ids.length > MAX_IMPORT) throw httpError(400, `at most ${MAX_IMPORT} conversations per import`);
    for (const id of ids) if (!/^[A-Za-z0-9_-]{4,80}$/.test(id)) throw httpError(400, `not a Paseo agent id: ${id}`);
    if(input.frameId&&ids.length===1&&!input.host){
      const room=this.host.get(boardId);const frame=room.records.get(input.frameId);
      this.watcher.requestLink(room,input.frameId,ids[0]);
      return {boardId,created:[{agentId:ids[0],frameId:input.frameId,cardId:null,pending:true,title:frame?.props?.name??ids[0],url:this.watcher.deepLink(boardId,input.frameId)}],skipped:[],url:this.watcher.deepLink(boardId,input.frameId)};
    }
    if (!this.bridge.api) throw httpError(503, "Paseo host disconnected. Retry in a few seconds.");
    if (input.frameId && ids.length !== 1) throw httpError(400, "importing into an existing frame takes exactly one conversation");
    const remoteHost = input.host ?? null;
    if (remoteHost && !this.remote) throw httpError(400, "the remote source is off on this board server (af-network missing, or config remoteAgents is false)");
    if (remoteHost && !(await this.remote!.hosts()).some((h) => h.machine === remoteHost || h.id === remoteHost))
      throw httpError(400, `${remoteHost} is not one of af-network's other hosts`);

    // The only awaits: look the agents up. Everything after them is synchronous, so the
    // "already bound?" checks and the writes cannot interleave with another import.
    const infos = await withDaemonRead(()=>Promise.all(ids.map((id) => remoteHost ? this.remote!.lookup(remoteHost, id) : this.directory.get(id))));
    const result: ImportResult = { boardId, created: [], skipped: [], url: null };
    const ready: Array<{ id: string; title: string; workspaceId: string | null; status: FrameStatus; host?: string | null }> = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const info = infos[i];
      if (!info) {
        result.skipped.push({ agentId: id, reason: remoteHost ? `not found on ${remoteHost}` : "not found in Paseo" });
        continue;
      }
      if (info.archived || info.status === 'archived') { result.skipped.push({agentId:id,reason:'archived conversation; restore it in Paseo before importing'}); continue; }
      const bound = this.watcher.boundRef(id);
      if (bound) {
        result.skipped.push({
          agentId: id,
          reason: bound.boardId === boardId ? "already on this board" : `already on board ${bound.boardId}`,
          boardId: bound.boardId,
          frameId: bound.frameId,
        });
        continue;
      }
      ready.push({ id, title: (info.title ?? "").trim() || `Conversation ${id.slice(0, 8)}`, workspaceId: remoteHost ? null : info.workspaceId, status: info.status, host: remoteHost ? ((info as { host?: string }).host ?? remoteHost) : null });
    }

    // Open (or create) the board only when something will land on it.
    if (!ready.length) {
      result.url = result.skipped[0]?.boardId && result.skipped[0]?.frameId ? this.watcher.deepLink(result.skipped[0].boardId, result.skipped[0].frameId) : null;
      this.log(`import into ${boardId}: nothing to import (${result.skipped.map((x) => `${x.agentId.slice(0, 8)}: ${x.reason}`).join("; ")})`);
      return result;
    }
    const room = this.host.get(boardId);
    if (input.frameId) {
      const frame = room.records.get(input.frameId);
      if (!frame || frame.type !== "frame") throw httpError(404, `frame ${input.frameId} is not on board ${boardId}`);
      if (frame.meta?.paseo?.agentId || frame.meta?.paseo?.request) throw httpError(409, "this frame is already bound or starting a conversation; draw a new frame");
      const a = ready[0];
      if (a) {
        this.watcher.linkSync(room, input.frameId, { ...a, title: a.title });
        result.created.push({ agentId: a.id, frameId: input.frameId, cardId: null, title: frame.props.name || a.title, url: this.watcher.deepLink(boardId, input.frameId) });
      }
    } else if (ready.length) {
      const pageId = input.pageId ?? room.pageId();
      if (room.records.get(pageId)?.typeName !== 'page') throw httpError(404, 'selected page no longer exists');
      const measured: Box[] = (input.occupied ?? []).filter((b) => [b.x, b.y, b.w, b.h].every((v) => typeof v === "number" && Number.isFinite(v)) && b.w >= 0 && b.h >= 0).slice(0, 5000);
      const slots = gridSlots([...topLevelBounds(room.records, pageId), ...measured], ready.length, input.at && Number.isFinite(input.at.x) && Number.isFinite(input.at.y) ? input.at : undefined);
      const by = (input.by ?? "").trim() || this.cfg.humanName;
      const author = { kind: "human", userId: "board-import", name: by };
      const planned: Array<{ a: (typeof ready)[number]; frame: Rec; card: Rec }> = [];
      let index = nextIndex(room.records, pageId);
      for (let i = 0; i < ready.length; i++) {
        const a = ready[i];
        const s = slots[i];
        const frame = baseShape("frame", pageId, index, s.x, s.y, { w: IMPORT_FRAME.w, h: IMPORT_FRAME.h, name: a.title.slice(0, 80), color: "black" }, { author });
        index = nextAfter(index);
        const card = baseShape(TRANSCRIPT_TYPE, frame.id, "a1", CARD_INSET, CARD_INSET, transcriptDefaults(a.id, "compact"), { author });
        planned.push({ a, frame, card });
      }
      room.write({ kind: "server", reason: "import" }, (ops) => {
        for (const { frame, card } of planned) {
          ops.put(frame);
          ops.put(card);
        }
      });
      for (const { a, frame, card } of planned) {
        try {
          this.watcher.linkSync(room, frame.id, a);
          result.created.push({ agentId: a.id, frameId: frame.id, cardId: card.id, title: a.title, url: this.watcher.deepLink(boardId, frame.id) });
        } catch (e) {
          // Cannot happen after the checks above (no await in between); keep the board clean if it does.
          room.write({ kind: "server", reason: "import-undo" }, (ops) => ops.remove(frame.id));
          result.skipped.push({ agentId: a.id, reason: (e as Error).message });
        }
      }
    }
    if (result.created.length) {
      room.save();
      this.directory.invalidate();
      // Fresh status for the new frames (the directory's may be a few seconds old).
      if (!remoteHost) for (const c of result.created) void this.watcher.refreshStatus(boardId, c.frameId);
    }
    result.url = result.created[0]?.url ?? (result.skipped[0]?.boardId && result.skipped[0]?.frameId ? this.watcher.deepLink(result.skipped[0].boardId, result.skipped[0].frameId) : null);
    this.log(`import into ${boardId}: ${result.created.length} framed, ${result.skipped.length} skipped${result.skipped.length ? ` (${result.skipped.map((s) => `${s.agentId.slice(0, 8)}: ${s.reason}`).join("; ")})` : ""}`);
    return result;
  }
}

// Fractional index above `index` without reading the room again (the frames of one
// import are created in one transaction).
function nextAfter(index: string): string {
  return getIndexAbove(index as never);
}

export interface BoardSummary {
  id: string;
  frames: number;
  boundFrames: number;
  cards: number;
  shapes: number;
  lastActivityAt: string;
  url: string;
}

// Every board this server holds, most recently changed first.
export function boardSummaries(host: BoardHost, publicBase: string): BoardSummary[] {
  const out: BoardSummary[] = [];
  for (const room of host.all()) {
    let frames = 0;
    let boundFrames = 0;
    let cards = 0;
    let shapes = 0;
    for (const r of room.records.values()) {
      if (r.typeName !== "shape") continue;
      shapes++;
      if (r.type === "frame") {
        frames++;
        if (r.meta?.paseo?.agentId) boundFrames++;
      } else if (r.type === TRANSCRIPT_TYPE) cards++;
    }
    out.push({ id: room.id, frames, boundFrames, cards, shapes, lastActivityAt: new Date(room.lastChangeAt).toISOString(), url: `${publicBase}/?board=${encodeURIComponent(room.id)}` });
  }
  return out.sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1));
}
