// The lifecycle of a frame's conversation as one state machine: how a frame gets, keeps
// and loses its agent. Six states:
// - unbound: no conversation. `relink` is the offer left on a pasted or restored copy.
// - starting: a create or link request is under way (queued, creating, opening), with the
//   retry count and the remote start intent when there is one.
// - bound: the frame has its agent. `activity` is what the agent is doing; "unknown"
//   means it has not been read yet (a remote link before its first poll), "missing" that
//   the daemon says there is no such agent. Both are re-read later.
// - restarting: "restart with board tools" is replacing agent `from` with agent `to`.
// - failed: a lifecycle failure with a stage and a reason. A failed turn is NOT this
//   state: it is bound with activity "turn-failed".
// - archived: the agent was archived in Paseo.
// The stored field names (meta.paseo: status, request, agentId, restart, ...) are unchanged.
// Nothing is migrated: lifecycleOf derives the state from those fields on every read, and
// legacyStatusOf gives the status value the old code stores for a state.
// transition(state, event) is the only place that says which moves exist. A move that is
// not in its table is rejected with a reason; "ignored" is an accepted no-op.
// Kept free of React, tldraw, server and canvas imports so both bundles can use it.

export type Activity = "idle" | "working" | "needs-permission" | "turn-failed" | "unknown" | "missing";
export type StartStep = "queued" | "creating" | "opening";
export type FailureStage = "start" | "remote-unresolved" | "restart";
// What a daemon read or hook says about an agent (server/paseo-bridge.ts statusOf).
export type AgentStatusName = "idle" | "running" | "needs-permission" | "error" | "missing" | "archived";
// The status values stored in meta.paseo.status today (server/records.ts FrameStatus).
export type LegacyStatus = "requested" | "idle" | "running" | "needs-permission" | "archived" | "error";

// The id of the board's own Paseo daemon when a host is named (remote hosts carry their
// af-network id).
export const LOCAL_HOST = "local";
// Retryable bind errors a start may collect before it becomes failed(start, retryable).
// With the 2 s doubling backoff capped at 30 s that is about 3 minutes.
export const BIND_RETRY_CAP = 8;

export interface StartRequest {
  kind: "create" | "link";
  host?: string;
  agentId?: string;
  requestedAt?: number;
  [key: string]: unknown;
}
export interface BindRetry {
  attempt: number;
  nextAt?: number;
  lastError?: string;
}
// server/remote-start.ts RemoteStartIntent, read structurally.
export interface RemoteIntent {
  phase?: string;
  host?: string;
  agentId?: string;
  key?: string;
  payload?: unknown;
  [key: string]: unknown;
}
export interface Relink {
  agentId: string;
  host?: string;
  [key: string]: unknown;
}
export interface StoredFailure {
  stage: FailureStage;
  reason: string;
  host?: string;
  retryable?: boolean;
}
// The meta.paseo fields the lifecycle is derived from (server/records.ts FramePaseoMeta).
// `failure` is new and server-owned; frames written before it exist are read by the
// legacy rules in lifecycleOf. `activity` is new and server-owned too: it is stored only
// as "missing", beside status "error", so a missing agent still shows red as it always
// did and is not mistaken for a failed turn.
export interface LifecycleMeta {
  status?: string;
  activity?: string | null;
  agentId?: string;
  host?: string;
  error?: string;
  request?: StartRequest | null;
  remoteStart?: RemoteIntent | null;
  bindRetry?: BindRetry | null;
  restart?: { from: string; at?: number; prev: Record<string, unknown> } | null;
  relink?: Relink | null;
  failure?: StoredFailure | null;
}

export type Unbound = { s: "unbound"; relink?: Relink };
export type Starting = { s: "starting"; step: StartStep; req: StartRequest; retry?: BindRetry; remote?: RemoteIntent; agentId?: string; host?: string };
export type Bound = { s: "bound"; agentId: string; host?: string; activity: Activity };
export type Restarting = { s: "restarting"; from: string; to: string; prev: Record<string, unknown> };
// req and remote are kept on a failure that can resume the same start: remote-unresolved
// (the same intent and key are rechecked) and a retryable start (HOST_UP, RETRY_START).
export type Failed = { s: "failed"; stage: FailureStage; reason: string; host?: string; retryable?: boolean; req?: StartRequest; remote?: RemoteIntent; agentId?: string };
export type Archived = { s: "archived"; agentId: string; host?: string };
export type Lifecycle = Unbound | Starting | Bound | Restarting | Failed | Archived;
// The frame was deleted: not a stored state, only the result of FRAME_DELETED.
export type Gone = { s: "gone" };
export const GONE: Gone = { s: "gone" };

export type LifecycleEvent =
  | { type: "REQUEST_CREATE"; req: StartRequest }
  | { type: "REQUEST_LINK"; req: StartRequest }
  // A bound frame was pasted or restored: the copy is unbound and offers a re-link.
  | { type: "COPIED"; relink: Relink }
  // The agent id was chosen and written before the create (prebind).
  | { type: "RESERVED"; agentId: string }
  | { type: "REMOTE_PHASE"; phase: string; remote?: RemoteIntent; agentId?: string; host?: string }
  | { type: "BIND_RETRYABLE"; lastError: string; nextAt?: number }
  | { type: "RETRY_DUE" }
  // activity wins when given (a remote create is known to be working); otherwise a remote
  // bind is "unknown" until its first read, and a local one follows the agent's status.
  | { type: "BIND_OK"; agentId: string; host?: string; status?: AgentStatusName; activity?: Activity }
  | { type: "BIND_FAILED"; reason: string }
  | { type: "AGENT_STATUS"; status: AgentStatusName }
  | { type: "AGENT_ARCHIVED" }
  | { type: "PROMPT_SENT" }
  | { type: "RESTART_BEGIN"; to: string; prev: Record<string, unknown> }
  | { type: "RESTART_DONE" }
  | { type: "RESTART_FAILED"; activity?: Activity }
  // The server stopped mid-restart. fromTaken: the old agent is bound elsewhere now.
  | { type: "RESTART_ABANDONED"; fromTaken: boolean; reason?: string }
  | { type: "RETRY_START"; req?: StartRequest }
  | { type: "RECHECK" }
  | { type: "DISCARD" }
  | { type: "UNBIND" }
  | { type: "FRAME_DELETED" }
  // A host went from not connected to connected. The caller debounces it (host up for
  // 30 s), limits resets per frame and adds jitter when it fans out; no timers here.
  | { type: "HOST_UP"; host: string };

export type LifecycleEventType = LifecycleEvent["type"];
export const LIFECYCLE_STATES = ["unbound", "starting", "bound", "restarting", "failed", "archived"] as const;
export const LIFECYCLE_EVENT_TYPES = [
  "REQUEST_CREATE", "REQUEST_LINK", "COPIED", "RESERVED", "REMOTE_PHASE", "BIND_RETRYABLE", "RETRY_DUE", "BIND_OK", "BIND_FAILED",
  "AGENT_STATUS", "AGENT_ARCHIVED", "PROMPT_SENT", "RESTART_BEGIN", "RESTART_DONE", "RESTART_FAILED", "RESTART_ABANDONED",
  "RETRY_START", "RECHECK", "DISCARD", "UNBIND", "FRAME_DELETED", "HOST_UP",
] as const satisfies readonly LifecycleEventType[];

export type TransitionResult =
  | { ok: true; next: Lifecycle | Gone; ignored?: false }
  | { ok: true; ignored: true; next: Lifecycle }
  | { ok: false; reason: string };

// A short code per state, for test tables and the parity report (server/lifecycle-parity.ts):
// U unbound · Ur unbound with a re-link offer · Sq/Sc/So starting (queued, creating, opening)
// Bi/Bw/Bp/Bf/Bu/Bm bound (idle, working, needs-permission, turn-failed, unknown, missing)
// R restarting
// Fs failed start · Fr failed start, retryable · Fu failed remote-unresolved · Fx failed restart
// A archived · G gone (frame deleted)
const ACTIVITY_CODE: Record<Activity, string> = { idle: "i", working: "w", "needs-permission": "p", "turn-failed": "f", unknown: "u", missing: "m" };
export function lifecycleCode(state: Lifecycle | Gone): string {
  switch (state.s) {
    case "gone":
      return "G";
    case "unbound":
      return state.relink ? "Ur" : "U";
    case "starting":
      return `S${state.step[0]}`;
    case "bound":
      return `B${ACTIVITY_CODE[state.activity]}`;
    case "restarting":
      return "R";
    case "failed":
      return state.stage === "start" ? (state.retryable ? "Fr" : "Fs") : state.stage === "remote-unresolved" ? "Fu" : "Fx";
    case "archived":
      return "A";
  }
}

// --- reading the stored fields -----------------------------------------------------------

export function activityOfStatus(status: string | null | undefined): Activity {
  if (status === "idle") return "idle";
  if (status === "running") return "working";
  if (status === "needs-permission") return "needs-permission";
  if (status === "error") return "turn-failed";
  // The daemon's answer for an agent it does not know.
  if (status === "missing") return "missing";
  // "requested" on a bound frame, or nothing: not read yet.
  return "unknown";
}

// The remote create went out (or may have): the intent cannot be dropped, only rechecked.
// The same test as the remote-start-error write in server/frame-watcher.ts.
export function remoteDiscardable(intent: RemoteIntent | null | undefined): boolean {
  return !intent || (intent.phase === "prepared" && !intent.payload);
}

function stepOf(remote: RemoteIntent | null | undefined, agentId: string | undefined): StartStep {
  const phase = remote?.phase;
  if (phase === "created" || phase === "sending" || phase === "complete") return "opening";
  if (phase === "prepared" || phase === "creating" || phase === "unknown" || agentId) return "creating";
  return "queued";
}

const hostOf = (req: StartRequest | null | undefined, fallback?: string): string | undefined => (typeof req?.host === "string" && req.host ? req.host : fallback);

// First matching rule wins.
export function lifecycleOf(meta: LifecycleMeta | null | undefined): Lifecycle {
  const p = meta;
  if (!p) return { s: "unbound" };
  const agentId = typeof p.agentId === "string" && p.agentId ? p.agentId : undefined;
  const req = p.request ?? undefined;
  const remote = p.remoteStart ?? undefined;
  const host = typeof p.host === "string" && p.host ? p.host : undefined;
  const carried = { ...(req ? { req } : {}), ...(remote ? { remote } : {}), ...(agentId ? { agentId } : {}) };
  // 1. The server-owned failure record.
  if (p.failure) {
    const f = p.failure;
    return { s: "failed", stage: f.stage, reason: f.reason, ...(f.host ? { host: f.host } : {}), ...(f.retryable ? { retryable: true } : {}), ...carried };
  }
  // 2. Legacy failures, written before `failure` existed (stored frames are never migrated).
  if (p.status === "error") {
    const reason = p.error || "start failed";
    // The restart marker was stranded: its old agent is bound elsewhere.
    if (p.restart) return { s: "failed", stage: "restart", reason: p.error || "restart never completed", ...(agentId ? { agentId } : {}) };
    // A remote start whose outcome is not known keeps its request and its intent (the
    // request is kept only when the intent cannot be discarded).
    if (req && remote) return { s: "failed", stage: "remote-unresolved", reason, ...(hostOf(req) ? { host: hostOf(req) } : {}), ...carried };
    // A start that stopped with its request kept and no remote intent: never parked, so a
    // new request is still accepted.
    if (req) return { s: "failed", stage: "start", reason, ...(hostOf(req) ? { host: hostOf(req) } : {}), req, ...(agentId ? { agentId } : {}) };
    // A failed start clears the request and, for a create, the agent id.
    if (!agentId) return { s: "failed", stage: "start", reason };
  }
  // 3. Nothing bound and nothing asked for.
  if (!agentId && !req) return p.relink ? { s: "unbound", relink: p.relink } : { s: "unbound" };
  // 4. A restart is creating the new agent.
  if (p.restart && agentId) return { s: "restarting", from: p.restart.from, to: agentId, prev: p.restart.prev ?? {} };
  // 5. Legacy: a remote start created its agent, the request is gone and the opener is not
  // acknowledged yet. shared/start-pending.ts calls this pending (never after an error), so
  // it is still starting; the request is rebuilt from the intent.
  if (!req && agentId && remote && remote.phase !== "complete" && p.status !== "error") {
    const h = (typeof remote.host === "string" && remote.host) || host;
    const rebuilt: StartRequest = { kind: "create", ...(h ? { host: h } : {}), ...(typeof remote.requestedAt === "number" ? { requestedAt: remote.requestedAt } : {}) };
    return { s: "starting", step: stepOf(remote, agentId), req: rebuilt, remote, agentId, ...(h ? { host: h } : {}) };
  }
  // 6. A create or link request is under way.
  if (req) {
    const h = hostOf(req);
    return { s: "starting", step: stepOf(remote, agentId), req, ...(p.bindRetry ? { retry: p.bindRetry } : {}), ...(remote ? { remote } : {}), ...(agentId ? { agentId } : {}), ...(h ? { host: h } : {}) };
  }
  // 7. Bound. (agentId is set here: rule 3 took the other case.)
  const id = agentId as string;
  if (p.status === "archived") return { s: "archived", agentId: id, ...(host ? { host } : {}) };
  // A missing agent is stored as status "error" with activity "missing"; without the field
  // an errored bound frame is a failed turn.
  const activity = p.status === "error" && p.activity === "missing" ? "missing" : activityOfStatus(p.status);
  return { s: "bound", agentId: id, ...(host ? { host } : {}), activity };
}

// The status the old code stores for a state. "requested" also stands for a bound agent
// that has not been read yet, and "error" for one the daemon calls missing.
export function legacyStatusOf(state: Lifecycle): LegacyStatus | undefined {
  switch (state.s) {
    case "unbound":
      return undefined;
    case "starting":
    case "restarting":
      return "requested";
    case "failed":
      return "error";
    case "archived":
      return "archived";
    case "bound":
      return state.activity === "idle" ? "idle" : state.activity === "working" ? "running" : state.activity === "needs-permission" ? "needs-permission" : state.activity === "turn-failed" || state.activity === "missing" ? "error" : "requested";
  }
}

// The `activity` field a state stores: "missing" for a bound agent the daemon does not know,
// nothing for every other state (a status write clears it).
export function storedActivityOf(state: Lifecycle): "missing" | undefined {
  return state.s === "bound" && state.activity === "missing" ? "missing" : undefined;
}

// The frame's tldraw colour: the one source for it. Matches STATUS_COLOR in
// server/records.ts; an idle agent whose subagents or cloud sessions still run is drawn
// as working (frameColor in server/frame-watcher.ts), and an unbound frame is black.
export const LEGACY_COLOUR: Record<LegacyStatus, string> = { requested: "violet", idle: "green", running: "blue", "needs-permission": "orange", archived: "grey", error: "red" };
export function colourOf(state: Lifecycle, extra: { subagents?: number; cloud?: number } = {}): string {
  const status = legacyStatusOf(state);
  if (!status) return "black";
  if (status === "idle" && ((extra.subagents ?? 0) > 0 || (extra.cloud ?? 0) > 0)) return LEGACY_COLOUR.running;
  return LEGACY_COLOUR[status];
}

// --- the transition table ----------------------------------------------------------------

type Handler<S extends Lifecycle> = (state: S, event: LifecycleEvent) => TransitionResult;
type Row<S extends Lifecycle> = Partial<Record<LifecycleEventType, Handler<S>>>;

const go = (next: Lifecycle | Gone): TransitionResult => ({ ok: true, next });
const ignore = (state: Lifecycle): TransitionResult => ({ ok: true, ignored: true, next: state });
const reject = (reason: string): TransitionResult => ({ ok: false, reason });
// Narrow an event inside a handler registered under its own type.
const as = <T extends LifecycleEventType>(event: LifecycleEvent, _type: T) => event as Extract<LifecycleEvent, { type: T }>;

function queued(req: StartRequest): Starting {
  const h = hostOf(req);
  return { s: "starting", step: "queued", req, ...(h ? { host: h } : {}) };
}
const request: Handler<Lifecycle> = (_state, event) => go(queued(as(event, "REQUEST_CREATE").req));
const unbind: Handler<Lifecycle> = () => go({ s: "unbound" });
const deleted: Handler<Lifecycle> = () => go(GONE);
const noop: Handler<Lifecycle> = (state) => ignore(state);

function agentStatus(state: Bound, status: AgentStatusName): TransitionResult {
  if (status === "archived") return go({ s: "archived", agentId: state.agentId, ...(state.host ? { host: state.host } : {}) });
  return go({ ...state, activity: activityOfStatus(status) });
}

const UNBOUND: Row<Unbound> = {
  REQUEST_CREATE: request,
  REQUEST_LINK: request,
  COPIED: (_state, event) => go({ s: "unbound", relink: as(event, "COPIED").relink }),
  FRAME_DELETED: deleted,
  HOST_UP: noop,
};

const STARTING: Row<Starting> = {
  // The request may change only while nothing was reserved for it.
  REQUEST_CREATE: (state, event) => (state.step === "queued" && !state.agentId ? request(state, event) : reject("a start is already under way for this frame")),
  REQUEST_LINK: (state, event) => (state.step === "queued" && !state.agentId ? request(state, event) : reject("a start is already under way for this frame")),
  RESERVED: (state, event) => {
    const { agentId } = as(event, "RESERVED");
    if (state.agentId) return state.agentId === agentId ? ignore(state) : reject(`this start already reserved agent ${state.agentId}`);
    return go({ ...state, step: state.step === "queued" ? "creating" : state.step, agentId });
  },
  REMOTE_PHASE: (state, event) => {
    const e = as(event, "REMOTE_PHASE");
    const remote: RemoteIntent = { ...(state.remote ?? {}), ...(e.remote ?? {}), phase: e.phase };
    const agentId = e.agentId ?? state.agentId;
    const host = e.host ?? state.host;
    return go({ ...state, step: stepOf(remote, agentId), remote, ...(agentId ? { agentId } : {}), ...(host ? { host } : {}) });
  },
  BIND_RETRYABLE: (state, event) => {
    const e = as(event, "BIND_RETRYABLE");
    const attempt = (state.retry?.attempt ?? 0) + 1;
    if (attempt > BIND_RETRY_CAP)
      return go({ s: "failed", stage: "start", reason: e.lastError, host: state.host ?? LOCAL_HOST, retryable: true, req: state.req, ...(state.remote ? { remote: state.remote } : {}), ...(state.agentId ? { agentId: state.agentId } : {}) });
    return go({ ...state, retry: { attempt, lastError: e.lastError, ...(e.nextAt !== undefined ? { nextAt: e.nextAt } : {}) } });
  },
  // The retry timer fired: the same start is tried again.
  RETRY_DUE: (state) => go(state),
  BIND_OK: (state, event) => {
    const e = as(event, "BIND_OK");
    const host = e.host ?? state.host;
    if (!e.activity && !host && e.status === "archived") return go({ s: "archived", agentId: e.agentId });
    const activity = e.activity ?? (host ? "unknown" : activityOfStatus(e.status));
    return go({ s: "bound", agentId: e.agentId, ...(host ? { host } : {}), activity });
  },
  BIND_FAILED: (state, event) => {
    const { reason } = as(event, "BIND_FAILED");
    // A remote create that may have gone out stays parked with its request and intent.
    if (state.req.kind === "create" && state.host && !remoteDiscardable(state.remote))
      return go({ s: "failed", stage: "remote-unresolved", reason, host: state.host, req: state.req, ...(state.remote ? { remote: state.remote } : {}), ...(state.agentId ? { agentId: state.agentId } : {}) });
    // The request is cleared; a link keeps no agent either (it was never bound).
    return go({ s: "failed", stage: "start", reason, ...(state.host ? { host: state.host } : {}) });
  },
  // Hooks can arrive for a prebound or opening agent before BIND_OK.
  AGENT_STATUS: noop,
  AGENT_ARCHIVED: noop,
  FRAME_DELETED: deleted,
  HOST_UP: noop,
};

const BOUND: Row<Bound> = {
  AGENT_STATUS: (state, event) => agentStatus(state, as(event, "AGENT_STATUS").status),
  AGENT_ARCHIVED: (state) => agentStatus(state, "archived"),
  // The board's own send shows the agent working before its hook arrives. A missing
  // agent has nothing to send to.
  PROMPT_SENT: (state) => (state.activity === "working" || state.activity === "needs-permission" || state.activity === "missing" ? ignore(state) : go({ ...state, activity: "working" })),
  RESTART_BEGIN: (state, event) => {
    const e = as(event, "RESTART_BEGIN");
    if (state.activity !== "idle") return reject("the conversation is not idle; stop it (or let it finish) first, then restart");
    return go({ s: "restarting", from: state.agentId, to: e.to, prev: e.prev });
  },
  UNBIND: unbind,
  FRAME_DELETED: deleted,
  HOST_UP: noop,
};

const RESTARTING: Row<Restarting> = {
  RESTART_DONE: (state) => go({ s: "bound", agentId: state.to, activity: "working" }),
  RESTART_FAILED: (state, event) => go({ s: "bound", agentId: state.from, activity: as(event, "RESTART_FAILED").activity ?? previousActivity(state) }),
  RESTART_ABANDONED: (state, event) => {
    const e = as(event, "RESTART_ABANDONED");
    if (e.fromTaken) return go({ s: "failed", stage: "restart", reason: e.reason ?? `restart never completed and ${state.from} is bound elsewhere now`, agentId: state.to });
    return go({ s: "bound", agentId: state.from, activity: "idle" });
  },
  AGENT_STATUS: noop,
  AGENT_ARCHIVED: noop,
  FRAME_DELETED: deleted,
  HOST_UP: noop,
};

function previousActivity(state: Restarting): Activity {
  const a = state.prev.status === "error" && state.prev.activity === "missing" ? "missing" : activityOfStatus(typeof state.prev.status === "string" ? state.prev.status : undefined);
  return a === "unknown" ? "idle" : a;
}

// The same start again after a failure that kept its request: the reserved agent id and
// the remote intent are kept, so a create that may have gone out is not made twice. The
// retry count starts over.
function resume(state: Failed, req: StartRequest): Starting {
  const host = state.host && state.host !== LOCAL_HOST ? state.host : hostOf(req);
  return { s: "starting", step: stepOf(state.remote, state.agentId), req, ...(state.remote ? { remote: state.remote } : {}), ...(state.agentId ? { agentId: state.agentId } : {}), ...(host ? { host } : {}) };
}

// A parked remote start accepts no new request: its idempotency key must be resolved first.
const parked = (state: Failed): boolean => state.stage === "remote-unresolved";
const failedRequest: Handler<Failed> = (state, event) => (parked(state) ? reject("a remote start is unresolved; recheck or discard it before starting again") : request(state, event));

const FAILED: Row<Failed> = {
  REQUEST_CREATE: failedRequest,
  REQUEST_LINK: failedRequest,
  RETRY_START: (state, event) => {
    if (parked(state)) return reject("a remote start is unresolved; recheck or discard it");
    const fresh = as(event, "RETRY_START").req;
    if (fresh) return go(queued(fresh));
    return state.req ? go(resume(state, state.req)) : reject("there is no request to retry");
  },
  RECHECK: (state) => {
    if (!parked(state) || !state.req) return reject("only an unresolved remote start can be rechecked");
    return go(resume(state, state.req));
  },
  DISCARD: unbind,
  UNBIND: unbind,
  FRAME_DELETED: deleted,
  AGENT_STATUS: noop,
  AGENT_ARCHIVED: noop,
  // Only a start that stopped at the retry cap, and only for its own host.
  HOST_UP: (state, event) => {
    const { host } = as(event, "HOST_UP");
    if (state.stage !== "start" || !state.retryable || !state.req || (state.host ?? LOCAL_HOST) !== host) return ignore(state);
    return go(resume(state, state.req));
  },
};

const ARCHIVED: Row<Archived> = {
  // The agent was unarchived in Paseo.
  AGENT_STATUS: (state, event) => {
    const { status } = as(event, "AGENT_STATUS");
    if (status !== "idle" && status !== "running" && status !== "needs-permission") return ignore(state);
    return go({ s: "bound", agentId: state.agentId, ...(state.host ? { host: state.host } : {}), activity: activityOfStatus(status) });
  },
  AGENT_ARCHIVED: noop,
  UNBIND: unbind,
  FRAME_DELETED: deleted,
  HOST_UP: noop,
};

const TABLE: { [S in Lifecycle as S["s"]]: Row<S> } = {
  unbound: UNBOUND,
  starting: STARTING,
  bound: BOUND,
  restarting: RESTARTING,
  failed: FAILED,
  archived: ARCHIVED,
};

// The only place that says which moves exist. Pure: the caller stores `next` and does the
// side effects. Anything not in the table is rejected.
export function transition(state: Lifecycle, event: LifecycleEvent): TransitionResult {
  const row = TABLE[state.s] as Row<Lifecycle>;
  const handler = row[event.type];
  if (!handler) return reject(`${event.type} is not a move from ${state.s}`);
  return handler(state, event);
}
