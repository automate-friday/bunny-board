import { hasRemoteRuntimeFiles, requestRuntimeFiles } from "./runtime-files";
import { readArtifactFile } from "./artifact-files";
import { writeCompressionSummary } from "./frame-compression";
import { checklistProps } from '../shared/components/checklist';
import { persistArtifactBundle, persistBundleFiles } from "./artifact-bundle";
import { persistImage } from './file-intake';
// The frame-scoped operations behind the board MCP tools. Every write is
// confined to the caller's frame: parentId must be the frame (or an unbound frame
// inside it), coordinates are frame-relative and must start inside the frame,
// and records are stamped meta.author = { kind: "agent", agentId }.

import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { toRichText } from "@tldraw/tlschema";
import { getIndexAbove } from "@tldraw/utils";
import { componentAgentIds, isComponent } from "../shared/components";
import { BOARD_ID_RE, FRAME_ID_RE } from "../shared/components/link";
import { CLOUD_SESSION_ID_RE, CLOUD_SESSION_TYPE, CLOUD_URL_RE, type CloudSessionProps, REPO_RE } from "../shared/components/cloud-session";
import type { CloudSessions } from "./cloud-sessions";
import { TRANSCRIPT_SIZE, TRANSCRIPT_TYPE, type TranscriptMode, transcriptDefaults } from "../shared/components/transcript";
import { DEFAULT_INSTALLED, isDevPlugin, visiblePlugins } from "../shared/plugins";
import { devPluginsEnabled, notAvailableMessage } from "./plugins";
import { WIDGET_TYPE, WIDGETS, WidgetConfigError, isConfigured, widgetJsonSchema, widgetManifest, widgetOutline, widgetProps } from "../shared/widgets";
import type { WidgetHub } from "./widgets";
import { isOpenStamp, isStampKind, STAMP_KINDS, STAMP_KIND_INFO, STAMP_TYPE, stampKindProps, stampMeanings, stampOutline, stampSpot } from "../shared/components/stamp";
import type { BoardConfig } from "./config";
import type { FrameWatcher } from "./frame-watcher";
import { type Box, childBoxes, freeGridSlot, GRID, type LayoutStrategy, layoutPositions, occupies, overlaps, type Placed } from "./layout";
import type { PaseoBridge } from "./paseo-bridge";
import {
  ancestors,
  baseShape,
  buildArrow,
  buildArrowBinding,
  buildShape,
  defaultSize,
  describeShape,
  geoGrowY,
  isShape,
  nextIndex,
  noteGrowY,
  type Rec,
  type ShapeSpec,
  shapeSize,
  shapeText,
} from "./records";
import type { BoardRoom, ChangeSource } from "./room-host";
import { addReply, agentPersonId, orderedMessages, readThreads } from "../shared/comments";
import { isAreaPortal, parsePortal, type PortalTarget } from "../shared/portal";

// A portal on a sticky: {id} of any shape on this board (another frame included) or a
// page-space area. Reading, not writing, so any frame may be the target.
function checkPortal(room: BoardRoom, raw: unknown, what: string, self?: string): PortalTarget {
  let p: PortalTarget;
  try {
    p = parsePortal(raw);
  } catch (e) {
    throw new InputError(`${what}: ${(e as Error).message}`);
  }
  if (!isAreaPortal(p)) {
    if (p.id === self) throw new InputError(`${what}: a sticky cannot be a portal to itself`);
    if (!isShape(room.records.get(p.id))) throw new InputError(`${what}: portal target ${p.id} is not a shape on this board`);
  }
  return p;
}

export class ScopeError extends Error {
  status = 403;
}
export class InputError extends Error {
  status = 400;
}

function inScope(room: BoardRoom, frameId: string, id: string): Rec {
  const s = room.records.get(id);
  if (!isShape(s)) throw new InputError(`shape ${id} does not exist`);
  if (!ancestors(room.records, s).includes(frameId))
    throw new ScopeError(`shape ${id} is outside your frame ${frameId}. You can only change shapes inside your own frame.`);
  // A nested bound frame belongs to another agent.
  for (const a of ancestors(room.records, s)) {
    if (a === frameId) break;
    if (room.records.get(a)?.meta?.paseo?.agentId)
      throw new ScopeError(`shape ${id} is inside nested frame ${a}, which is bound to another agent.`);
  }
  return s;
}

// Resolve a parent inside the frame; returns the parent's offset from the frame origin.
function resolveParent(room: BoardRoom, frameId: string, parentId: string | undefined): { parentId: string; ox: number; oy: number; w: number; h: number } {
  const frame = room.records.get(frameId)!;
  if (!parentId || parentId === frameId) return { parentId: frameId, ox: 0, oy: 0, w: frame.props.w, h: frame.props.h };
  const p = room.records.get(parentId);
  if (!isShape(p) || p.type !== "frame" || !ancestors(room.records, p).includes(frameId))
    throw new ScopeError(
      `parentId ${parentId} is outside your frame ${frameId}. Agents may only write into their own frame (or an unbound frame inside it).`,
    );
  if (p.meta?.paseo?.agentId) throw new ScopeError(`parentId ${parentId} is a nested frame bound to another agent.`);
  let ox = p.x;
  let oy = p.y;
  let cur = room.records.get(p.parentId);
  while (cur && cur.id !== frameId) {
    ox += cur.x;
    oy += cur.y;
    cur = room.records.get(cur.parentId);
  }
  return { parentId, ox, oy, w: p.props.w, h: p.props.h };
}

function checkPoint(x: number, y: number, w: number, h: number, what: string): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new InputError(`${what}: x and y must be numbers`);
  if (x < 0 || y < 0 || x >= w || y >= h)
    throw new ScopeError(
      `${what}: coordinates (${x}, ${y}) are outside your frame (${Math.round(w)} x ${Math.round(h)}). Use frame-relative coordinates with 0 <= x < ${Math.round(w)} and 0 <= y < ${Math.round(h)}, or grow the frame with board_frame({resize}).`,
    );
}

// First free slot on the 240 px grid inside the frame (layout.ts GRID), clear of every
// shape already there (cards included) and of the shapes earlier in the same write.
function freeSlot(room: BoardRoom, parentId: string, w: number, h: number, size: { w: number; h: number }, taken: Box[]): { x: number; y: number } {
  const slot = freeGridSlot([...childBoxes(room.records, parentId), ...taken], { w, h }, size);
  if (!slot)
    throw new ScopeError(
      `no free space in your frame for a ${Math.round(size.w)}x${Math.round(size.h)} shape. Grow it with board_frame({resize}), tidy it with board_layout, or shorten the text. ${PORTAL_HINT}`,
    );
  return slot;
}

const r0 = (n: number) => Math.round(n);

// Added to every out-of-room message (no free space, would overlap, does not fit, frame
// grown): instead of cramming or growing the frame further, put the extra content where
// there is room and leave a portal sticky here that links to it (shared/portal.ts). An
// agent writes only inside its own frame, so "where there is room" is free space further
// along the frame, or empty board next to it reached with board_frame({resize}).
export const PORTAL_HINT =
  "Out of room here? Put the extra content where there is space (free space elsewhere in your frame, or grow the frame into empty board with board_frame({resize})) " +
  "and leave a portal sticky in this spot that links to it, e.g. board_write({shapes:[{type:'note',text:'Details →',portal:{id:'shape:…'}}]}) " +
  "(the id of the shape or frame holding the details; portal:{x,y,w,h} links a page area). " +
  "board_update({id,patch:{portal:{id:'shape:…'}}}) turns an existing sticky into a portal.";

// What a frame resized to w x h would run into: another frame, or any shape next to it
// that it does not already cover (a person's stickies below it would otherwise be
// swallowed, and adopted on the next manual resize), or the edge of a parent frame.
function growthBlocker(room: BoardRoom, frame: Rec, w: number, h: number): Rec | null {
  const parent = room.records.get(frame.parentId);
  if (isShape(parent) && parent.type === "frame" && (frame.x + w > parent.props.w || frame.y + h > parent.props.h)) return parent;
  const now = { x: frame.x, y: frame.y, w: frame.props.w, h: frame.props.h };
  const grown = { x: frame.x, y: frame.y, w, h };
  for (const s of childBoxes(room.records, frame.parentId)) {
    if (s.id === frame.id) continue;
    if (s.rec.type === "frame" ? overlaps(grown, s, -1) : overlaps(grown, s, -1) && !overlaps(now, s, -1)) return s.rec;
  }
  return null;
}

function blockerLabel(o: Rec): string {
  return o.type === "frame" ? `frame ${o.id} ${JSON.stringify(o.props?.name ?? "")}` : `${describeShape(o, 40)} (${o.id})`;
}

// Rejects a shape whose box would overlap another shape in the same parent (cards and
// human shapes included; arrows and freehand marks ignored). Suggests the next free slot.
function checkOverlap(
  room: BoardRoom,
  parent: { parentId: string; w: number; h: number },
  box: Box,
  what: string,
  opts: { exclude?: Set<string>; pending?: Array<Placed & { label: string }> } = {},
): void {
  const existing = childBoxes(room.records, parent.parentId).filter((b) => !opts.exclude?.has(b.id));
  const pending = opts.pending ?? [];
  const hitOld = existing.find((b) => overlaps(box, b, -1));
  const hitNew = hitOld ? undefined : pending.find((b) => overlaps(box, b, -1));
  if (!hitOld && !hitNew) return;
  const hit = (hitOld ?? hitNew)!;
  const label = hitOld ? `${describeShape(hitOld.rec, 40)} (${hitOld.id})` : hitNew!.label;
  const slot = freeGridSlot([...existing, ...pending], parent, box);
  throw new ScopeError(
    `${what} at (${r0(box.x)}, ${r0(box.y)}) is ${r0(box.w)}x${r0(box.h)} and would overlap ${label} at (${r0(hit.x)}, ${r0(hit.y)}) ${r0(hit.w)}x${r0(hit.h)}. ` +
      `${slot ? `Next free slot for it: (${slot.x}, ${slot.y}).` : "There is no free slot left for it: grow your frame with board_frame({resize})."} ` +
      "Omit x/y to auto-place, or call board_layout to re-flow your shapes. (Notes are 200 wide and grow about 30 px per line past ~12 words.) " +
      PORTAL_HINT,
  );
}

// Shared by the pin tool and frame-agent binding. Placement is synchronous: a
// replay or concurrent pin observes the card before any transcript fetch awaits.
export function pinTranscriptCard(
  room: BoardRoom, frameId: string, target: string, mode: TranscriptMode,
  source: ChangeSource, meta: object,
  options: { x?: number; y?: number; grow?: boolean } = {},
): Rec {
  const existing = [...room.records.values()].find(r => r.type === TRANSCRIPT_TYPE && r.props?.agentId === target && ancestors(room.records, r).includes(frameId));
  if (existing) return existing;
  return placeCard(room, frameId, TRANSCRIPT_TYPE, transcriptDefaults(target, mode), TRANSCRIPT_SIZE[mode], "transcript card", source, meta, options);
}

// A card shape placed in the frame's first free grid slot (or at x/y). With grow, a full
// frame grows to make room (when that runs into nothing); without, the card shrinks to fit.
export function placeCard(
  room: BoardRoom, frameId: string, type: string, props: object, want: { w: number; h: number }, what: string,
  source: ChangeSource, meta: object,
  options: { x?: number; y?: number; grow?: boolean } = {},
): Rec {
  const frame = room.records.get(frameId)!;
  const parent = resolveParent(room, frameId, undefined);
  const size = options.grow ? want : { w: Math.min(want.w, parent.w - 20), h: Math.min(want.h, parent.h - 50) };
  if (size.w < 200 || size.h < 120) throw new ScopeError(`your frame (${Math.round(parent.w)}x${Math.round(parent.h)}) is too small for a ${what}; grow it with board_frame({resize}) first. ${PORTAL_HINT}`);
  let x = options.x;
  let y = options.y;
  let grown: { w: number; h: number } | undefined;
  if (x === undefined || y === undefined) {
    const boxes = childBoxes(room.records, frameId);
    let slot = freeGridSlot(boxes, parent, size);
    if (!slot && options.grow && x === undefined && y === undefined) {
      const w = Math.max(parent.w, GRID.x0 + size.w + 20);
      const below = freeGridSlot(boxes, { w, h: 6000 }, size);
      const h = below ? Math.max(parent.h, below.y + size.h + 20) : 0;
      if (below && w <= 6000 && h <= 6000 && !growthBlocker(room, frame, w, h)) {
        grown = { w, h };
        parent.w = w;
        parent.h = h;
        slot = below;
      }
    }
    if (!slot) slot = freeSlot(room, frameId, parent.w, parent.h, size, []);
    x = x ?? slot.x;
    y = y ?? slot.y;
  }
  checkPoint(x, y, parent.w, parent.h, what);
  const cx = Math.max(0, Math.min(x, parent.w - size.w));
  const cy = Math.max(0, Math.min(y, parent.h - size.h));
  checkOverlap(room, parent, { x: cx, y: cy, ...size }, what);
  const shape = baseShape(type, frameId, nextIndex(room.records, frameId), cx, cy, { ...props, ...size }, meta);
  room.write(source, ops => {
    if (grown) ops.put({ ...ops.get(frameId)!, props: { ...ops.get(frameId)!.props, ...grown } });
    ops.put(shape);
  });
  return shape;
}

// File artifacts keep their name for the URL; anything but [A-Za-z0-9._-] becomes "_".
export function safeFileName(name: string): string {
  const s = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(0, 120);
  return s || "file";
}

export class AgentApi {
  // The human's "Lock layout" (board header): agents may add shapes and change text or colour,
  // but not move, resize or delete anything.
  private layoutLocked(room: BoardRoom, what: string): void {
    if (this.watcher.layoutLocked(room.id))
      throw new ScopeError(`${this.cfg.humanName} locked this board's layout, so ${what} is refused until they unlock it (board header). You can still add new shapes and change text or colour.`);
  }

  // Plugin widget data sources (server/widgets), for board_widget read.
  widgets: WidgetHub | null = null;
  // BUNNY_DEV_PLUGINS=1: board_widget also offers and adds developer plugins (shared/plugins.ts).
  devPlugins = devPluginsEnabled();

  constructor(
    private readonly cfg: BoardConfig,
    private readonly watcher: FrameWatcher,
    private readonly log: (m: string) => void,
    private readonly bridge: PaseoBridge | null = null,
  ) {}

  // Set by core.ts; keeps cloud session cards current (server/cloud-sessions.ts).
  cloudSessions: CloudSessions | null = null;

  private ctx(room: BoardRoom, frameId: string): { frame: Rec; agentId: string; source: ChangeSource; meta: object } {
    const frame = room.records.get(frameId);
    if (!frame || frame.type !== "frame") throw new InputError(`frame ${frameId} no longer exists on board ${room.id}`);
    const agentId = frame.meta?.paseo?.agentId ?? "unbound";
    return { frame, agentId, source: { kind: "agent", agentId, frameId }, meta: { author: { kind: "agent", agentId } } };
  }

  checkAgent(room: BoardRoom, frameId: string, callerAgentId: string | undefined): void {
    const bound = room.records.get(frameId)?.meta?.paseo?.agentId;
    if (callerAgentId && bound && callerAgentId !== bound)
      throw new ScopeError(`frame ${frameId} is now bound to agent ${bound}, not to you (${callerAgentId}).`);
  }

  // Comment threads. action "read" opens any thread on this board by id or link; "reply"
  // (default) answers one this frame is involved in (it sits here, covers it, mentions it,
  // was sent here, or this agent replied before). Agents do not resolve, edit or delete
  // people's comments. messageId makes a retry idempotent.
  comment(room: BoardRoom, frameId: string, body: { action?: unknown; threadId?: unknown; link?: unknown; text?: unknown; messageId?: unknown }) {
    const { frame, agentId, source } = this.ctx(room, frameId);
    let threadId = typeof body.threadId === "string" ? body.threadId : "";
    if (!threadId && typeof body.link === "string") {
      try {
        const u = new URL(body.link);
        threadId = u.searchParams.get("comment") ?? "";
        const board = u.searchParams.get("board");
        if (board && board !== room.id) throw new ScopeError(`that comment is on board ${board}; you can only open comments on ${room.id}`);
      } catch (e) {
        if (e instanceof ScopeError) throw e;
        throw new InputError("link is not a board comment link");
      }
    }
    if (!threadId) throw new InputError("threadId (or a comment link) is required");
    const page = [...room.records.values()].find((r) => r.typeName === "page" && readThreads(r.meta)[threadId]);
    const thread = page ? readThreads(page.meta)[threadId] : undefined;
    if (!page || !thread) throw new InputError(`there is no comment thread ${threadId} on board ${room.id}`);
    const involved = this.watcher.involvedFrames(room, thread);
    if (body.action === "read") {
      const where = this.watcher.commentFrame(room, thread);
      return {
        threadId,
        resolved: thread.resolved,
        frame: where ? { id: where, name: room.records.get(where)?.props?.name ?? "" } : null,
        canReply: involved.has(frameId),
        messages: orderedMessages(thread).map((m) => ({ id: m.id, author: m.author, text: m.text, at: m.createdAt })),
      };
    }
    if (body.action !== undefined && body.action !== "reply") throw new InputError("action must be read or reply");
    const text = typeof body.text === "string" ? body.text : "";
    if (!involved.has(frameId)) throw new ScopeError(`comment thread ${threadId} is not in your frame and does not mention you; ask ${this.cfg.humanName} to @mention your frame or send it to you`);
    const messageId = typeof body.messageId === "string" && body.messageId ? body.messageId : randomUUID();
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(messageId)) throw new InputError("messageId may contain letters, digits, - and _ (up to 80)");
    if (thread.messages[messageId]) return { ok: true, threadId, messageId, repeat: true };
    const name = `${String(frame.props?.name || "Agent").slice(0, 60)} (agent)`;
    const now = new Date().toISOString();
    const who = { userId: agentPersonId(agentId), userName: name };
    // Validate (text length, thread) before writing, so errors come back as 400s.
    try {
      addReply(page.meta, threadId, { messageId, text, who, now });
    } catch (e) {
      throw new InputError((e as Error).message);
    }
    room.write(source, (ops) => {
      const cur = ops.get(page.id);
      if (!cur) throw new InputError("the page holding that thread no longer exists");
      // Re-apply on the current page so a concurrent human edit is kept.
      ops.put({ ...cur, meta: addReply(cur.meta, threadId, { messageId, text, who, now }) });
    });
    return { ok: true, threadId, messageId };
  }

  async read(room: BoardRoom, frameId: string, body: { scope?: string; format?: string; ids?: string[] }) {
    const { frame } = this.ctx(room, frameId);
    // Transcript cards in the frame: refresh their agents' latest messages first.
    const shown: string[] = [];
    for (const r of room.records.values()) if (isShape(r) && isComponent(r) && ancestors(room.records, r).includes(frameId)) shown.push(...componentAgentIds(r as never));
    if (shown.length && this.watcher.transcripts) await this.watcher.transcripts.prime(shown).catch(() => undefined);
    const queued = frame.meta?.paseo?.mode === "on-demand" ? this.watcher.takeQueued(room.id, frameId) : [];
    if (body.format === "json") {
      const recs = [...room.records.values()].filter((r) => {
        if (body.ids?.length) return body.ids.includes(r.id);
        if (body.scope === "board") return r.typeName === "shape" || r.typeName === "binding";
        return isShape(r) && (r.id === frameId || ancestors(room.records, r).includes(frameId));
      });
      return { frameId, records: recs.slice(0, 300), truncated: recs.length > 300, queuedDeltas: queued, locks: this.watcher.locks(room.id) };
    }
    const base = body.scope === "board" ? this.watcher.boardOutline(room.id, frameId) : this.watcher.frameOutline(room.id, frameId);
    const locks = this.watcher.lockSummary(room.id);
    const comments = body.scope === "board" ? null : this.watcher.commentOutline(room, frameId);
    const outline = [locks, base, comments].filter(Boolean).join("\n");
    return { frameId, outline: queued.length ? `${outline}\n\nUnread board deltas:\n${queued.join("\n\n")}` : outline, locks: this.watcher.locks(room.id) };
  }

  write(room: BoardRoom, frameId: string, body: { shapes?: ShapeSpec[]; summary?: unknown }) {
    if (room.records.get(frameId)?.meta?.videoIntake && body.shapes?.some(s => s.type === 'frame')) throw new InputError('Video processing frames have exactly two children. Use board_video action children.');
    const { source, meta } = this.ctx(room, frameId);
    if (body.summary !== undefined) return writeCompressionSummary(room, frameId, body.summary);
    if (room.records.get(frameId)?.meta?.paseo?.compression?.status === "pending") throw new InputError("Compression pending: submit board_write({summary:{requestId,title,decisions,results,openItems,artifacts}}) to fit the requested size");
    const specs = body.shapes;
    if (!Array.isArray(specs) || specs.length === 0) throw new InputError("board_write needs { shapes: [...] } with at least one shape");
    if (specs.length > 50) throw new InputError("at most 50 shapes per board_write");
    const out: Rec[] = [];
    const notes: string[] = [];
    // Auto-placed shapes that do not fit grow the caller's frame downwards (when that
    // does not run into another frame), so "write 20 stickies" just works.
    const frameRec = room.records.get(frameId)!;
    let grownH: number | null = null;
    // Shapes placed earlier in this write, per parent (frame-local boxes).
    const takenBy = new Map<string, Array<Placed & { label: string }>>();
    const indexCursor = new Map<string, string>();
    const idx = (parentId: string) => {
      const prev = indexCursor.get(parentId);
      const next = prev ? getIndexAbove(prev as never) : nextIndex(room.records, parentId);
      indexCursor.set(parentId, next);
      return next;
    };
    specs.forEach((spec, i) => {
      const what = `shapes[${i}] (${spec.type})`;
      if (!["note", "text", "box", "ellipse", "arrow", "frame", "bookmark", "link", "checklist"].includes(spec.type))
        throw new InputError(`${what}: unsupported type; images and files go through board_add_artifact`);
      if (spec.type === "checklist") {
        try { checklistProps(spec); }
        catch (error) { throw new InputError(`${what}: ${(error as Error).message}`); }
      }
      if (spec.portal !== undefined && spec.portal !== null && spec.type !== "note") throw new InputError(`${what}: only stickies (type note) carry a portal`);
      const portal = spec.type === "note" && spec.portal !== undefined && spec.portal !== null ? checkPortal(room, spec.portal, what) : null;
      if (spec.type === "note" && (spec.w !== undefined || spec.h !== undefined))
        notes.push(`${what}: notes are always 200 wide and grow with their text; w/h were ignored`);
      if (spec.type === "bookmark") {
        const url = String(spec.url ?? "");
        if (/^file:/i.test(url))
          throw new InputError(`${what}: file:// links do not open from the board. Use board_add_artifact({kind:'file', path}) to copy the file into the board and link it.`);
        if (!/^https?:\/\//i.test(url)) throw new InputError(`${what}: bookmark needs an http(s) url`);
      }
      if (spec.type === "link") {
        if (!BOARD_ID_RE.test(String(spec.board ?? ""))) throw new InputError(`${what}: link needs board: a board id (letters, digits, - and _)`);
        if (spec.frameId && !FRAME_ID_RE.test(spec.frameId)) throw new InputError(`${what}: frameId must be a frame id like shape:abc123`);
        if (spec.frameId && spec.board === room.id && !room.records.get(spec.frameId)) throw new InputError(`${what}: frame ${spec.frameId} is not on this board`);
      }
      const parent = resolveParent(room, frameId, spec.parentId);
      if (parent.parentId === frameId && grownH !== null) parent.h = grownH;
      const taken = takenBy.get(parent.parentId) ?? [];
      takenBy.set(parent.parentId, taken);
      if (spec.type === "arrow") {
        const end = (e: ShapeSpec["from"], label: string) => {
          if (!e) throw new InputError(`${what}: arrow needs ${label}: {id} or {x,y}`);
          if (e.id) {
            const target = out.find((r) => r.id === e.id) ?? inScope(room, frameId, e.id);
            const size = shapeSize(target);
            return { id: target.id, x: target.x + size.w / 2, y: target.y + size.h / 2 };
          }
          checkPoint(e.x ?? Number.NaN, e.y ?? Number.NaN, parent.w, parent.h, `${what} ${label}`);
          return { id: undefined, x: e.x!, y: e.y! };
        };
        const a = end(spec.from, "from");
        const b = end(spec.to, "to");
        const arrow = buildArrow(parent.parentId, idx(parent.parentId), a, b, spec.text ?? "", spec.color, meta);
        out.push(arrow);
        if (a.id) out.push(buildArrowBinding(arrow.id, a.id, "start"));
        if (b.id) out.push(buildArrowBinding(arrow.id, b.id, "end"));
        return;
      }
      for (const k of ["w", "h"] as const) {
        const v = spec[k];
        if (v !== undefined && !(typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 6000)) throw new InputError(`${what}: ${k} must be a number between 1 and 6000`);
      }
      // A one-line text wider than the frame wraps at the frame's width instead.
      if (spec.type === "text" && spec.w === undefined) {
        const one = defaultSize(spec);
        const room0 = Math.max(60, parent.w - (spec.x ?? GRID.x0) - 20);
        if (one.w > room0) spec = { ...spec, w: Math.floor(room0) };
      }
      const size = defaultSize(spec);
      let x = spec.x;
      let y = spec.y;
      if (x === undefined || y === undefined) {
        let slot = freeGridSlot([...childBoxes(room.records, parent.parentId), ...taken], parent, size);
        if (!slot && parent.parentId === frameId && x === undefined && y === undefined && !this.watcher.layoutLocked(room.id)) {
          const below = freeGridSlot([...childBoxes(room.records, parent.parentId), ...taken], { w: parent.w, h: 6000 }, size);
          const need = below ? Math.ceil(below.y + size.h + 20) : 0;
          if (below && need <= 6000 && !growthBlocker(room, frameRec, frameRec.props.w, need)) {
            grownH = need;
            parent.h = need;
            slot = below;
          }
        }
        if (!slot) slot = freeSlot(room, parent.parentId, parent.w, parent.h, size, taken);
        x = x ?? slot.x;
        y = y ?? slot.y;
      }
      checkPoint(x, y, parent.w, parent.h, what);
      if (size.w > parent.w || size.h > parent.h)
        throw new ScopeError(`${what}: a ${size.w}x${size.h} shape does not fit in your ${Math.round(parent.w)}x${Math.round(parent.h)} frame. Grow it with board_frame({resize}) first. ${PORTAL_HINT}`);
      const cx = Math.min(x, parent.w - size.w);
      const cy = Math.min(y, parent.h - size.h);
      if (cx !== x || cy !== y) notes.push(`${what} clamped from (${x},${y}) to (${cx},${cy}) to stay inside the frame`);
      checkOverlap(room, parent, { x: cx, y: cy, ...size }, what, { pending: taken });
      const rec = buildShape(spec, parent.parentId, idx(parent.parentId), cx, cy, portal ? { ...meta, portal } : meta);
      taken.push({ id: rec.id, x: cx, y: cy, ...size, label: `${what} of this write` });
      if (spec.type === "link" && spec.board !== room.id && !this.watcher.boardExists(String(spec.board)))
        notes.push(`${what}: board ${spec.board} does not exist yet; opening the link creates it`);
      out.push(rec);
    });
    if (grownH !== null) notes.push(`your frame was full, so it grew from ${r0(frameRec.props.h)} to ${grownH} px tall. Next time, rather than growing it again: ${PORTAL_HINT}`);
    room.write(source, (ops) => {
      if (grownH !== null) {
        const f = ops.get(frameId);
        if (f && f.props.h < grownH) ops.put({ ...f, props: { ...f.props, h: grownH } });
      }
      for (const r of out) ops.put(r);
    });
    return { ok: true, ids: out.filter((r) => r.typeName === "shape").map((r) => r.id), notes };
  }

  update(room: BoardRoom, frameId: string, body: { id?: string; patch?: Record<string, unknown> }) {
    const { source } = this.ctx(room, frameId);
    if (!body.id || !body.patch) throw new InputError("board_update needs { id, patch }");
    const s = inScope(room, frameId, body.id);
    if (s.type === "frame" && s.meta?.paseo?.agentId) throw new ScopeError(`${s.id} is a bound frame owned by another agent`);
    const parent = resolveParent(room, frameId, s.parentId === frameId ? undefined : s.parentId);
    const patch = body.patch as { text?: string; color?: string; x?: number; y?: number; w?: number; h?: number; portal?: unknown };
    if (patch.portal !== undefined && s.type !== "note") throw new InputError(`update ${s.id}: only stickies carry a portal`);
    if (patch.x !== undefined || patch.y !== undefined || patch.w !== undefined || patch.h !== undefined) this.layoutLocked(room, "moving or resizing a shape");
    const next: Rec = { ...s, props: { ...s.props } };
    const notes: string[] = [];
    // portal: null (or false) removes it; an object sets it.
    if (patch.portal !== undefined) {
      const { portal: _old, ...rest } = (s.meta ?? {}) as Record<string, unknown>;
      next.meta = patch.portal === null || patch.portal === false ? rest : { ...rest, portal: checkPortal(room, patch.portal, `update ${s.id}`, s.id) };
    }
    if (patch.text !== undefined) {
      if (s.type === "frame") next.props.name = patch.text;
      else if ("richText" in s.props) next.props.richText = toRichText(patch.text);
      else if (s.type === "link") next.props.title = String(patch.text).slice(0, 120);
    }
    if (patch.color !== undefined && "color" in s.props) {
      next.props.color = patch.color;
      if ("labelColor" in s.props && s.type !== "note") next.props.labelColor = patch.color;
    }
    if (patch.w !== undefined && "w" in s.props && s.type !== "note") next.props.w = Math.min(patch.w, parent.w - next.x);
    if (patch.h !== undefined && "h" in s.props && s.type !== "note") next.props.h = Math.min(patch.h, parent.h - next.y);
    if (s.type === "note" && (patch.w !== undefined || patch.h !== undefined)) notes.push("notes are always 200 wide and grow with their text; w/h were ignored");
    // Text-driven height, as a tab would measure it (only when the text or box changed:
    // a colour change must not replace a height a tab measured).
    if (s.type === "note" && patch.text !== undefined) next.props.growY = noteGrowY(shapeText(next), next.props.size);
    if (s.type === "geo" && (patch.text !== undefined || patch.w !== undefined || patch.h !== undefined))
      next.props.growY = geoGrowY(shapeText(next), next.props.w, next.props.h, next.props.geo, next.props.size);
    const moved = patch.x !== undefined || patch.y !== undefined;
    if (moved) {
      const nx = patch.x ?? s.x;
      const ny = patch.y ?? s.y;
      checkPoint(nx, ny, parent.w, parent.h, `update ${s.id}`);
      const size = shapeSize(next);
      next.x = Math.min(nx, Math.max(0, parent.w - size.w));
      next.y = Math.min(ny, Math.max(0, parent.h - size.h));
    }
    if (occupies(next)) {
      const size = shapeSize(next);
      const box = { x: next.x, y: next.y, ...size };
      const resized = patch.w !== undefined || patch.h !== undefined;
      if (moved || resized) checkOverlap(room, { ...parent, parentId: s.parentId }, box, `update ${s.id}`, { exclude: new Set([s.id]) });
      else if (patch.text !== undefined) {
        // A longer text grows the note downwards; allow it, but say what it now covers.
        const hit = childBoxes(room.records, s.parentId).find((b) => b.id !== s.id && overlaps(box, b, -1));
        if (hit) notes.push(`the new text makes ${s.id} ${r0(size.w)}x${r0(size.h)}, which now overlaps ${describeShape(hit.rec, 40)} (${hit.id}); move one of them or call board_layout`);
        if (box.y + box.h > parent.h) notes.push(`${s.id} now runs ${r0(box.y + box.h - parent.h)} px past the bottom of the frame; grow the frame with board_frame({resize}) or call board_layout`);
      }
    }
    room.write(source, (ops) => ops.put(next));
    return { ok: true, id: s.id, notes };
  }

  // board_layout: re-flow the shapes in the caller's frame (or an unbound frame inside it)
  // on a grid or in masonry columns, using the estimated sizes. Only agent-written shapes
  // move unless includeHuman; everything else (human shapes, cards, nested bound frames)
  // stays put and is laid out around. Grows the frame downwards when the result needs it.
  layout(room: BoardRoom, frameId: string, body: { strategy?: string; ids?: string[]; gap?: number; includeHuman?: boolean; parentId?: string }) {
    const { source, frame } = this.ctx(room, frameId);
    this.layoutLocked(room, "board_layout (it moves shapes)");
    const strategy: LayoutStrategy = body.strategy === "columns" ? "columns" : "grid";
    if (body.strategy !== undefined && body.strategy !== "grid" && body.strategy !== "columns") throw new InputError("board_layout strategy must be 'grid' or 'columns'");
    const gap = body.gap === undefined ? 40 : Number(body.gap);
    if (!Number.isFinite(gap) || gap < 0 || gap > 400) throw new InputError("board_layout gap must be between 0 and 400");
    const parent = resolveParent(room, frameId, body.parentId);
    const kids = childBoxes(room.records, parent.parentId);
    const wanted = body.ids?.length ? new Set(body.ids) : null;
    if (wanted) for (const id of wanted) if (!kids.some((k) => k.id === id)) throw new InputError(`board_layout: ${id} is not a shape directly inside ${parent.parentId} (arrows and drawings are not laid out)`);
    const movable = (k: (typeof kids)[number]) => {
      const r = k.rec;
      if (r.type === "frame" && r.meta?.paseo?.agentId) return false;
      if (wanted && !wanted.has(r.id)) return false;
      // Cards (transcript, link) stay put unless asked for by id.
      if (isComponent(r) && !wanted?.has(r.id)) return false;
      return r.meta?.author?.kind === "agent" || body.includeHuman === true;
    };
    if (wanted && !body.includeHuman) {
      const human = kids.filter((k) => wanted.has(k.id) && k.rec.meta?.author?.kind !== "agent");
      if (human.length) throw new ScopeError(`board_layout: ${human.map((k) => k.id).join(", ")} ${human.length === 1 ? "is" : "are"} ${this.cfg.humanName}'s; pass includeHuman:true to move them (ask first)`);
    }
    const items = kids.filter(movable).sort((a, b) => Math.round(a.y / 80) - Math.round(b.y / 80) || a.x - b.x);
    if (!items.length) return { ok: true, strategy, moved: 0, positions: [], frame: { w: frame.props.w, h: frame.props.h }, notes: ["nothing to lay out: no agent-written shapes here (human shapes need includeHuman:true)"] };
    const fixed = kids.filter((k) => !items.includes(k));
    if (items.some((i) => i.w > parent.w - 40)) throw new ScopeError(`board_layout: a ${r0(Math.max(...items.map((i) => i.w)))} px wide shape does not fit in ${r0(parent.w)} px; grow the frame first`);
    const { positions, unplaced, height } = layoutPositions(items, fixed, parent.w, strategy, gap);
    if (unplaced.length)
      throw new ScopeError(`board_layout could not place ${unplaced.length} shape(s) (${unplaced.slice(0, 5).join(", ")}) within 6000 px around the shapes that stay put. Nothing was moved. Try strategy 'columns', a smaller gap, or fewer shapes.`);
    const notes: string[] = [];
    let grewTo: number | null = null;
    if (height > parent.h) {
      if (parent.parentId !== frameId) throw new ScopeError(`board_layout needs ${r0(height)} px of height but frame ${parent.parentId} is ${r0(parent.h)}; resize it first`);
      const o = growthBlocker(room, frame, frame.props.w, height);
      if (o) throw new ScopeError(`board_layout needs ${r0(height)} px of height, but growing your frame would cover ${blockerLabel(o)}. Nothing was moved. Use strategy 'columns', a smaller gap, or fewer shapes.`);
      grewTo = Math.ceil(height);
      notes.push(`grew your frame from ${r0(parent.h)} to ${grewTo} px tall to fit. Rather than growing it again next time: ${PORTAL_HINT}`);
    }
    const byId = new Map(positions.map((p) => [p.id, p]));
    room.write(source, (ops) => {
      for (const it of items) {
        const p = byId.get(it.id);
        const cur = ops.get(it.id);
        if (!p || !cur) continue;
        // Offsets between a shape's x/y and its box (rotated shapes, drawings) are kept.
        const next: Rec = { ...cur, x: cur.x + (p.x - it.x), y: cur.y + (p.y - it.y), props: { ...cur.props } };
        // Never shrink a height a tab measured; old agent notes (growY 0) get the estimate.
        if (cur.type === "note") next.props.growY = Math.max(cur.props.growY ?? 0, noteGrowY(shapeText(cur), cur.props.size));
        ops.put(next);
      }
      if (grewTo !== null) {
        const f = ops.get(frameId);
        if (f) ops.put({ ...f, props: { ...f.props, h: grewTo } });
      }
    });
    return {
      ok: true,
      strategy,
      moved: positions.length,
      positions: positions.map((p) => ({ id: p.id, x: r0(p.x), y: r0(p.y), w: r0(p.w), h: r0(p.h) })),
      frame: { w: r0(parent.w), h: grewTo ?? r0(parent.h) },
      notes,
    };
  }

  delete(room: BoardRoom, frameId: string, body: { ids?: string[]; force?: boolean }) {
    const { source } = this.ctx(room, frameId);
    const ids = body.ids ?? [];
    if (!ids.length) throw new InputError("board_delete needs { ids: [...] }");
    this.layoutLocked(room, "deleting shapes");
    for (const id of ids) inScope(room, frameId, id);
    const doomed = new Set<string>(ids);
    for (const r of room.records.values()) {
      if (isShape(r) && ancestors(room.records, r).some((a) => doomed.has(a))) doomed.add(r.id);
    }
    // Check everything that would go, including children of deleted containers.
    const shapes = [...doomed].map((id) => room.records.get(id)).filter(isShape);
    const human = shapes.filter((s) => s.meta?.author?.kind !== "agent");
    if (human.length && !body.force)
      throw new ScopeError(`refusing to delete human-authored shapes ${human.map((s) => s.id).join(", ")} without force:true. Ask ${this.cfg.humanName} first.`);
    const bound = shapes.filter((s) => s.type === "frame" && s.meta?.paseo?.agentId);
    if (bound.length) throw new ScopeError(`cannot delete bound frames ${bound.map((s) => s.id).join(", ")}`);
    for (const r of room.records.values()) {
      if (r.typeName === "binding" && (doomed.has(r.fromId) || doomed.has(r.toId))) doomed.add(r.id);
    }
    room.write(source, (ops) => {
      for (const id of doomed) ops.remove(id);
    });
    return { ok: true, deleted: [...doomed] };
  }

  async frame(room: BoardRoom, frameId: string, body: { resize?: { w: number; h: number }; name?: string }) {
    const { frame, source, agentId } = this.ctx(room, frameId);
    const next: Rec = { ...frame, props: { ...frame.props } };
    if (body.resize) {
      this.layoutLocked(room, "resizing your frame");
      const { w, h } = body.resize;
      if (!(w > 0 && h > 0) || w > 6000 || h > 6000) throw new InputError("resize needs 0 < w,h <= 6000");
      // Do not grow over another frame on the same parent.
      const o = growthBlocker(room, frame, w, h);
      if (o) throw new ScopeError(`resizing to ${w}x${h} would ${o.type === "frame" ? "overlap" : "cover"} ${blockerLabel(o)}. Choose a smaller size.`);
      next.props.w = w;
      next.props.h = h;
    }
    if (body.name !== undefined) next.props.name = String(body.name).slice(0, 120);
    room.write(source, (ops) => ops.put(next));
    return { ok: true, frameId, w: next.props.w, h: next.props.h, name: next.props.name, agentId };
  }

  // board_pin_transcript: a live transcript card of another agent inside the caller's
  // frame. Allowed targets: the caller itself, an agent bound to a frame on the same
  // board, or an agent in the board's own Paseo workspace (where board agents' subagents
  // land). Without a board workspace (workspacePerBoard off), the caller's workspace.
  async pin(room: BoardRoom, frameId: string, body: { agentId?: string; mode?: string; x?: number; y?: number }) {
    const { source, meta, agentId: caller, frame } = this.ctx(room, frameId);
    const target = String(body.agentId ?? "").trim();
    if (!/^[A-Za-z0-9_-]{4,80}$/.test(target)) throw new InputError("board_pin_transcript needs { agentId } (a Paseo agent id)");
    const mode: TranscriptMode = body.mode === "full" ? "full" : "compact";
    const boundHere = [...room.records.values()].some((r) => r.type === "frame" && r.meta?.paseo?.agentId === target);
    if (target !== caller && !boundHere) {
      const api = this.bridge?.api;
      if (!api) throw new InputError("Paseo is not connected yet; try again in a few seconds");
      const theirs = await api.agents.ref(target).refresh().catch(() => null);
      if (!theirs) throw new InputError(`agent ${target} not found`);
      const ws = this.watcher.boardWorkspaceId(room) ?? (await api.agents.ref(caller).refresh().catch(() => null))?.agent.workspaceId;
      if (!ws || theirs.agent.workspaceId !== ws)
        throw new ScopeError(`agent ${target} is not in this board's workspace and not bound on this board; you may pin only your own subagents or this board's agents.`);
    }
    // The frame may have been deleted or re-bound while we waited on Paseo.
    if (this.ctx(room, frameId).agentId !== caller) throw new ScopeError(`frame ${frameId} is no longer bound to you`);
    const shape = pinTranscriptCard(room, frameId, target, mode, source, meta, body);
    const { x: cx, y: cy } = shape;
    const size = shapeSize(shape);
    if (this.watcher.transcripts) await this.watcher.transcripts.prime([target]).catch(() => undefined);
    this.log(`pinned transcript of ${target} into ${room.id}/${frame.id} for ${caller}`);
    return { ok: true, id: shape.id, agentId: target, x: cx, y: cy, ...size, preview: this.watcher.frameOutline(room.id, frameId).split("\n").find((l) => l.includes(shape.id)) ?? null };
  }

  // board_widget: plugin widgets (shared/widgets) in the caller's frame. list shows the
  // installed widgets and their config fields; add places one (auto-placed on the grid
  // unless x/y are given); configure merges config into one ("" clears a field); read
  // returns its live status and a short data summary.
  async widget(room: BoardRoom, frameId: string, body: { action?: unknown; widgetId?: unknown; config?: unknown; id?: unknown; x?: number; y?: number; w?: number; h?: number }) {
    const { source, meta } = this.ctx(room, frameId);
    const action = body.action ?? "list";
    const props = (widgetId: string, config: unknown, size?: { w?: number; h?: number }) => {
      try {
        return widgetProps(widgetId, config, size);
      } catch (e) {
        if (e instanceof WidgetConfigError) throw new InputError(e.message);
        throw e;
      }
    };
    const status = async (shape: Rec) => {
      const { widgetId, config } = shape.props as { widgetId: string; config: Record<string, unknown> };
      const configured = isConfigured(widgetId, config);
      const state = configured && this.widgets ? await this.widgets.read(widgetId, config) : null;
      return { status: state?.status ?? (configured ? "connecting" : "not set up"), reason: state?.reason ?? null, syncedAt: state?.syncedAt ? new Date(state.syncedAt).toISOString() : null, boardRead: widgetOutline({ widgetId, config }, state), state };
    };
    if (action === "list")
    {
      // The person's registry (/plugins): installed plugins are offered; the rest are listed
      // as available, with the page where the person can install them.
      // Only released plugins are offered unless developer plugins are on (shared/plugins.ts).
      const offered = visiblePlugins(this.devPlugins);
      const installed = new Set(this.widgets?.plugins ? this.widgets.plugins.installed() : DEFAULT_INSTALLED);
      return {
        widgets: WIDGETS.filter((m) => installed.has(m.id) && (this.devPlugins || !isDevPlugin(m.id))).map((m) => ({ id: m.id, label: m.label, description: m.description, installed: true, size: m.size, staleSeconds: m.staleMs / 1000, config: widgetJsonSchema(m) })),
        apps: offered.filter((p) => p.kind === "app" && installed.has(p.id)).map((p) => ({ id: p.id, name: p.name, tagline: p.tagline, installed: true, widgetId: p.widgetId, config: p.preset, framesInline: p.app?.frameable ?? null })),
        available: offered.filter((p) => !installed.has(p.id)).map((p) => ({ id: p.id, kind: p.kind, name: p.name, tagline: p.tagline, installed: false, page: `/plugins/${p.id}`, ...(p.kind === "app" ? { widgetId: p.widgetId, config: p.preset } : {}) })),
        note: "Add one with board_widget({action:'add', widgetId, config}); an installed app is board_widget({action:'add', widgetId:'app', config}) with its config. The person sees a status dot: grey connecting, green live, amber stale, red error. 'available' plugins are not in the person's registry: prefer installed ones, or point the person at the plugin's page to install it.",
      };
    }
    if (action === "add") {
      const widgetId = typeof body.widgetId === "string" ? body.widgetId : "";
      // Developer plugins (slack, hello, app, …) stay hidden; existing ones on boards still
      // load, read and configure, but agents cannot add new ones without the flag.
      if (widgetManifest(widgetId) && isDevPlugin(widgetId) && !this.devPlugins) throw new InputError(notAvailableMessage(widgetId));
      const p = props(widgetId, body.config, { w: body.w, h: body.h });
      const parent = resolveParent(room, frameId, undefined);
      const size = { w: Math.min(p.w, parent.w - 20), h: Math.min(p.h, parent.h - 50) };
      if (size.w < 160 || size.h < 100) throw new ScopeError(`your frame (${Math.round(parent.w)}x${Math.round(parent.h)}) is too small for a ${widgetId} widget; grow it with board_frame({resize}) first`);
      let { x, y } = body;
      if (x === undefined || y === undefined) {
        const slot = freeSlot(room, frameId, parent.w, parent.h, size, []);
        x = x ?? slot.x;
        y = y ?? slot.y;
      }
      checkPoint(x, y, parent.w, parent.h, `${widgetId} widget`);
      const cx = Math.max(0, Math.min(x, parent.w - size.w));
      const cy = Math.max(0, Math.min(y, parent.h - size.h));
      checkOverlap(room, parent, { x: cx, y: cy, ...size }, `${widgetId} widget`);
      const shape = baseShape(WIDGET_TYPE, frameId, nextIndex(room.records, frameId), cx, cy, { ...p, ...size }, meta);
      room.write(source, (ops) => ops.put(shape));
      this.log(`added widget ${widgetId} ${shape.id} to ${room.id}/${frameId}`);
      return { ok: true, id: shape.id, widgetId, config: p.config, x: cx, y: cy, ...size, ...(await status(shape)), state: undefined };
    }
    const id = typeof body.id === "string" ? body.id : "";
    const shape = room.records.get(id);
    if (!shape || shape.type !== WIDGET_TYPE) throw new InputError(`${id || "(no id)"} is not a widget on board ${room.id}; board_read lists them`);
    if (action === "read") {
      const out = await status(shape);
      const m = widgetManifest(shape.props.widgetId);
      const data = out.state?.data ?? null;
      const json = JSON.stringify(data);
      return { id, widgetId: shape.props.widgetId, config: shape.props.config, status: out.status, reason: out.reason, syncedAt: out.syncedAt, summary: m ? m.describe(shape.props.config, out.state) : null, ...(json && json.length <= 6000 ? { data } : { dataOmitted: `${json.length} bytes; see summary` }) };
    }
    if (action === "configure") {
      if (!ancestors(room.records, shape).includes(frameId)) throw new ScopeError(`widget ${id} is not in your frame; you may configure only widgets in your frame`);
      if (!body.config || typeof body.config !== "object" || Array.isArray(body.config)) throw new InputError("configure needs config: an object of fields to change (\"\" clears one)");
      const merged = { ...shape.props.config, ...(body.config as Record<string, unknown>) };
      for (const [k, v] of Object.entries(merged)) if (v === "" || v === null) delete merged[k];
      const p = props(shape.props.widgetId, merged, shape.props);
      room.write(source, (ops) => {
        const cur = ops.get(id);
        if (!cur) throw new InputError(`widget ${id} no longer exists`);
        ops.put({ ...cur, props: { ...cur.props, config: p.config } });
      });
      const next = room.records.get(id)!;
      return { ok: true, id, widgetId: next.props.widgetId, config: next.props.config, ...(await status(next)), state: undefined };
    }
    throw new InputError("board_widget action must be list, add, configure or read (stamps are board_stamp now)");
  }

  // board_stamp: structured stamps on shapes in the caller's frame (shared/components/stamp).
  // list shows open stamps (people's asks: needs-change, stop, …) with their state; ack moves
  // one to acting, resolve to done (the person sees the badge change); add attaches the
  // agent's own stamp to a shape in its frame (it notifies nobody).
  stamp(room: BoardRoom, frameId: string, body: { action?: unknown; id?: unknown; target?: unknown; stamp?: unknown; note?: unknown; all?: unknown }) {
    const { source, meta, frame } = this.ctx(room, frameId);
    const action = body.action ?? "list";
    const describe = (r: Rec) => {
      const t = room.records.get(r.parentId);
      return {
        id: r.id,
        stamp: r.props.kind || r.props.label,
        state: r.props.state || (r.props.kind ? "not sent" : ""),
        target: t ? { id: t.id, type: t.type === "frame" ? "frame" : describeShape(t).split(" ")[0], text: t.type === "frame" ? String(t.props?.name ?? "") : shapeText(t).slice(0, 120) } : null,
        by: r.props.by,
        at: new Date(r.props.at).toISOString(),
        ...(r.props.note ? { note: r.props.note } : {}),
        meaning: isStampKind(r.props.kind) ? STAMP_KIND_INFO[r.props.kind as keyof typeof STAMP_KIND_INFO].meaning : undefined,
        boardRead: stampOutline(r.props),
      };
    };
    if (action === "list") {
      const all = body.all === true;
      const rows = [...room.records.values()].filter((r) => r.type === STAMP_TYPE && ancestors(room.records, r).includes(frameId) && (all || isOpenStamp(r.props)));
      rows.sort((a, b) => a.props.at - b.props.at);
      return { stamps: rows.map(describe), meanings: stampMeanings(), note: "ack a stamp when you start on it, resolve it when it is handled; the person sees sent → seen → acting → done on the stamp." };
    }
    if (action === "ack" || action === "resolve") {
      const id = typeof body.id === "string" ? body.id : "";
      const r = room.records.get(id);
      if (!r || r.type !== STAMP_TYPE) throw new InputError(`${id || "(no id)"} is not a stamp on board ${room.id}; board_stamp list shows yours`);
      if (!ancestors(room.records, r).includes(frameId)) throw new ScopeError(`stamp ${id} is not in your frame`);
      if (!r.props.kind) throw new InputError(`stamp ${id} is an old label stamp (${r.props.label}); there is nothing to acknowledge`);
      const want = action === "ack" ? "acting" : "done";
      const moved = this.watcher.setStampState(room.id, id, want, source);
      const now = room.records.get(id)!;
      return { ok: true, id, state: now.props.state, changed: moved, boardRead: stampOutline(now.props) };
    }
    if (action === "add") {
      const targetId = typeof body.target === "string" ? body.target : "";
      if (!isStampKind(body.stamp)) throw new InputError(`stamp must be one of ${STAMP_KINDS.join(", ")}`);
      if (body.note !== undefined && typeof body.note !== "string") throw new InputError("note must be a string");
      if (!targetId) throw new InputError("add needs target: the id of a shape in your frame (or your frame itself)");
      const target = targetId === frameId ? frame : inScope(room, frameId, targetId);
      if (target.type === STAMP_TYPE || target.type === "arrow") throw new InputError(`${targetId} is a ${target.type}; stamp a sticky, card, frame or other shape`);
      this.layoutLocked(room, "stamping");
      const p = stampKindProps({ kind: body.stamp, by: String(frame.props?.name ?? "").trim() || "agent", at: Date.now(), target: target.id, note: body.note as string | undefined });
      const n = [...room.records.values()].filter((r) => r.type === STAMP_TYPE && r.parentId === target.id).length;
      const at = stampSpot(shapeSize(target), p, null, n);
      const rec = baseShape(STAMP_TYPE, target.id, nextIndex(room.records, target.id), at.x, at.y, p, meta);
      room.write(source, (ops) => ops.put(rec));
      this.log(`agent stamped ${body.stamp} ${rec.id} on ${target.id} in ${room.id}/${frameId}`);
      return { ok: true, id: rec.id, stamp: body.stamp, target: target.id, boardRead: stampOutline(p) };
    }
    throw new InputError("board_stamp action must be list, ack, resolve or add");
  }

  // bin/cloud-task: pin a cloud session card for a session it just dispatched (or update the
  // one already in this frame: a relayed message, a branch it learnt, a dispatch failure).
  // The board server keeps the card's status current from then on.
  cloud(room: BoardRoom, frameId: string, body: { provider?: unknown; session?: unknown; url?: unknown; repo?: unknown; title?: unknown; branch?: unknown; state?: unknown; detail?: unknown; activity?: unknown }) {
    if (!this.cloudSessions) throw new InputError("cloud session cards are not available on this board server");
    const { source, meta, agentId, frame } = this.ctx(room, frameId);
    const provider = body.provider === "codex" ? "codex" : body.provider === undefined || body.provider === "claude" ? "claude" : null;
    if (!provider) throw new InputError("provider must be claude or codex");
    const session = String(body.session ?? "");
    if (!CLOUD_SESSION_ID_RE.test(session)) throw new InputError("session must be a cloud session or task id (session_… or task_…)");
    const url = String(body.url ?? "");
    if (!CLOUD_URL_RE.test(url)) throw new InputError("url must be the claude.ai/code/session_… or chatgpt.com/codex/tasks/task_… page");
    const repo = String(body.repo ?? "automate-friday/bunny-board");
    if (!REPO_RE.test(repo)) throw new InputError("repo must be owner/name");
    const branch = typeof body.branch === "string" ? body.branch.trim() : "";
    if (branch && !/^[A-Za-z0-9._\/-]{1,250}$/.test(branch)) throw new InputError("branch is not a git branch name");
    const title = typeof body.title === "string" ? body.title.replace(/\s+/g, " ").trim().slice(0, 200) : "";
    const init: Partial<CloudSessionProps> = { provider, session, url, repo, title, branch };
    if (body.activity === true) init.activityAt = Date.now();
    if (body.state === "failed") Object.assign(init, { state: "failed", detail: String(body.detail ?? "dispatch failed").slice(0, 300) });
    const { card, created } = this.cloudSessions.upsert(room, frameId, init, (props) =>
      placeCard(room, frameId, CLOUD_SESSION_TYPE, props, { w: props.w, h: props.h }, "cloud session card", source, meta, { grow: true }),
    );
    if (created) this.log(`cloud session card ${card.id} (${session}) in ${room.id}/${frame.id} for ${agentId}`);
    // Its "Claude Code activity" widget (subagents, background processes) goes beside it.
    let activityWidget: string | null = null;
    if (provider === "claude") {
      const has = [...room.records.values()].find((r) => r.type === WIDGET_TYPE && r.props?.widgetId === "claude-activity" && r.props?.config?.session === session && ancestors(room.records, r).includes(frameId));
      if (has) activityWidget = has.id;
      else {
        try {
          const props = widgetProps("claude-activity", { session });
          activityWidget = placeCard(room, frameId, WIDGET_TYPE, props, { w: props.w, h: props.h }, "activity widget", source, meta, { grow: true }).id;
        } catch (e) {
          this.log(`activity widget for ${session} not placed in ${room.id}/${frameId}: ${(e as Error).message}`);
        }
      }
    }
    // A relayed message (cloud-task send): the session is about to work, so watch it closely.
    if (body.activity === true && !created) {
      try { this.cloudSessions.burst(room.id, card.id); } catch { /* card gone meanwhile */ }
    }
    return { ok: true, id: card.id, created, activityWidget, preview: this.watcher.frameOutline(room.id, frameId).split("\n").find((l) => l.includes(card.id)) ?? null };
  }

  // Regular files only: a FIFO or device would block the daemon's event loop on read,
  // and a symlink could read around the agent's sandbox. Secrets are refused outright:
  // the asset store is served to anyone on the tailnet.
  private readArtifact(p: string | undefined): Buffer {
    try { return readArtifactFile(p, this.cfg.stateDir); } catch (e) { throw new InputError((e as Error).message); }
  }

  async runtimeArtifact(room:BoardRoom,frameId:string,body:Parameters<AgentApi['artifact']>[2]) {
    const {agentId}=this.ctx(room,frameId);
    if(!hasRemoteRuntimeFiles()||!body.path)return this.artifact(room,frameId,body);
    if(this.watcher.remoteHostOf(agentId))throw new ScopeError('File artifacts must come from the primary runtime host');
    const fetched=await requestRuntimeFiles({op:'artifact',path:body.path,bundle:body.bundle===true});
    if(fetched.path!==body.path||!fetched.files?.length)throw new InputError('Runtime returned no artifact');
    const files=fetched.files.map(f=>({name:f.name,bytes:Buffer.from(f.bytes,'base64')}));
    const name=path.basename(body.path);const file=files.find(f=>f.name===name);
    if(!file||!file.bytes.length||files.reduce((n,f)=>n+f.bytes.length,0)>20*1024*1024)throw new InputError('Invalid runtime artifact size');
    // Recheck the binding after the await before writing into a possibly rebound frame.
    if(this.ctx(room,frameId).agentId!==agentId)throw new ScopeError('Frame binding changed during artifact read');
    return this.artifact(room,frameId,body,{bytes:file.bytes,...(body.bundle?{bundle:persistBundleFiles(name,files,this.cfg.assetsDir)}:{})});
  }

  artifact(room: BoardRoom, frameId: string, body: { bundle?: boolean; kind?: string; path?: string; url?: string; title?: string; w?: number; h?: number; x?: number; y?: number }, material?:{bytes:Buffer;bundle?:ReturnType<typeof persistArtifactBundle>}) {
    const { source, meta, agentId } = this.ctx(room, frameId);
    // A path is read from this Mac's disk. An agent on another Mac (an imported remote
    // conversation, holding a frame token) must not reach this machine's files that way.
    const remoteHost = this.watcher.remoteHostOf(agentId);
    if (body.path && remoteHost)
      throw new ScopeError(`board_add_artifact with a path reads a file on the board's Mac; your conversation runs on ${remoteHost}. Write a note with the link instead, or use {url} for a web link.`);
    if (body.kind !== undefined && !["image", "file", "url"].includes(body.kind)) throw new InputError("board_add_artifact kind must be 'image', 'file' or 'url'");
    if (body.kind === "file") return this.fileArtifact(room, frameId, body,material);
    if (body.url && !body.path) {
      return this.write(room, frameId, { shapes: [{ type: "bookmark", url: body.url, text: body.title, x: body.x, y: body.y, w: body.w, h: body.h }] });
    }
    const buf = material?.bytes ?? this.readArtifact(body.path);
    const srcPath = body.path as string;
    let stored:ReturnType<typeof persistImage>;
    try{stored=persistImage(this.cfg,buf);}catch(e){throw new InputError(`${(e as Error).message}. For a non-image file use board_add_artifact({kind:'file', path}).`);}
    const dim={w:stored.w,h:stored.h,mime:stored.mimeType};
    const sha=stored.hash.slice(0,32);const file=stored.file;
    const frame = room.records.get(frameId)!;
    if (dim.w <= 0 || dim.h <= 0) throw new InputError("artifact has no pixel size");
    const maxW = Math.min(body.w ?? 480, frame.props.w - 40);
    const maxH = frame.props.h - 70;
    if (maxW < 20 || maxH < 20) throw new ScopeError(`your frame is too small for an image; grow it with board_frame({resize}) first. ${PORTAL_HINT}`);
    const scale = Math.min(1, maxW / dim.w, maxH / dim.h);
    const w = Math.max(20, Math.round(dim.w * scale));
    const h = Math.max(20, Math.round(dim.h * scale));
    const assetId = `asset:${sha}`;
    const asset: Rec = {
      id: assetId,
      typeName: "asset",
      type: "image",
      props: { name: path.basename(srcPath), src: stored.src, w: dim.w, h: dim.h, mimeType: dim.mime, isAnimated: false, fileSize: buf.length },
      meta: { artifact: { kind: "screenshot", sourcePath: srcPath } },
    };
    const parent = resolveParent(room, frameId, undefined);
    const pos = body.x !== undefined && body.y !== undefined ? { x: body.x, y: body.y } : freeSlot(room, frameId, parent.w, parent.h, { w, h }, []);
    checkPoint(pos.x, pos.y, parent.w, parent.h, "artifact");
    if (pos.x + w > parent.w || pos.y + h > parent.h) throw new ScopeError(`a ${w}x${h} image at (${pos.x},${pos.y}) does not fit in your frame; omit x/y or grow the frame. ${PORTAL_HINT}`);
    checkOverlap(room, parent, { x: pos.x, y: pos.y, w, h }, "artifact");
    const shape = buildShape({ type: "image", w, h, text: body.title ?? "", assetId }, frameId, nextIndex(room.records, frameId), Math.min(pos.x, parent.w - w), Math.min(pos.y, parent.h - h), { ...meta, artifact: { kind: "screenshot", sourcePath: srcPath } });
    room.write(source, (ops) => {
      if (!ops.get(assetId)) ops.put(asset);
      ops.put(shape);
    });
    this.log(`artifact ${file} → ${shape.id} in ${room.id}/${frameId}`);
    return { ok: true, id: shape.id, assetId, url: asset.props.src, w, h };
  }

  // kind:'file': copy any regular file (HTML report, transcript, PDF, …) into the
  // plugin's asset store, serve it at /api/assets/files/<sha>/<name>, and put a bookmark
  // card linking it in the frame. Served with a sandbox CSP (http.ts), so an HTML file
  // cannot act as the board.
  private fileArtifact(room: BoardRoom, frameId: string, body: { bundle?: boolean; path?: string; title?: string; x?: number; y?: number; w?: number },material?:{bytes:Buffer;bundle?:ReturnType<typeof persistArtifactBundle>}) {
    const { source, meta } = this.ctx(room, frameId);
    const buf = material?.bytes ?? this.readArtifact(body.path);
    const srcPath = body.path as string;
    let bundle: ReturnType<typeof persistArtifactBundle> | null = material?.bundle ?? null;
    if(body.bundle&&!bundle)try{bundle=persistArtifactBundle(srcPath,this.cfg.assetsDir,file=>this.readArtifact(file));}catch(e){throw new InputError((e as Error).message);}
    const sha = bundle?.sha ?? createHash("sha256").update(buf).digest("hex").slice(0, 32);
    const name = safeFileName(path.basename(srcPath));
    const dir = path.join(this.cfg.assetsDir, "files", sha);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    if (!existsSync(file)) writeFileSync(file, buf);
    const url = bundle ? `${this.cfg.publicBase}${bundle.urlPath}` : `${this.cfg.publicBase}/api/assets/files/${sha}/${encodeURIComponent(name)}`;
    const title = (body.title ?? "").trim() || path.basename(srcPath);
    const kb = buf.length < 1024 ? `${buf.length} B` : buf.length < 1024 * 1024 ? `${Math.round(buf.length / 1024)} KB` : `${(buf.length / 1024 / 1024).toFixed(1)} MB`;
    const assetId = `asset:file-${sha}`;
    const asset: Rec = {
      id: assetId,
      typeName: "asset",
      type: "bookmark",
      props: { src: url, title: title.slice(0, 200), description: `${path.basename(srcPath)} · ${kb} · copied to the board`, image: "", favicon: "" },
      meta: { artifact: { kind: "file", sourcePath: srcPath, bytes: buf.length } },
    };
    const parent = resolveParent(room, frameId, undefined);
    // A bookmark with a title and no image renders 101 px tall (tldraw SHORT_BOOKMARK_HEIGHT).
    const size = { w: Math.max(200, Math.min(body.w ?? 300, parent.w - 40)), h: 101 };
    const pos = body.x !== undefined && body.y !== undefined ? { x: body.x, y: body.y } : freeSlot(room, frameId, parent.w, parent.h, size, []);
    checkPoint(pos.x, pos.y, parent.w, parent.h, "artifact");
    const x = Math.min(pos.x, parent.w - size.w);
    const y = Math.min(pos.y, parent.h - size.h);
    checkOverlap(room, parent, { x, y, ...size }, "artifact");
    const shape = buildShape({ type: "bookmark", url, ...size }, frameId, nextIndex(room.records, frameId), x, y, { ...meta, artifact: { kind: "file", sourcePath: srcPath } });
    shape.props.assetId = assetId;
    room.write(source, (ops) => {
      if (!ops.get(assetId)) ops.put(asset);
      ops.put(shape);
    });
    this.log(`file artifact ${srcPath} → ${file} → ${shape.id} in ${room.id}/${frameId}`);
    return { ok: true, id: shape.id, assetId, url, bytes: bundle?.bytes ?? buf.length, ...(bundle ? {bundle: true, fileCount: bundle.fileCount} : {}), w: size.w, h: size.h };
  }
}
