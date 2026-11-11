// Cloud session cards (shared/components/cloud-session.ts): pinned into a frame by
// `bin/cloud-task start` through the agent API (op "cloud"), then kept current here so the
// frame agent does not have to. For every card that is not finished:
//
//   - the session itself (Claude): `cloud-task session <id>` reads the sessions API the claude
//     CLI uses (running / idle / requires_action / …, the last event, the newest message).
//     When it cannot be read the card says so ("status unknown" and why); nothing is guessed.
//   - Codex tasks: `cloud-task status <task>` until there is a PR.
//   - GitHub (REST through `gh api`, read only): the newest PR (highest number) linked to the
//     session (its body names the session, or its head is the session's branch); its state
//     and checks. For a Claude card the PR is a second line: a merged PR does not finish the
//     card, only the session ending (archived) or failing does.
//
// Polling: every card once a minute. Opening a card's session (or clicking the card) starts a
// burst: that card every 3 s for 5 minutes, then back to the minute. A burst reads the session
// on every pass and GitHub at most every 30 s.
//
// GitHub budget: the operator's gh login (5000 requests/hour) is shared with deployment.
// board-env previews copy production's cards, so they skip GitHub (BUNNY_CLOUD_GITHUB=1
// opts in); a poll pass fetches the recent-PR list once per repo for all its cards; a rate-limit
// answer pauses every GitHub call for 15 minutes instead of retrying each card each minute.
//
// Every lookup has a timeout, and one card's failure never stops the others.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  CLOUD_SESSION_SIZE,
  CLOUD_SESSION_TYPE,
  type CloudSessionProps,
  type CloudState,
  checksText,
  cloudSessionDefaults,
  holdsFrame,
  isActive,
  type PrState,
  type SessionStatus,
} from "../shared/components/cloud-session";
import { type ActivityEvent, type ClaudeActivityData, parseActivity } from "../shared/widgets/claude-activity";
import { ancestors, isShape, type Rec } from "./records";
import type { BoardHost, BoardRoom } from "./room-host";

// What `cloud-task session <id>` prints (bin/cloud-session.mjs).
export interface SessionRead {
  reachable: boolean;
  status?: string;
  title?: string;
  lastEventAt?: string | null;
  pendingAction?: string;
  message?: { role: "user" | "assistant"; text: string; at?: string | null };
  error?: string;
  http?: number;
  // With { activity: true }: the compacted task events, oldest first (bin/cloud-session.mjs).
  events?: ActivityEvent[];
  eventsComplete?: boolean;
  scanned?: number;
  activityError?: string;
}

// What the "Claude Code activity" widget hears for its session on every read.
export type ActivityUpdate = { ok: true; data: ClaudeActivityData } | { ok: false; reason: string };
type ActivityListener = (u: ActivityUpdate) => void;

export interface CloudRunner {
  codexDoctor?(): Promise<CodexReadiness>;
  // `gh api <args>` parsed as JSON. Throws with gh's own message on failure.
  gh(args: string[]): Promise<unknown>;
  // `cloud-task status <task>` (Codex), parsed; null when unavailable.
  codexStatus?(task: string): Promise<{ status?: string; error?: string } | null>;
  // `cloud-task session <session> [--activity]` (Claude). Never throws: unreadable is reachable:false.
  session?(id: string, opts?: { activity?: boolean }): Promise<SessionRead>;
}

export interface CodexReadiness {
  ready: boolean;
  error?: string;
}

const BURST_MS = 5 * 60_000;
const GITHUB_EVERY_MS = 30_000;

function run(cmd: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env }, (err, stdout, stderr) => {
      // cloud-task prints its JSON on stdout even when it exits 1.
      if (err && String(stdout).trim().startsWith("{")) resolve(String(stdout));
      else if (err) reject(new Error((String(stderr || "").trim().split("\n").slice(-2).join(" ") || err.message).slice(0, 240)));
      else resolve(String(stdout));
    });
  });
}

function findTool(name: string, override?: string): string | null {
  if (override) return override;
  for (const dir of [...(process.env.PATH ?? "").split(path.delimiter), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]) {
    if (dir && existsSync(path.join(dir, name))) return path.join(dir, name);
  }
  return null;
}

// The real runner: gh from BUNNY_GH, PATH or Homebrew; cloud-task from this checkout
// (BUNNY_CLOUD_TASK overrides, for proofs).
export function defaultCloudRunner(repoRoot: string): CloudRunner {
  const cloudTask = () => process.env.BUNNY_CLOUD_TASK ?? path.join(repoRoot, "bin", "cloud-task");
  return {
    async codexDoctor() {
      try {
        const result = JSON.parse(await run(cloudTask(), ["doctor", "--provider", "codex"], 25_000));
        return { ready: result.codex?.ready === true, ...(result.codex?.error ? { error: String(result.codex.error) } : {}) };
      } catch (error) { return { ready: false, error: (error as Error).message }; }
    },
    async gh(args) {
      const gh = findTool("gh", process.env.BUNNY_GH);
      if (!gh) throw new Error("gh not found on the board server (PATH, /opt/homebrew/bin)");
      const out = await run(gh, ["api", ...args], 20_000);
      return out.trim() ? JSON.parse(out) : null;
    },
    async codexStatus(task) {
      const bin = cloudTask();
      if (!existsSync(bin)) return null;
      try {
        return JSON.parse(await run(bin, ["status", task], 30_000));
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
    async session(id, opts = {}) {
      const bin = cloudTask();
      if (!existsSync(bin)) return { reachable: false, error: `${bin} not found` };
      try {
        // The board's own node runs cloud-session.mjs. 60 s: an expired token is refreshed first.
        const out = await run(bin, ["session", id, ...(opts.activity ? ["--activity"] : [])], 60_000, { ...process.env, CLOUD_TASK_NODE: process.env.CLOUD_TASK_NODE ?? process.execPath });
        const r = JSON.parse(out.trim().split("\n").pop() ?? "{}") as SessionRead;
        return typeof r.reachable === "boolean" ? r : { reachable: false, error: "cloud-task session printed no state" };
      } catch (e) {
        return { reachable: false, error: (e as Error).message };
      }
    },
  };
}

type Card = Rec & { props: CloudSessionProps };
const isCard = (r: Rec | undefined): r is Card => isShape(r) && r.type === CLOUD_SESSION_TYPE;
const ms = (iso: unknown) => (typeof iso === "string" && Date.parse(iso)) || 0;

interface Pull {
  number: number;
  html_url: string;
  state: string;
  merged?: boolean;
  merged_at?: string | null;
  updated_at?: string;
  body?: string | null;
  head?: { ref?: string; sha?: string };
}

// Codex `cloud status` text -> a card state (its wording is not a stable API: match words).
export function codexState(text: string): CloudState | null {
  const t = text.toLowerCase();
  if (/\b(fail|failed|error|errored|cancel+ed)\b/.test(t)) return "failed";
  if (/\b(ready|completed?|done|succeeded|success)\b/.test(t)) return "waiting";
  if (/\b(pending|queued|running|in[_ ]progress|working|started)\b/.test(t)) return "working";
  return null;
}

const SESSION_KNOWN: SessionStatus[] = ["running", "idle", "requires_action", "pending", "archived", "failed"];

// A Claude card's headline: what the session itself reports. The PR never decides it.
export function sessionState(session: SessionStatus): CloudState {
  switch (session) {
    case "running": return "working";
    case "requires_action": return "waiting";
    case "pending": return "starting";
    case "idle": return "idle";
    case "failed": return "failed";
    case "archived": return "ended";
    default: return "unknown";
  }
}

// Whether a room change can move the active-card counts (recount): a card that holds its
// frame was added or removed, moved to another parent, or started or stopped holding it.
// The pollers patch every card on every pass (checkedAt, message, activity); those writes
// cannot change a count, and recount scans every record of every loaded board.
export function cloudCountChanged(changes: ReadonlyArray<{ before: Rec | null; after: Rec | null }>): boolean {
  return changes.some(({ before, after }) => {
    const b = isCard(before ?? undefined) ? (before as Card) : null;
    const a = isCard(after ?? undefined) ? (after as Card) : null;
    if (!a || !b) return !!(a ?? b) && holdsFrame((a ?? b)!.props);
    return a.parentId !== b.parentId || holdsFrame(a.props) !== holdsFrame(b.props);
  });
}

export class CloudSessions {
  private timer: ReturnType<typeof setInterval> | null = null;
  private fastTimer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  // Active cards per bound frame ("board/frame" -> count), for the frame's status.
  private active = new Map<string, number>();
  // Bursts: "board/card" -> until (epoch ms).
  private bursts = new Map<string, number>();
  private inFlight = new Set<string>();
  private githubAt = new Map<string, number>();
  // Recent-PR lists shared by the cards of one poll pass (null outside a pass).
  private pass: Map<string, Promise<unknown>> | null = null;
  private githubPausedUntil = 0;
  // "Claude Code activity" widgets, per session id (server/widgets/claude-activity.ts).
  private activity = new Map<string, Set<ActivityListener>>();
  private activityInFlight = new Set<string>();
  private readiness: { expires: number; result: Promise<CodexReadiness> } | null = null;

  constructor(
    private host: BoardHost,
    private runner: CloudRunner,
    private log: (m: string) => void,
    private onActiveChange: (boardId: string, frameId: string) => void = () => {},
    private pollMs = Number(process.env.BUNNY_CLOUD_POLL_MS) || 60_000,
    private burstPollMs = Number(process.env.BUNNY_CLOUD_BURST_MS) || 3_000,
    private githubEnabled = !process.env.BOARD_ENV || process.env.BUNNY_CLOUD_GITHUB === "1",
  ) {}

  // Every GitHub read goes through here (see "GitHub budget" above).
  private async gh(args: string[], now = Date.now()): Promise<unknown> {
    if (now < this.githubPausedUntil) throw new Error(`GitHub paused after a rate limit until ${new Date(this.githubPausedUntil).toISOString()}`);
    try {
      return await this.runner.gh(args);
    } catch (e) {
      // ponytail: fixed 15 min pause; read the reset time from `gh api rate_limit` if it matters.
      if (/rate limit/i.test((e as Error).message)) {
        this.githubPausedUntil = now + 15 * 60_000;
        this.log("cloud sessions: GitHub rate limited; pausing GitHub reads for 15 min");
      }
      throw e;
    }
  }

  private recent(repo: string): Promise<unknown> {
    const hit = this.pass?.get(repo);
    if (hit) return hit;
    const pulls = this.gh(["-X", "GET", `repos/${repo}/pulls`, "-f", "state=all", "-f", "sort=updated", "-f", "direction=desc", "-f", "per_page=30"]);
    pulls.catch(() => {});
    this.pass?.set(repo, pulls);
    return pulls;
  }

  codexDoctor(): Promise<CodexReadiness> {
    if (!this.readiness || this.readiness.expires <= Date.now()) {
      const result = Promise.resolve().then(() => this.runner.codexDoctor?.() ?? { ready: false, error: "Codex Cloud readiness is unavailable" })
        .catch((error: Error) => ({ ready: false, error: error.message }));
      this.readiness = { expires: Date.now() + 30_000, result };
    }
    return this.readiness.result;
  }

  start(): void {
    if (this.timer) return;
    this.recount();
    this.timer = setInterval(() => void this.tick(), Math.max(2_000, this.pollMs));
    this.timer.unref?.();
    this.fastTimer = setInterval(() => void this.burstTick(), Math.max(1_000, this.burstPollMs));
    this.fastTimer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.fastTimer) clearInterval(this.fastTimer);
    this.timer = this.fastTimer = null;
  }

  // Active cloud sessions inside a bound frame (nested unbound frames included).
  activeIn(boardId: string, frameId: string): number {
    return this.active.get(`${boardId}/${frameId}`) ?? 0;
  }

  // Someone opened the card's session (or clicked the card): they are likely to send it a
  // message, so look every few seconds for a while. Reads it right away too.
  burst(boardId: string, cardId: string, now = Date.now()): { until: number; everyMs: number } {
    const room = this.host.exists(boardId) ? this.host.get(boardId) : null;
    const card = room?.records.get(cardId);
    if (!room || !isCard(card)) throw new Error(`no cloud session card ${cardId} on board ${boardId}`);
    const until = now + BURST_MS;
    const key = `${boardId}/${cardId}`;
    if (!this.bursts.has(key)) this.log(`cloud session ${card.props.session}: burst polling every ${this.burstPollMs / 1000} s for 5 min`);
    this.bursts.set(key, until);
    void this.refresh(room, cardId, { github: false });
    return { until, everyMs: this.burstPollMs };
  }

  bursting(boardId: string, cardId: string, now = Date.now()): boolean {
    return (this.bursts.get(`${boardId}/${cardId}`) ?? 0) > now;
  }

  // A widget wants this session's subagents and background processes. They are read with the
  // session itself on every poll of its card (and burst), or every minute on their own when
  // no card shows the session. Reads once right away.
  watchActivity(session: string, listener: ActivityListener): () => void {
    let set = this.activity.get(session);
    if (!set) this.activity.set(session, (set = new Set()));
    set.add(listener);
    const card = this.cardFor(session);
    if (card) void this.refresh(card.room, card.id, { github: false });
    else void this.readActivity(session);
    return () => {
      set!.delete(listener);
      if (!set!.size) this.activity.delete(session);
    };
  }

  private cardFor(session: string): { room: BoardRoom; id: string } | null {
    for (const room of this.host.all()) for (const r of room.records.values()) if (isCard(r) && r.props.session === session && isActive(r.props.state)) return { room, id: r.id };
    return null;
  }

  private emitActivity(session: string, s: SessionRead): void {
    const set = this.activity.get(session);
    if (!set?.size) return;
    let u: ActivityUpdate;
    if (!s.reachable) u = { ok: false, reason: `session not readable: ${s.error ?? "unknown error"}` };
    else if (s.activityError || !s.events) u = { ok: false, reason: `session events not readable: ${s.activityError ?? "no events in the reply"}` };
    else u = { ok: true, data: parseActivity(s.events, { complete: !!s.eventsComplete, scanned: s.scanned, sessionStatus: s.status }) };
    for (const l of set) l(u);
  }

  // A watched session that no live card polls.
  private async readActivity(session: string): Promise<void> {
    if (!this.runner.session || this.activityInFlight.has(session)) return;
    this.activityInFlight.add(session);
    try {
      this.emitActivity(session, await this.runner.session(session, { activity: true }));
    } finally {
      this.activityInFlight.delete(session);
    }
  }

  // Pin a card for a session into the frame, or update the one already there. Returns the
  // card. Placement is the caller's (agent-api.ts, which owns frame geometry); `place`
  // gets the size and writes the new shape.
  upsert(
    room: BoardRoom,
    frameId: string,
    body: Partial<CloudSessionProps>,
    place: (props: CloudSessionProps) => Rec,
  ): { card: Rec; created: boolean } {
    const existing = this.cardsIn(room, frameId).find((c) => c.props.session === body.session);
    if (existing) {
      const patch: Partial<CloudSessionProps> = {};
      if (body.branch && !existing.props.branch) patch.branch = body.branch;
      if (body.title && !existing.props.title) patch.title = body.title;
      if (body.activityAt) patch.activityAt = Math.max(existing.props.activityAt, body.activityAt);
      // A reported failure (cloud-task start's error) wins; nothing else rewinds the state.
      if (body.state === "failed") Object.assign(patch, { state: "failed", detail: body.detail ?? "" });
      const card = this.patch(room, existing.id, patch) ?? existing;
      this.recount();
      if (isActive(card.props.state)) void this.refresh(room, card.id);
      return { card, created: false };
    }
    const card = place(cloudSessionDefaults({ ...body, ...CLOUD_SESSION_SIZE }));
    this.log(`cloud session ${body.session} pinned into ${room.id}/${frameId}`);
    this.recount();
    if (isActive(String(card.props.state))) void this.refresh(room, card.id);
    return { card, created: true };
  }

  private cardsIn(room: BoardRoom, frameId: string): Card[] {
    const out: Card[] = [];
    for (const r of room.records.values()) if (isCard(r) && ancestors(room.records, r).includes(frameId)) out.push(r);
    return out;
  }

  private patch(room: BoardRoom, id: string, patch: Partial<CloudSessionProps>): Card | null {
    const cur = room.records.get(id);
    if (!isCard(cur)) return null;
    const changed = (Object.keys(patch) as (keyof CloudSessionProps)[]).some((k) => patch[k] !== undefined && cur.props[k] !== patch[k]);
    if (!changed) return cur;
    let out: Card | null = null;
    room.write({ kind: "server", reason: "cloud-session" }, (ops) => {
      const now = ops.get(id);
      if (!isCard(now)) return;
      const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      out = { ...now, props: { ...now.props, ...clean } } as Card;
      ops.put(out);
    });
    return out;
  }

  // Which bound frame each active card counts for: its nearest ancestor frame with an agent.
  recount(): void {
    const next = new Map<string, number>();
    for (const room of this.host.all()) {
      for (const r of room.records.values()) {
        if (!isCard(r) || !holdsFrame(r.props)) continue;
        const owner = ancestors(room.records, r).find((id) => room.records.get(id)?.meta?.paseo?.agentId);
        if (owner) next.set(`${room.id}/${owner}`, (next.get(`${room.id}/${owner}`) ?? 0) + 1);
      }
    }
    const before = this.active;
    this.active = next;
    for (const k of new Set([...before.keys(), ...next.keys()])) {
      if ((before.get(k) ?? 0) === (next.get(k) ?? 0)) continue;
      const i = k.indexOf("/");
      this.onActiveChange(k.slice(0, i), k.slice(i + 1));
    }
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.pass = new Map();
    try {
      for (const room of this.host.all()) {
        for (const r of [...room.records.values()]) {
          if (isCard(r) && isActive(r.props.state)) await this.refresh(room, r.id);
        }
      }
      for (const session of [...this.activity.keys()]) if (!this.cardFor(session)) await this.readActivity(session);
    } finally {
      this.busy = false;
      this.pass = null;
      this.recount();
    }
  }

  // Bursting cards only, every few seconds; finished bursts are dropped.
  async burstTick(now = Date.now()): Promise<void> {
    const due: Array<Promise<void>> = [];
    for (const [key, until] of this.bursts) {
      const i = key.indexOf("/");
      const boardId = key.slice(0, i), cardId = key.slice(i + 1);
      const room = this.host.exists(boardId) ? this.host.get(boardId) : null;
      const card = room?.records.get(cardId);
      if (until <= now || !room || !isCard(card) || !isActive(card.props.state)) {
        this.bursts.delete(key);
        continue;
      }
      due.push(this.refresh(room, cardId, { github: now - (this.githubAt.get(key) ?? 0) >= GITHUB_EVERY_MS }));
    }
    await Promise.all(due);
  }

  // Look the session up once and write what changed. Never throws; one lookup per card at a time.
  async refresh(room: BoardRoom, id: string, opts: { github?: boolean } = {}): Promise<void> {
    const key = `${room.id}/${id}`;
    if (this.inFlight.has(key)) return;
    const card = room.records.get(id);
    if (!isCard(card)) return;
    this.inFlight.add(key);
    const github = opts.github !== false;
    if (github) this.githubAt.set(key, Date.now());
    let patch: Partial<CloudSessionProps>;
    try {
      patch = await this.lookup(card.props, Date.now(), { github });
    } catch (e) {
      patch = { detail: `status check failed: ${(e as Error).message}`.slice(0, 300) };
    } finally {
      this.inFlight.delete(key);
    }
    if (room.closed) return;
    const before = room.records.get(id);
    const after = this.patch(room, id, { ...patch, checkedAt: Date.now() });
    if (patch.state && !isActive(patch.state)) this.bursts.delete(key);
    if (isCard(before) && after && (before.props.state !== after.props.state || before.props.prState !== after.props.prState)) this.recount();
  }

  async lookup(p: CloudSessionProps, now = Date.now(), opts: { github?: boolean } = {}): Promise<Partial<CloudSessionProps>> {
    const out: Partial<CloudSessionProps> = {};
    // 1. The session's own state (Claude). Unreadable is said, not guessed.
    let session: SessionStatus = p.provider === "claude" ? p.sessionStatus : "";
    let sessionError = "";
    if (p.provider === "claude" && this.runner.session) {
      const s = await this.runner.session(p.session, { activity: this.activity.has(p.session) });
      this.emitActivity(p.session, s);
      if (s.reachable && SESSION_KNOWN.includes(s.status as SessionStatus)) {
        session = s.status as SessionStatus;
        out.sessionStatus = session;
        if (s.title && !p.title) out.title = s.title.slice(0, 200);
        if (s.message?.text) {
          out.message = s.message.text.slice(0, 240);
          out.messageRole = s.message.role === "user" ? "user" : "assistant";
        }
        out.activityAt = Math.max(p.activityAt, ms(s.lastEventAt), ms(s.message?.at));
        if (session === "requires_action") sessionError = s.pendingAction ? `needs input: ${s.pendingAction}` : "needs input";
      } else {
        session = "unreachable";
        out.sessionStatus = "unreachable";
        sessionError = `session status unavailable: ${s.error ?? "unknown error"}`;
      }
    }

    // 2. GitHub: the newest linked PR and its checks (skipped on most burst passes).
    let prState: PrState = p.prState;
    let githubError = "";
    if (opts.github !== false && this.githubEnabled) {
      let pull: Pull | null = null;
      try {
        pull = await this.findPull(p);
      } catch (e) {
        githubError = `GitHub check failed: ${(e as Error).message}`;
      }
      if (pull) {
        const merged = !!pull.merged || !!pull.merged_at;
        prState = merged ? "merged" : pull.state === "closed" ? "closed" : "open";
        Object.assign(out, {
          pr: pull.number,
          prUrl: pull.html_url,
          prState,
          branch: pull.head?.ref || p.branch,
          activityAt: Math.max(out.activityAt ?? p.activityAt, ms(pull.merged_at), ms(pull.updated_at)),
        });
        if (pull.head?.sha && prState === "open") Object.assign(out, await this.checks(p.repo, pull.head.sha).catch(() => ({})));
      }
    }
    const checks = { checksPass: out.checksPass ?? p.checksPass, checksFail: out.checksFail ?? p.checksFail, checksPending: out.checksPending ?? p.checksPending };

    // 3. Codex: its task status until there is a PR, then the PR decides (merged finishes it).
    if (p.provider === "codex") {
      if (prState) {
        out.state = prState === "open" ? "pr" : prState;
        out.detail = prState === "merged" ? "" : prState === "closed" ? "closed without merging" : checksText(checks);
        return out;
      }
      if (this.runner.codexStatus) {
        const st = await this.runner.codexStatus(p.session);
        if (st?.error) return { ...out, state: "unknown", detail: `codex status: ${st.error}`.slice(0, 300) };
        const s = codexState(st?.status ?? "");
        if (s === "failed") return { ...out, state: "failed", detail: (st?.status ?? "").split("\n")[0].slice(0, 300) };
        if (s === "waiting") return { ...out, state: "waiting", detail: "diff ready: create the PR from the task page" };
        if (s) return { ...out, state: s, detail: "no PR yet" };
      }
      return { ...out, state: p.state === "failed" ? "failed" : "unknown", detail: p.state === "failed" ? p.detail : "codex status unavailable" };
    }

    // 4. Claude: the session's own state. A dispatch failure reported by cloud-task stays
    // until the session can be read.
    if (p.state === "failed" && (session === "" || session === "unreachable")) return out;
    out.state = sessionState(session);
    const details = [sessionError, githubError];
    if (!sessionError && !prState) details.unshift(session === "idle" ? "no PR yet; the session is waiting for a message" : "no PR yet");
    out.detail = details.filter(Boolean).join(" · ").slice(0, 300);
    return out;
  }

  // The newest PR (highest number) linked to the session: its body names the session, or its
  // head is the session's branch. Falls back to the PR already on the card.
  private async findPull(p: CloudSessionProps): Promise<Pull | null> {
    const repo = p.repo;
    const recent = (await this.recent(repo)) as Pull[];
    const linked = (Array.isArray(recent) ? recent : []).filter((pr) => (typeof pr.body === "string" && pr.body.includes(p.session)) || (!!p.branch && pr.head?.ref === p.branch));
    // A merged or closed PR cannot change: only a newer linked PR in the shared list matters.
    if (p.pr && (p.prState === "merged" || p.prState === "closed")) {
      const newer = linked.reduce<Pull | null>((a, b) => (b.number > p.pr && (!a || b.number > a.number) ? b : a), null);
      return newer;
    }
    if (p.branch) {
      const owner = repo.split("/")[0];
      const byHead = (await this.gh(["-X", "GET", `repos/${repo}/pulls`, "-f", "state=all", "-f", `head=${owner}:${p.branch}`, "-f", "per_page=5"])) as Pull[];
      if (Array.isArray(byHead)) linked.push(...byHead);
    }
    const newest = linked.reduce<Pull | null>((a, b) => (!a || b.number > a.number ? b : a), null);
    if (newest && newest.number >= p.pr) return newest;
    return p.pr ? ((await this.gh([`repos/${repo}/pulls/${p.pr}`])) as Pull) : null;
  }

  private async checks(repo: string, sha: string): Promise<Pick<CloudSessionProps, "checksPass" | "checksFail" | "checksPending">> {
    const res = (await this.gh(["-X", "GET", `repos/${repo}/commits/${sha}/check-runs`, "-f", "per_page=100"])) as { check_runs?: Array<{ status?: string; conclusion?: string | null }> };
    let pass = 0, fail = 0, pending = 0;
    for (const c of res?.check_runs ?? []) {
      if (c.status !== "completed") pending++;
      else if (c.conclusion === "success" || c.conclusion === "neutral" || c.conclusion === "skipped") pass++;
      else fail++;
    }
    return { checksPass: pass, checksFail: fail, checksPending: pending };
  }
}
