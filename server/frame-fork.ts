import type { FrameWatcher } from './frame-watcher';
import { besideShape } from './frame-start';
import { gridSlots, IMPORT_FRAME, topLevelBounds } from './layout';
import type { PaseoBridge } from './paseo-bridge';
import { buildShape, type FramePaseoMeta, nextIndex } from './records';
import type { BoardRoom } from './room-host';

// "Fork conversation to new frame": a sibling frame beside the source, with a new agent in
// the same workspace that starts from Paseo's fork context of the source conversation.
// The source frame and its agent are not touched. Only started by an explicit menu action,
// so copying a frame never starts a paid agent (decisions.md §8).

// The opener is capped (frame-start allows 100k); keep the end, where the conversation is.
const MAX_CONTEXT = 60_000;

function fail(status: number, message: string): never { throw Object.assign(new Error(message), { status }); }

export function forkOpener(source: {name: string; agentId: string}, context: string | null): string {
  const text = context?.trim() ?? '';
  const capped = text.length > MAX_CONTEXT ? `…(earlier conversation omitted)\n${text.slice(-MAX_CONTEXT)}` : text;
  return [
    `Fork of the conversation in frame "${source.name}" (agent ${source.agentId}). That conversation continues separately in its own frame; this frame is a new branch of it.`,
    capped ? `Its conversation so far:\n\n${capped}` : 'Its conversation could not be read; ask what this fork should pick up.',
    '',
    'Restate in one or two sentences where the conversation stood, put that on a sticky in your frame, then wait for direction. Do not repeat or continue work the original is doing unless asked.',
  ].join('\n');
}

const inflight = new Set<string>();

export async function forkFrame(room: BoardRoom, watcher: FrameWatcher, bridge: PaseoBridge, frameId: string): Promise<{frameId: string}> {
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
    const snap = await api.agents.ref(agentId).refresh().catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: agent snapshot payload.
    const a = snap?.agent as any;
    if (!a) fail(404, `agent ${agentId} not found in Paseo`);
    const provider = a.model ? `${a.provider}/${a.model}` : String(a.provider);
    const workspaceId: string | undefined = a.workspaceId ?? p.workspaceId ?? undefined;
    const cwd: string | undefined = !workspaceId && typeof a.cwd === 'string' ? a.cwd : undefined;
    let context: string | null = null;
    try {
      const res = await bridge.aux?.buildAgentForkContext(agentId);
      context = res?.attachment?.text ?? null;
    } catch { /* the opener says the context could not be read */ }
    const fresh = room.records.get(frameId);
    if (!fresh) fail(410, 'the frame was deleted while forking');
    const name = String(fresh.props.name || a.title || 'Conversation').trim();
    const pageId = room.pageId();
    const slot = gridSlots(topLevelBounds(room.records, pageId), 1, besideShape(room, frameId))[0];
    const frame = buildShape({type:'frame', text:`${name.slice(0, 70)} (fork)`, ...IMPORT_FRAME, color:'light-blue'}, pageId, nextIndex(room.records, pageId), slot.x, slot.y, {
      paseo: {status:'requested', forkOf:{frameId, agentId}, request:{kind:'create', provider, prompt:forkOpener({name, agentId}, context), requestedAt:Date.now(),
        ...(workspaceId ? {workspaceId} : {}), ...(cwd ? {cwd, context:'repo' as const} : {})}},
    });
    room.write({kind:'server', reason:'frame-fork'}, ops => ops.put(frame));
    room.save();
    setImmediate(() => { void watcher.fulfil(room, frame.id); });
    return {frameId: frame.id};
  } finally {
    inflight.delete(k);
  }
}
