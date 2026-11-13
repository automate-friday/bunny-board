// Shadow parity check for the frame lifecycle machine (shared/frame-lifecycle.ts).
// The status writers in frame-watcher.ts still decide everything; this only watches. For
// every write to a frame record it derives the lifecycle state before and after and asks
// three questions:
// - status: does the state say the status that is stored (legacyStatusOf)?
// - colour: does the state say the colour the frame has (colourOf)?
// - move: when the state changed, is there an event in the transition table that makes
//   that move (explainMove)?
// A disagreement the new machine causes on purpose carries a tag (EXPECTED below); anything
// else is "untagged" and is what a person should look at. GET /api/ui/debug/lifecycle-parity
// returns the report. Nothing here writes to a room, and no entry point can throw.
// The report holds state codes, board and frame ids, write reasons, status and colour
// names only: never prompts, error text, agent ids or request bodies.

import {
  colourOf,
  GONE,
  LEGACY_COLOUR,
  legacyStatusOf,
  lifecycleCode,
  lifecycleOf,
  LOCAL_HOST,
  transition,
  type AgentStatusName,
  type Gone,
  type Lifecycle,
  type LifecycleEvent,
  type LifecycleEventType,
  type LifecycleMeta,
  type StartRequest,
} from "../shared/frame-lifecycle";

export const PARITY_VERSION = "lifecycle-parity/1";
const RECENT_MAX = 100;
const DISTINCT_MAX = 500;
const SCAN_UNTAGGED_MAX = 100;

// Differences the new machine makes on purpose, or that today's writers are known to
// produce. Each has one predicate in tagStatus / tagColour / tagMove.
export const EXPECTED = {
  // frame-start.ts and frame-fork.ts create a starting frame light-blue; colourOf says violet.
  createdLightBlue: "a-created-light-blue",
  // A hook for a prebound, opening or restarting agent sets its status (and colour) while
  // the request or the restart marker is still there; the machine ignores it until BIND_OK.
  hookDuringStart: "e-hook-during-start",
  // A write that changed the status or the state without painting the frame (link-intent,
  // prebind, the restart's meta write): the colour is the one the frame had before.
  statusWithoutColour: "f-status-without-colour",
  // An idle frame drawn working (or not) from the live subagent or cloud counts.
  workingRepaint: "g-working-repaint",
  // A person pasted or duplicated a frame that carries a binding or a request...
  copiedFrame: "copied-frame",
  // ...and the protect-binding write that strips or reverts it.
  protectRevert: "protect-binding-revert",
  // The server wrote a frame back with its binding (archive or snapshot restore).
  restoredFrame: "restored-frame",
  // AGENT_STATUS overwrote a failed state: the old status writer still handles failed
  // frames (a parked remote start a poll reports as running turns blue). Legacy, until the
  // failed states move onto the machine with Recheck and Discard.
  statusOverFailed: "i-agent-status-over-failed",
  // finishRestart clears the marker with status still "requested"; applyStatus follows.
  restartFinish: "two-write-restart-finish",
} as const;

// Old behaviours the stored fields cannot show, counted where they happen (note()).
export const SEEN = {
  // The old applyStatus stores a missing agent as a plain error (a failed turn, read back);
  // the machine stores bound/missing (status error with activity "missing").
  missingAsError: "b-missing-as-error",
  // A failed delta send sets the frame's status to error; the machine leaves it alone.
  sendFailureAsError: "c-send-failure-as-error",
  // The remote intent's phase moved on a frame that is already bound.
  remotePhaseOnBound: "remote-phase-on-bound",
  // An agent status, a sent prompt or a repaint on a failed frame still goes through the
  // old writer, which overwrites the failure (a parked remote start a poll reports as
  // running turns blue). It moves onto the machine with Recheck and Discard.
  legacyStatusOnFailed: "legacy-status-on-failed",
} as const;

type Kind = "status" | "colour" | "move";
// biome-ignore lint/suspicious/noExplicitAny: frame records arrive unvalidated here on purpose.
type Loose = any;

export interface ParityEntry {
  at: number;
  boardId: string;
  frameId: string;
  reason: string;
  kind: Kind;
  beforeCode: string;
  afterCode: string;
  storedStatus: string | null;
  storedColour: string | null;
  expected: string;
}

interface Disagreement {
  kind: Kind;
  stored: string | null;
  expected: string;
}

// Only short enum-like strings leave this module; anything else is "(other)".
const word = (v: unknown): string | null => (v === undefined || v === null ? null : typeof v === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(v) ? v : "(other)");
const ident = (v: unknown): string => (typeof v === "string" && /^[\w:.-]{1,100}$/.test(v) ? v : "(other)");

const paseoOf = (rec: Loose): LifecycleMeta | undefined => (rec && typeof rec === "object" && rec.meta && typeof rec.meta === "object" && rec.meta.paseo && typeof rec.meta.paseo === "object" ? (rec.meta.paseo as LifecycleMeta) : undefined);
const colourOfRecord = (rec: Loose): unknown => (rec && typeof rec === "object" && rec.props && typeof rec.props === "object" ? rec.props.color : undefined);
const count = (rec: Loose, key: "subagents" | "cloudSessions"): number => {
  const v = (paseoOf(rec) as Loose)?.[key];
  return typeof v === "number" && v > 0 ? v : 0;
};

// The agent a state is about, where a swap would be a real move.
function agentOf(state: Lifecycle | Gone): string | undefined {
  if (state.s === "bound" || state.s === "archived") return state.agentId;
  if (state.s === "restarting") return state.to;
  if (state.s === "starting") return state.agentId;
  return undefined;
}

const AGENT_STATUSES: AgentStatusName[] = ["idle", "running", "needs-permission", "error", "missing", "archived"];

// Events that could have produced `to`, built from its own fields.
function candidates(to: Lifecycle | Gone): LifecycleEvent[] {
  if (to.s === "gone") return [{ type: "FRAME_DELETED" }];
  switch (to.s) {
    case "unbound":
      return [{ type: "UNBIND" }, { type: "DISCARD" }, ...(to.relink ? [{ type: "COPIED" as const, relink: to.relink }] : [])];
    case "starting":
      return [
        requestEvent(to.req),
        ...(to.agentId ? [{ type: "RESERVED" as const, agentId: to.agentId }] : []),
        ...(to.remote ? [{ type: "REMOTE_PHASE" as const, phase: String(to.remote.phase ?? ""), remote: to.remote, agentId: to.agentId, host: to.host }] : []),
        { type: "BIND_RETRYABLE", lastError: "" },
        { type: "RETRY_START" },
        { type: "RETRY_START", req: to.req },
        { type: "RECHECK" },
        { type: "HOST_UP", host: to.host ?? LOCAL_HOST },
      ];
    case "bound":
      return [
        { type: "BIND_OK", agentId: to.agentId, host: to.host, activity: to.activity },
        ...AGENT_STATUSES.map((status) => ({ type: "AGENT_STATUS" as const, status })),
        { type: "PROMPT_SENT" },
        { type: "RESTART_DONE" },
        { type: "RESTART_FAILED", activity: to.activity },
        { type: "RESTART_ABANDONED", fromTaken: false },
      ];
    case "restarting":
      return [{ type: "RESTART_BEGIN", to: to.to, prev: to.prev }];
    case "failed":
      return [{ type: "BIND_FAILED", reason: "" }, { type: "BIND_RETRYABLE", lastError: "" }, { type: "RESTART_ABANDONED", fromTaken: true }];
    case "archived":
      return [{ type: "AGENT_STATUS", status: "archived" }, { type: "AGENT_ARCHIVED" }, { type: "BIND_OK", agentId: to.agentId, status: "archived" }];
  }
}

function requestEvent(req: StartRequest): LifecycleEvent {
  return req.kind === "link" ? { type: "REQUEST_LINK", req } : { type: "REQUEST_CREATE", req };
}

function reaches(from: Lifecycle, event: LifecycleEvent, to: Lifecycle | Gone): boolean {
  const r = transition(from, event);
  if (!r.ok || r.ignored) return false;
  if (lifecycleCode(r.next) !== lifecycleCode(to)) return false;
  const want = agentOf(to);
  return want === undefined || agentOf(r.next) === want;
}

// Which event (or, for two known single writes, which pair) makes the move from `from` to
// `to`; null when the transition table has no such move. The pairs are writes that do two
// steps at once today:
// - video-workflow.ts writes the request and the reserved agent id together
//   (REQUEST_CREATE + RESERVED);
// - linkSync binds a frame that never held a request, as the board importer does
//   (REQUEST_LINK + BIND_OK).
// Both are server writes: a person's client never does two steps in one push (pairs: false).
export function explainMove(from: Lifecycle, to: Lifecycle | Gone, pairs = true): LifecycleEventType[] | null {
  for (const e of candidates(to)) if (reaches(from, e, to)) return [e.type];
  if (!pairs || from.s !== "unbound" || to.s === "gone") return null;
  const first: LifecycleEvent | null =
    to.s === "starting" && to.agentId ? requestEvent(to.req) : to.s === "bound" || to.s === "archived" ? { type: "REQUEST_LINK", req: { kind: "link", agentId: to.agentId } } : null;
  if (!first) return null;
  const mid = transition(from, first);
  if (!mid.ok || mid.ignored || mid.next.s === "gone") return null;
  for (const e of candidates(to)) if ((e.type === "RESERVED" || e.type === "BIND_OK") && reaches(mid.next, e, to)) return [first.type, e.type];
  return null;
}

const STATUS_COLOUR: Record<string, string> = LEGACY_COLOUR;

interface Derived {
  state: Lifecycle | Gone;
  code: string;
  storedStatus: unknown;
  storedColour: unknown;
  status: Disagreement | null;
  colour: Disagreement | null;
}

// What the machine says about one stored frame record (null: the frame does not exist).
function derive(rec: Loose, cameFromBound: boolean): Derived {
  if (!rec) return { state: GONE, code: "G", storedStatus: undefined, storedColour: undefined, status: null, colour: null };
  const meta = paseoOf(rec);
  const state = lifecycleOf(meta);
  const storedStatus = (meta as Loose)?.status;
  const storedColour = colourOfRecord(rec);
  const wantStatus = legacyStatusOf(state);
  const status: Disagreement | null = (storedStatus ?? undefined) === wantStatus ? null : { kind: "status", stored: word(storedStatus), expected: wantStatus ?? "(none)" };
  // An unbound frame keeps whatever colour a person gave it; only the unbind itself paints.
  const wantColour = colourOf(state, { subagents: count(rec, "subagents"), cloud: count(rec, "cloudSessions") });
  const colour: Disagreement | null = (state.s === "unbound" && !cameFromBound) || storedColour === wantColour ? null : { kind: "colour", stored: word(storedColour), expected: wantColour };
  return { state, code: lifecycleCode(state), storedStatus, storedColour, status, colour };
}

const sameDisagreement = (a: Disagreement | null, b: Disagreement | null): boolean => !!a && !!b && a.stored === b.stored && a.expected === b.expected;

// (e): the request or the restart marker is still stored, and a hook wrote a real status.
function hookDuringStart(after: Loose, d: Derived): boolean {
  if (d.state.s !== "starting" && d.state.s !== "restarting") return false;
  if (d.state.s === "starting" && !paseoOf(after)?.request) return false;
  return typeof d.storedStatus === "string" && ["idle", "running", "needs-permission", "archived"].includes(d.storedStatus);
}

function tagStatus(after: Loose, d: Derived): string | null {
  return hookDuringStart(after, d) ? EXPECTED.hookDuringStart : null;
}

function tagColour(before: Loose, after: Loose, d: Derived): string | null {
  const s = d.state;
  // (a) a starting frame that is light-blue: frame-start.ts / frame-fork.ts made it so.
  if (s.s === "starting" && d.storedColour === "light-blue") return EXPECTED.createdLightBlue;
  // (e) the colour is the one the hook's status has.
  if (hookDuringStart(after, d) && d.storedColour === STATUS_COLOUR[d.storedStatus as string]) return EXPECTED.hookDuringStart;
  // (g) an idle frame painted from live subagent or cloud counts that are not (or no
  // longer) in the stored meta.
  if (s.s === "bound" && s.activity === "idle" && (d.storedColour === "blue" || d.storedColour === "green")) return EXPECTED.workingRepaint;
  // (f) this write changed the status or the state and left the colour as it was.
  if (before && colourOfRecord(before) === d.storedColour) return EXPECTED.statusWithoutColour;
  return null;
}

function tagMove(before: Loose, reason: string, from: Lifecycle, to: Lifecycle | Gone): string | null {
  if (reason === "protect-binding") return EXPECTED.protectRevert;
  if (!before && to.s !== "gone") return reason === "human" ? EXPECTED.copiedFrame : reason === "agent" ? null : EXPECTED.restoredFrame;
  if (from.s === "restarting" && to.s === "bound" && to.activity === "unknown" && to.agentId === from.to) return EXPECTED.restartFinish;
  return null;
}

// At rest there is no "this write": a stale colour is tagged only for the two shapes that
// are known to stay (a light-blue start, a "requested" frame nothing painted).
function tagAtRest(rec: Loose, d: Derived, kind: Kind): string | null {
  if (kind === "status") return tagStatus(rec, d);
  const s = d.state;
  if (s.s === "starting" && d.storedColour === "light-blue") return EXPECTED.createdLightBlue;
  if (hookDuringStart(rec, d) && d.storedColour === STATUS_COLOUR[d.storedStatus as string]) return EXPECTED.hookDuringStart;
  if (s.s === "bound" && s.activity === "idle" && (d.storedColour === "blue" || d.storedColour === "green")) return EXPECTED.workingRepaint;
  if (d.storedStatus === "requested" && d.storedColour !== "violet") return EXPECTED.statusWithoutColour;
  return null;
}

const bump = (map: Map<string, number>, key: string, by = 1): void => void map.set(key, (map.get(key) ?? 0) + by);
const toObject = (map: Map<string, number>): Record<string, number> => Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]));

export interface ScanBoard {
  id: string;
  records: Iterable<unknown>;
}
export type ScanEntry = Omit<ParityEntry, "at" | "reason" | "beforeCode">;
export interface ParityScan {
  boards: number;
  frames: number;
  states: Record<string, number>;
  expected: Record<string, number>;
  untaggedTotal: number;
  untagged: ScanEntry[];
}

export interface ParityObservation {
  boardId: string;
  frameId: string;
  before: unknown;
  after: unknown;
  reason: string;
}

export class LifecycleParity {
  private readonly since = Date.now();
  private writes = 0;
  private created = 0;
  private deleted = 0;
  private moves = 0;
  private noops = 0;
  private persisting = 0;
  private errors = 0;
  private untaggedTotal = 0;
  private readonly expected = new Map<string, number>();
  private readonly seen = new Map<string, number>();
  private readonly pairs = new Map<string, number>();
  private readonly explainedBy = new Map<string, number>();
  private readonly distinct = new Map<string, { kind: Kind; beforeCode: string; afterCode: string; reason: string; count: number }>();
  private readonly recent: ParityEntry[] = [];

  constructor(private readonly log: (msg: string) => void = () => {}) {}

  // One write to a frame record. before/after are the records (null: created / deleted).
  observe(o: ParityObservation): void {
    try {
      this.check(o);
    } catch {
      this.errors++;
    }
  }

  // An old behaviour the stored fields cannot show (SEEN), counted at its call site. Also
  // a move the machine rejected at a writer that already goes through it, as
  // "rejected:<state code>:<event>" (server/frame-watcher.ts dispatchStatus).
  note(tag: string): void {
    try {
      bump(this.seen, typeof tag === "string" && /^[A-Za-z0-9_:-]{1,60}$/.test(tag) ? tag : "(other)");
    } catch {
      this.errors++;
    }
  }

  private check(o: ParityObservation): void {
    const before = o.before as Loose;
    const after = o.after as Loose;
    if (!before && !after) return;
    this.writes++;
    if (!before) this.created++;
    if (!after) this.deleted++;
    const reason = word(o.reason) ?? "(none)";
    const from = derive(before, false);
    // A frame that does not exist yet is an unbound frame as far as the machine goes.
    const fromState: Lifecycle = from.state.s === "gone" ? { s: "unbound" } : from.state;
    const fromCode = lifecycleCode(fromState);
    const to = derive(after, fromState.s !== "unbound");
    const entry = (kind: Kind, expected: string): ParityEntry => ({
      at: Date.now(),
      boardId: ident(o.boardId),
      frameId: ident(o.frameId),
      reason,
      kind,
      beforeCode: before ? fromCode : "(new)",
      afterCode: to.code,
      storedStatus: word(to.storedStatus),
      storedColour: word(to.storedColour),
      expected,
    });

    // Status and colour: reported when this write introduced them, not on every later
    // write to a frame that still has them (scan() shows what is there at rest).
    if (to.status) {
      if (sameDisagreement(from.status, to.status)) this.persisting++;
      else this.record(entry("status", to.status.expected), tagStatus(after, to));
    }
    if (to.colour) {
      if (sameDisagreement(from.colour, to.colour)) this.persisting++;
      else this.record(entry("colour", to.colour.expected), tagColour(before, after, to));
    }

    // The move. The same code with another agent is a move too (nothing swaps an agent).
    const swapped = fromCode === to.code && (to.state.s === "bound" || to.state.s === "archived" || to.state.s === "restarting") && agentOf(fromState) !== agentOf(to.state);
    if (fromCode === to.code && !swapped) {
      this.noops++;
      if (fromState.s === "bound" && paseoOf(before)?.remoteStart?.phase !== paseoOf(after)?.remoteStart?.phase) bump(this.seen, SEEN.remotePhaseOnBound);
      return;
    }
    this.moves++;
    bump(this.pairs, `${before ? fromCode : "(new)"}>${to.code}`);
    // (i) a plain status write is never a move out of failed, whatever event could be
    // found to fit it: it is the old writer overwriting the failure.
    if (fromState.s === "failed" && reason === "status" && (to.state.s === "starting" || to.state.s === "restarting" || to.state.s === "bound" || to.state.s === "archived"))
      return void this.record(entry("move", "a status write is not a move from failed"), EXPECTED.statusOverFailed);
    const events = explainMove(fromState, to.state, reason !== "human");
    if (events) return void bump(this.explainedBy, events.join("+"));
    this.record(entry("move", swapped ? "no event swaps the agent of a state" : "no event makes this move"), tagMove(before, reason, fromState, to.state));
  }

  private record(e: ParityEntry, tag: string | null): void {
    if (tag) return void bump(this.expected, tag);
    this.untaggedTotal++;
    this.recent.push(e);
    if (this.recent.length > RECENT_MAX) this.recent.shift();
    const key = `${e.kind}|${e.beforeCode}|${e.afterCode}|${e.reason}`;
    const known = this.distinct.get(key);
    if (known) return void known.count++;
    if (this.distinct.size >= DISTINCT_MAX) return;
    this.distinct.set(key, { kind: e.kind, beforeCode: e.beforeCode, afterCode: e.afterCode, reason: e.reason, count: 1 });
    // Once per distinct disagreement, never per write.
    this.log(`lifecycle-parity untagged ${e.kind} ${e.beforeCode}>${e.afterCode} reason=${e.reason} board=${e.boardId} frame=${e.frameId} stored=${e.storedStatus}/${e.storedColour} expected=${e.expected}`);
  }

  // Every frame of the given boards as it is stored now: how many are in each state, and
  // which disagree with the machine about their status or colour.
  scan(boards: Iterable<ScanBoard>): ParityScan {
    const states = new Map<string, number>();
    const expected = new Map<string, number>();
    const untagged: ScanEntry[] = [];
    let boardCount = 0;
    let frames = 0;
    let untaggedTotal = 0;
    try {
      for (const board of boards) {
        boardCount++;
        for (const rec of board.records as Iterable<Loose>) {
          try {
            if (!rec || rec.type !== "frame") continue;
            frames++;
            const d = derive(rec, false);
            bump(states, d.code);
            for (const dis of [d.status, d.colour]) {
              if (!dis) continue;
              const tag = tagAtRest(rec, d, dis.kind);
              if (tag) {
                bump(expected, tag);
                continue;
              }
              untaggedTotal++;
              if (untagged.length < SCAN_UNTAGGED_MAX) untagged.push({ boardId: ident(board.id), frameId: ident(rec.id), kind: dis.kind, afterCode: d.code, storedStatus: word(d.storedStatus), storedColour: word(d.storedColour), expected: dis.expected });
            }
          } catch {
            this.errors++;
          }
        }
      }
    } catch {
      this.errors++;
    }
    return { boards: boardCount, frames, states: toObject(states), expected: toObject(expected), untaggedTotal, untagged };
  }

  // The JSON for GET /api/ui/debug/lifecycle-parity. `boards`: the loaded boards, for a
  // fresh scan. clean: nothing untagged, in the writes seen or at rest.
  report(boards?: Iterable<ScanBoard>) {
    const scan = boards ? this.scan(boards) : null;
    return {
      version: PARITY_VERSION,
      since: new Date(this.since).toISOString(),
      at: new Date().toISOString(),
      clean: this.untaggedTotal === 0 && (scan?.untaggedTotal ?? 0) === 0,
      writes: { frames: this.writes, created: this.created, deleted: this.deleted, moves: this.moves, noops: this.noops, persisting: this.persisting, errors: this.errors },
      untagged: { total: this.untaggedTotal, distinct: [...this.distinct.values()].sort((a, b) => b.count - a.count), recent: [...this.recent] },
      expected: toObject(this.expected),
      seen: toObject(this.seen),
      pairs: toObject(this.pairs),
      explainedBy: toObject(this.explainedBy),
      scan,
    };
  }
}
