import { createBindingId, createShapeId } from '@tldraw/tlschema';
import { CLOUD_SESSION_TYPE } from '../shared/components/cloud-session';
import { STAMP_TYPE } from '../shared/components/stamp';
import { TRANSCRIPT_TYPE } from '../shared/components/transcript';
import { WIDGET_TYPE } from '../shared/widgets';
import type { FrameWatcher } from './frame-watcher';
import { besideShape } from './frame-start';
import { gridSlots, IMPORT_FRAME, topLevelBounds } from './layout';
import type { PaseoBridge } from './paseo-bridge';
import { buildShape, type FramePaseoMeta, isShape, nextIndex, type Rec } from './records';
import type { BoardRoom } from './room-host';
import { timelineEntry } from './timeline-pages';

// "Fork conversation to new frame": a sibling frame beside the source, with a new agent in
// the same workspace that starts from Paseo's fork context of the source conversation.
// The source frame and its agent are not touched. Only started by an explicit menu action,
// so copying a frame never starts a paid agent (decisions.md §8).
//
// "Fork from here" is the same from an earlier message. The route names the message by its
// timeline row id (the `id` every row of the live stream and of the history pages carries:
// agent, timeline epoch and sequence range, timeline-pages.ts). The row is read again from
// the daemon, so its kind, time and current end are the daemon's, not the browser's. Then:
// - the opener holds the conversation up to and including that row: Paseo's own fork context
//   with `boundaryCursor` at the row's end (the daemon keeps the rows that end at or before it);
// - the new frame starts with a copy of the source frame's contents as they stood at the
//   row's time, from its History (frame-history.ts snapshotAt), under fresh ids, and takes
//   that version's size. With no version that old it starts empty and the response says so.
// Files on disk are not part of either: the opener says they were not rewound.

// The opener is capped (frame-start allows 100k); keep the end, where the conversation is.
const MAX_CONTEXT = 60_000;

function fail(status: number, message: string): never { throw Object.assign(new Error(message), { status }); }

// `point`: a fork from an earlier message (its time, and whether the frame's contents of
// that time were copied in).
export function forkOpener(source: {name: string; agentId: string}, context: string | null, point?: {at: string; contents: boolean}): string {
  const text = context?.trim() ?? '';
  const capped = text.length > MAX_CONTEXT ? `…(earlier conversation omitted)\n${text.slice(-MAX_CONTEXT)}` : text;
  return [
    `Fork of the conversation in frame "${source.name}" (agent ${source.agentId}). That conversation continues separately in its own frame; this frame is a new branch of it.`,
    ...(point ? [`This branch starts from an earlier point in that conversation: its message of ${point.at}. Later messages are deliberately not included, and files on disk are NOT rewound: they are as they are now.${point.contents ? " This frame starts with a copy of that frame's contents as they were then." : ''}`] : []),
    capped ? `Its conversation ${point ? 'up to that point' : 'so far'}:\n\n${capped}` : 'Its conversation could not be read; ask what this fork should pick up.',
    '',
    'Restate in one or two sentences where the conversation stood, put that on a sticky in your frame, then wait for direction. Do not repeat or continue work the original is doing unless asked.',
  ].join('\n');
}

// Not contents but live views of, or messages to, the source frame's agent: its transcript
// card, cloud session cards, plugin widgets and stamps (which carry a delivery state).
const NOT_COPIED = new Set<string>([TRANSCRIPT_TYPE, CLOUD_SESSION_TYPE, WIDGET_TYPE, STAMP_TYPE]);

export interface ContentsCopy {
  // Parents before children.
  shapes: Rec[];
  bindings: Rec[];
  // Asset records the copied shapes show (ids unchanged: a put only where the board lost one).
  assets: Rec[];
  // Shapes left out: NOT_COPIED kinds, frames with a binding, and what was inside those.
  skipped: number;
}

// A History version's records (frame-history.ts frameContents: the frame, its shapes, the
// bindings between them, their assets) as new records under `frameId`. Every shape and
// binding gets a fresh id; parents and binding ends follow the new ids; assets keep theirs.
// A binding with an end that was left out is dropped. No copy keeps a binding to an agent
// (meta.paseo) or a pending flush.
export function copyContents(version: readonly Rec[], frameId: string): ContentsCopy {
  const source = version[0];
  if (!isShape(source) || source.type !== 'frame') return { shapes: [], bindings: [], assets: [], skipped: 0 };
  const byId = new Map(version.map(r => [r.id, r]));
  const ids = new Map<string, string>([[source.id, frameId]]);
  const kept = new Map<string, boolean>([[source.id, true]]);
  const keep = (s: Rec): boolean => {
    const known = kept.get(s.id);
    if (known !== undefined) return known;
    kept.set(s.id, false); // cycle guard
    const parent = byId.get(s.parentId);
    const yes = !NOT_COPIED.has(s.type) && !s.meta?.paseo && isShape(parent) && keep(parent);
    kept.set(s.id, yes);
    return yes;
  };
  const depth = (s: Rec): number => {
    let d = 0;
    for (let p = byId.get(s.parentId); p && p.id !== source.id && d < 50; p = byId.get(p.parentId)) d++;
    return d;
  };
  const inside = version.filter(r => isShape(r) && r.id !== source.id);
  const copied = inside.filter(keep).sort((a, b) => depth(a) - depth(b));
  for (const s of copied) ids.set(s.id, createShapeId());
  const shapes = copied.map(s => {
    const { paseo: _binding, paseoFlushAt: _flush, ...meta } = (s.meta ?? {}) as Record<string, unknown>;
    return { ...structuredClone(s), id: ids.get(s.id)!, parentId: ids.get(s.parentId)!, meta } as Rec;
  });
  const bindings = version
    .filter(r => r.typeName === 'binding' && ids.has(r.fromId) && ids.has(r.toId))
    .map(b => ({ ...structuredClone(b), id: createBindingId(), fromId: ids.get(b.fromId)!, toId: ids.get(b.toId)! }) as Rec);
  const shown = new Set(shapes.map(s => s.props?.assetId).filter((a): a is string => typeof a === 'string'));
  const assets = version.filter(r => r.typeName === 'asset' && shown.has(r.id));
  return { shapes, bindings, assets, skipped: inside.length - copied.length };
}

// The frame's size in a History version (the new frame takes it).
export function versionSize(version: readonly Rec[]): { w: number; h: number } | null {
  const w = Number(version[0]?.props?.w), h = Number(version[0]?.props?.h);
  return version[0]?.type === 'frame' && w > 0 && h > 0 ? { w, h } : null;
}

// Why the daemon would not cut the conversation at a row, in the board's words.
function cutRefusal(message: string): string {
  if (/checkpoint changed|later completed response/i.test(message)) return 'a tool call was still running at that message, so the conversation cannot be cut there; fork from a later message';
  if (/no longer available/i.test(message)) return 'that message is no longer in the conversation; reload it and try again';
  return `the conversation could not be cut at that message: ${message}`;
}

export interface ForkResult {
  frameId: string;
  // "Fork from here" only: the message forked from, as the daemon has it.
  point?: { at: string; kind: 'user' | 'assistant' };
  // "Fork from here" only: the History version copied into the new frame, or null when the
  // frame starts empty (`empty` says why: nothing that old in its History, or a version
  // this board can no longer store).
  contents?: { version: string; at: number; shapes: number; skipped: number } | null;
  empty?: 'no-version' | 'not-copyable';
}

const inflight = new Set<string>();

export async function forkFrame(room: BoardRoom, watcher: FrameWatcher, bridge: PaseoBridge, frameId: string, from?: {rowId: string}): Promise<ForkResult> {
  const source = room.records.get(frameId);
  if (!source || source.type !== 'frame') fail(404, `frame ${frameId} is not on board ${room.id}`);
  const p = source.meta?.paseo as FramePaseoMeta | undefined;
  if (!p?.agentId || p.request) fail(409, 'this frame has no conversation to fork yet');
  if (p.host) fail(409, `this conversation runs on ${p.host}; only this machine's conversations can be forked`);
  const k = `${room.id}/${frameId}`;
  if (inflight.has(k)) fail(409, 'this frame is already being forked');
  inflight.add(k);
  try {
    const agentId = p.agentId;
    const api = await bridge.ready;
    const ref = api.agents.ref(agentId);
    const snap = await ref.refresh().catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: agent snapshot payload.
    const a = snap?.agent as any;
    if (!a) fail(404, `agent ${agentId} not found in Paseo`);
    const provider = a.model ? `${a.provider}/${a.model}` : String(a.provider);
    const workspaceId: string | undefined = a.workspaceId ?? p.workspaceId ?? undefined;
    const cwd: string | undefined = !workspaceId && typeof a.cwd === 'string' ? a.cwd : undefined;
    let context: string | null = null;
    let point: { at: string; ms: number; kind: 'user' | 'assistant' } | null = null;
    if (from) {
      const { epoch, entry } = await timelineEntry(ref.timeline, agentId, from.rowId);
      const kind = entry.item.type === 'user_message' ? 'user' : entry.item.type === 'assistant_message' ? 'assistant' : null;
      if (!kind) fail(400, 'fork from a message you or the agent wrote; this row is not one');
      const ms = Date.parse(entry.timestamp);
      if (!Number.isFinite(ms)) fail(409, 'that message has no time; fork from another one');
      point = { at: new Date(ms).toISOString(), ms, kind };
      // A fork from a point never starts without its cut: an opener holding the whole
      // conversation, or none, would not be what was asked for.
      const cursor = { epoch, seq: entry.seqEnd };
      if (!bridge.aux) fail(503, 'Paseo is not connected; try again in a moment');
      const res = await bridge.aux.buildAgentForkContext(agentId, { boundaryCursor: cursor }).catch((e: Error) => fail(409, cutRefusal(e.message)));
      // A daemon that does not know `boundaryCursor` ignores it and answers with everything.
      if (res.boundaryCursor?.epoch !== cursor.epoch || res.boundaryCursor?.seq !== cursor.seq) fail(409, 'this Paseo version cannot cut a conversation at a message; update Paseo to fork from an earlier point');
      context = res.attachment?.text ?? null;
      if (!context?.trim()) fail(502, 'the conversation up to that message could not be read; try again');
    } else {
      try {
        const res = await bridge.aux?.buildAgentForkContext(agentId);
        context = res?.attachment?.text ?? null;
      } catch { /* the opener says the context could not be read */ }
    }
    const fresh = room.records.get(frameId);
    if (!fresh) fail(410, 'the frame was deleted while forking');
    const name = String(fresh.props.name || a.title || 'Conversation').trim();
    const origin = besideShape(room, frameId);
    const pageId = origin.pageId;
    // The frame as it stood at that message (its History), or nothing that old.
    const version = point ? (watcher.history?.at(room.id, frameId, point.ms) ?? null) : null;
    const build = (size: {w: number; h: number}, contents: boolean): Rec => {
      const slot = gridSlots(topLevelBounds(room.records, pageId), 1, origin, size)[0];
      return buildShape({type:'frame', text:`${name.slice(0, 70)} (fork)`, w:size.w, h:size.h, color:'light-blue'}, pageId, nextIndex(room.records, pageId), slot.x, slot.y, {
        paseo: {status:'requested', forkOf:{frameId, agentId, ...(point ? {at: point.at} : {})}, request:{kind:'create', provider, prompt:forkOpener({name, agentId}, context, point ? {at: point.at, contents} : undefined), requestedAt:Date.now(),
          ...(workspaceId ? {workspaceId} : {}), ...(cwd ? {cwd, context:'repo' as const} : {})}},
      });
    };
    let frame: Rec | null = null;
    let result: ForkResult | null = null;
    if (version) {
      // One write: a version this board can no longer store (an older schema) fails whole.
      const made = build(versionSize(version.records) ?? IMPORT_FRAME, true);
      const copy = copyContents(version.records, made.id);
      // The frame was empty then (or held only what is not copied): the opener does not call it a copy.
      if (!copy.shapes.length) made.meta.paseo.request.prompt = forkOpener({name, agentId}, context, {at: point!.at, contents: false});
      try {
        room.write({kind:'server', reason:'frame-fork'}, ops => {
          ops.put(made);
          for (const asset of copy.assets) if (!ops.get(asset.id)) ops.put(asset);
          for (const shape of copy.shapes) ops.put(shape);
          for (const binding of copy.bindings) ops.put(binding);
        });
        frame = made;
        result = { frameId: made.id, point: { at: point!.at, kind: point!.kind }, contents: { version: version.id, at: version.at, shapes: copy.shapes.length, skipped: copy.skipped } };
      } catch { /* starts empty below */ }
    }
    if (!frame) {
      frame = build(IMPORT_FRAME, false);
      const empty = frame;
      room.write({kind:'server', reason:'frame-fork'}, ops => ops.put(empty));
      result = point ? { frameId: frame.id, point: { at: point.at, kind: point.kind }, contents: null, empty: version ? 'not-copyable' : 'no-version' } : { frameId: frame.id };
    }
    room.save();
    const started = frame.id;
    setImmediate(() => { void watcher.fulfil(room, started); });
    return result!;
  } finally {
    inflight.delete(k);
  }
}
