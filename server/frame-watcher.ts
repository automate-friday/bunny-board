import {executionProvider,upstashDefault} from '../shared/conversation-links';
import { bunnyEnv } from "./bunny-env";
import { startPending } from "../shared/start-pending";
import { timed } from "./perf";
import path from "node:path";
import { compressionOffers } from "./frame-compression";
import type { PromptOutbox, PromptReceipt } from "./prompt-outbox";
import { hostOperation } from "./daemon-health";
import { pinTranscriptCard } from "./agent-api";
import { BoardWorkspaces } from './board-workspaces';
import { cleanName, isGenericName, isProvisionalName, reconcileNames, startName } from "./frame-names";
import { BOARD_SYSTEM_PROMPT, agentContext, frameUpkeep } from "./agent-context";
import { missingAgent, retryableBindingError, withDaemonRead } from './daemon-health';
// Watches every board for frame binding requests and human edits inside bound
// frames. Fulfils requests through Paseo, keeps frame status/colour in sync with
// the agent, and turns human edits into debounced, turn-aware "board delta"
// prompts (design sections 3, 5 and 10).

import type { PaseoApi } from "@getpaseo/client";
import { randomUUID } from "node:crypto";
import type { WidgetHub } from "./widgets";
import { componentAgentIds, isComponent, type OutlineContext, VIEW_ONLY_PROPS } from "../shared/components";
import type { LinkTarget } from "../shared/components/link";
import { SILENT_ACK, TRANSCRIPT_TYPE } from "../shared/components/transcript";
import { addedMessages, addedShares, COMMENT_DELTA_PREFIX, type CommentMessage, type CommentThread, orderedMessages, readThreads, splitMentions } from "../shared/comments";
import { resolveStartProvider, startEffort } from "../shared/start-catalogue";
import { advancesTo, isStampKind, STAMP_TYPE, type StampState, stampEvent, stampMeanings, stampMessage, stampNoteMessage } from "../shared/components/stamp";
import { type BoardLocks, DOCUMENT_ID, LOCKS_KEY, layoutChange, lockSummary, NO_LOCKS, readLocks } from "../shared/locks";
import { type BoardConfig, frameToken } from "./config";
import { boardOutline, frameOutline } from "./outline";
import { type AgentStatus, type PaseoBridge, statusOf } from "./paseo-bridge";
import {
  absPos,
  ancestors,
  describeShape,
  type FramePaseoMeta,
  type FrameStatus,
  gridCell,
  isShape,
  owningBoundFrame,
  kindLabel,
  quote,
  quoteLines,
  type Rec,
  STATUS_COLOR,
  shapeSize,
  shapeText,
} from "./records";
import { authorFor, type BoardHost, type BoardRoom, type ChangeSource, type RecordChange, type WriteOps } from "./room-host";
import { SEEN, type LifecycleParity } from "./lifecycle-parity";
import { colourOf, legacyStatusOf, type Lifecycle, type LifecycleEvent, type LifecycleMeta, lifecycleCode, lifecycleOf, storedActivityOf, transition } from "../shared/frame-lifecycle";
import type { Receipt, RemoteAgents } from "./remote";
import { burstDelay, type FrameHistory } from "./frame-history";
import type { FrameArchive } from "./frame-archive";
import { simplifyItem } from "./timeline";
import type { TranscriptHub } from "./transcripts";
import { frameCloudProvider, requestedCloudProvider, type CloudProvider } from "../shared/cloud-provider";

// Longest delta prompt body (linked frames quote whole texts).
const DELTA_CAP = 12_000;
// How long an agent released from a frame (deleted or unbound) may be archived from the board UI.
const RELEASED_TTL_MS = 30 * 60_000;
// A frame title being typed settles before it is sent to Paseo as the agent's name.
const NAME_SYNC_MS = 1500;
// Live frames steer deltas into a busy agent's turn, at most once per this interval
// (cfg.busyDeltaMs), so steady editing cannot flood a long-running turn.
const BUSY_DELTA_MS = 20_000;
// A bound agent the daemon called missing, or never read, is re-read by reconcileStatuses: first on the
// next pass, then with a doubling gap up to five minutes, so a board of deleted agents does
// not cost a daemon read each every 15 s.
const UNKNOWN_REREAD_MS = 15_000;
const UNKNOWN_REREAD_MAX_MS = 300_000;

// The lifecycle state a frame's stored fields say it is in (shared/frame-lifecycle.ts reads
// them structurally, so the server's own meta type is passed as is).
const stateOf = (p: FramePaseoMeta | undefined): Lifecycle => lifecycleOf(p as LifecycleMeta | undefined);

export const BOARD_TOOLS = ["board_read", "board_write", "board_update", "board_delete", "board_frame", "board_layout", "board_add_artifact", "board_pin_transcript", "board_widget", "board_stamp", "board_video", "board_channel", "board_archive_candidates", "board_archive"];

// What a delta is for: context, not a request. Agents used to answer every one (an
// "I've seen it" sticky for an FYI note); now they reply only when asked something.
export function deltaFooter(human: string, linked: boolean, busy = false): string {
  const how = linked
    ? `This session has no board tools; ${human} reads your reply in the board sidebar.`
    : "Call board_read if you need the whole frame; keep board writes inside your frame.";
  // Steered into a running turn: a one-word acknowledgement would end the agent's work.
  if (busy)
    return `(This is context: ${human}'s edits, sent while you were working so you know what changed. Carry on with your current task and take them into account. Respond to them only if they ask you a question, ask you to do something, or change your task; do not stop to acknowledge them. ${how})`;
  return [
    `(This is context: ${human}'s edits, sent so you know what changed. Reply only if it asks you a question, asks you to do something, or changes your task.`,
    `Otherwise acknowledge silently: no sticky, no board write, and reply with exactly one word: ${SILENT_ACK} (the board shows that as a tick, not a message). ${how})`,
  ].join(" ");
}

interface Touch {
  before: Rec | null;
  wasInside: boolean;
  adopted?: boolean;
}

interface Binding {
  boardId: string;
  frameId: string;
  agentId: string;
  status: FrameStatus;
  // Provider subagents still running (display only: status stays the agent's own).
  subagents: number;
  // An agent the daemon called missing (or never read) is re-read by reconcileStatuses with a growing gap:
  // how many times it was still missing, and when to ask next.
  unknownReads?: number;
  unknownReadAt?: number;
  touched: Map<string, Touch>;
  pendingText: Map<string, Touch>;
  textQuietAt: number;
  frameBefore: Rec | null;
  timer: ReturnType<typeof setTimeout> | null;
  // A later flush: a busy agent's rate limit or text still settling (see wake). Unlike
  // the edit debounce timer it does not hold back a flush from a turn end.
  wakeTimer: ReturnType<typeof setTimeout> | null;
  queued: string[];
  humanName: string;
  seq: number;
  sending: boolean;
  firstTouchAt: number;
  // An imported conversation that has not had its board introduction yet (sent at the
  // next idle moment, even before any edit; see importIntro).
  introPending: boolean;
  // Another machine's Paseo agent (af-network host), reached through af-network.
  host: string | null;
  // After an unconfirmed remote send: automatic sends stop until "Send N changes".
  held: boolean;
  // Turn ends seen for this agent (hooks and status-reconcile), and the count when the
  // delta in flight was dispatched: a confirmation that arrives after its turn already
  // ended must not mark the frame busy again.
  turnEnds: number;
  sentAtTurn: number | null;
  // When the last delta was dispatched (busy agents get at most one per busyDeltaMs).
  lastSentAt: number;
  // The unconfirmed receipt whose hold was last logged (logged once per receipt).
  loggedHold?: string;
}

export interface RestartResult {
  agentId: string;
  oldAgentId: string;
  archivedOld: boolean;
  url: string;
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

// Binding fields only the server may change. Human edits to them are reverted.
const SERVER_OWNED = ["agentId", "activity", "workspaceId", "boundAt", "linked", "queue", "pendingDeltas", "lastDeltaAt", "error", "introducedAt", "introPending", "previousAgentId", "forkOf", "restart", "host", "lastReceipt", "workspaceSetup", "bindRetry", "pendingText", "deltaDelivery", "relink", "cloud", "cloudProvider", "compressionOffer", "compression", "remoteStart"] as const;

// A shape a person creates while the layout is locked may still be shaped by the tool
// that is creating it (a box dragged out, a stroke, an arrow) for this long.
const FRESH_MS = 15_000;

const key = (boardId: string, frameId: string) => `${boardId}/${frameId}`;

const DERIVED_KEYS = new Set(["props.growY", "props.fontSizeAdjustment", "props.textLastEditedBy", "meta.author", "meta.measuredTextBounds", "index"]);

// Clients recompute derived props (note growY, font fit, arrow geometry) after any write,
// including agent writes. Those echoes are not anyone's intent. Component view toggles
// (a transcript card's mode/follow) are a person's own view state.
function echoOnly(before: Rec, after: Rec, keys = changedKeys(before, after)): boolean {
  const viewOnly = VIEW_ONLY_PROPS[after.type] ?? [];
  return keys.every((k) => DERIVED_KEYS.has(k) || viewOnly.some((p) => k === `props.${p}`));
}

// `rec` with the placement (position, rotation, parent, box) of `from`.
function withLayoutOf(rec: Rec, from: Rec): Rec {
  return { ...rec, x: from.x, y: from.y, rotation: from.rotation, parentId: from.parentId, index: from.index, props: { ...rec.props, ...pick(from.props, ["w", "h", "scale", "start", "end", "points", "bend"]) } };
}

function pick(o: Record<string, unknown> | undefined, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (o && k in o) out[k] = o[k];
  return out;
}

function changedKeys(a: Rec, b: Rec): string[] {
  const out: string[] = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (k === "props" || k === "meta") {
      const pa = a[k] ?? {};
      const pb = b[k] ?? {};
      for (const kk of new Set([...Object.keys(pa), ...Object.keys(pb)]))
        if (JSON.stringify(pa[kk]) !== JSON.stringify(pb[kk])) out.push(`${k}.${kk}`);
    } else if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(k);
  }
  return out;
}

// Retarget existing cards before a replacement agent can call board_pin_transcript.
// The same operation reverses the transfer if creation fails or startup recovers.
function retargetTranscripts(room: BoardRoom, ops: WriteOps, frameId: string, oldId: string, newId: string): void {
  for (const r of room.records.values()) {
    if (r.type === TRANSCRIPT_TYPE && r.props?.agentId === oldId && ancestors(room.records, r).includes(frameId)) ops.put({ ...r, props: { ...r.props, agentId: newId } });
  }
}

const isCommentDelta = (t: string) => t.startsWith(COMMENT_DELTA_PREFIX) || t.startsWith(`(Possibly a repeat: an earlier send was unconfirmed.) ${COMMENT_DELTA_PREFIX}`);

// A delivery receipt that carried nothing: no text, no deltas, no introduction.
const isEmptyReceipt = (d: { text?: string; deltas?: string[]; intro?: boolean }) => !d.text?.trim() && !d.deltas?.length && !d.intro;

// Remove and return the queued comments, keeping deltas for later.
function takeComments(queue: string[]): string[] {
  const out = queue.filter(isCommentDelta);
  const rest = queue.filter((t) => !isCommentDelta(t));
  queue.splice(0, queue.length, ...rest);
  return out;
}

export class FrameWatcher {
  private workspacePolicy: BoardWorkspaces | null = null;
  private readonly bindings = new Map<string, Binding>();
  private readonly byAgent = new Map<string, Binding>();
  private readonly nameTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // The agent title Paseo last reported (hook events), so a frame rename knows what it replaces.
  private readonly paseoTitles = new Map<string, string>();
  private readonly inflight = new Set<string>();
  private readonly bindRetries = new Map<string, ReturnType<typeof setTimeout>>();
  private host!: BoardHost;
  // Per-frame snapshots for the History slider (server/frame-history.ts).
  history: FrameHistory | null = null;
  archive: FrameArchive | null = null;
  private stopped = false;
  transcripts: TranscriptHub | null = null;
  // Plugin widget data sources (server/widgets): board_read shows each widget's status.
  widgets: WidgetHub | null = null;
  promptOutbox: PromptOutbox | null = null;
  // Shadow parity check of the lifecycle machine against these writers (lifecycle-parity.ts).
  parity: LifecycleParity | null = null;
  promptReceiptChanged(receipt: PromptReceipt): void {
    if(receipt.kind==='stamp'){this.stampReceipt(receipt);return;}
    const b=this.bindingFor(receipt.boardId,receipt.frameId);
    if(!b || b.agentId!==receipt.agentId)return;
    const prior=this.frameMeta(b)?.deltaDelivery;
    if(!prior || prior.operationId!==receipt.messageId)return;
    // Only a timeline-confirmed delta releases the frame; accepted is still being checked.
    // An old accepted receipt the timeline cannot place (final) is left as it was: released.
    const delivered=receipt.status==='delivered'||(receipt.status==='accepted'&&!!receipt.final);
    const pending=!receipt.final&&(receipt.status==='queued'||receipt.status==='sending'||receipt.status==='accepted'||(receipt.status==='unknown'&&receipt.reason!=='binding-revoked'));
    b.held=!delivered;
    if(delivered && prior.intro)b.introPending=false;
    const error=delivered?undefined:receipt.status==='queued'?(receipt.reason==='waiting-turn'?'Board message waits for the agent\'s turn to end (its provider cannot take messages mid-turn).':receipt.reason==='waiting-status'?'Board message waits until the other Mac reports the agent idle.':receipt.attempts?'Board message not confirmed yet; resending automatically.':'Board message queued; waiting for host recovery.'):pending?'Board message sent; waiting for it to appear in the conversation.':`Board message not delivered (${receipt.reason ?? 'unknown'}). Send again or discard.`;
    this.writeFrameMeta(b,{deltaDelivery:{...prior,status:delivered?'accepted':pending?'sending':'unknown'},error,introPending:b.introPending||undefined,...(delivered&&prior.intro?{introducedAt:Date.now()}:{}),pendingDeltas:b.queued.length+b.pendingText.size});
    this.host.get(b.boardId).save();
    if(receipt.status==='delivered'||(receipt.status==='accepted'&&receipt.reason==='host-ack')){
      this.record(b,prior.text,receipt.status==='delivered'?'delivered':'accepted-remote:host-ack');
      // The delta starts (or joins) a turn: hold the next one until it ends. If that turn
      // already ended (its hook beat the timeline confirmation), the agent is idle now.
      const turnEnded=b.sentAtTurn!==null&&b.turnEnds!==b.sentAtTurn;
      b.sentAtTurn=null;
      if(!turnEnded)this.promptSent(b);
    }
    // Edits that settled while this delta was in flight were held only by it: deliver them
    // now (flush re-checks busy, paused and mode) instead of waiting for an unrelated edit.
    if(delivered)queueMicrotask(()=>void this.flush(b,false));
  }
  // Agents on other machines (af-network); null when the remote source is off.
  remote: RemoteAgents | null = null;
  private wsPending = new Map<string, Promise<string | undefined>>();
  private componentAgentsMemo: { at: number; ids: Set<string> } | null = null;
  // Human pushes that touched component shapes, by changed key (proof: cards must not churn).
  readonly componentEdits: Record<string, number> = {};
  // Every delivered or queued delta, for the proof log and the sidebar.
  readonly deliveries: Array<{ at: string; boardId: string; frameId: string; agentId: string; text: string; event: string }> = [];

  constructor(
    private readonly cfg: BoardConfig,
    private readonly bridge: PaseoBridge,
    private readonly log: (msg: string) => void,
  ) {}

  attach(host: BoardHost): void {
    this.host = host;
  }

  detachBoard(boardId:string){
    for(const b of this.bindings.values())if(b.boardId===boardId){if(b.timer)clearTimeout(b.timer);this.unwake(b);this.bindings.delete(key(b.boardId,b.frameId));if(this.byAgent.get(b.agentId)===b)this.byAgent.delete(b.agentId);}
    for(const [id,r]of this.reserved)if(r.boardId===boardId)this.reserved.delete(id);
    for(const [id,timer]of this.bindRetries)if(id.startsWith(boardId+'/')){clearTimeout(timer);this.bindRetries.delete(id);}
    this.componentAgentsMemo=null;
  }

  onHostReady(){if(this.stopped||this.bridge.health().state!=='connected')return;for(const b of this.bindings.values())void this.flush(b,false);}

  // --- startup resume (P4) -------------------------------------------------------

  async resume(rooms: BoardRoom[]): Promise<void> {
    // Bind every frame first, synchronously, so the sidebar and cards can prompt, stop
    // and stream bound agents as soon as the server is up (before Paseo reconnects).
    const resumed: Array<{ room: BoardRoom; b: Binding }> = [];
    const remote: Array<{ room: BoardRoom; b: Binding }> = [];
    const requests: Array<{ room: BoardRoom; frameId: string }> = [];
    for (const room of rooms) {
      for (const r of room.records.values()) {
        if (r.type !== "frame") continue;
        const p: FramePaseoMeta | undefined = r.meta?.paseo;
        if (p?.request) { requests.push({ room, frameId: r.id }); const pendingId=p.request.kind==='link'?p.request.agentId:p.agentId;if(pendingId&&!this.boundRef(pendingId))this.reserved.set(pendingId,{boardId:room.id,frameId:r.id}); }
        else if (p?.agentId) {
          const b = this.bind(room.id, r.id, p.agentId, p.status ?? "idle", p.host || null);
          // Deltas that were queued when the server stopped are persisted in meta.
          if (Array.isArray(p.queue) && p.queue.length) b.queued = [...(p.queue as string[])];
          if(Array.isArray(p.pendingText))for(const [id,touch] of p.pendingText) b.pendingText.set(id,touch);
          if(p.deltaDelivery&&isEmptyReceipt(p.deltaDelivery)){
            // A send that carried nothing (an empty prompt, fixed in #49) cannot be repeated or
            // lost: clear it instead of holding the frame on it.
            this.log(`cleared an empty unconfirmed delivery on ${room.id}/${r.id}`);
            this.writeFrameMeta(b,{deltaDelivery:undefined,error:undefined});room.save();
          }
          else if(p.deltaDelivery?.status==='sending'||p.deltaDelivery?.status==='unknown'){
            b.held=true;
            this.writeFrameMeta(b,{deltaDelivery:{...p.deltaDelivery,status:'unknown'},error:'Board message delivery unconfirmed after interruption. Resolve its receipt before sending again.'});room.save();
          }
          b.introPending = p.introPending === true && !p.introducedAt;
          if (b.host) {
            remote.push({ room, b });
            continue;
          }
          resumed.push({ room, b });
        }
      }
    }
    // Other machines' agents: their status comes from af-network polls, not from Paseo here.
    for (const { b } of remote) {
      this.log(`resume ${b.boardId}/${b.frameId} → remote agent ${b.host}/${b.agentId}`);
      // Its first af-network read sends a pending introduction if it is idle (onRemoteStatus).
      this.remote?.watchStatus(b.host!, b.agentId);
    }
    for (const { room, frameId } of requests) void this.fulfil(room, frameId);
    const api = await this.bridge.ready;
    const unread: Array<{ room: BoardRoom; b: Binding }> = [];
    for (const { room, b } of resumed) {
      const snap = await this.resumeRead(api, b.agentId);
      // undefined: the daemon could not be read (at start-up the API exists before its
      // connection is accepted). That says nothing about the agent, so keep the frame's
      // stored status and read again; only an answer (null = no such agent) is applied.
      if (snap === undefined) unread.push({ room, b });
      else this.resumeAgent(room, b, snap);
    }
    if (unread.length) void this.resumeWhenReadable(api, unread);
  }

  // An agent read at resume: the snapshot, null when the daemon says there is no such agent
  // (an answer of null, or a not-found error), undefined when it could not be asked (not
  // connected yet, timeout, server error): only the first two say anything about the agent.
  // biome-ignore lint/suspicious/noExplicitAny: a daemon agent snapshot.
  private resumeRead(api: PaseoApi, agentId: string): Promise<any> {
    return api.agents.ref(agentId).refresh().catch((e) => (missingAgent(e) ? null : undefined));
  }

  // Delay between start-up reads of agents the daemon could not be asked about yet; the last
  // one repeats until the daemon answers.
  resumeRetryMs = [1000, 2000, 5000, 10000, 30000];

  private async resumeWhenReadable(api: PaseoApi, pending: Array<{ room: BoardRoom; b: Binding }>): Promise<void> {
    for (const { room, b } of pending) this.log(`resume ${room.id}/${b.frameId} → agent ${b.agentId} (status unavailable: daemon not answering yet; keeping ${b.status})`);
    for (let attempt = 0; pending.length && !this.stopped; attempt++) {
      const delay = this.resumeRetryMs[Math.min(attempt, this.resumeRetryMs.length - 1)];
      await new Promise((r) => { const t = setTimeout(r, delay); (t as { unref?: () => void }).unref?.(); });
      for (const item of [...pending]) {
        if (this.stopped) return;
        if (this.bindingFor(item.room.id, item.b.frameId) !== item.b) { pending.splice(pending.indexOf(item), 1); continue; }
        const snap = await this.resumeRead(api, item.b.agentId);
        if (snap === undefined) continue;
        pending.splice(pending.indexOf(item), 1);
        this.resumeAgent(item.room, item.b, snap);
      }
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: a daemon agent snapshot.
  private resumeAgent(room: BoardRoom, b: Binding, snap: any): void {
    // The read was awaited: the frame may have been re-bound, or the watcher stopped, since.
    // An answer about the old agent must not touch the frame's new binding or its restart.
    if (!this.current(b)) return;
    // A restart with board tools that never finished creating its agent: put the
    // previous conversation back on the frame.
    const pending = room.records.get(b.frameId)?.meta?.paseo?.restart as FramePaseoMeta["restart"];
    if (pending && snap === null && this.byAgent.get(pending.from)) {
      this.log(`resume ${room.id}/${b.frameId}: restart never completed, but ${pending.from} is bound elsewhere now; leaving the frame in error`);
    } else if (pending && snap === null) {
      this.log(`resume ${room.id}/${b.frameId}: restart to ${b.agentId} never completed; restoring ${pending.from}`);
      const back = this.bind(room.id, b.frameId, pending.from, "idle");
      if (Array.isArray(pending.prev.queue)) back.queued = [...(pending.prev.queue as string[])];
      room.write({ kind: "server", reason: "restart-recover" }, (ops) => {
        retargetTranscripts(room, ops, b.frameId, b.agentId, pending.from);
        const cur = ops.get(b.frameId);
        if (cur) ops.put({ ...cur, meta: { ...cur.meta, paseo: { ...pending.prev, error: "Restart with board tools did not finish (the board server restarted); the previous conversation is back." } } });
      });
      void this.refreshStatus(room.id, back.frameId);
      return;
    }
    if (pending && snap) this.finishRestart(room, b.frameId, pending.from, b.agentId);
    const status = statusOf(snap?.agent);
    this.log(`resume ${room.id}/${b.frameId} → agent ${b.agentId} (${status})`);
    // The stranded restart (its old agent is bound elsewhere) is still left in error by the
    // old writer; the machine takes it over with the restart writers.
    if (pending && snap === null) this.applyStatusLegacy(b, status);
    else this.agentStatus(b, status);
    if (b.introPending || b.queued.length || b.pendingText.size) void this.flush(b, false);
  }

  private bind(boardId: string, frameId: string, agentId: string, status: FrameStatus, host: string | null = null): Binding {
    const k = key(boardId, frameId);
    const prev = this.bindings.get(k);
    if (prev && prev.agentId === agentId) { prev.host = host; return prev; }
    if (prev) {
      // A re-bind (restart with board tools): the old binding's pending timer must not
      // settle and send to the old agent.
      if (prev.timer) clearTimeout(prev.timer);
      prev.timer = null;
      this.unwake(prev);
      this.byAgent.delete(prev.agentId);
    }
    const b: Binding = {
      boardId,
      frameId,
      agentId,
      status,
      subagents: this.subagentCount?.(agentId) ?? 0,
      touched: new Map(),
      pendingText: new Map(),
      textQuietAt: 0,
      frameBefore: null,
      timer: null,
      wakeTimer: null,
      queued: [],
      humanName: this.cfg.humanName,
      seq: 0,
      sending: false,
      firstTouchAt: 0,
      introPending: false,
      host,
      held: false,
      turnEnds: 0,
      sentAtTurn: null,
      lastSentAt: 0,
    };
    this.bindings.set(k, b);
    this.byAgent.set(agentId, b);
    this.onBind?.(agentId);
    return b;
  }

  boundAgentIds(): string[] {
    return [...this.byAgent.keys()];
  }

  // The subagent tracker checks every newly bound agent and seeds its count.
  onBind: ((agentId: string) => void) | null = null;
  subagentCount: ((agentId: string) => number) | null = null;

  // An idle agent whose background subagents still run is drawn as working.
  // ponytail: colour only; the stored status stays the agent's own, so prompt gating and
  // delta delivery are unchanged.
  // Active cloud session cards in a frame (server/cloud-sessions.ts; set by core.ts).
  cloudCount?: (boardId: string, frameId: string) => number;

  private cloudIn(b: Binding): number {
    return this.cloudCount?.(b.boardId, b.frameId) ?? 0;
  }

  // An idle agent whose cloud session still runs is not done either.
  private frameColor(b: Binding): string {
    return STATUS_COLOR[b.status === "idle" && (b.subagents > 0 || this.cloudIn(b) > 0) ? "running" : b.status];
  }

  cloudChanged(boardId: string, frameId: string): void {
    const b = this.bindings.get(key(boardId, frameId));
    if (b) this.dispatchStatus(b, null);
  }

  setSubagents(agentId: string, running: number): void {
    const b = this.byAgent.get(agentId);
    if (!b || b.subagents === running) return;
    b.subagents = running;
    this.dispatchStatus(b, null);
  }

  bindingFor(boardId: string, frameId: string): Binding | undefined {
    return this.bindings.get(key(boardId, frameId));
  }

  // A binding replaced by a re-bind (restart with board tools) must not touch the frame.
  private current(b: Binding): boolean {
    return !this.stopped && this.bindings.get(key(b.boardId, b.frameId)) === b;
  }

  // Linked agents cannot board_read, so on-demand would hold their deltas forever.
  private modeOf(b: Binding): string {
    const p = this.frameMeta(b);
    const mode = p?.mode ?? "live";
    return p?.linked && mode === "on-demand" ? "live" : mode;
  }

  isBoundAgent(agentId: string): boolean {
    return this.byAgent.has(agentId);
  }

  // Re-read one bound frame's agent status from Paseo.
  async refreshStatus(boardId: string, frameId: string): Promise<void> {
    const b = this.bindingFor(boardId, frameId);
    if (!b) return;
    if (b.host) return void (await this.remote?.read(b.agentId));
    const api = await this.bridge.ready;
    const snap = await api.agents
      .ref(b.agentId)
      .refresh()
      .catch(() => undefined);
    if (snap === undefined || this.bindingFor(boardId, frameId) !== b) return;
    this.agentStatus(b, statusOf(snap?.agent));
  }

  // Where an agent is bound, if anywhere (one frame per agent).
  boundRef(agentId: string): { boardId: string; frameId: string } | null {
    const b = this.byAgent.get(agentId);
    if (b) return { boardId: b.boardId, frameId: b.frameId };
    // An agent being replaced by "Restart with board tools" stays reserved to its frame
    // until the restart settles (it may be put back).
    return this.reserved.get(agentId) ?? null;
  }

  private readonly reserved = new Map<string, { boardId: string; frameId: string }>();

  // Agents shown by a component on some board (a transcript card). The UI proxy may
  // read these as well as bound agents.
  componentAgents(): Set<string> {
    const now = Date.now();
    if (this.componentAgentsMemo && now - this.componentAgentsMemo.at < 1000) return this.componentAgentsMemo.ids;
    const ids = new Set<string>();
    for (const room of this.host.all()) for (const r of room.records.values()) if (isShape(r) && isComponent(r)) for (const id of componentAgentIds(r as never)) ids.add(id);
    this.componentAgentsMemo = { at: now, ids };
    return ids;
  }

  isVisibleAgent(agentId: string): boolean {
    return this.byAgent.has(agentId) || this.componentAgents().has(agentId) || this.startPendingFor(agentId);
  }

  // The agent's frame still has its start under way (shared/start-pending.ts): a remote
  // start the host has not finished, or a bind after a restart that has not settled. The
  // UI may read it and queue replies for it; they wait for the start (waiting-start).
  startPendingFor(agentId: string): boolean {
    const ref = this.boundRef(agentId);
    if (!ref || !this.host) return false;
    const p = this.host.peek(ref.boardId)?.get(ref.frameId)?.meta?.paseo;
    return p?.agentId === agentId && startPending(p);
  }

  outlineCtx(): OutlineContext {
    return { transcript: (id) => this.transcripts?.summary(id) ?? null, link: (board, frameId) => this.linkTarget(board, frameId), widget: (widgetId, config) => this.widgets?.state(widgetId, config) ?? null };
  }

  boardExists(id: string): boolean {
    return this.host.exists(id);
  }

  // What a board link card points at: the board's frame counts, or one frame's name and
  // agent status. Boards that are not open are read from their snapshot (BoardHost.peek).
  linkTarget(board: string, frameId: string): LinkTarget {
    const records = this.host.exists(board) ? this.host.peek(board) : null;
    if (!records) return { board, exists: false };
    let frames = 0;
    let boundFrames = 0;
    for (const r of records.values()) {
      if (r.type !== "frame") continue;
      frames++;
      if (r.meta?.paseo?.agentId) boundFrames++;
    }
    const out: LinkTarget = { board, exists: true, frames, boundFrames };
    if (frameId) {
      const f = records.get(frameId);
      out.frame = f?.type === "frame" ? { id: f.id, name: String(f.props?.name ?? ""), status: f.meta?.paseo?.status ?? null, subagents: f.meta?.paseo?.subagents || undefined, agentId: f.meta?.paseo?.agentId ?? null } : null;
    }
    return out;
  }

  stop(): void {
    for(const b of this.bindings.values())this.collectTouches(b);
    this.stopped = true;
    for (const timer of this.bindRetries.values()) clearTimeout(timer);
    this.bindRetries.clear();
    for (const b of this.bindings.values()) {
      if (b.timer) clearTimeout(b.timer);
      b.timer = null;
      this.unwake(b);
    }
  }

  // --- document changes -------------------------------------------------------------

  onChanges(room: BoardRoom, source: ChangeSource, changes: RecordChange[]): void {
    // Shadow only (server/lifecycle-parity.ts): every write to a frame record, from anyone,
    // is compared with the lifecycle machine. It reads and counts; it cannot throw.
    if (this.parity) for (const c of changes) if ((c.after ?? c.before)?.type === "frame") this.parity.observe({ boardId: room.id, frameId: c.id, before: c.before, after: c.after, reason: source.kind === "server" ? source.reason : source.kind });
    if (this.componentAgentsMemo && changes.some((c) => isComponent(c.after) || isComponent(c.before))) this.componentAgentsMemo = null;
    // Frame renames from anyone (the user, the agent's board_frame, the server) name the agent too.
    for (const c of changes) {
      if (c.after?.type !== "frame" || !c.before || c.before.props?.name === c.after.props?.name) continue;
      const b = this.bindingFor(room.id, c.after.id);
      if (b) this.queueNameSync(b);
    }
    // The frame timeline: the same content changes deltas are made of, from people and agents.
    if (this.history && (source.kind === "human" || source.kind === "agent"))
      timed("change.history", () => this.history?.observe(room, source, changes.filter((c) => (isShape(c.after) || isShape(c.before)) && !(c.before && c.after && echoOnly(c.before, c.after)))));
    if (source.kind !== "human") return;
    const fixups: Array<(r: BoardRoom) => void> = [];
    // Board locks are the server's: a push that changes them is put back. With the layout
    // locked, a push that moves, resizes or deletes something already on the board is put
    // back too (canvases block that before it happens; this catches older tabs and any
    // other websocket client), and never reaches an agent as a delta.
    // The lock as it was before this push (a push that also edits the document record must
    // not unlock and move in one go).
    const docChange = changes.find((c) => c.id === DOCUMENT_ID);
    const locked = docChange ? readLocks(docChange.before?.meta).layout : this.locks(room.id).layout;
    if (!locked) fixups.push(...compressionOffers(room, changes));
    const restore: Rec[] = [];
    for (const c of changes) {
      const after = c.after;
      const before = c.before;
      if (c.id === DOCUMENT_ID) {
        if (JSON.stringify(before?.meta?.[LOCKS_KEY]) !== JSON.stringify(after?.meta?.[LOCKS_KEY])) {
          const want = before?.meta?.[LOCKS_KEY];
          this.log(`reverted a human edit to the board locks of ${room.id}`);
          fixups.push((r) =>
            r.write({ kind: "server", reason: "protect-locks" }, (ops) => {
              const cur = ops.get(DOCUMENT_ID);
              if (!cur) {
                // The document record itself was removed: put it back whole.
                if (before) ops.put(before);
                return;
              }
              const meta = { ...cur.meta };
              if (want === undefined) delete meta[LOCKS_KEY];
              else meta[LOCKS_KEY] = want;
              ops.put({ ...cur, meta });
            }),
          );
        }
        continue;
      }
      // Comments live in the page record's meta: a new comment or reply goes to the agent of
      // the frame it sits in. (Agent replies arrive as agent writes and never get here.)
      if ((after ?? before)?.typeName === "page") {
        if (after) this.onComments(room, before?.meta, after.meta, source);
        continue;
      }
      const rec0 = (before ?? after) as Rec | null;
      if (locked && rec0 && (rec0.typeName === "shape" || rec0.typeName === "binding")) {
        if (!before && after) {
          this.freshWhileLocked.set(after.id, Date.now());
          if (this.freshWhileLocked.size > 500) for (const [id] of this.freshWhileLocked) if (!this.isFresh(id)) this.freshWhileLocked.delete(id);
          if (this.lockOrigins.size > 500) for (const [id, o] of this.lockOrigins) if (Date.now() - o.at > 3000) this.lockOrigins.delete(id);
        } else if (before && !this.isFresh(before.id)) {
          const keys = after ? (before.typeName === "shape" ? layoutChange(before as never, after as never) : ["binding"]) : ["deleted"];
          if (keys.length) {
            // An older tab dragging sends many pushes before the first repair lands; put the
            // shape back where the drag started, not where the previous push left it.
            const origin = this.lockOrigins.get(before.id);
            const first = origin && Date.now() - origin.at < 3000 ? origin.rec : before;
            this.lockOrigins.set(before.id, { rec: first, at: Date.now() });
            restore.push(first);
            // Content in the same push (new text) still reaches the frame's agent, as if the
            // shape had not moved.
            if (after && before.typeName === "shape") this.track(room, { id: c.id, before, after: withLayoutOf(after, first) }, source);
            continue;
          }
        }
      }
      // Author stamping: creations by a websocket are human, whatever meta they carry
      // (a pasted agent sticky must not keep claiming agent authorship). Edits keep
      // the original author.
      if (isShape(after)) {
        const want = before ? before.meta?.author : authorFor(source);
        if (want && JSON.stringify(after.meta?.author) !== JSON.stringify(want)) {
          fixups.push((r) =>
            r.write({ kind: "server", reason: "stamp" }, (ops) => {
              const cur = ops.get(after.id);
              if (cur) ops.put({ ...cur, meta: { ...cur.meta, author: want } });
            }),
          );
        }
      }
      if (after?.type === "frame") {
        const revert = this.protectBinding(before, after);
        if (revert) {
          fixups.push((r) =>
            r.write({ kind: "server", reason: "protect-binding" }, (ops) => {
              const cur = ops.get(after.id);
              if (cur) ops.put({ ...cur, ...(!before ? {props:{...cur.props,color:"black"}} : {}), meta: { ...cur.meta, paseo: revert(cur.meta?.paseo ?? {}) } });
            }),
          );
          if (!before) continue;
        }
        this.onFrameChange(room, before, after, source, fixups);
      }
      if (!after && before?.type === "frame" && before.meta?.paseo?.agentId) this.onFrameDeleted(room, before);
      // Stamps are their own message to the agent (onStamp), never a text delta.
      if ((after ?? before)?.type === STAMP_TYPE) {
        if (after) this.onStamp(room, before ?? null, after, source, fixups);
        continue;
      }
      this.track(room, c, source);
    }
    if (restore.length) {
      this.log(`layout locked on ${room.id}: put back ${restore.length} moved/resized/deleted record(s) from ${source.name}`);
      fixups.push((r) =>
        r.write({ kind: "server", reason: "layout-lock" }, (ops) => {
          // Shapes first (parents before children), then bindings that point at them.
          const order = [...restore].sort((a, b) => (a.typeName === "binding" ? 1 : 0) - (b.typeName === "binding" ? 1 : 0) || ancestors(r.records, a).length - ancestors(r.records, b).length);
          for (const rec of order) {
            const cur = ops.get(rec.id);
            if (!cur) ops.put(rec);
            else if (rec.typeName === "binding") ops.put(rec);
            else ops.put(withLayoutOf(cur, rec));
          }
        }),
      );
    }
    // Defer past the room's push_result: a server write that lands before the
    // pusher's acknowledgement is rebased away by the client and re-pushed forever.
    if (fixups.length) setTimeout(() => fixups.forEach((f) => f(room)), 30);
  }

  // --- stamps ---------------------------------------------------------------------------
  // A person's stamp goes to the agent of the bound frame its target sits in, as its own
  // message (prompt outbox kind "stamp", a busy agent takes it into its running turn; stop
  // interrupts the turn). Its state follows: sent once handed to the outbox, seen once the
  // agent's timeline shows it, then acting / done as the agent acks and resolves it
  // (board_stamp). Agent-placed stamps notify nobody.

  // Outbox message id → the stamp it carries (the stamp's meta says so too, written a
  // moment later; receipts can arrive before that write lands).
  private readonly stampMessages = new Map<string, { boardId: string; stampId: string }>();

  private onStamp(room: BoardRoom, before: Rec | null, after: Rec, source: ChangeSource, fixups: Array<(r: BoardRoom) => void>): void {
    const p = after.props ?? {};
    if (!isStampKind(p.kind) || source.kind !== "human") return;
    // A stamp's state is the board's and the agent's, never a tab's. A tab that re-pushes
    // its first copy of the stamp (a server write landed before its push was acknowledged)
    // would set it back to "": put the state back.
    if (before && before.props?.state !== p.state) {
      const want = before.props.state;
      fixups.push((r) =>
        r.write({ kind: "server", reason: "stamp-state" }, (ops) => {
          const cur = ops.get(after.id);
          if (cur && cur.props.state === p.state) ops.put({ ...cur, props: { ...cur.props, state: want }, meta: { ...cur.meta, ...(before.meta?.stamp ? { stamp: before.meta.stamp } : {}) } });
        }),
      );
    }
    const isNew = !before;
    const noteAdded = !isNew && p.note && p.note !== before?.props?.note;
    if (!isNew && !noteAdded) return;
    const frameId = owningBoundFrame(room.records, after);
    const b = frameId ? this.bindingFor(room.id, frameId) : undefined;
    if (!b || b.status === "archived" || this.startingNow(b)) {
      if (isNew) this.log(`stamp ${p.kind} ${after.id} on ${room.id}: no agent bound to its frame; not sent`);
      return;
    }
    const target = room.records.get(after.parentId);
    const targetInfo = { id: target?.id ?? after.parentId, type: target ? (target.id === frameId ? "frame" : kindLabel(target)) : "shape", text: target ? (target.type === "frame" ? String(target.props?.name ?? "") : shapeText(target)) : "" };
    const by = p.by || source.name || this.cfg.humanName;
    const text = isNew ? stampMessage(stampEvent(after.id, { ...p, by } as never, targetInfo), this.deepLink(room.id, frameId!)) : stampNoteMessage(after.id, p.kind, targetInfo.text, by, p.note);
    const messageId = `stamp-${randomUUID()}`;
    const urgent = isNew && p.kind === "stop";
    if (source.kind === "human") b.humanName = source.name || this.cfg.humanName;
    if (this.promptOutbox) {
      try {
        const receipt = this.promptOutbox.submit({ messageId, agentId: b.agentId, host: b.host ?? null, boardId: b.boardId, frameId: b.frameId, text, kind: "stamp", ...(urgent ? { urgent: true } : {}) });
        if (isNew) this.stampMessages.set(messageId, { boardId: room.id, stampId: after.id });
        this.record(b, text, `stamp ${receipt.status}`);
        void this.promptOutbox.drain();
      } catch (e) {
        this.log(`stamp ${after.id} for ${b.agentId} not accepted by the outbox: ${(e as Error).message}`);
        return;
      }
    } else {
      // Rigs without an outbox: straight to the agent.
      void this.bridge.ready.then((api) => api.agents.ref(b.agentId).send(text, { messageId })).catch((e: Error) => this.log(`stamp send to ${b.agentId} failed: ${e.message}`));
    }
    this.log(`stamp ${p.kind} ${after.id}${isNew ? "" : " note"} queued for ${b.agentId} (${room.id}/${b.frameId})${urgent ? " urgent" : ""}`);
    if (!isNew) return;
    fixups.push((r) =>
      r.write({ kind: "server", reason: "stamp-sent" }, (ops) => {
        const cur = ops.get(after.id);
        if (!cur || !advancesTo(cur.props.state, "sent")) return;
        ops.put({ ...cur, props: { ...cur.props, state: "sent" }, meta: { ...cur.meta, stamp: { messageId, agentId: b.agentId, frameId: b.frameId } } });
      }),
    );
  }

  private stampReceipt(receipt: PromptReceipt): void {
    const ref = this.stampMessages.get(receipt.messageId) ?? this.findStampByMessage(receipt.boardId, receipt.messageId);
    if (!ref) return;
    const seen = receipt.status === "delivered" || (receipt.status === "accepted" && !!receipt.final);
    const next: StampState | null = seen ? "seen" : receipt.status === "failed" ? "failed" : null;
    if (!next) return;
    this.stampMessages.delete(receipt.messageId);
    // Past the creating push's own fixup (30 ms), so "sent" is never written over "seen".
    const t = setTimeout(() => {
      if (this.stopped) return;
      try {
        this.setStampState(ref.boardId, ref.stampId, next, { kind: "server", reason: `stamp-${next}` });
      } catch (e) {
        this.log(`stamp ${ref.stampId} state ${next} not written: ${(e as Error).message}`);
      }
    }, 40);
    t.unref?.();
  }

  private findStampByMessage(boardId: string, messageId: string): { boardId: string; stampId: string } | null {
    const records = this.host.peek(boardId);
    if (!records) return null;
    for (const r of records.values()) if (r.type === STAMP_TYPE && r.meta?.stamp?.messageId === messageId) return { boardId, stampId: r.id };
    return null;
  }

  // Moves a stamp's state forward (never back); false when it did not move.
  setStampState(boardId: string, stampId: string, state: StampState, source: ChangeSource): boolean {
    if (!this.host.peek(boardId)) return false;
    const room = this.host.get(boardId);
    const cur = room.records.get(stampId);
    if (cur?.type !== STAMP_TYPE || !advancesTo(cur.props.state, state)) return false;
    room.write(source, (ops) => {
      const now = ops.get(stampId);
      if (now && advancesTo(now.props.state, state)) ops.put({ ...now, props: { ...now.props, state } });
    });
    room.save();
    this.log(`stamp ${stampId} ${cur.props.state || "unsent"} → ${state} (${source.kind === "server" ? source.reason : source.kind})`);
    return true;
  }

  // --- comments -----------------------------------------------------------------------

  // The bound frame a comment thread sits in: the frame its pin or area follows (or the
  // bound frame owning that shape), else the deepest bound frame under its point.
  commentFrame(room: BoardRoom, t: CommentThread): string | null {
    const a = t.anchor;
    const s = a.shapeId ? room.records.get(a.shapeId) : undefined;
    let point = { x: a.pageX + (a.w ?? 0) / 2, y: a.pageY + (a.h ?? 0) / 2 };
    if (isShape(s)) {
      if (s.type === "frame" && this.bindingFor(room.id, s.id)) return s.id;
      const owner = this.ownerOf(room, s);
      if (owner) return owner;
      const at = absPos(room.records, s); // rotation ignored, as elsewhere on the server
      point = { x: at.x + a.x + (a.w ?? 0) / 2, y: at.y + a.y + (a.h ?? 0) / 2 };
    }
    let best: { id: string; depth: number } | null = null;
    for (const r of room.records.values()) {
      if (!isShape(r) || r.type !== "frame" || !this.bindingFor(room.id, r.id)) continue;
      const at = absPos(room.records, r);
      if (point.x < at.x || point.y < at.y || point.x > at.x + r.props.w || point.y > at.y + r.props.h) continue;
      const depth = ancestors(room.records, r).length;
      if (!best || depth > best.depth) best = { id: r.id, depth };
    }
    return best?.id ?? null;
  }

  // Page-space box of a thread's area (its point for a pin), following its shape.
  private commentBox(room: BoardRoom, t: CommentThread): { x: number; y: number; w: number; h: number } {
    const a = t.anchor;
    const s = a.shapeId ? room.records.get(a.shapeId) : undefined;
    const at = isShape(s) ? absPos(room.records, s) : null;
    return { x: at ? at.x + a.x : a.pageX, y: at ? at.y + a.y : a.pageY, w: a.w ?? 0, h: a.h ?? 0 };
  }

  // Bound frames on this board by name (for @Name typed without picking a suggestion).
  private boundFramesByName(room: BoardRoom): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const r of room.records.values()) {
      if (!isShape(r) || r.type !== "frame" || !this.bindingFor(room.id, r.id)) continue;
      const name = String(r.props.name ?? "").trim();
      if (!name) continue;
      out.set(name.toLowerCase(), [...(out.get(name.toLowerCase()) ?? []), r.id]);
    }
    return out;
  }

  // Frames a message mentions: picked suggestions, plus a typed @Name that names exactly one frame.
  private mentionedFrames(room: BoardRoom, m: CommentMessage): string[] {
    const byName = this.boundFramesByName(room);
    const out = new Set((m.mentions ?? []).filter((id) => this.bindingFor(room.id, id)));
    for (const part of splitMentions(m.text, [...byName.keys()])) {
      const ids = part.mention ? byName.get(part.text.slice(1).toLowerCase()) : undefined;
      if (ids?.length === 1) out.add(ids[0]);
    }
    return [...out];
  }

  // Every bound frame involved in a thread, and why: the frame it sits in, frames its area
  // covers, frames it was sent to or mentions, and frames whose agents replied in it.
  involvedFrames(room: BoardRoom, t: CommentThread): Map<string, "here" | "covered" | "sent" | "mentioned" | "replied"> {
    const out = new Map<string, "here" | "covered" | "sent" | "mentioned" | "replied">();
    const add = (id: string | null | undefined, why: "here" | "covered" | "sent" | "mentioned" | "replied") => {
      if (id && this.bindingFor(room.id, id) && !out.has(id)) out.set(id, why);
    };
    add(this.commentFrame(room, t), "here");
    const box = this.commentBox(room, t);
    if (box.w && box.h) {
      for (const r of room.records.values()) {
        if (!isShape(r) || r.type !== "frame" || !this.bindingFor(room.id, r.id)) continue;
        const at = absPos(room.records, r);
        if (box.x < at.x + r.props.w && box.x + box.w > at.x && box.y < at.y + r.props.h && box.y + box.h > at.y) add(r.id, "covered");
      }
    }
    for (const f of t.shares ?? []) add(f, "sent");
    for (const m of Object.values(t.messages)) for (const f of this.mentionedFrames(room, m)) add(f, "mentioned");
    for (const m of Object.values(t.messages)) {
      if (!m.authorId.startsWith("agent:")) continue;
      const b = this.byAgent.get(m.authorId.slice("agent:".length));
      if (b && b.boardId === room.id) add(b.frameId, "replied");
    }
    return out;
  }

  private onComments(room: BoardRoom, before: unknown, after: unknown, source: ChangeSource): void {
    const sends: { frameId: string; thread: CommentThread; text: string }[] = [];
    for (const { thread, message, isNew } of addedMessages(before, after)) {
      // Agents' own replies notify nobody (no agent-to-agent loops).
      if (message.authorId.startsWith("agent:")) continue;
      const mentionedHere = new Set(this.mentionedFrames(room, message));
      for (const [frameId, why] of this.involvedFrames(room, thread)) {
        const how = mentionedHere.has(frameId)
          ? `${message.author} mentioned you in a ${isNew ? "new comment" : "comment thread"}`
          : why === "here"
            ? `${message.author} ${isNew ? `commented on your frame${thread.anchor.w ? " (an area of it)" : ""}` : "replied in a comment thread on your frame"}`
            : why === "covered"
              ? `${message.author} ${isNew ? "commented on an area that covers your frame" : "replied in a comment thread on an area covering your frame"}`
              : `${message.author} replied in a comment thread you are part of`;
        sends.push({ frameId, thread, text: this.commentText(room, frameId, thread, message, how, isNew) });
      }
    }
    for (const { thread, frameId } of addedShares(before, after)) {
      const first = orderedMessages(thread)[0];
      const by = source.kind === "human" ? source.name || this.cfg.humanName : this.cfg.humanName;
      sends.push({ frameId, thread, text: this.commentText(room, frameId, thread, first, `${by} sent you a comment thread`, true, true) });
    }
    const seen = new Set<string>();
    for (const { frameId, thread, text } of sends) {
      const b = this.bindingFor(room.id, frameId);
      if (!b || seen.has(`${frameId}:${text}`)) continue;
      seen.add(`${frameId}:${text}`);
      if (source.kind === "human") b.humanName = source.name || this.cfg.humanName;
      b.queued.push(text);
      this.writeFrameMeta(b, { queue: b.queued, pendingDeltas: b.queued.length + b.pendingText.size });
      this.log(`comment ${thread.id} queued for ${b.agentId} (${room.id}/${frameId})`);
      void this.flush(b, false);
    }
  }

  private commentText(room: BoardRoom, frameId: string, thread: CommentThread, message: CommentMessage, how: string, isNew: boolean, whole = false): string {
    const link = `${this.cfg.publicBase}/?board=${encodeURIComponent(room.id)}&comment=${encodeURIComponent(thread.id)}`;
    const lines = [`${COMMENT_DELTA_PREFIX}: ${how} (thread ${thread.id}):`, ...message.text.split("\n").map((l) => `> ${l}`)];
    const others = orderedMessages(thread).filter((m) => m.id !== message.id);
    if (others.length && (whole || !isNew)) {
      lines.push(whole ? "The rest of the thread:" : "Earlier in the thread:", ...(whole ? others : others.slice(-4)).map((m) => `- ${m.author}: ${m.text.replace(/\s+/g, " ").slice(0, 200)}`));
    }
    const target = thread.anchor.shapeId ? room.records.get(thread.anchor.shapeId) : undefined;
    if (isShape(target) && target.id !== frameId) {
      const owner = owningBoundFrame(room.records, target);
      lines.push(`It is pinned to ${describeShape(target, 60)}${owner && owner !== frameId ? ` in frame ${JSON.stringify(room.records.get(owner)?.props?.name ?? owner)}` : ""}.`);
    }
    if (thread.resolved) lines.push(`(Resolved by ${thread.resolved.by}.)`);
    lines.push(`Reply in the thread with board_comment {threadId: "${thread.id}", text}. Open it: ${link}`);
    return lines.join("\n");
  }

  // Open comment threads in a frame, for board_read.
  commentOutline(room: BoardRoom, frameId: string): string | null {
    const lines: string[] = [];
    for (const page of room.records.values()) {
      if (page.typeName !== "page") continue;
      for (const t of Object.values(readThreads(page.meta))) {
        if (t.resolved || !this.involvedFrames(room, t).has(frameId)) continue;
        const msgs = orderedMessages(t);
        const last = msgs.at(-1)!;
        lines.push(`  thread ${t.id}: ${msgs[0].author}: ${quote(msgs[0].text, 80)}${msgs.length > 1 ? ` · ${msgs.length - 1} repl${msgs.length === 2 ? "y" : "ies"}, last ${last.author}: ${quote(last.text, 60)}` : ""}`);
      }
    }
    return lines.length ? `Open comment threads you are part of (reply with board_comment):\n${lines.join("\n")}` : null;
  }

  // --- board locks ------------------------------------------------------------------

  // Shapes people created while the layout was locked, for FRESH_MS (their tool may
  // still be sizing them).
  private readonly freshWhileLocked = new Map<string, number>();
  private readonly lockOrigins = new Map<string, { rec: Rec; at: number }>();

  private isFresh(id: string): boolean {
    const at = this.freshWhileLocked.get(id);
    if (at === undefined) return false;
    if (Date.now() - at < FRESH_MS) return true;
    this.freshWhileLocked.delete(id);
    return false;
  }

  locks(boardId: string): BoardLocks {
    if (!this.host.exists(boardId)) return NO_LOCKS;
    return readLocks(this.host.get(boardId).records.get(DOCUMENT_ID)?.meta);
  }

  layoutLocked(boardId: string): boolean {
    return this.locks(boardId).layout;
  }

  paused(boardId: string): boolean {
    return this.locks(boardId).agentsPaused;
  }

  lockSummary(boardId: string): string | null {
    return lockSummary(this.locks(boardId), this.cfg.humanName);
  }

  // Deltas waiting on one board (queued and not yet sent), for the header.
  queuedOn(boardId: string): { deltas: number; frames: number; intros: number } {
    let deltas = 0;
    let frames = 0;
    let intros = 0;
    for (const b of this.bindings.values()) {
      if (b.boardId !== boardId) continue;
      const n = b.queued.length + new Set([...b.pendingText.keys(),...b.touched.keys()]).size + (b.frameBefore ? 1 : 0);
      deltas += n;
      if (n) frames++;
      if (b.introPending) intros++;
    }
    return { deltas, frames, intros };
  }

  // The board header's two switches. Turning the pause off delivers what was queued
  // (one prompt per frame), or drops the queued deltas when discard is set (pending
  // introductions of imported conversations are kept).
  setLocks(room: BoardRoom, patch: { layout?: boolean; agentsPaused?: boolean; discard?: boolean; by?: string }): { locks: BoardLocks; flushed: number; discarded: number } {
    const before = this.locks(room.id);
    const by = (patch.by ?? "").trim().slice(0, 60) || this.cfg.humanName;
    const next: BoardLocks = { ...before };
    if (typeof patch.layout === "boolean" && patch.layout !== before.layout) {
      next.layout = patch.layout;
      next.layoutBy = by;
      next.layoutAt = Date.now();
    }
    if (typeof patch.agentsPaused === "boolean" && patch.agentsPaused !== before.agentsPaused) {
      next.agentsPaused = patch.agentsPaused;
      next.pausedBy = by;
      next.pausedAt = Date.now();
    }
    if (JSON.stringify(next) !== JSON.stringify(before)) {
      room.write({ kind: "server", reason: "locks" }, (ops) => {
        const doc = ops.get(DOCUMENT_ID) ?? { id: DOCUMENT_ID, typeName: "document", gridSize: 10, name: "", meta: {} };
        ops.put({ ...doc, meta: { ...doc.meta, [LOCKS_KEY]: next } });
      });
      room.save();
      this.log(`board ${room.id}: layout ${next.layout ? "locked" : "unlocked"}, agents ${next.agentsPaused ? "paused" : "live"} (by ${by})`);
    }
    let flushed = 0;
    let discarded = 0;
    if (before.agentsPaused && !next.agentsPaused) {
      for (const b of [...this.bindings.values()]) {
        if (b.boardId !== room.id) continue;
        // Discard drops what the pause held back on live frames; a manual frame's changes
        // (for "Send N changes") and an on-demand frame's (for board_read) are kept.
        const live = this.modeOf(b) === "live";
        if (patch.discard && live) {
          if (b.timer) clearTimeout(b.timer);
          b.timer = null;
          discarded += b.queued.length + b.pendingText.size + (b.touched.size ? 1 : 0);
          b.touched.clear();
          b.pendingText.clear();
          b.frameBefore = null;
          b.queued = [];
          this.writeFrameMeta(b, { pendingDeltas: 0, queue: [], pendingText: undefined });
        }
        if ((live && (b.queued.length || b.pendingText.size) && !b.held) || b.introPending) flushed++;
        void this.flush(b, false);
      }
      if (patch.discard) this.log(`board ${room.id}: discarded ${discarded} queued delta(s) on resume`);
    }
    return { locks: next, flushed, discarded };
  }

  // Returns a function that repairs meta.paseo when a human edit touched binding
  // state, or null when the edit is allowed (mode changes, create/link requests on
  // an unbound frame, the client's own "requested" status).
  private protectBinding(before: Rec | null, after: Rec): ((p: FramePaseoMeta) => FramePaseoMeta) | null {
    const pa: Record<string, unknown> = after.meta?.paseo ?? {};
    if (!before) {
      // A pasted or duplicated bound frame must not share the original's agent.
      if (!pa.agentId && !pa.request) return null;
      this.log(`stripping copied binding from new frame ${after.id}`);
      return () => typeof pa.agentId==='string' ? {relink:{agentId:pa.agentId,...(typeof pa.host==='string'?{host:pa.host}:{}),reason:'restored-or-copied' as const,requiresConfirmation:true as const},error:'This restored or copied frame is unbound. Choose Re-link existing conversation to reuse it; no agent was created.'} : {};
    }
    const pb: Record<string, unknown> = before.meta?.paseo ?? {};
    const fix: Record<string, unknown> = {};
    let touched = false;
    for (const k of SERVER_OWNED) {
      if (JSON.stringify(pa[k]) !== JSON.stringify(pb[k])) {
        fix[k] = pb[k];
        touched = true;
      }
    }
    if (pa.status !== pb.status && !(pa.status === "requested" && pa.request && !pb.agentId)) {
      fix.status = pb.status;
      touched = true;
    }
    if (pb.agentId && pa.request && JSON.stringify(pa.request) !== JSON.stringify(pb.request)) {
      fix.request = pb.request;
      fix.error = "This frame is already bound. Draw a new frame for a new conversation.";
      touched = true;
    }
    if (!touched) return null;
    this.log(`reverted human edit to binding meta of ${after.id}: ${Object.keys(fix).join(",")}`);
    return (cur) => JSON.parse(JSON.stringify({ ...cur, ...fix }));
  }

  private onFrameChange(room: BoardRoom, before: Rec | null, after: Rec, source: ChangeSource, fixups: Array<(r: BoardRoom) => void>): void {
    const pb: FramePaseoMeta = before?.meta?.paseo ?? {};
    const pa: FramePaseoMeta = after.meta?.paseo ?? {};
    if (pa.request && JSON.stringify(pa.request) !== JSON.stringify(pb.request)) {
      queueMicrotask(() => void this.fulfil(room, after.id));
    }
    const flushReq = (after.meta?.paseoFlushAt as number | undefined) ?? 0;
    if (flushReq && flushReq !== before?.meta?.paseoFlushAt) {
      const b = this.bindingFor(room.id, after.id);
      if (b) queueMicrotask(() => void this.flush(b, true));
    }
    if (pa.mode !== pb.mode && pa.mode === "live") {
      const b = this.bindingFor(room.id, after.id);
      if (b) queueMicrotask(() => void this.flush(b, false));
    }
    // Frame dragged (or reshaped from its top/left edge) by a person: they chose this spot,
    // so its agent does not move it with board_frame({move}) and neighbours may not push it
    // (frame-room.ts humanMovedAt).
    if (before && source.kind === "human" && (before.x !== after.x || before.y !== after.y) && before.parentId === after.parentId) {
      fixups.push((r) =>
        r.write({ kind: "server", reason: "human-moved" }, (ops) => {
          const cur = ops.get(after.id);
          if (cur) ops.put({ ...cur, meta: { ...cur.meta, layout: { ...cur.meta?.layout, humanMovedAt: Date.now() } } });
        }),
      );
    }
    // Frame resized by a human: adopt sibling shapes now fully enclosed (the user's
    // "expanded the board to include a new idea").
    if (pa.agentId && before && (before.props.w !== after.props.w || before.props.h !== after.props.h || before.x !== after.x || before.y !== after.y)) {
      fixups.push((r) => this.adoptEnclosed(r, after.id, source));
    }
  }

  adoptEnclosed(room: BoardRoom, frameId: string, source: ChangeSource | null): void {
    const frame = room.records.get(frameId);
    if (!frame || this.layoutLocked(room.id)) return;
    const fa = absPos(room.records, frame);
    const adopt: Rec[] = [];
    for (const s of room.records.values()) {
      if (!isShape(s) || s.id === frameId || s.parentId !== frame.parentId) continue;
      if (s.type === "frame" && s.meta?.paseo?.agentId) continue;
      const a = absPos(room.records, s);
      const size = shapeSize(s);
      if (a.x >= fa.x && a.y >= fa.y && a.x + size.w <= fa.x + frame.props.w && a.y + size.h <= fa.y + frame.props.h) adopt.push(s);
    }
    if (!adopt.length) return;
    const b = source ? this.bindingFor(room.id, frameId) : undefined;
    if (b) {
      for (const s of adopt) {
        if (!b.touched.has(s.id)) b.touched.set(s.id, { before: s, wasInside: false, adopted: true });
        else b.touched.get(s.id)!.adopted = true;
      }
    }
    room.write({ kind: "server", reason: "adopt" }, (ops) => {
      for (const s of adopt) {
        const a = absPos(room.records, s);
        ops.put({ ...s, parentId: frameId, x: a.x - fa.x, y: a.y - fa.y });
      }
    });
    if (b && source) this.arm(b, source);
  }

  // A bound frame was deleted (by a person; agents cannot delete bound frames). Stop
  // everything for it: pending deltas, the binding, the agent's board labels. The agent
  // keeps running; the canvas that deleted it asks whether to archive it (see
  // archiveReleased).
  private onFrameDeleted(room: BoardRoom, frame: Rec, note?: string): void {
    const timer=this.bindRetries.get(key(room.id,frame.id));if(timer)clearTimeout(timer);this.bindRetries.delete(key(room.id,frame.id));
    const req=frame.meta?.paseo?.request;
    const pendingId=req?.kind==='link'?req.agentId:frame.meta?.paseo?.agentId;
    if(pendingId&&this.reserved.get(pendingId)?.boardId===room.id&&this.reserved.get(pendingId)?.frameId===frame.id)this.reserved.delete(pendingId);
    const b = this.bindingFor(room.id, frame.id);
    if (!b) return;
    this.release(b, "deleted");
    void this.appendRow(b, `board-frame-removed-${Date.now()}`, note ?? `The frame ${quote(frame.props.name || frame.id)} was removed from board ${room.id}. The agent was not archived.`);
  }

  // Frames the Archive took off the board (server/frame-archive.ts): release their agents
  // as a deletion would. The archive keeps the frame; the agent keeps running in Paseo.
  releaseArchived(room: BoardRoom, frames: Rec[], by: string): void {
    for (const f of frames)
      this.onFrameDeleted(room, f, `${by} archived the frame ${quote(f.props.name || f.id)} on board ${room.id} (Archive). Board edits no longer reach this conversation and its board tools stop working. The frame can be restored from the board's Archive panel and re-linked; this agent was not archived.`);
  }

  // Drop a binding: no more deltas or status writes for it, its labels stop pointing at
  // the frame, and it is remembered for a while so the person who let it go can archive it.
  private release(b: Binding, why: "deleted" | "unbound"): void {
    this.bindings.delete(key(b.boardId, b.frameId));
    if (this.byAgent.get(b.agentId) === b) this.byAgent.delete(b.agentId);
    if (b.timer) clearTimeout(b.timer);
    b.timer = null;
    this.unwake(b);
    b.queued = [];
    b.touched.clear();
    this.released.set(b.agentId, { boardId: b.boardId, frameId: b.frameId, at: Date.now() });
    for (const [id, r] of this.released) if (Date.now() - r.at > RELEASED_TTL_MS) this.released.delete(id);
    this.log(`frame ${b.boardId}/${b.frameId} ${why}; agent ${b.host ? `${b.host}/` : ""}${b.agentId} released (not archived)`);
    if (b.host) {
      // Another machine's agent: no labels to clear here, and it cannot be archived from this board.
      if (!this.byAgent.has(b.agentId)) this.remote?.unwatch(b.agentId);
      this.released.delete(b.agentId);
      return;
    }
    if (!this.byAgent.has(b.agentId) && !this.reserved.has(b.agentId))
      void this.bridge.updateAgent(b.agentId, { labels: { board: "", frame: "" } }).catch((e) => this.log(`label update failed: ${(e as Error).message}`));
  }

  // Agents recently unbound or whose frame was deleted, for "Archive agent X?".
  private readonly released = new Map<string, { boardId: string; frameId: string; at: number }>();

  releasedRef(agentId: string): { boardId: string; frameId: string } | null {
    const r = this.released.get(agentId);
    return r && Date.now() - r.at < RELEASED_TTL_MS ? r : null;
  }

  // "Unbind" on the frame toolbar: the frame becomes a plain frame, the conversation
  // keeps going in Paseo. Its transcript card inside the frame goes too (it was the
  // frame's view of that conversation).
  unbind(room: BoardRoom, frameId: string): { agentId: string; removedCards: string[] } {
    const frame = room.records.get(frameId);
    if (!frame || frame.type !== "frame") throw httpError(404, `frame ${frameId} is not on board ${room.id}`);
    const p = frame.meta?.paseo as FramePaseoMeta | undefined;
    const starting = this.bindingFor(room.id, frameId);
    const stored = stateOf(p).s;
    if (p?.request || stored === "starting" || stored === "restarting" || (starting && this.startingNow(starting)))
      throw httpError(409, "this frame is still starting its conversation; wait for it, then unbind");
    if (!p?.agentId) throw httpError(409, "this frame is not bound to a conversation");
    if (this.restarting.has(key(room.id, frameId)) || p.restart) throw httpError(409, "this frame is restarting its conversation; try again in a moment");
    const agentId = p.agentId;
    const b = this.bindingFor(room.id, frameId);
    const cards = [...room.records.values()].filter((r) => r.type === TRANSCRIPT_TYPE && r.props?.agentId === agentId && ancestors(room.records, r).includes(frameId)).map((r) => r.id);
    room.write({ kind: "server", reason: "unbind" }, (ops) => {
      const cur = ops.get(frameId);
      if (cur) {
        const meta = { ...cur.meta };
        delete meta.paseo;
        delete meta.paseoFlushAt;
        ops.put({ ...cur, props: { ...cur.props, color: "black" }, meta });
      }
      for (const id of cards) ops.remove(id);
    });
    room.save();
    const remoteFrame = !!b?.host;
    if (b) this.release(b, "unbound");
    else this.released.set(agentId, { boardId: room.id, frameId, at: Date.now() });
    if (!remoteFrame) void this.appendRowFor(agentId, room.id, frameId, `board-frame-unbound-${Date.now()}`, `This conversation was unbound from the frame ${quote(frame.props.name || frameId)} on board ${room.id}. Board edits no longer reach it, and its board tools stop working.`);
    return { agentId, removedCards: cards };
  }

  // Archive an agent this server just released (frame deleted or unbound), on request
  // from the board UI. Other agents are not archivable from the board.
  async archiveReleased(agentId: string): Promise<void> {
    if (this.byAgent.has(agentId)) throw httpError(409, "that agent is bound to a frame again; unbind it first");
    if (!this.releasedRef(agentId)) throw httpError(403, `agent ${agentId} was not released from a board frame in the last 30 minutes`);
    const api = await this.bridge.ready;
    await api.agents
      .ref(agentId)
      .archive()
      .catch((e: Error) => {
        throw httpError(/not found/i.test(e.message) ? 404 : 409, `could not archive ${agentId}: ${e.message}`);
      });
    this.released.delete(agentId);
    this.log(`archived released agent ${agentId} from the board UI`);
  }

  private track(room: BoardRoom, c: RecordChange, source: ChangeSource): void {
    const rec = c.after ?? c.before;
    if (!isShape(rec)) return;
    if (c.before && c.after) {
      const keys = changedKeys(c.before, c.after);
      if (bunnyEnv("DEBUG"))
        this.log(`human change ${rec.id} keys=${keys.join(",")} author ${JSON.stringify(c.before.meta?.author)} -> ${JSON.stringify(c.after.meta?.author)}`);
      if (isComponent(rec)) for (const k of keys) this.componentEdits[k] = (this.componentEdits[k] ?? 0) + 1;
      if (echoOnly(c.before, c.after, keys)) return;
    }
    const frames = new Set<string>();
    const ownerBefore = c.before ? this.ownerOf(room, c.before) : null;
    const ownerAfter = c.after ? this.ownerOf(room, c.after) : null;
    if (ownerBefore) frames.add(ownerBefore);
    if (ownerAfter) frames.add(ownerAfter);
    // The bound frame itself: renames and resizes (ignore meta-only edits).
    if (rec.type === "frame" && this.bindingFor(room.id, rec.id) && c.before && c.after) {
      const b = this.bindingFor(room.id, rec.id)!;
      const metaOnly = JSON.stringify({ ...c.before, meta: null }) === JSON.stringify({ ...c.after, meta: null });
      if (!metaOnly) {
        if (!b.frameBefore) b.frameBefore = c.before;
        this.arm(b, source);
      }
    }
    for (const frameId of frames) {
      const b = this.bindingFor(room.id, frameId);
      if (!b) continue;
      if (!b.touched.has(rec.id)) b.touched.set(rec.id, { before: c.before, wasInside: ownerBefore === frameId });
      // Save the original text snapshot in the same observed change, before
      // the room's snapshot timer can persist the edited shape.
      const textChanged = !!c.after && !isComponent(c.after) && (!c.before || shapeText(c.before)!==shapeText(c.after)) && (c.after.type==='text'||c.after.type==='note'||!!shapeText(c.after));
      if(textChanged){
        if(!b.pendingText.has(rec.id))b.pendingText.set(rec.id,b.touched.get(rec.id)!);
        this.writeFrameMeta(b,{pendingText:[...b.pendingText],pendingDeltas:b.queued.length+b.pendingText.size});
      }
      this.arm(b, source, !!c.after && !isComponent(c.after) && (!c.before || shapeText(c.before)!==shapeText(c.after)) && (c.after.type==='text'||c.after.type==='note'||!!shapeText(c.after)));
    }
  }

  // Nearest bound frame owning a record. Uses the record's own parentId with the
  // current parent chain, which is right for both before and after states.
  private ownerOf(room: BoardRoom, s: Rec): string | null {
    const owner = owningBoundFrame(room.records, s);
    return owner && this.bindingFor(room.id, owner) ? owner : null;
  }

  // Debounce: settle after debounceMs of quiet, but never later than maxWaitMs
  // after the first edit, so steady editing cannot starve the agent.
  private arm(b: Binding, source: ChangeSource, textEdit=false): void {
    if (this.stopped) return;
    if (source.kind === "human") b.humanName = source.name || this.cfg.humanName;
    const now = Date.now();
    if (!b.timer) b.firstTouchAt = now;
    if (b.timer) clearTimeout(b.timer);
    if(textEdit)b.textQuietAt=now+this.cfg.debounceMs;
    const delay = Math.max(burstDelay(b.firstTouchAt, now, this.cfg.debounceMs, this.cfg.maxWaitMs),b.textQuietAt-now);
    b.timer = setTimeout(() => {
      b.timer = null;
      void this.settle(b);
    }, delay);
  }

  // Settle and flush again in `ms` (a busy agent's rate limit, text still settling).
  // Each flush that gets past the debounce check starts by cancelling it.
  private wake(b: Binding, ms: number): void {
    if (this.stopped) return;
    if (b.wakeTimer) clearTimeout(b.wakeTimer);
    b.wakeTimer = setTimeout(() => {
      b.wakeTimer = null;
      void this.settle(b);
    }, Math.max(0, ms));
  }

  private unwake(b: Binding): void {
    if (b.wakeTimer) clearTimeout(b.wakeTimer);
    b.wakeTimer = null;
  }

  // --- delta rendering ---------------------------------------------------------------

  renderDelta(b: Binding, touches=b.touched, includeFrame=true): string | null {
    const room = this.host.get(b.boardId);
    const frame = room.records.get(b.frameId);
    if (!frame) return null;
    const who = b.humanName;
    const lines: string[] = [];
    let strokes = 0;
    const cell = (s: Rec) => {
      const size = shapeSize(s);
      return gridCell(s.x + size.w / 2, s.y + size.h / 2, frame.props.w, frame.props.h);
    };
    const yours = (s: Rec | null) => (s?.meta?.author?.kind === "agent" ? "your " : "");
    // Imported (linked) agents cannot board_read, so they get the whole text of what
    // changed; agents with tools get short quotes and read the frame for detail.
    const linked = !!frame.meta?.paseo?.linked;
    const describe = (s: Rec) => (linked && shapeText(s) ? `${kindLabel(s)} ${quoteLines(shapeText(s))}` : describeShape(s));
    const q = (t: string) => (linked ? quoteLines(t) : quote(t));
    for (const [id, t] of touches) {
      const after = room.records.get(id) ?? null;
      const inAfter = !!after && isShape(after) && ancestors(room.records, after).includes(b.frameId) && this.ownerOf(room, after) === b.frameId;
      const before = t.before;
      // A card showing this frame's own agent is the user's view of the conversation, not news for it.
      if ((after ?? before)?.type === "transcript" && (after ?? before)?.props?.agentId === b.agentId) continue;
      if (!t.wasInside && inAfter && after) {
        if (after.type === "draw" || after.type === "highlight") {
          strokes++;
          continue;
        }
        if (t.adopted) lines.push(`${who} expanded the frame to include a new idea: ${describe(after)} (${cell(after)})`);
        else if (before) lines.push(`${who} moved ${describe(after)} into the frame (${cell(after)})`);
        else lines.push(`${who} added ${describe(after)} (${cell(after)})`);
      } else if (t.wasInside && before && !after) {
        if (before.type === "draw" || before.type === "highlight") continue;
        lines.push(`${who} removed ${yours(before)}${describe(before)}`);
      } else if (t.wasInside && before && after && !inAfter) {
        lines.push(`${who} moved ${yours(before)}${describe(after)} out of the frame`);
      } else if (t.wasInside && before && after && inAfter) {
        const tb = shapeText(before);
        const ta = shapeText(after);
        if (tb !== ta) {
          lines.push(`${who} changed ${yours(before)}${before.type === "note" ? "sticky" : before.type} text ${q(tb)} → ${q(ta)}`);
          continue;
        }
        if (before.props?.color !== after.props?.color)
          lines.push(`${who} recoloured ${yours(before)}${describe(after)} to ${after.props.color}`);
        const moved = Math.hypot(after.x - before.x, after.y - before.y) > 20 || before.parentId !== after.parentId;
        if (moved && cell(before) !== cell(after)) lines.push(`${who} moved ${yours(before)}${describe(after)} to ${cell(after)}`);
      }
    }
    if (strokes) lines.push(`${who} drew ${strokes} freehand stroke${strokes > 1 ? "s" : ""} in the frame`);
    if (includeFrame && b.frameBefore) {
      const fb = b.frameBefore;
      if (fb.props.name !== frame.props.name) lines.push(`${who} renamed the frame ${quote(fb.props.name)} → ${quote(frame.props.name)}`);
      if (fb.props.w !== frame.props.w || fb.props.h !== frame.props.h)
        lines.push(`${who} resized the frame to ${Math.round(frame.props.w)}x${Math.round(frame.props.h)}`);
    }
    if (!lines.length) return null;
    const head = `Board delta — ${who} changed your frame ${quote(frame.props.name || b.frameId)}:`;
    return [head, ...lines.map((l) => `- ${l}`)].join("\n");
  }

  // Keep text edits structured until delivery so pauses while the agent is busy
  // do not turn each intermediate value into a permanent prompt row.
  private collectTouches(b:Binding){
    if(!b.touched.size&&!b.frameBefore)return;
    const room=this.host.get(b.boardId);
    for(const [id,touch] of b.touched){
      const after=room.records.get(id);const rec=after??touch.before;
      const textual=!!rec&&!isComponent(rec)&&((!touch.before&&(rec.type==='text'||rec.type==='note'))||(!!after&&!!touch.before&&shapeText(after)!==shapeText(touch.before)));
      if(textual||b.pendingText.has(id)){
        if(!b.pendingText.has(id))b.pendingText.set(id,touch);
        b.touched.delete(id);
      }
    }
    const text=this.renderDelta(b);b.touched.clear();b.frameBefore=null;
    if(text){b.queued.push(text);this.record(b,text,'queued');}
    this.writeFrameMeta(b,{pendingDeltas:b.queued.length+b.pendingText.size,queue:b.queued,pendingText:b.pendingText.size?[...b.pendingText]:undefined});
  }
  private materializeText(b:Binding){
    if(!b.pendingText.size)return;
    for(const [id,touch] of b.pendingText){const text=this.renderDelta(b,new Map([[id,touch]]),false);if(text){b.queued.push(text);this.record(b,text,'queued');}}
    b.pendingText.clear();b.textQuietAt=0;
    this.writeFrameMeta(b,{pendingDeltas:b.queued.length,queue:b.queued,pendingText:undefined});
  }
  private async settle(b: Binding): Promise<void> {
    if (this.stopped) return;
    this.collectTouches(b);
    if(this.modeOf(b)==='live')await this.flush(b,false);
  }

  // Deliver every queued delta as ONE prompt, unless the agent is busy or the board's
  // agents are paused. An imported conversation's introduction goes out the same way
  // (first, in the same prompt), whatever the frame's delta mode.
  // Hand queued comments to the prompt outbox, one message each (durable, retried, confirmed
  // on the agent's timeline like sidebar chat). Anything the outbox refuses stays queued.
  private sendComments(b: Binding): void {
    const texts = takeComments(b.queued);
    for (let i = 0; i < texts.length; i++) {
      try {
        const receipt = this.promptOutbox!.submit({ messageId: `comment-${randomUUID()}`, agentId: b.agentId, host: null, boardId: b.boardId, frameId: b.frameId, text: texts[i], kind: "prompt" });
        this.record(b, texts[i], `comment ${receipt.status}`);
      } catch (e) {
        this.log(`comment for ${b.agentId} not accepted by the outbox: ${(e as Error).message}`);
        b.queued.unshift(...texts.slice(i));
        break;
      }
    }
    this.writeFrameMeta(b, { queue: b.queued, pendingDeltas: b.queued.length + b.pendingText.size });
    this.host.get(b.boardId).save();
    void this.promptOutbox!.drain();
  }

  async flush(b: Binding, force: boolean): Promise<void> {
    if (this.stopped || b.sending || !this.current(b)) return;
    if (!b.queued.length && !b.pendingText.size && !b.touched.size && !b.frameBefore && !b.introPending) return;
    // Comments are messages to the agent, like the sidebar chat: each goes through the prompt
    // outbox on its own, so it never waits behind (or replaces) an unconfirmed delta receipt.
    // Pause agents holds them; a busy agent gets them during its turn, as chat does.
    if (this.promptOutbox && !b.host && b.queued.some(isCommentDelta) && b.status !== "archived" && !this.startingNow(b)) {
      if (!force && this.paused(b.boardId)) this.log(`comment held for ${b.agentId}: agents paused on board ${b.boardId}`);
      else this.sendComments(b);
    }
    if(!force&&b.timer)return;
    this.unwake(b);
    // Another Mac's agent with the remote source off: keep everything queued.
    if (b.host && !this.remote) return;
    let outstanding=this.frameMeta(b)?.deltaDelivery;
    if(outstanding&&isEmptyReceipt(outstanding)){
      this.log(`cleared an empty unconfirmed delivery on ${b.boardId}/${b.frameId}`);
      this.writeFrameMeta(b,{deltaDelivery:undefined,error:undefined});
      b.held=false;
      outstanding=undefined;
    }
    if(outstanding?.status==='sending'||outstanding?.status==='unknown'){
      // Say why, once per receipt: a silent hold looked like lost messages (2026-11-01).
      if(outstanding.status==='unknown'&&(b.queued.length||b.pendingText.size||b.touched.size)&&b.loggedHold!==outstanding.operationId){
        b.loggedHold=outstanding.operationId;
        this.log(`delta held for ${b.agentId}: delivery ${outstanding.operationId} unconfirmed since ${new Date(outstanding.at).toISOString()}; resolve it in the frame (${b.queued.length} queued)`);
      }
      return;
    }
    if (force) b.held = false;
    else if (b.held) return;
    // Only live frames deliver on their own; manual waits for "Send N changes",
    // on-demand waits for board_read.
    const meta = this.frameMeta(b);
    const deltasToo = force || this.modeOf(b) === "live";
    // A comment is addressed to the agent: it goes out in every mode (on-demand and manual
    // frames hold only their deltas). Pause agents and a busy agent still hold it.
    const commentsWaiting = b.queued.some(isCommentDelta);
    if (!deltasToo && !b.introPending && !commentsWaiting) return;
    // "Pause agents" (board header): nothing automatic goes out. "Send N changes" still does.
    if (!force && this.paused(b.boardId)) {
      this.log(`delta held for ${b.agentId}: agents paused on board ${b.boardId}; ${b.queued.length} queued`);
      return;
    }
    // A busy live frame steers its deltas into the running turn (the outbox sends with
    // activeTurnBehavior 'steer', which never cancels it), rate-limited. Manual and
    // on-demand frames, remote agents and permission prompts still hold them.
    const busy = b.status === "running";
    const steer = busy && deltasToo && this.modeOf(b) === "live" && !!this.promptOutbox && !b.host;
    if (!force && (b.status === "needs-permission" || this.startingNow(b) || (busy && !steer))) {
      this.log(`delta held for ${b.agentId} (${b.status}); ${b.queued.length} queued`);
      return;
    }
    if (!force && steer) {
      const wait = b.lastSentAt + (this.cfg.busyDeltaMs ?? BUSY_DELTA_MS) - Date.now();
      if (wait > 0) {
        this.wake(b, wait);
        return;
      }
    }
    if (b.status === "archived") return;
    if(!b.host&&this.bridge.health&&this.bridge.health().state!=='connected'){this.collectTouches(b);this.writeFrameMeta(b,{error:'Paseo host disconnected or reconnecting. Work stays queued.'});return;}
    const textReady=force||b.textQuietAt<=Date.now();
    if(b.timer&&textReady){clearTimeout(b.timer);b.timer=null;}
    this.collectTouches(b);if(deltasToo&&textReady)this.materializeText(b);
    // Text still inside its quiet window (a timer that fired a millisecond early, or a
    // flush from a turn end): come back when it settles rather than lose track of it.
    if (deltasToo && !textReady && b.pendingText.size) this.wake(b, b.textQuietAt - Date.now());
    this.host.get(b.boardId).save(); // Persist final text queue before the external send.
    // Nothing ready to say (only settling text): an empty prompt would fail as a delivery.
    if (!b.introPending && !(deltasToo ? b.queued.length : b.queued.some(isCommentDelta))) return;
    const texts = deltasToo ? b.queued.splice(0) : takeComments(b.queued);
    const joined =
      texts.length === 0
        ? ""
        : texts.length === 1
          ? texts[0]
          : `${texts.length} board deltas arrived while you were busy or the board was paused:\n\n${texts.join("\n\n")}`;
    const text = joined.length > DELTA_CAP ? `${joined.slice(0, DELTA_CAP)}\n… (${joined.length - DELTA_CAP} more characters; open the board to see the rest: ${this.deepLink(b.boardId, b.frameId)})` : joined;
    // Linked (imported) agents have no board tools. New imports get the full
    // introduction (importIntro) right away; frames linked before it existed get the
    // one-line intro with their first delta.
    const linked = !!meta?.linked;
    const intro = b.introPending ? this.importIntro(b) : linked && !meta?.introducedAt && text ? this.linkIntro(b) : null;
    const parts: string[] = [];
    if (intro) parts.push(intro);
    // Comments are addressed to the agent: no "this is context, reply only if…" footer
    // when nothing else is in the message.
    if (text) parts.push(...(texts.every(isCommentDelta) ? [text] : [text, deltaFooter(this.cfg.humanName, linked, busy)]));
    const body = parts.join("\n\n");
    b.sending = true;
    const wasIntro = b.introPending;
    const delivery:NonNullable<FramePaseoMeta['deltaDelivery']>={operationId:randomUUID(),status:'sending',at:Date.now(),text:body,deltas:texts,intro:wasIntro};
    this.writeFrameMeta(b,{queue:b.queued,pendingDeltas:b.queued.length+b.pendingText.size,deltaDelivery:delivery});
    this.host.get(b.boardId).save(); // Durable intent BEFORE any external delivery.
    const finish = hostOperation(this.log, b.host ?? "local", "delta-send");
    b.lastSentAt = Date.now();
    b.sentAtTurn = b.turnEnds;
    try {
      b.seq++;
      if(this.promptOutbox) {
        b.held=true;
        const receipt=this.promptOutbox.submit({messageId:delivery.operationId,agentId:b.agentId,host:b.host,boardId:b.boardId,frameId:b.frameId,text:body,kind:'delta'});
        this.promptReceiptChanged(receipt);
        void this.promptOutbox.drain();
        return;
      }
      if (b.host) {
        const receipt = await this.sendRemote(b, body, wasIntro ? "Board introduction for an imported conversation" : "Board delta");
        this.record(b, body, `delivered-remote:${receipt.delivery}`);
        // Hold later deltas until a poll sees the agent idle again (as turn ends do here).
        this.promptSent(b);
      } else {
        const api = await this.bridge.ready;
        if (text || wasIntro) await this.appendRow(b, `board-delta-${b.frameId}-${Date.now()}`, text || "Board introduction sent (what the board is, the frame, how to read and write it).");
        this.promptSent(b);
        if(this.stopped||!this.current(b))return;
        await api.agents.ref(b.agentId).send(body,{messageId:delivery.operationId});
        this.record(b, body, "delivered");
      }
      finish();
      delivery.status='accepted';
      if (wasIntro) b.introPending = false;
      if (this.current(b))
        this.writeFrameMeta(b, { deltaDelivery:delivery, error:undefined, pendingDeltas: b.queued.length+b.pendingText.size, queue: b.queued, lastDeltaAt: Date.now(), ...(intro ? { introducedAt: Date.now(), introPending: undefined } : {}) });
    } catch (e) {
      finish(e);
      this.log(`delta send to ${b.host ? `${b.host}/` : ""}${b.agentId} failed: ${(e as Error).message}`);
      // Re-bound meanwhile (restart): the changes belong to the frame's new agent.
      const now = this.bindingFor(b.boardId, b.frameId);
      if (now && now !== b) now.queued.unshift(...texts);
      else if (b.host && (e as { receipt?: Receipt }).receipt?.traceId) {
        // af-network accepted the dispatch but lost the acknowledgement: it may have arrived.
        // af-network never resends that, and neither does the board: the texts stay queued,
        // marked, and the frame holds them until "Send N changes". The introduction is not
        // sent again.
        const mark = "(Possibly a repeat: an earlier send was unconfirmed.) ";
        b.queued.unshift(...texts.map((t) => (t.startsWith(mark) ? t : `${mark}${t}`)));
        b.introPending = false;
        b.held = true;
        this.writeFrameMeta(b, {
          pendingDeltas: b.queued.length,
          queue: b.queued,
          error: `af-network send unconfirmed: ${(e as Error).message}`.slice(0, 400),
          introPending: undefined,
          ...(wasIntro ? { introducedAt: Date.now() } : {}),
        });
      } else if (b.host) {
        // af-network refused before dispatching (unknown host, bad input, not installed):
        // nothing went out; keep it all for the next attempt.
        b.queued.unshift(...texts);
        this.writeFrameMeta(b, { pendingDeltas: b.queued.length, queue: b.queued, error: `af-network send failed: ${(e as Error).message}`.slice(0, 400) });
      } else {
        b.queued.unshift(...texts);
        this.parity?.note(SEEN.sendFailureAsError);
        this.applyStatusLegacy(b, "error");
      }
      delivery.status="unknown";b.held=true;
      this.writeFrameMeta(b,{deltaDelivery:delivery,error:"Board message delivery unconfirmed. Resolve its receipt before sending again.",queue:b.queued,pendingDeltas:b.queued.length+b.pendingText.size});
    } finally {
      if(!this.stopped&&this.current(b))this.host.get(b.boardId).save();
      b.sending = false;
    }
    // Deltas that settled while send() was in flight wait for the next turn end;
    // if the agent is already idle again, deliver them now.
    if ((b.queued.length || b.pendingText.size) && !b.timer && b.status === "idle" && !b.host) void this.flush(b, false);
  }

  resolveDelta(boardId:string,frameId:string,operationId:string,decision:'accepted'|'discard'|'retry') {
    const b=this.bindingFor(boardId,frameId);if(!b)throw httpError(404,'frame is not bound');
    const receipt=this.frameMeta(b)?.deltaDelivery;
    if(!receipt||receipt.operationId!==operationId)throw httpError(409,'delivery receipt changed; read it again');
    if(receipt.status!=='unknown')throw httpError(409,'only an unknown delivery can be resolved');
    if(!['accepted','discard','retry'].includes(decision))throw httpError(400,'choose accepted, discard or retry');
    // Failed sends may have restored these rows in memory; remove that copy first.
    for(const text of receipt.deltas){const marked=b.queued.indexOf('(Possibly a repeat: an earlier send was unconfirmed.) '+text);const i=marked>=0?marked:b.queued.indexOf(text);if(i>=0)b.queued.splice(i,1);}
    // The outbox only fails a send after the conversation was checked and it was not there.
    const outboxed=this.promptOutbox?(()=>{try{return this.promptOutbox!.get(b.agentId,operationId);}catch{return null;}})():null;
    if(decision==='retry' && this.promptOutbox && outboxed?.status!=='failed')throw httpError(409,'Daemon receipt is uncertain. Inspect the conversation, then mark accepted or discard; creating a replacement send could duplicate work.');
    if(decision==='retry'){b.queued.unshift(...receipt.deltas);b.introPending=receipt.intro;}
    else if(receipt.intro)b.introPending=false;
    b.held=false;
    this.writeFrameMeta(b,{deltaDelivery:undefined,error:undefined,queue:b.queued,pendingDeltas:b.queued.length+b.pendingText.size,introPending:b.introPending||undefined});
    this.host.get(boardId).save();
    // Whatever queued behind the receipt goes out now (retry forces it; otherwise the usual
    // mode, pause and busy rules apply).
    void this.flush(b,decision==='retry');
    return {resolved:decision,operationId};
  }

  // on-demand mode: the agent pulls queued changes with board_read.
  // "Restore this version" from a frame's History slider. The restore is one server write
  // (frame-history.ts); the frame's agent hears about it like any other change of its frame.
  restoreVersion(room: BoardRoom, frameId: string, entryId: string, by: string) {
    if (this.layoutLocked(room.id)) throw httpError(409, "The board's layout is locked; unlock it to restore an older version");
    // http.ts only routes here when this server has a history.
    const out = this.history!.restore(room, frameId, entryId, by);
    const b = this.bindingFor(room.id, frameId);
    if (b && out.entry) {
      const when = new Date(out.at).toTimeString().slice(0, 5);
      const name = room.records.get(frameId)?.props?.name || frameId;
      const text = `Board delta — ${by} restored your frame ${quote(name)} to its version from ${when} (History): ${out.restored} shape${out.restored === 1 ? "" : "s"} put back, ${out.removed} removed.`;
      b.queued.push(text);
      this.record(b, text, "queued");
      this.writeFrameMeta(b, { pendingDeltas: b.queued.length + b.pendingText.size, queue: b.queued });
      if (this.modeOf(b) === "live") void this.flush(b, false);
    }
    return out;
  }

  takeQueued(boardId: string, frameId: string): string[] {
    const b = this.bindingFor(boardId, frameId);
    if (!b) return [];
    if(b.timer){clearTimeout(b.timer);b.timer=null;}
    this.collectTouches(b);this.materializeText(b);
    const out = b.queued.splice(0);
    if (out.length) this.writeFrameMeta(b, { pendingDeltas: 0, queue: [], pendingText: undefined });
    return out;
  }

  // One message to another machine's agent through af-network; the receipt goes on the frame.
  private async sendRemote(b: Binding, body: string, reason: string): Promise<Receipt> {
    if (!this.remote) throw new Error("the remote source is off on this board server");
    try {
      const receipt = await this.remote.send(b.host!, b.agentId, { reason, workRef: `bunny/${b.boardId}/${b.frameId}`, returnTo: `board ${this.deepLink(b.boardId, b.frameId)}`, message: body });
      if (this.current(b)) this.writeFrameMeta(b, { lastReceipt: { delivery: receipt.delivery, at: Date.now(), traceId: receipt.traceId }, error: undefined });
      return receipt;
    } catch (e) {
      const r = (e as { receipt?: Receipt }).receipt;
      if (r && this.current(b)) this.writeFrameMeta(b, { lastReceipt: { delivery: r.delivery, at: Date.now(), traceId: r.traceId, error: r.error } });
      throw e;
    }
  }

  // A message to a bound agent on another machine. purpose labels the network handoff
  // (default: a sidebar reply); board-originated notices pass their own so the agent does
  // not read them as something the person typed.
  async promptRemote(agentId: string, text: string, purpose?: string): Promise<Receipt> {
    const b = this.byAgent.get(agentId);
    if (!b?.host) throw httpError(409, `agent ${agentId} is not a remote frame's agent`);
    return this.sendRemote(b, text, purpose ?? `Reply from ${this.cfg.humanName} in the board sidebar`);
  }

  remoteHostOf(agentId: string): string | null {
    const bound = this.byAgent.get(agentId);
    if (bound) return bound.host;
    for (const room of this.host.all()) for (const record of room.records.values()) {
      if (record.type === "transcript" && record.props?.agentId === agentId && typeof record.meta?.paseo?.host === "string") return record.meta.paseo.host;
    }
    return null;
  }

  // af-network polls of a remote agent (every 20 s): status, and turn ends.
  onRemoteStatus(agentId: string, status: AgentStatus | FrameStatus): void {
    const b = this.byAgent.get(agentId);
    if (!b?.host) return;
    this.agentStatus(b, status);
    if (status === "idle" && (b.queued.length || b.pendingText.size || b.introPending)) void this.flush(b, false);
  }

  private record(b: Binding, text: string, event: string): void {
    this.deliveries.push({ at: new Date().toISOString(), boardId: b.boardId, frameId: b.frameId, agentId: b.agentId, text, event });
    if (this.deliveries.length > 200) this.deliveries.shift();
    this.log(`delta ${event} ${b.boardId}/${b.frameId} → ${b.agentId}: ${text.split("\n")[1] ?? text}`);
  }

  private appendRow(b: Binding, id: string, text: string): Promise<void> {
    return this.appendRowFor(b.agentId, b.boardId, b.frameId, id, text);
  }

  private async appendRowFor(agentId: string, boardId: string, frameId: string, id: string, text: string): Promise<void> {
    // Remote agents' timelines live on their own machine.
    if (this.remote?.isRemote(agentId)) return;
    const api = await this.bridge.ready;
    try {
      await api.agents.ref(agentId).timeline.append({
        type: "plugin",
        id,
        kind: "board-delta",
        version: 1,
        data: { text, boardId, frameId, url: this.deepLink(boardId, frameId) },
      });
    } catch (e) {
      this.log(`timeline.append failed for ${agentId}: ${(e as Error).message}`);
    }
  }

  // --- lifecycle --------------------------------------------------------------------------

  // --- names -----------------------------------------------------------------------------

  private queueNameSync(b: Binding): void {
    if (b.host) return; // another Mac's agent: its Paseo is not ours to rename
    const k = key(b.boardId, b.frameId);
    const t = this.nameTimers.get(k);
    if (t) clearTimeout(t);
    this.nameTimers.set(
      k,
      setTimeout(() => {
        this.nameTimers.delete(k);
        void this.syncName(b, this.paseoTitles.get(b.agentId) ?? null);
      }, NAME_SYNC_MS),
    );
  }

  // Top-most note in the frame: the request when the frame was started from a sticky.
  private firstNoteText(room: BoardRoom, frameId: string): string | null {
    let best: Rec | null = null;
    for (const r of room.records.values()) {
      if (!isShape(r) || r.type !== "note" || r.parentId !== frameId) continue;
      if (!best || r.y < best.y || (r.y === best.y && r.x < best.x)) best = r;
    }
    return best ? shapeText(best) : null;
  }

  // Paseo hook events carry the agent's current title: a rename made in Paseo comes back here.
  onAgentTitle(agentId: string, title: string | null | undefined): void {
    const b = this.byAgent.get(agentId);
    if (!b || b.host) return;
    if (title) this.paseoTitles.set(agentId, title);
    void this.syncName(b, title ?? null);
  }

  private async syncName(b: Binding, paseoTitle: string | null): Promise<void> {
    if (this.stopped || !this.current(b)) return;
    const room = this.host.get(b.boardId);
    const frame = room.records.get(b.frameId);
    if (!frame) return;
    const act = reconcileNames(frame.props.name, paseoTitle, frame.meta?.paseo?.syncedName, frame.meta?.paseo?.autoName);
    if (act.kind === "none") return;
    if (act.kind === "toPaseo") {
      if (!this.bridge.aux) return; // retried on the next rename or hook event
      try {
        await this.bridge.updateAgent(b.agentId, { name: act.name });
      } catch (e) {
        this.log(`rename of agent ${b.agentId} failed: ${(e as Error).message}`);
        return;
      }
      this.paseoTitles.set(b.agentId, act.name);
      this.log(`named agent ${b.agentId} after its frame: ${quote(act.name)}`);
    }
    if (this.stopped || !this.current(b) || room.closed) return;
    room.write({ kind: "server", reason: "name-sync" }, (ops) => {
      const cur = ops.get(b.frameId);
      if (!cur) return;
      // The frame changed again while Paseo was being renamed: that rename syncs next.
      if (act.kind === "toPaseo" && cleanName(cur.props.name) !== act.name) return;
      ops.put({
        ...cur,
        props: act.kind === "toFrame" ? { ...cur.props, name: act.name } : cur.props,
        meta: { ...cur.meta, paseo: { ...cur.meta?.paseo, syncedName: act.name } },
      });
    });
    room.save();
    if (act.kind === "toFrame") this.log(`named frame ${b.boardId}/${b.frameId} after its agent: ${quote(act.name)}`);
  }

  // Lifecycle hooks are this server's only turn events, and Paseo drops them when the
  // plugin RPC times out (busy machine): a missed turn_ended leaves a frame "running"
  // and its deltas held forever. Re-read local frames that look busy from the daemon.
  private reconciling = false;
  async reconcileStatuses(): Promise<void> {
    const aux = this.bridge.aux;
    if (this.reconciling || this.stopped || !aux?.isConnected) return;
    this.reconciling = true;
    try {
      for (const b of [...this.bindings.values()]) {
        if (b.host || !this.current(b)) continue;
        // An agent the daemon called missing (or that was never read) is asked about again,
        // less and less often: it may be back, or it may be gone for good. A failed turn is
        // not re-read: it stays red until the next turn, as before.
        const unknown = b.status === "error" || b.status === "requested" ? this.unreadActivity(b) : null;
        if (unknown) {
          if (Date.now() < (b.unknownReadAt ?? 0)) continue;
        } else if (b.status !== "running" && b.status !== "needs-permission") continue;
        const snap = await withDaemonRead(() => aux.fetchAgent(b.agentId)).catch(() => undefined);
        if (snap === undefined || this.stopped || !this.current(b)) continue;
        // The dropped hook also carried the agent's title: a Paseo rename still reaches the frame.
        const title = (snap?.agent as { title?: string | null } | undefined)?.title;
        if (title && title !== this.paseoTitles.get(b.agentId)) this.onAgentTitle(b.agentId, title);
        const status = statusOf(snap?.agent);
        if (unknown) {
          if (status === "missing") {
            b.unknownReads = (b.unknownReads ?? 0) + 1;
            b.unknownReadAt = Date.now() + Math.min(UNKNOWN_REREAD_MAX_MS, UNKNOWN_REREAD_MS * 2 ** Math.min(b.unknownReads - 1, 5));
            // Never read, and the daemon does not know it: it is missing now.
            if (unknown === "unknown") this.onAgentEvent(b.agentId, status, false, "status-reconcile");
            continue;
          }
          b.unknownReads = 0;
          b.unknownReadAt = 0;
          this.log(`status-reconcile ${b.agentId.slice(0, 8)} ${unknown} -> ${status} (the agent answers again)`);
          // No turn is known to have ended: only the status, then anything that waited.
          this.onAgentEvent(b.agentId, status, false, "status-reconcile");
          if (status === "idle" && (b.introPending || b.queued.length || b.pendingText.size)) void this.flush(b, false);
          continue;
        }
        if (status === b.status || status === "running") continue;
        this.log(`status-reconcile ${b.agentId.slice(0, 8)} ${b.status} -> ${status} (missed lifecycle hook)`);
        this.onAgentEvent(b.agentId, status, status === "idle" || status === "error", "status-reconcile");
      }
    } finally {
      this.reconciling = false;
    }
  }

  onAgentEvent(agentId: string, status: AgentStatus, turnEnded: boolean, event = ""): void {
    const b = this.byAgent.get(agentId);
    if (!b) return;
    if (bunnyEnv("DEBUG")) this.log(`event ${event} ${agentId.slice(0, 8)} → ${status}`);
    if (turnEnded) b.turnEnds++;
    this.agentStatus(b, status);
    if (turnEnded) void this.flush(b, false);
  }

  // --- agent status through the lifecycle machine (shared/frame-lifecycle.ts) ------------
  // Hooks, daemon re-reads, remote polls and the board's own sends all end here. The
  // frame's stored fields say which state it is in and transition() says whether the event
  // is a move from there.

  // What the daemon (or a remote poll) says the agent is doing.
  private agentStatus(b: Binding, status: AgentStatus | FrameStatus): void {
    // "requested" is the board's own word, never an agent status: nothing to apply.
    this.dispatchStatus(b, status === "requested" ? null : { type: "AGENT_STATUS", status });
  }

  // The board sent the agent a prompt: it is working before its own hook says so.
  private promptSent(b: Binding): void {
    this.dispatchStatus(b, { type: "PROMPT_SENT" });
  }

  // event null repaints only (subagents or cloud sessions changed): the status stays.
  // - rejected: nothing is written; logged once per (state, event) and counted for the
  //   parity report.
  // - ignored (a hook while the frame is still starting or restarting): no status write,
  //   only the repaint.
  // - moved: the status the state stores and its colour, in one write; the binding's
  //   status follows the stored one.
  private rejectedMoves = new Set<string>();
  private dispatchStatus(b: Binding, event: Extract<LifecycleEvent, { type: "AGENT_STATUS" | "PROMPT_SENT" }> | null): void {
    if (this.stopped || !this.current(b)) return;
    const room = this.host.get(b.boardId);
    const frame = room.records.get(b.frameId);
    if (!frame) return;
    let state = stateOf(frame.meta?.paseo);
    // A failed frame (a start, a remote start or a restart that did not finish) is still
    // written by the old code: an agent status overwrites the failure, as before. Counted,
    // so the parity report shows how often it happens.
    if (state.s === "failed") {
      if (event) this.parity?.note(SEEN.legacyStatusOnFailed);
      this.applyStatusLegacy(b, !event ? b.status : event.type === "PROMPT_SENT" ? "running" : event.status);
      return;
    }
    let moved = false;
    if (event) {
      const r = transition(state, event);
      if (!r.ok) {
        const what = `${lifecycleCode(state)}:${event.type}`;
        this.parity?.note(`rejected:${what}`);
        if (!this.rejectedMoves.has(what)) {
          this.rejectedMoves.add(what);
          this.log(`lifecycle: ${event.type} rejected for ${b.boardId}/${b.frameId} (${lifecycleCode(state)}): ${r.reason}`);
        }
        return;
      }
      if (!r.ignored && r.next.s !== "gone") {
        state = r.next;
        moved = true;
      }
    }
    // An unbound frame has no status to paint (and is not painted black by a repaint).
    if (state.s === "unbound") return;
    const stored = frame.meta?.paseo?.status as FrameStatus | undefined;
    const s: FrameStatus | undefined = moved ? legacyStatusOf(state) : stored;
    if (moved && s) {
      if (bunnyEnv("DEBUG") && b.status !== s) this.log(`status ${b.agentId.slice(0, 8)} ${b.status} -> ${s}`);
      b.status = s;
    }
    const color = colourOf(state, { subagents: b.subagents, cloud: this.cloudIn(b) });
    const subagents = b.subagents > 0 ? b.subagents : undefined;
    const cloudSessions = this.cloudIn(b) || undefined;
    // "missing" is stored beside status "error"; every other status write clears it.
    const activity = moved ? storedActivityOf(state) : (frame.meta?.paseo?.activity as string | undefined);
    if (stored === s && frame.meta?.paseo?.activity === activity && frame.props.color === color && frame.meta?.paseo?.subagents === subagents && frame.meta?.paseo?.cloudSessions === cloudSessions) return;
    room.write({ kind: "server", reason: "status" }, (ops) => {
      const cur = ops.get(b.frameId);
      if (!cur) return;
      const { subagents: _old, cloudSessions: _oldCloud, activity: _oldActivity, ...paseo } = cur.meta?.paseo ?? {};
      ops.put({ ...cur, props: { ...cur.props, color }, meta: { ...cur.meta, paseo: { ...paseo, ...(moved && s ? { status: s } : {}), ...(activity ? { activity } : {}), ...(subagents ? { subagents } : {}), ...(cloudSessions ? { cloudSessions } : {}) } } });
    });
  }

  // Still starting (or restarting): the conversation cannot take stamps, comments or deltas
  // yet, and the frame cannot be unbound. The stored fields decide, not the status word: a
  // bound agent that was not read yet is stored as "requested" too, and is not starting.
  // A remote link still waits, in memory only, for its first af-network read (linkSync).
  private startingNow(b: Binding): boolean {
    const s = stateOf(this.frameMeta(b)).s;
    return s === "starting" || s === "restarting" || (!!b.host && b.status === "requested");
  }

  // A bound agent the daemon called missing, or that has not been read: worth asking about
  // again. A failed turn is neither.
  private unreadActivity(b: Binding): "missing" | "unknown" | null {
    const state = stateOf(this.frameMeta(b));
    return state.s === "bound" && (state.activity === "missing" || state.activity === "unknown") ? state.activity : null;
  }

  // The writers that have not moved onto the lifecycle machine yet (bind, link, restart, a
  // failed send): today's behaviour, unchanged. dispatchStatus replaces it writer by writer.
  private applyStatusLegacy(b: Binding, status: AgentStatus | FrameStatus): void {
    if (this.stopped || !this.current(b)) return;
    const s: FrameStatus = status === "missing" ? "error" : status;
    if (status === "missing") this.parity?.note(SEEN.missingAsError);
    if (bunnyEnv("DEBUG") && b.status !== s) this.log(`status ${b.agentId.slice(0, 8)} ${b.status} -> ${s}`);
    b.status = s;
    const room = this.host.get(b.boardId);
    const frame = room.records.get(b.frameId);
    if (!frame) return;
    const color = this.frameColor(b);
    const subagents = b.subagents > 0 ? b.subagents : undefined;
    const cloudSessions = this.cloudIn(b) || undefined;
    // activity ("missing", written by dispatchStatus beside status "error") must not sit
    // stale beside another status: any write of a status other than error clears it.
    const stale = s !== "error" && frame.meta?.paseo?.activity !== undefined;
    if (frame.meta?.paseo?.status === s && !stale && frame.props.color === color && frame.meta?.paseo?.subagents === subagents && frame.meta?.paseo?.cloudSessions === cloudSessions) return;
    room.write({ kind: "server", reason: "status" }, (ops) => {
      const cur = ops.get(b.frameId);
      if (!cur) return;
      const { subagents: _old, cloudSessions: _oldCloud, activity: oldActivity, ...paseo } = cur.meta?.paseo ?? {};
      ops.put({ ...cur, props: { ...cur.props, color }, meta: { ...cur.meta, paseo: { ...paseo, status: s, ...(s === "error" && oldActivity ? { activity: oldActivity } : {}), ...(subagents ? { subagents } : {}), ...(cloudSessions ? { cloudSessions } : {}) } } });
    });
  }

  private frameMeta(b: Binding): FramePaseoMeta | undefined {
    return this.host.get(b.boardId).records.get(b.frameId)?.meta?.paseo;
  }

  private writeFrameMeta(b: Binding, patch: Partial<FramePaseoMeta> & { queue?: string[] }): void {
    if (this.stopped || !this.current(b)) return;
    const room = this.host.get(b.boardId);
    room.write({ kind: "server", reason: "meta" }, (ops) => {
      const cur = ops.get(b.frameId);
      if (cur) ops.put({ ...cur, meta: { ...cur.meta, paseo: { ...cur.meta?.paseo, ...patch } } });
    });
  }

  // --- binding requests ---------------------------------------------------------------------

  deepLink(boardId: string, frameId: string): string {
    return `${this.cfg.publicBase}/?board=${encodeURIComponent(boardId)}&frame=${encodeURIComponent(frameId)}`;
  }

  mcpServerFor(boardId: string, frameId: string, agentId: string) {
    return {
      type: "stdio" as const,
      // In a container deployment the agent host is another container or machine, so the
      // node binary and the board's address there come from config (config.ts).
      command: this.cfg.mcpNode ?? process.execPath,
      args: [this.cfg.mcpEntry],
      env: {
        BOARD_URL: this.cfg.agentBoardUrl ?? `http://127.0.0.1:${this.cfg.port}`,
        BOARD_TOKEN: frameToken(this.cfg.secret, boardId, frameId, agentId),
        BOARD_ID: boardId,
        FRAME_ID: frameId,
        // board-mcp.mjs reads server.json here if BOARD_URL stops answering (port moves).
        BOARD_STATE: this.cfg.stateDir,
        // A board-env environment: board-mcp.mjs then refuses the live board.
        ...(process.env.BOARD_ENV ? { BOARD_ENV: process.env.BOARD_ENV } : {}),
      },
      alwaysLoad: true,
    };
  }

  // The frame agent's own environment: its frame, and (like the board MCP's) the board's
  // address and the frame token, so bin/cloud-task can pin its cloud session card into this
  // frame without the agent placing it. The token authorises this frame only.
  agentEnv(boardId: string, frameId: string, agentId: string): Record<string, string> {
    const mcp = this.mcpServerFor(boardId, frameId, agentId).env;
    return { BOARD_ID: boardId, FRAME_ID: frameId, BOARD_AGENT_ID: agentId, BOARD_URL: mcp.BOARD_URL, BOARD_TOKEN: mcp.BOARD_TOKEN, BOARD_STATE: mcp.BOARD_STATE };
  }

  // The paragraph a "Use cloud agent" frame's opener adds: this agent conducts, the chosen
  // cloud builder (a Claude Code cloud session or a Codex cloud task) codes and proves, the
  // Mac only previews and deploys.
  cloudPath(provider: CloudProvider = "claude"): string {
    const repo = path.dirname(path.dirname(this.cfg.mcpEntry));
    const skill = path.join(repo, "skills/cloud-dev/SKILL.md"), bin = path.join(repo, "bin/cloud-task");
    if (provider === "codex")
      return `Cloud path: this frame uses the cloud path with Codex as the cloud builder. For code changes, follow ${skill}: dispatch the work to a Codex cloud task with ${bin} start --provider codex (never a Claude cloud session, never local codex exec). It pins a live cloud session card for the task in this frame itself and fails if it cannot (never pass --no-pin here; if it prints "pinned":false, tell ${this.cfg.humanName} and put the task link in the frame yourself). Give ${this.cfg.humanName} the task link in your reply. Until that card says merged, closed or failed, this frame's work is not done: never sign off as if it were. Preview and deploy its PR from here. Codex cloud has no follow-up command: for ${this.cfg.humanName}'s change requests, run cloud-task send --provider codex <task> and pass on the task link it prints so ${this.cfg.humanName} continues in that task's page. If cloud-task start reports a Codex error, tell ${this.cfg.humanName} exactly what it says; do not switch builders. This replaces the board-env rule above for this frame. Do not build or test on this Mac.`;
    return `Cloud path: this frame uses the cloud path. For code changes, follow ${skill}: dispatch the work to a Claude Code cloud session with ${bin} start. It pins a live cloud session card for the session in this frame itself and fails if it cannot (never pass --no-pin here; if it prints "pinned":false, tell ${this.cfg.humanName} and put the session link in the frame yourself). Give ${this.cfg.humanName} the session link in your reply. Until that card says merged, closed or failed, this frame's work is not done: never sign off as if it were. Relay ${this.cfg.humanName}'s change requests with cloud-task send, and preview and deploy its PR from here. This replaces the board-env rule above for this frame. Do not build or test on this Mac.`;
  }

  // cloud: the frame's cloud builder (null or false for a local frame; true means Claude).
  openingPrompt(room: BoardRoom, frameId: string, line: string | undefined, viaHttp: string | null, cloud: CloudProvider | boolean | null = false): string {
    const frame = room.records.get(frameId)!;
    const link = this.deepLink(room.id, frameId);
    const tools = viaHttp
      ? this.httpPrimer(room.id, frameId, viaHttp)
      : [
          "Board tools (MCP server `board`, all scoped to your frame):",
          "- board_read({scope:'frame'|'board', format:'outline'|'json'}) — outline of your frame (default) or one line per frame for the whole board.",
          "- board_snapshot({area?:{x,y,w,h}}) — a picture of your frame as the person sees it, drawn by a browser that has the board open (the outline cannot show crowding, long text or how the colours read). area shows one part of a large frame larger. It says so when the picture is not current.",
          "- board_write({shapes:[{type:'note'|'text'|'box'|'ellipse'|'arrow'|'frame'|'bookmark'|'link'|'checklist', x, y, w?, h?, text?, color?, from?, to?, url?, board?, frameId?, title?, items?, portal?}]}) — writes shapes, including portal stickies (a note with portal:{id} links another shape or frame). x/y are relative to your frame's top-left. Writes outside your frame, and writes that would overlap another shape, are rejected (the error names the next free slot). type:'link' with board (and frameId) is a card that opens another board or frame. A note may carry portal:{id} (any shape on the board, other frames too) or a page-space area portal:{x,y,w,h}: a sticky that links to related content elsewhere, which the person can jump to and back or expand in place.",
          "- board_update({id, patch:{text?, color?, x?, y?, w?, h?, portal?, items?, title?}}) — changes a shape; on a checklist, patch.items:[{id, checked}] ticks items by id (also text, remove, or a new id with text to add one); patch.portal:{id:'shape:…'} turns a sticky into a portal (portal:null removes it), board_delete({ids}) — only shapes inside your frame; deleting a human's shape needs force:true.",
          `- board_layout({strategy:'grid'|'columns', ids?, gap?}) — re-flow your shapes so nothing overlaps (${this.cfg.humanName}'s shapes and cards stay put); grows your frame if needed.`,
          "- board_frame({resize?:{w,h,anchor?}, move?:'auto', name?}) — grow your frame (anchor 'top-right' grows left, 'bottom-left' grows up), move it to the nearest free spot that fits, or rename it. A blocked resize lists what is in the way and your options.",
          "- board_add_artifact({path|url, title}) — drop a PNG/JPG screenshot or a link card into your frame; board_add_artifact({kind:'file', path}) copies any other file (HTML report, transcript, PDF) into the board and links it.",
          "- board_widget({action:'list'|'add'|'configure'|'read', widgetId?, config?, id?, x?, y?}) — live plugin widgets (e.g. a Slack channel or thread) with a status dot; add one to your frame for the person, configure it, or read its status.",
          `- board_stamp({action:'list'|'ack'|'resolve'|'add', id?, target?, stamp?, note?}) — stamps ${this.cfg.humanName} attaches to shapes in your frame. Each arrives at once as a message starting "Stamp <kind> on …" with a JSON event, even while you work. Fixed meanings: ${stampMeanings()}. ack one when you start on it and resolve it when handled (${this.cfg.humanName} sees sent → seen → acting → done on the stamp); add puts your own stamp on a shape in your frame.`,
          "- board_pin_transcript({agentId, mode?:'compact'|'full', x?, y?}) — pin a live transcript card of another agent (a subagent in your workspace, or an agent bound on this board) into your frame. board_read then shows its latest messages.",
          "- board_channel({action:'list'|'send', channelId?, messageId?, text?}) — arrow channels: when someone connects your frame to another frame with an arrow channel, you get a \"Channel opened\" message. list shows your active channels and their member frames; send delivers one message (stable messageId) to the other frame's agent. The arrow is the person's approval: coordinate without asking them, starting with what you are working on and what you need; transcripts are never forwarded automatically.",
          `- board_archive_candidates({idleDays?}) and board_archive({frameIds, reason}) — only when ${this.cfg.humanName} asks you to tidy the board: list stale frames with reasons, then propose archiving some. A proposal archives nothing until ${this.cfg.humanName} approves it on the board; archived frames can be restored.`,
          "",
          "Placing shapes: a sticky (note) is 200 px wide and holds about 12 words; longer text makes it grow about 30 px per line. Put stickies on the 240 px grid: x = 20, 260, 500, 740, …; y = 50, 290, 530, … (the outline lists free slots), or omit x/y to auto-place. Keep each sticky to one short headline (under about 8 words); put detail in your chat reply or a second sticky. Cards in your frame are occupied space: write around them. If things overlap, call board_layout. Portals: when a topic needs more room than your frame has, or relates to another frame, link it with a portal sticky instead of cramming or growing the frame: put the detail where there is room and leave a note here, board_write({shapes:[{type:'note',text:'Details →',portal:{id:'shape:…'}}]}), or turn an existing sticky into one with board_update({id,patch:{portal:{id:'shape:…'}}}). The person opens it in place or jumps there and back; board_read lists portals both ways.",
        ].join("\n");
    return [
      line?.trim() ? `${this.cfg.humanName} says: ${line.trim()}` : `${this.cfg.humanName} drew a frame around some ideas on a whiteboard and started this conversation from it.`,
      "",
      `You are the agent for one frame on a shared tldraw board. Board deep link (give ${this.cfg.humanName} this when you mention the board): ${link}`,
      "",
      "Your frame right now:",
      frameOutline(room.records, frameId, this.outlineCtx()),
      "",
      tools,
      "",
      BOARD_SYSTEM_PROMPT,
      "",
      ...(cloud ? [this.cloudPath(cloud === true ? "claude" : cloud), ""] : []),
      frameUpkeep(this.cfg.humanName),
      "",
      `How to work: start your first reply by restating what is in your frame (quote the notes), then answer. Put the useful result on the board too, laid out as above: at least the status line and the result. Later, when ${this.cfg.humanName} edits your frame, you will get a message starting with "Board delta". Deltas are context, not requests: reply (in chat or on the board) only when one asks you something, asks you to do something, or changes your task. Otherwise write nothing on the board and reply with exactly one word: ${SILENT_ACK}.`,
      frame.props.name ? `Frame title: ${quote(frame.props.name)}.` : "",
      `Naming: the frame title is also this conversation's name in Paseo (they stay in sync). ${isGenericName(frame.props.name) ? "It is a placeholder: rename" : isProvisionalName(frame.props.name, frame.meta?.paseo?.autoName) ? "It is only a provisional title cut from the first line of the request: rename" : "If it no longer says what this task is, rename"} it with ${viaHttp ? "POST {name} to /frame" : "board_frame({name})"} to a short title (under about 6 words) once you know the task.`,
    ]
      .filter((l) => l !== null)
      .join("\n");
  }

  private httpPrimer(boardId: string, frameId: string, agentId: string): string {
    const t = frameToken(this.cfg.secret, boardId, frameId, agentId);
    const base = `http://127.0.0.1:${this.cfg.port}/api/agent/boards/${boardId}/frames/${frameId}`;
    return [
      // Only remote starts use this primer: the agent was created for this frame, on another
      // machine that has no board MCP executable. (It once said "linked after your session
      // started", which told freshly created agents they had joined late.)
      "You were created for this frame on another machine, where the board MCP server is not installed, so the board tools reach you over HTTP instead (same rules, scoped to this frame):",
      `- read:  curl -s -H 'authorization: Bearer ${t}' '${base}/read?format=outline'`,
      `- write: curl -s -H 'authorization: Bearer ${t}' -H 'content-type: application/json' -d '{"shapes":[{"type":"note","x":40,"y":60,"text":"hi"}]}' ${base}/write`,
      `- update/delete/frame/pin/widget/stamp: POST JSON to ${base}/update | /delete | /frame | /pin | /widget | /stamp (bodies match the MCP tools; /pin is board_pin_transcript, /widget is board_widget, /stamp is board_stamp).`,
      `- snapshot: POST {} (or {"area":{"x":0,"y":0,"w":800,"h":600}}) to ${base}/snapshot for a picture of your frame as the person sees it: the reply's "data" is a base64 PNG (save it to a file and view it) and "note" says whether it is current.`,
      `- arrow channels: POST {"action":"list"} to ${base}/channel to see channels connecting your frame to another frame (a "Channel opened" message announces each); POST {"action":"send","channelId":"…","messageId":"<stable id>","text":"…"} sends one message to the other frame's agent. The arrow is the person's approval: coordinate without asking them; transcripts are never forwarded automatically.`,
      `- Stamps on shapes in your frame arrive as messages starting "Stamp <kind> on …". Fixed meanings: ${stampMeanings()}. POST {action:"ack"|"resolve", id} to ${base}/stamp as you start on and finish each.`,
      `- board clean-up (only when asked): POST JSON to ${base}/archive-candidates | /archive (board_archive_candidates, board_archive: a proposal ${this.cfg.humanName} approves on the board).`,
    ].join("\n");
  }

  requestLink(room:BoardRoom,frameId:string,agentId:string){
    const f=room.records.get(frameId);if(f?.type!=='frame')throw httpError(404,'selected frame no longer exists');
    const p=f.meta?.paseo;
    if(p?.request?.kind==='link'&&p.request.agentId===agentId)return;
    if(p?.agentId||p?.request)throw httpError(409,'frame is already bound or starting');
    const other=this.boundRef(agentId);if(other&&(other.boardId!==room.id||other.frameId!==frameId))throw httpError(409,'conversation is already on a board');
    this.reserved.set(agentId,{boardId:room.id,frameId});
    room.write({kind:'server',reason:'link-intent'},ops=>{const cur=ops.get(frameId)!;ops.put({...cur,meta:{...cur.meta,paseo:{...cur.meta?.paseo,request:{kind:'link',agentId,requestedAt:Date.now()},status:'requested',error:undefined}}});});room.save();
    void this.fulfil(room,frameId);
  }

  private retryBinding(room:BoardRoom,frameId:string,nextAt:number){
    const k=key(room.id,frameId);const old=this.bindRetries.get(k);if(old)clearTimeout(old);
    if(this.stopped)return;
    const timer=setTimeout(()=>{this.bindRetries.delete(k);if(!this.stopped)void this.fulfil(room,frameId);},Math.max(0,nextAt-Date.now()));
    timer.unref?.();this.bindRetries.set(k,timer);
  }

  async fulfil(room: BoardRoom, frameId: string): Promise<void> {
    const frame = room.records.get(frameId);
    const p: FramePaseoMeta | undefined = frame?.meta?.paseo;
    const req = p?.request;
    if (!frame || !req || this.stopped || room.closed) return;
    if (p?.bindRetry && p.bindRetry.nextAt > Date.now()) { this.retryBinding(room,frameId,p.bindRetry.nextAt); return; }
    const k = `${room.id}/${frameId}/${req.requestedAt}`;
    if (this.inflight.has(k)) return;
    this.inflight.add(k);
    try {
      // Checked before anything is created: an unknown builder fails the request.
      const cloudProvider = req.kind === "create" ? requestedCloudProvider(req) : null;
      if(req.kind==='create'&&req.host){
        await this.fulfilRemoteCreate(room,frameId,req);
        return;
      }
      const api = await withDaemonRead(()=>this.bridge.ready);
      if(this.stopped||room.closed)return;
      if(this.bridge.health&&this.bridge.health().state!=='connected')throw new Error('Paseo host disconnected; binding stays queued');
      if (req.kind === "link") await this.fulfilLink(api, room, frameId, req.agentId);
      else await this.fulfilCreate(api, room, frameId, req.provider, req.prompt, req.workspaceId, req.context, cloudProvider, req.cwd, startEffort(req.thinkingOptionId));
      if(this.stopped||room.closed)return;
      const timer=this.bindRetries.get(key(room.id,frameId));if(timer)clearTimeout(timer);this.bindRetries.delete(key(room.id,frameId));
      room.write({kind:'server',reason:'bind-recovered'},ops=>{const cur=ops.get(frameId);if(cur)ops.put({...cur,meta:{...cur.meta,paseo:{...cur.meta?.paseo,bindRetry:undefined}}});});room.save();
    } catch (e) {
      const msg = (e as Error).message;
      if(this.stopped||room.closed)return;
      const cur=room.records.get(frameId);
      if(!cur || cur.meta?.paseo?.request?.requestedAt!==req.requestedAt)return;
      this.log(`fulfil ${k} failed: ${msg}`);
      if(req.kind==='create'&&req.host){
        const intent=cur.meta?.paseo?.remoteStart;
        const safeToDiscard=!intent || (intent.phase==='prepared'&&!intent.payload);
        room.write({kind:'server',reason:'remote-start-error'},ops=>{const f=ops.get(frameId);if(f)ops.put({...f,props:{...f.props,color:STATUS_COLOR.error},meta:{...f.meta,paseo:{...f.meta?.paseo,status:'error',error:msg,bindRetry:undefined,...(safeToDiscard?{request:undefined,remoteStart:undefined}:{})}}});});room.save();return;
      }
      if(retryableBindingError(e)){
        const attempt=(cur.meta?.paseo?.bindRetry?.attempt ?? 0)+1;
        const nextAt=Date.now()+Math.min(30000,2000*2**Math.min(attempt-1,4));
        room.write({kind:'server',reason:'bind-retry'},ops=>{const f=ops.get(frameId);if(f)ops.put({...f,props:{...f.props,color:STATUS_COLOR.requested},meta:{...f.meta,paseo:{...f.meta?.paseo,request:req,status:'requested',error:'Paseo host disconnected or slow. Retrying this same conversation.',bindRetry:{attempt,nextAt,lastError:msg}}}});});room.save();
        this.retryBinding(room,frameId,nextAt);return;
      }
      if(req.kind==='link'&&this.reserved.get(req.agentId)?.frameId===frameId)this.reserved.delete(req.agentId);
      const failed = this.bindingFor(room.id, frameId);
      if (failed && req.kind === "create") {
        this.bindings.delete(key(room.id, frameId));
        this.byAgent.delete(failed.agentId);
      }
      room.write({ kind: "server", reason: "request-failed" }, (ops) => {
        const cur = ops.get(frameId);
        if (cur)
          ops.put({
            ...cur,
            props: { ...cur.props, color: STATUS_COLOR.error },
            meta: {
              ...cur.meta,
              paseo: { ...cur.meta?.paseo, request: undefined, status: "error", error: msg, ...(req.kind === "create" && !this.bindingFor(room.id, frameId) ? { agentId: undefined } : {}) },
            },
          });
      });
    } finally {
      this.inflight.delete(k);
    }
  }

  private async fulfilRemoteCreate(room:BoardRoom,frameId:string,req:Extract<NonNullable<FramePaseoMeta['request']>,{kind:'create'}>){
    if(!this.remote?.enabled)throw Error('Remote creation unavailable');
    if(req.cloud)throw Error('Cloud agents are not supported for remote starts');
    const frame=room.records.get(frameId)!;
    const previous=frame.meta?.paseo?.remoteStart as FramePaseoMeta['remoteStart'];
    const existing=previous?.phase==='complete'||(previous?.phase==='prepared'&&!previous.payload)?undefined:previous;
    if(existing&&(existing.host!==req.host||existing.requestedAt!==req.requestedAt))throw Error(`Pending remote operation ${existing.key} belongs to another request; reconcile it before starting again`);
    const intent=existing??{host:req.host!,requestedAt:req.requestedAt,key:`board-start:${randomUUID()}`,agentId:randomUUID(),messageId:randomUUID(),phase:'prepared' as const};
    const persist=(value:NonNullable<FramePaseoMeta['remoteStart']>)=>{
      if(this.stopped||room.closed||!room.records.has(frameId))throw Error('Frame closed during remote start');
      const pending=room.records.get(frameId)?.meta?.paseo?.request;
      if(pending?.kind!=='create'||pending.requestedAt!==req.requestedAt||pending.host!==req.host)throw Error('Remote start request changed during creation');
      // Bind the pair before the separately identified opener can execute HTTP
      // board tools. Keep the request until that message is acknowledged.
      const created=['created','sending','complete'].includes(value.phase);
      if(created)this.bind(room.id,frameId,value.agentId,'requested',value.host);
      room.write({kind:'server',reason:'remote-start-intent'},ops=>{const f=ops.get(frameId)!;ops.put({...f,meta:{...f.meta,paseo:{...f.meta?.paseo,remoteStart:JSON.parse(JSON.stringify(value)),...(created?{agentId:value.agentId,host:value.host,workspaceId:value.payload?.workspaceId}:{})}}});});room.save();
    };
    persist(intent);
    const named=startName(frame.props.name,req.prompt);
    const title=named.name||cleanName(frame.props.name)||`Board ${room.id} frame`;
    const chosen=executionProvider(resolveStartProvider(req.provider||this.cfg.defaultProvider,this.cfg.defaultProvider),this.cfg.defaultProvider,req.host);
    // HTTP tools use the environment's reachable address; no local paths or MCP
    // executables are sent to another Mac.
    const prompt=this.openingPrompt(room,frameId,req.prompt,intent.agentId).replaceAll(`http://127.0.0.1:${this.cfg.port}`,this.cfg.publicBase);
    const thinkingOptionId=startEffort(req.thinkingOptionId);
    await this.remote.createOnHost(intent,{provider:chosen,title,prompt,modeId:this.modeFor(chosen),...(thinkingOptionId?{thinkingOptionId}:{}),labels:{board:room.id,frame:frameId,workRef:`bunny/${room.id}/${frameId}`}},persist);
    if(this.stopped||room.closed||!room.records.has(frameId))return;
    this.adoptEnclosed(room,frameId,null);
    const b=this.linkSync(room,frameId,{id:intent.agentId,title,workspaceId:intent.payload?.workspaceId??null,status:'running',host:intent.host},named.auto?title:undefined);
    this.remote.quickRefresh(intent.agentId);
    this.reserved.delete(intent.agentId);
    b.introPending=false;
    this.writeFrameMeta(b,{linked:false,introPending:false,introducedAt:Date.now(),status:'running',error:undefined});
    room.save();
  }

  // One Paseo workspace per board, named after it (the user: one board = one workspace,
  // one frame = one tab). Reuses the board's stored workspace, else one with the
  // board's title in the default folder, else creates it. Serialised per board so two
  // frames bound at once do not create two workspaces.
  private boardWorkspace(api: PaseoApi, room: BoardRoom, requested?: string): Promise<string | undefined> {
    if (requested) return Promise.resolve(requested);
    if (!this.cfg.workspacePerBoard) return this.legacyBoardWorkspace(api, room);
    const pending = this.wsPending.get(room.id);
    if (pending) return pending;
    const p = this.ensureBoardWorkspace(api, room).finally(() => this.wsPending.delete(room.id));
    this.wsPending.set(room.id, p);
    return p;
  }

  // The board's own workspace is kept under document meta `bunnyWorkspaceId`, which
  // only this function writes, and only for a workspace it created or adopted by title.
  // It never renames a workspace: older boards stored their first agent's workspace
  // under `paseoWorkspaceId`, which may be a shared one, so that key is ignored here.
  // Daemon errors fail the bind rather than create a duplicate workspace.
  private async ensureBoardWorkspace(api: PaseoApi, room: BoardRoom): Promise<string> {
    const title = this.cfg.workspaceTitle.replaceAll("{board}", room.id);
    const doc = room.records.get("document:document");
    const stored = doc?.meta?.bunnyWorkspaceId as string | undefined;
    const usable = (w: { archivingAt?: string | null; archivedAt?: string | null } | null | undefined) => !!w && !w.archivingAt && !w.archivedAt;
    let id: string | undefined;
    if (stored) {
      const live = await api.workspaces
        .ref(stored)
        .refresh()
        .catch((err: Error) => {
          if (/not\s*found|unknown|no such/i.test(err.message)) return null;
          throw err;
        });
      if (usable(live as never)) id = stored;
      else this.log(`board ${room.id}: workspace ${stored} is gone or archived; finding another`);
    }
    if (!id) {
      const list = await api.workspaces.list();
      const hit = list.entries.find(
        (w) => usable(w as never) && (w.title ?? w.name) === title && (w.workspaceDirectory ?? w.projectRootPath) === this.cfg.defaultCwd,
      );
      if (hit) {
        id = hit.id;
        this.log(`board ${room.id}: adopting workspace ${id} "${title}"`);
      }
    }
    if (!id) {
      const ws = await api.workspaces.create({ source: { kind: "directory", path: this.cfg.defaultCwd }, title });
      id = ws.id;
      this.log(`board ${room.id}: created workspace ${id} "${title}" in ${this.cfg.defaultCwd}`);
    }
    if (id !== stored) {
      const chosen = id;
      room.write({ kind: "server", reason: "workspace" }, (ops) => {
        const d = ops.get("document:document");
        if (d) ops.put({ ...d, meta: { ...d.meta, bunnyWorkspaceId: chosen } });
      });
    }
    return id;
  }

  boardWorkspaceId(room: BoardRoom): string | undefined {
    return room.records.get("document:document")?.meta?.bunnyWorkspaceId as string | undefined;
  }

  modeFor(provider: string): string | undefined {
    const id = this.cfg.modeIds[provider.split("/")[0]];
    return id || undefined;
  }

  private async legacyBoardWorkspace(api: PaseoApi, room: BoardRoom): Promise<string | undefined> {
    const doc = room.records.get("document:document");
    const ws = doc?.meta?.paseoWorkspaceId as string | undefined;
    if (ws) {
      const live = await api.workspaces
        .ref(ws)
        .refresh()
        .catch(() => null);
      if (live && !(live as { archivingAt?: string | null }).archivingAt) return ws;
    }
    return undefined;
  }

  private async fulfilCreate(
    api: PaseoApi,
    room: BoardRoom,
    frameId: string,
    provider: string | undefined,
    line: string | undefined,
    workspaceId: string | undefined,
    context?: "board" | "repo",
    cloud: CloudProvider | null = null,
    cwd?: string,
    thinkingOptionId?: string,
  ): Promise<void> {
    if(upstashDefault(this.cfg))cloud=null;
    // Shapes the frame was drawn around belong to it (tldraw does not always reparent).
    this.adoptEnclosed(room, frameId, null);
    const frame = room.records.get(frameId)!;
    // An untitled frame is named from its request until the agent names it properly.
    const named = startName(frame.props.name, line, this.firstNoteText(room, frameId));
    const title = named.name || cleanName(frame.props.name) || `Board ${room.id} frame`;
    let startup = cwd ? {context: "repo" as const, cwd, systemPrompt: undefined} : agentContext(this.cfg, room.id, frame, context, workspaceId);
    // Choose the agent id first and write it into the frame before creating the
    // agent: the frame token names the agent, early tool calls resolve, and a
    // restart mid-create replays with the same id instead of making a second agent.
    const agentId: string = frame.meta?.paseo?.agentId ?? randomUUID();
    const owner=this.boundRef(agentId);
    if(owner&&(owner.boardId!==room.id||owner.frameId!==frameId))throw httpError(409,'pending conversation is already reserved by another frame');
    if (!frame.meta?.paseo?.agentId) {
      room.write({ kind: "server", reason: "prebind" }, (ops) => {
        const cur = ops.get(frameId);
        if (cur) ops.put({ ...cur, meta: { ...cur.meta, paseo: { ...cur.meta?.paseo, agentId, status: "requested" } } });
      });
    }
    room.save(); // Persist the prebound ID before any external create effect.
    const b = this.bind(room.id, frameId, agentId, "requested");
    this.reserved.delete(agentId);
    const existing = await api.agents
      .ref(agentId)
      .refresh()
      .catch((e:unknown) => { if(missingAgent(e)) return null; throw e; });
    if(this.stopped||room.closed||!this.current(b))return;
    let workspace: string | undefined = existing?.agent.workspaceId ?? undefined;
    if (existing) {
      this.log(`agent ${agentId} for ${room.id}/${frameId} already exists (replayed request); not creating another`);
    } else {
      const chosen = executionProvider(resolveStartProvider(provider || this.cfg.defaultProvider, this.cfg.defaultProvider),this.cfg.defaultProvider);
      const modeId = this.modeFor(chosen);
      let selectedWorkspace: string | undefined;
      if (!cwd && (startup.context === 'board' || this.cfg.workspacePerBoard !== false || workspaceId)) {
        const selected = await (this.workspacePolicy ??= new BoardWorkspaces(this.cfg)).select(api, room, startup.context === 'repo', workspaceId, phase => {
          if(this.stopped||room.closed||!this.current(b))return;
          room.write({kind:'server',reason:'workspace-phase'},ops=>{const cur=ops.get(frameId);if(cur)ops.put({...cur,meta:{...cur.meta,paseo:{...cur.meta?.paseo,workspaceSetup:phase}}});});room.save();
        }, () => !this.stopped && !room.closed && this.current(b));
        if(this.stopped||room.closed||!this.current(b))return;
        selectedWorkspace = selected.id;
        if (selected.reason) startup = {context: 'board', cwd: selected.cwd!, systemPrompt: BOARD_SYSTEM_PROMPT};
        room.write({kind:'server',reason:'workspace-selected'},ops=>{
          const cur=ops.get(frameId), doc=ops.get('document:document');
          if(cur)ops.put({...cur,meta:{...cur.meta,paseo:{...cur.meta?.paseo,workspaceSetup:{phase:'ready',mode:selected.mode,cwd:selected.cwd,workspaceId:selected.id,reason:selected.reason,fallbackFrom:selected.fallbackFrom}}}});
          if(doc && !workspaceId)ops.put({...doc,meta:{...doc.meta,bunnyWorkspaceId:selected.id}});
        });room.save();
      } else if (!cwd) selectedWorkspace = await this.boardWorkspace(api, room, workspaceId);
      const options = {
        agentId,
        config: {
          provider: chosen,
          ...(startup.systemPrompt ? { systemPrompt: startup.systemPrompt } : {}),
          ...(modeId ? { modeId } : {}),
          ...(thinkingOptionId ? { thinkingOptionId } : {}),
          mcpServers: { board: this.mcpServerFor(room.id, frameId, agentId) },
          toolPolicy: { preapproved: BOARD_TOOLS.map((tool) => ({ kind: "mcp" as const, server: "board", tool })) },
        },
        title,
        prompt: this.openingPrompt(room, frameId, line, null, cloud),
        labels: { board: room.id, frame: frameId },
        env: this.agentEnv(room.id, frameId, agentId),
      };
      const ws = selectedWorkspace;
      if(this.stopped||room.closed||!this.current(b))return;
      const handle = ws
        ? await api.workspaces.ref(ws).agents.create(options)
        : await api.agents.create({ ...options, cwd: startup.cwd });
      if (handle.id !== agentId) throw new Error(`daemon assigned ${handle.id}, expected ${agentId}`);
      workspace = handle.workspaceId ?? ws ?? undefined;
      this.log(`created agent ${agentId} for ${room.id}/${frameId} in workspace ${workspace} (mode ${modeId ?? "provider default"}, effort ${thinkingOptionId ?? "model default"})`);
    }
    const status = existing ? statusOf(existing.agent) : "running";
    // The frame was deleted (or the binding replaced) while the agent was being created:
    // leave the frame alone; the agent is released like any deleted frame's.
    if (room.closed || !this.current(b) || !room.records.get(frameId)) {
      this.log(`created agent ${agentId}, but ${room.id}/${frameId} is gone or was released meanwhile; not binding`);
      return;
    }
    room.write({ kind: "server", reason: "bind" }, (ops) => {
      const cur = ops.get(frameId);
      if (cur)
        ops.put({
          ...cur,
          props: { ...cur.props, name: title },
          meta: {
            ...cur.meta,
            paseo: { ...cur.meta?.paseo, syncedName: existing ? cur.meta?.paseo?.syncedName : title, autoName: existing ? cur.meta?.paseo?.autoName : named.auto ? title : undefined, ...(cloud ? { cloud: true, cloudProvider: cloud } : {}), request: undefined, error: undefined, relink: undefined, agentId, workspaceId: workspace, mode: cur.meta?.paseo?.mode ?? "live", boundAt: Date.now() },
          },
        });
      const doc = ops.get("document:document");
      // Legacy key, used only when workspacePerBoard is off.
      if (startup.context === "repo" && !this.cfg.workspacePerBoard && doc && workspace && !doc.meta?.paseoWorkspaceId) ops.put({ ...doc, meta: { ...doc.meta, paseoWorkspaceId: workspace } });
    });
    this.autoPinTranscript(room, frameId, agentId);
    room.save();
    this.applyStatusLegacy(b, status === "missing" ? "error" : status);
  }

  // Legacy path: a canvas wrote request {kind:"link"} into a frame (old tabs; the
  // current canvas calls the import route instead).
  private async fulfilLink(api: PaseoApi, room: BoardRoom, frameId: string, agentId: string): Promise<void> {
    const snap = await api.agents.ref(agentId).refresh();
    if(this.stopped||room.closed)return;
    if (!snap) throw new Error(`agent ${agentId} not found`);
    const intent=room.records.get(frameId)?.meta?.paseo?.request;
    if(intent?.kind!=='link'||intent.agentId!==agentId)return;
    if(statusOf(snap.agent)==='archived') throw httpError(409,'archived conversation; restore it in Paseo before linking');
    const agent = snap.agent as { title?: string | null; labels?: Record<string, string>; workspaceId?: string | null };
    const status = statusOf(snap.agent);
    this.linkSync(room, frameId, { id: agentId, title: agent.title ?? null, workspaceId: agent.workspaceId ?? null, status: status === "missing" ? "error" : status, labels: agent.labels });
    this.reserved.delete(agentId);
  }

  // Bind a frame to an existing conversation. Synchronous from the checks to the
  // write, so two imports racing for one agent cannot both bind it (one frame per
  // agent, one agent per frame). Labels are updated afterwards. No prompt is sent:
  // the agent hears about the board with its first delta (see flush).
  linkSync(
    room: BoardRoom,
    frameId: string,
    agent: { id: string; title: string | null; workspaceId: string | null; status: FrameStatus; labels?: Record<string, string> | null; host?: string | null },
    autoName?: string,
  ): Binding {
    const frame = room.records.get(frameId);
    if (!frame || frame.type !== "frame") throw httpError(404, `frame ${frameId} is not on board ${room.id}`);
    const other = this.boundRef(agent.id);
    if (other && (other.boardId !== room.id || other.frameId !== frameId))
      throw httpError(409, `that conversation is already on board ${other.boardId} (frame ${other.frameId})`);
    const cur = frame.meta?.paseo as FramePaseoMeta | undefined;
    if (cur?.agentId && cur.agentId !== agent.id) throw httpError(409, "this frame is already bound to another conversation; draw a new frame");
    const b = this.bind(room.id, frameId, agent.id, agent.status, agent.host ?? null);
    b.introPending = true;
    room.write({ kind: "server", reason: "link" }, (ops) => {
      const f = ops.get(frameId);
      if (!f) return;
      ops.put({
        ...f,
        // A placeholder frame ("New agent") takes the conversation's own title.
        props: { ...f.props, name: (isGenericName(f.props.name) ? "" : f.props.name) || cleanName(agent.title) || f.props.name || agent.id.slice(0, 8), color: this.frameColor(b) },
        meta: {
          ...f.meta,
          paseo: {
            ...f.meta?.paseo,
            ...(autoName ? { autoName } : {}),
            request: undefined,
            remoteStart: undefined,
            error: undefined,
            relink: undefined,
            agentId: agent.id,
            workspaceId: agent.workspaceId ?? undefined,
            status: b.status,
            subagents: b.subagents || undefined,
            mode: f.meta?.paseo?.mode ?? "live",
            boundAt: Date.now(),
            linked: true,
            introducedAt: undefined,
            introPending: true,
            host: agent.host ?? undefined,
            lastReceipt: undefined,
          },
        },
      });
    });
    this.autoPinTranscript(room, frameId, agent.id);
    this.log(`linked ${room.id}/${frameId} → existing agent ${agent.host ? `${agent.host}/` : ""}${agent.id} (${b.status})`);
    // Tell the conversation where it is now, at its next idle moment: what the board is,
    // the frame (with what it already holds), how to read and write it, and that it may
    // prepare the space (importIntro).
    // Another Mac's agent: its first af-network read decides (onRemoteStatus); the picker's
    // status may be a minute old.
    if (agent.host) {
      b.status = "requested";
      this.remote?.watchStatus(agent.host, agent.id);
    } else queueMicrotask(() => void this.flush(b, false));
    if (!agent.host)
      void this.bridge
        .updateAgent(agent.id, { labels: { ...(agent.labels ?? {}), board: room.id, frame: frameId } })
        .catch((e) => this.log(`label update failed: ${(e as Error).message}`));
    return b;
  }

  private autoPinTranscript(room: BoardRoom, frameId: string, agentId: string): void {
    try {
      pinTranscriptCard(room, frameId, agentId, "compact", { kind: "server", reason: "auto-pin-transcript" }, { author: { kind: "agent", agentId } }, { grow: !this.layoutLocked(room.id) });
    } catch (error) {
      // A layout lock or neighbouring frame can prevent safe growth. The binding
      // still succeeds; do not cover human content or fail an already-created agent.
      this.log(`could not auto-pin ${agentId} in ${room.id}/${frameId}: ${(error as Error).message}`);
    }
  }

  // --- restart with board tools ------------------------------------------------------

  private readonly restarting = new Map<string, Promise<RestartResult>>();

  // A linked conversation cannot gain MCP tools mid-session (Paseo 0.11). Start a fresh
  // agent in the same workspace with the board tools and a handoff, then re-bind the
  // frame to it. The old agent is left as it is (running or not) unless archiveOld.
  // One restart per frame at a time; a second call joins the first.
  restartWithTools(room: BoardRoom, frameId: string, opts: { archiveOld?: boolean }): Promise<RestartResult> {
    const k = key(room.id, frameId);
    const pending = this.restarting.get(k);
    if (pending) return pending;
    const p = this.doRestart(room, frameId, opts).finally(() => this.restarting.delete(k));
    this.restarting.set(k, p);
    return p;
  }

  private async doRestart(room: BoardRoom, frameId: string, opts: { archiveOld?: boolean }): Promise<RestartResult> {
    const frame = room.records.get(frameId);
    const p = frame?.meta?.paseo as FramePaseoMeta | undefined;
    const old = this.bindingFor(room.id, frameId);
    if (!frame || frame.type !== "frame") throw httpError(404, `frame ${frameId} is not on board ${room.id}`);
    if (!p?.agentId || !old) throw httpError(409, "this frame is not bound to a conversation");
    // Only imported (linked) conversations lack the tools; this also makes a repeated
    // restart (second tab, retry after success) a no-op instead of a third agent.
    if (!p.linked) throw httpError(409, "this frame's agent already has the board tools");
    if (old.host) throw httpError(409, `this conversation runs on ${old.host}; restarting it with board tools is only possible for this machine's agents`);
    if (!this.bridge.api) throw httpError(503, "Paseo API not connected yet");
    const api = await this.bridge.ready;
    const oldId = old.agentId;
    const snap = await api.agents
      .ref(oldId)
      .refresh()
      .catch(() => null);
    if (!snap) throw httpError(404, `agent ${oldId} not found in Paseo`);
    // biome-ignore lint/suspicious/noExplicitAny: agent snapshot payload.
    const a = snap.agent as any;
    if (this.bindingFor(room.id, frameId)?.agentId !== oldId) throw httpError(409, "the frame was re-bound while restarting; try again");
    // Mid-turn, the handoff would carry a half-written reply and the answer would be lost
    // from the board (the card follows the new agent).
    if (statusOf(a) === "running" || statusOf(a) === "needs-permission") throw httpError(409, "the conversation is working; stop it (or let it finish) first, then restart");
    const provider = a.model ? `${a.provider}/${a.model}` : String(a.provider);
    // Same session mode as the conversation it replaces, else the board default.
    const modeId: string | undefined = a.currentModeId || this.modeFor(provider);
    const last = await this.lastAssistantText(api, oldId);
    // The handoff read can take seconds. Do not revoke tools if another turn
    // started while that read was pending, or if the frame changed meanwhile.
    const latest = await api.agents.ref(oldId).refresh();
    if(this.bindingFor(room.id,frameId)!==old || !latest || statusOf(latest.agent)!=='idle')
      throw httpError(409,"The conversation changed or started working during handoff; let it finish before restarting");
    const newId = randomUUID();
    const title = ((isGenericName(frame.props.name) ? "" : frame.props.name?.trim()) || a.title || frame.props.name?.trim() || `Board ${room.id} frame`).slice(0, 80);
    const carried = old.queued.splice(0);
    const prevMeta = JSON.parse(JSON.stringify(p)) as FramePaseoMeta;
    const prevColor = frame.props.color;
    // Re-bind first: the frame token names the agent, so the new agent's first tool
    // call must find itself in the frame. The old agent stays reserved to this frame
    // (no import can take it) until the restart settles.
    this.reserved.set(oldId, { boardId: room.id, frameId });
    const nb = this.bind(room.id, frameId, newId, "requested");
    for (const [id, t] of old.touched) nb.touched.set(id, t);
    for (const [id,t] of old.pendingText) nb.pendingText.set(id,t);
    old.pendingText.clear();
    nb.frameBefore = old.frameBefore;
    nb.humanName = old.humanName;
    old.touched.clear();
    // Edits made just before the restart still settle (as deltas to the new agent).
    if (nb.touched.size || nb.frameBefore) this.arm(nb, { kind: "server", reason: "restart" });
    this.writeFrameMeta(nb, {
      agentId: newId,
      previousAgentId: oldId,
      linked: undefined,
      introducedAt: undefined,
      introPending: undefined,
      boundAt: Date.now(),
      status: "requested",
      queue: [],
      pendingDeltas: 0,
      restart: { from: oldId, at: Date.now(), prev: { ...prevMeta, queue: carried, pendingDeltas: carried.length } },
    } as never);
    room.write({ kind: "server", reason: "restart-cards" }, ops => retargetTranscripts(room, ops, frameId, oldId, newId));
    const prompt = this.handoffPrompt(room, frameId, { title: a.title ?? title, id: oldId }, last, carried);
    let workspaceId: string | undefined = a.workspaceId ?? undefined;
    try {
      const options = {
        agentId: newId,
        config: {
          provider,
          ...(modeId ? { modeId } : {}),
          mcpServers: { board: this.mcpServerFor(room.id, frameId, newId) },
          toolPolicy: { preapproved: BOARD_TOOLS.map((tool) => ({ kind: "mcp" as const, server: "board", tool })) },
        },
        title,
        prompt,
        labels: { board: room.id, frame: frameId, "board-restarted-from": oldId },
        env: this.agentEnv(room.id, frameId, newId),
      };
      const handle = workspaceId ? await api.workspaces.ref(workspaceId).agents.create(options) : await api.agents.create({ ...options, cwd: a.cwd ?? this.cfg.defaultCwd });
      if (handle.id !== newId) throw new Error(`daemon assigned ${handle.id}, expected ${newId}`);
      workspaceId = handle.workspaceId ?? workspaceId;
    } catch (e) {
      // Put the old binding back; nothing is lost (edits made meanwhile come along).
      this.log(`restart of ${room.id}/${frameId} failed, keeping ${oldId}: ${(e as Error).message}`);
      this.reserved.delete(oldId);
      if (!this.current(nb) || !room.records.get(frameId)) {
        if (this.current(nb)) this.release(nb, 'deleted');
        for (const id of [oldId,newId]) void this.bridge.updateAgent(id, {labels:{board:'',frame:''}}).catch(()=>undefined);
        throw httpError(409, 'frame was deleted or rebound during failed restart; binding was not restored');
      }
      const back = this.bind(room.id, frameId, oldId, old.status);
      back.queued = [...carried, ...nb.queued];
      for (const [id, t] of nb.touched) back.touched.set(id, t);
      for (const [id,t] of nb.pendingText) back.pendingText.set(id,t);
      back.frameBefore = nb.frameBefore;
      if (nb.timer) clearTimeout(nb.timer);
      nb.timer = null;
      if (back.touched.size || back.frameBefore) this.arm(back, { kind: "server", reason: "restart-revert" });
      const restore: Partial<FramePaseoMeta> = {
        agentId: oldId,
        linked: prevMeta.linked,
        introducedAt: prevMeta.introducedAt,
        previousAgentId: prevMeta.previousAgentId,
        boundAt: prevMeta.boundAt,
        status: prevMeta.status,
        workspaceId: prevMeta.workspaceId,
        queue: back.queued,
        pendingDeltas: back.queued.length,
        restart: undefined,
        error: `Restart failed: ${(e as Error).message}`,
      };
      room.write({ kind: "server", reason: "restart-revert" }, (ops) => {
        retargetTranscripts(room, ops, frameId, newId, oldId);
        const cur = ops.get(frameId);
        if (cur) ops.put({ ...cur, props: { ...cur.props, color: prevColor }, meta: { ...cur.meta, paseo: { ...cur.meta?.paseo, ...restore } } });
      });
      throw httpError(502, `could not start the new agent: ${(e as Error).message}`);
    }
    this.reserved.delete(oldId);
    if (!this.current(nb) || room.records.get(frameId)?.meta?.paseo?.agentId !== newId) {
      if (this.current(nb)) this.release(nb, 'deleted');
      for (const id of [oldId,newId]) void this.bridge.updateAgent(id, { labels: { board: '', frame: '' } }).catch(() => undefined);
      throw httpError(409, 'frame was deleted or rebound during restart; new conversation remains released');
    }
    this.finishRestart(room, frameId, oldId, newId, workspaceId);
    this.applyStatusLegacy(nb, "running");
    this.log(`restarted ${room.id}/${frameId}: ${oldId} → ${newId} with board tools${opts.archiveOld ? " (archiving the old agent)" : ""}`);
    let archivedOld = false;
    if (opts.archiveOld) {
      archivedOld = await api.agents
        .ref(oldId)
        .archive()
        .then(() => true)
        .catch((e: Error) => {
          this.log(`archiving ${oldId} failed: ${e.message}`);
          return false;
        });
    }
    return { agentId: newId, oldAgentId: oldId, archivedOld, url: this.deepLink(room.id, frameId) };
  }

  // After the new agent exists: cards follow it, the marker goes, and the old agent's
  // labels stop pointing at the frame (its pill becomes "Add to board"). Also run by
  // resume() when the server stopped between the create and this step.
  private finishRestart(room: BoardRoom, frameId: string, oldId: string, newId: string, workspaceId?: string): void {
    room.write({ kind: "server", reason: "restart-cards" }, (ops) => {
      retargetTranscripts(room, ops, frameId, oldId, newId);
      const cur = ops.get(frameId);
      if (cur) ops.put({ ...cur, meta: { ...cur.meta, paseo: { ...cur.meta?.paseo, ...(workspaceId ? { workspaceId } : {}), restart: undefined } } });
    });
    this.autoPinTranscript(room, frameId, newId);
    room.save();
    if (!this.byAgent.has(oldId))
      void this.bridge.updateAgent(oldId, { labels: { board: "", frame: "", "board-restarted-as": newId } }).catch((e) => this.log(`label update failed: ${(e as Error).message}`));
  }

  private async lastAssistantText(api: PaseoApi, agentId: string): Promise<string | null> {
    const cached = this.transcripts?.summary(agentId);
    let rows = cached?.rows ?? [];
    try {
      const page = await api.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 60, projection: "projected" });
      rows = page.entries.map(simplifyItem).filter((r): r is NonNullable<typeof r> => !!r);
    } catch {
      /* fall back to the cache */
    }
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i].kind === "assistant" && !rows[i].ack && rows[i].text.trim()) return rows[i].text.trim();
    return null;
  }

  private handoffPrompt(room: BoardRoom, frameId: string, old: { title: string; id: string }, last: string | null, carried: string[]): string {
    const cap = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
    return [
      this.openingPrompt(room, frameId, undefined, null, frameCloudProvider(room.records.get(frameId)?.meta?.paseo)).replace(/^.*\n/, ""),
      "",
      `You are taking over this frame from an earlier conversation, ${quote(old.title)} (Paseo agent ${old.id}), which had no board tools. That conversation still exists; ${this.cfg.humanName} can open it in Paseo.`,
      last ? `Its last message was:\n<<<\n${cap(last, 6000)}\n>>>` : "It had not replied yet.",
      carried.length ? `Board changes it had not seen yet:\n${carried.join("\n\n")}` : "",
      "",
      "Start by calling board_read, then say in two or three sentences where things stand and what you will do next.",
    ]
      .filter((l) => l !== "")
      .join("\n");
  }

  // The one message an imported (or linked) conversation gets when it lands on a board:
  // what the board is, where its frame is and what it holds, what it can and cannot do
  // from this session, the HTTP recipe for its frame (scoped by its frame token, the same
  // routes the board MCP tools use), and an invitation to prepare the space. Kept short.
  importIntro(b: Binding): string {
    const room = this.host.get(b.boardId);
    const frame = room.records.get(b.frameId);
    const who = this.cfg.humanName;
    const t = frameToken(this.cfg.secret, b.boardId, b.frameId, b.agentId);
    // Agents on other machines reach the board over the tailnet; local ones on loopback.
    const origin = b.host ? this.cfg.publicBase : `http://127.0.0.1:${this.cfg.port}`;
    const base = `${origin}/api/agent/boards/${encodeURIComponent(b.boardId)}/frames/${encodeURIComponent(b.frameId)}`;
    const auth = `-H 'authorization: Bearer ${t}'`;
    const json = `${auth} -H 'content-type: application/json'`;
    const locks = this.lockSummary(b.boardId);
    return [
      `${who} put this conversation on his whiteboard: the frame ${quote(frame?.props?.name || b.frameId)} on board "${b.boardId}" (${this.deepLink(b.boardId, b.frameId)}). The frame is your space on a shared tldraw canvas; when ${who} edits inside it you get a message starting "Board delta".`,
      "",
      "Your frame now:",
      frameOutline(room.records, b.frameId, this.outlineCtx()),
      "",
      `What you can do: reply here as usual (${who} reads it in the board sidebar and on the card). This session has no board tools (tools attach only when a session starts; "Restart with board tools" on the frame toolbar starts a fresh agent that has them). You can still read and write your frame over HTTP; this token works only for this frame and this conversation:`,
      `- read: curl -s ${auth} '${base}/read?format=outline'`,
      `- add stickies: curl -s ${json} -d '{"shapes":[{"type":"note","text":"Plan: …"}]}' ${base}/write   (omit x/y to auto-place; one short headline per sticky)`,
      ...(b.host ? [] : [`- add a file (HTML report, PDF, image): curl -s ${json} -d '{"kind":"file","path":"/abs/path/report.html","title":"Report"}' ${base}/artifact`]),
      `- update / delete / layout / frame: POST the same JSON as the board tools to ${base}/update, /delete, /layout, /frame.`,
      ...(locks ? [locks] : []),
      "",
      BOARD_SYSTEM_PROMPT,
      "",
      `If it would help, prepare the space now: organise what is there or add one plan sticky. If you need nothing, say so in one line. Later deltas are context: answer one only when it asks you something or changes your task.`,
    ].join("\n");
  }

  linkIntro(b: Binding): string {
    const frame = this.host.get(b.boardId).records.get(b.frameId);
    const who = this.cfg.humanName;
    return `This conversation was added to the frame ${quote(frame?.props?.name || b.frameId)} on ${who}'s whiteboard (${this.deepLink(b.boardId, b.frameId)}); messages that start "Board delta" are ${who}'s edits in that frame. They are context: answer one only when it asks you something or changes your task.`;
  }

  // What a linked agent (no board_read) needs to know about a frame it was linked to: every shape's
  // text, in reading order, capped. Its own transcript card is left out.
  private frameContents(b: Binding, cap = 8000): string[] {
    const recs = this.host.get(b.boardId).records;
    const inside = [...recs.values()].filter(
      (r) => isShape(r) && ancestors(recs, r).includes(b.frameId) && !(r.type === "transcript" && r.props?.agentId === b.agentId) && r.type !== "draw" && r.type !== "highlight",
    );
    inside.sort((x, y) => absPos(recs, x).y - absPos(recs, y).y || absPos(recs, x).x - absPos(recs, y).x);
    const out: string[] = [];
    let used = 0;
    for (const r of inside) {
      const t = shapeText(r);
      const line = `- ${kindLabel(r)}${t ? ` ${quoteLines(t)}` : ""}`;
      if (used + line.length > cap) {
        out.push(`- … and ${inside.length - out.length} more shapes (open the board)`);
        break;
      }
      out.push(line);
      used += line.length;
    }
    return out;
  }

  frameOutline(boardId: string, frameId: string): string {
    return frameOutline(this.host.get(boardId).records, frameId, this.outlineCtx());
  }

  // query: only the frames whose name or agent title contains every term (outline.ts).
  boardOutline(boardId: string, frameId?: string, query?: string, pageId?: string): string {
    return boardOutline(this.host.get(boardId).records, frameId, { query, pageId, ctx: this.outlineCtx(), titleOf: (id) => this.paseoTitles.get(id) });
  }
}
