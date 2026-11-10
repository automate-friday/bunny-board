import { createHash } from 'node:crypto';
import path from 'node:path';
import type { FrameWatcher } from './frame-watcher';
import { gridSlots, IMPORT_FRAME, pageBox, topLevelBounds } from './layout';
import { buildShape, isShape, nextIndex, type Rec } from './records';
import { BoardHost, type BoardRoom } from './room-host';
import { startPending } from '../shared/start-pending';

interface StartInput {
  board: string;
  name: string;
  opener: string;
  key: string;
  provider?: string;
  cwd?: string;
  near?: string;
}
interface Receipt { frameId: string; fingerprint: string }
function fail(status: number, message: string): never { throw Object.assign(new Error(message), { status }); }
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function parse(body: unknown): StartInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'body must be a JSON object');
  const b = body as Record<string, unknown>;
  const text = (key: string, max: number, optional = false): string | undefined => {
    const value = b[key];
    if (optional && value === undefined) return undefined;
    if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) fail(400, `${key} must be a nonempty string of at most ${max} characters`);
    return value;
  };
  const board = text('board', 64)!;
  if (!BoardHost.validId(board)) fail(400, 'invalid board id');
  const name = text('name', 200)!;
  const opener = text('opener', 100_000)!;
  const key = text('key', 256)!;
  const provider = text('provider', 200, true);
  const cwd = text('cwd', 4096, true);
  const near = text('near', 256, true);
  if (cwd && !path.isAbsolute(cwd)) fail(400, 'cwd must be an absolute path on the Paseo host');
  return {board, name, opener, key, ...(provider ? {provider} : {}), ...(cwd ? {cwd} : {}), ...(near ? {near} : {})};
}

// Phase 1 uses the canvas's pending request and existing watcher/retry machinery.
// Replace this dispatch with an inbox start operation in phase 2. Never await Paseo here.
function requestFrameStart(watcher: FrameWatcher, room: BoardRoom, frameId: string): void {
  setImmediate(() => { void watcher.fulfil(room, frameId); });
}

export function startFrame(host: BoardHost, watcher: FrameWatcher, body: unknown): {frameId: string; status: string} {
  const input = parse(body);
  // host.get would create an empty board for any valid id; a typo must not start work there.
  if (!host.exists(input.board)) fail(404, `no board ${input.board}`);
  const room = host.get(input.board);
  const doc = room.records.get('document:document')!;
  const key = digest(input.key);
  const fingerprint = digest(JSON.stringify(input));
  const receipts = (doc.meta?.frameStarts ?? {}) as Record<string, Receipt>;
  const previous = receipts[key];
  if (previous) {
    if (previous.fingerprint !== fingerprint) fail(409, 'key already used with different frame start input');
    const frame = room.records.get(previous.frameId);
    if (!frame) fail(410, 'frame was deleted; this key cannot create another conversation');
    return {frameId: frame.id, status: startPending(frame.meta?.paseo) ? 'starting' : frame.meta?.paseo?.status ?? 'idle'};
  }
  const pageId = room.pageId();
  let origin: {x:number;y:number} | undefined;
  if (input.near) {
    const near = room.records.get(input.near);
    if (!isShape(near)) fail(400, 'near must name a shape on this board');
    let top: Rec = near;
    for (let i=0; isShape(room.records.get(top.parentId)) && i<50; i++) top = room.records.get(top.parentId)!;
    if (top.parentId !== pageId) fail(400, 'near must be on the current page');
    const children = new Map<string, Rec[]>();
    for (const r of room.records.values()) {
      if (!isShape(r)) continue;
      const list = children.get(r.parentId);
      if (list) list.push(r); else children.set(r.parentId, [r]);
    }
    const box = pageBox(room.records, top, children);
    if (!box) fail(400, 'near shape has no bounds');
    origin = {x:box.x + box.w + 60, y:box.y};
  }
  const slot = gridSlots(topLevelBounds(room.records, pageId), 1, origin)[0];
  const frame = buildShape({type:'frame', text:input.name, ...IMPORT_FRAME, color:'light-blue'}, pageId, nextIndex(room.records,pageId), slot.x,slot.y, {
    paseo: {status:'requested', request:{kind:'create',prompt:input.opener,requestedAt:Date.now(), ...(input.provider ? {provider:input.provider} : {}), ...(input.cwd ? {cwd:input.cwd,context:'repo'} : {})}},
  });
  room.write({kind:'server',reason:'frame-start'}, ops => {
    ops.put(frame);
    const current = ops.get(doc.id)!;
    ops.put({...current, meta:{...current.meta,frameStarts:{...receipts,[key]:{frameId:frame.id,fingerprint}}}});
  });
  // Atomic board snapshot includes frame, request and key before any daemon effect.
  room.save();
  requestFrameStart(watcher,room,frame.id);
  return {frameId:frame.id,status:'starting'};
}
