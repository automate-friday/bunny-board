// In-process fake of Slack's public Web API and Socket Mode, shaped after docs.slack.dev:
//   - every Web API reply is HTTP 200 with {ok:true,…} or {ok:false,error} (missing_scope
//     adds needed/provided); rate limits are HTTP 429 with Retry-After and
//     {ok:false,error:"ratelimited"};
//   - lists page with response_metadata.next_cursor ("" on the last page);
//   - apps.connections.open (app-level xapp token) returns a socket URL; the socket sends
//     hello, then events_api envelopes the client must ack with {envelope_id} (unacked
//     ones are redelivered with retry_attempt/retry_reason), and disconnect frames;
//   - thread reply events carry thread_ts and parent_user_id, and the parent's
//     message_replied event arrives WITHOUT its subtype (Slack's documented bug) while
//     repliedSubtypeBug is on, so clients must detect replies by thread_ts !== ts.
// Faults and toggles (admin) make the widget's stale and error states reproducible.

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { EventCallback, SlackChannel, SlackMessage, SlackUser, SocketFrame } from "../api";
import type { HttpReply, Params, SocketLike } from "../client";
import { BOT, CHATTER, channels, messages, TEAM, THREAD_TS, TOKENS, users } from "./fixtures";

// Scope each method needs (public channel flavour; groups:* for private channels).
const SCOPES: Record<string, string | null> = {
  "auth.test": null,
  "conversations.list": "channels:read",
  "conversations.info": "channels:read",
  "conversations.history": "channels:history",
  "conversations.replies": "channels:history",
  "users.info": "users:read",
  "chat.postMessage": "chat:write",
  "apps.connections.open": "connections:write",
};

export interface MockOptions {
  chatterMs?: number;
  pingMs?: number;
  redeliverMs?: number;
  chatter?: boolean;
}

interface Pending {
  frame: Extract<SocketFrame, { type: "events_api" }>;
  timer: ReturnType<typeof setTimeout>;
}

export class MockSocket extends EventEmitter implements SocketLike {
  open = true;
  readonly pending = new Map<string, Pending>();
  constructor(private readonly mock: MockSlack) {
    super();
  }
  // Client → server: acks.
  send(data: string): void {
    if (!this.open) return;
    let id = "";
    try {
      id = String(JSON.parse(data).envelope_id ?? "");
    } catch {
      return;
    }
    this.mock.ack(this, id);
  }
  close(): void {
    this.mock.dropSocket(this);
  }
  // Server → client.
  deliver(frame: SocketFrame): void {
    // A stalled server sends nothing at all (not even hello to a new connection).
    if (!this.open || this.mock.stalled()) return;
    setTimeout(() => this.open && this.emit("message", JSON.stringify(frame)), 0);
  }
}

const ok = (body: Record<string, unknown> = {}): HttpReply => ({ status: 200, headers: { "content-type": "application/json" }, body: { ok: true, ...body } });
const fail = (error: string, extra: Record<string, unknown> = {}): HttpReply => ({ status: 200, headers: { "content-type": "application/json" }, body: { ok: false, error, ...extra } });

function cursorOut(offset: number, total: number): string {
  return offset < total ? Buffer.from(`next:${offset}`).toString("base64") : "";
}
function cursorIn(c: unknown): number | null {
  if (c === undefined || c === "") return 0;
  const m = Buffer.from(String(c), "base64").toString("utf8").match(/^next:(\d+)$/);
  return m ? Number(m[1]) : null;
}
const num = (v: unknown, dflt: number, max: number) => Math.max(1, Math.min(max, Number.isFinite(Number(v)) && v !== undefined && v !== "" ? Math.floor(Number(v)) : dflt));
const bool = (v: unknown) => v === true || v === "true" || v === "1" || v === 1;

export class MockSlack {
  channels: SlackChannel[] = channels();
  users: SlackUser[] = users();
  messages: Record<string, SlackMessage[]> = messages();
  readonly sockets = new Set<MockSocket>();
  readonly toggles = { nonMarketplace: false, repliedSubtypeBug: true, chatter: true };
  readonly faults = { ratelimit: 0, retryAfter: 3, ratelimitUntil: 0, latencyMs: 0, latencyUntil: 0, dropAcks: 0, stallUntil: 0 };
  readonly counters = { calls: {} as Record<string, number>, ratelimited: 0, acks: 0, redeliveries: 0, events: 0 };
  private readonly tickets = new Set<string>();
  private readonly limiter = new Map<string, number>();
  private chatterTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private chatterIndex = 0;
  private lastTs = 0;
  private readonly chatterMs: number;
  private readonly pingMs: number;
  private readonly redeliverMs: number;

  constructor(opts: MockOptions = {}) {
    this.chatterMs = opts.chatterMs ?? 8000;
    this.pingMs = opts.pingMs ?? 5000;
    this.redeliverMs = opts.redeliverMs ?? 3000;
    if (opts.chatter === false) this.toggles.chatter = false;
  }

  // ---- Web API ---------------------------------------------------------------------
  async request(method: string, token: string, params: Params): Promise<HttpReply> {
    this.counters.calls[method] = (this.counters.calls[method] ?? 0) + 1;
    if (this.faults.latencyMs && Date.now() < this.faults.latencyUntil) await new Promise((r) => setTimeout(r, this.faults.latencyMs));
    if (this.faults.ratelimit > 0) {
      this.faults.ratelimit--;
      return this.ratelimited(this.faults.retryAfter);
    }
    const left = this.faults.ratelimitUntil - Date.now();
    if (left > 0) return this.ratelimited(Math.ceil(left / 1000));
    const denied = this.authorize(method, token);
    if (denied) return denied;
    try {
      return this.dispatch(method, token, params);
    } catch (e) {
      return fail("internal_error", { detail: (e as Error).message });
    }
  }

  private ratelimited(retryAfter: number): HttpReply {
    this.counters.ratelimited++;
    return { status: 429, headers: { "retry-after": String(retryAfter), "content-type": "application/json" }, body: { ok: false, error: "ratelimited" } };
  }

  private authorize(method: string, token: string): HttpReply | null {
    const t = TOKENS[token];
    if (!token) return fail("not_authed");
    if (!t) return fail("invalid_auth");
    if (t.kind === "revoked") return fail("token_revoked");
    if ((method === "apps.connections.open") !== (t.kind === "app")) return fail("not_allowed_token_type");
    const need = SCOPES[method];
    if (need === undefined) return fail("unknown_method");
    if (need && !t.scopes.includes(need)) return fail("missing_scope", { needed: need, provided: t.scopes.join(",") });
    return null;
  }

  private channelFor(id: unknown, needMember: boolean): SlackChannel | HttpReply {
    const c = this.channels.find((x) => x.id === id);
    if (!c || (c.is_private && !c.is_member)) return fail("channel_not_found");
    if (needMember && !c.is_member) return fail("not_in_channel");
    return c;
  }

  // Non-Marketplace apps: conversations.history/replies at 1 request per minute.
  private limited(method: string, token: string): HttpReply | null {
    if (!this.toggles.nonMarketplace) return null;
    const k = `${token}\n${method}`;
    const last = this.limiter.get(k) ?? 0;
    const now = Date.now();
    if (now - last < 60_000) return this.ratelimited(Math.ceil((60_000 - (now - last)) / 1000));
    this.limiter.set(k, now);
    return null;
  }

  private dispatch(method: string, token: string, p: Params): HttpReply {
    switch (method) {
      case "auth.test":
        return ok({ url: `https://${TEAM.domain}.slack.com/`, team: TEAM.name, user: BOT.name, team_id: TEAM.id, user_id: BOT.user, bot_id: BOT.bot, is_enterprise_install: false });
      case "apps.connections.open": {
        const ticket = randomUUID();
        this.tickets.add(ticket);
        return ok({ url: `wss://wss-mock.slack.com/link/?ticket=${ticket}&app_id=${BOT.app}` });
      }
      case "conversations.list": {
        const types = String(p.types ?? "public_channel").split(",");
        const skipArchived = bool(p.exclude_archived);
        const all = this.channels.filter((c) => types.includes(c.is_private ? "private_channel" : "public_channel") && (!c.is_private || c.is_member) && !(skipArchived && c.is_archived));
        const off = cursorIn(p.cursor);
        if (off === null || off > all.length) return fail("invalid_cursor");
        const limit = num(p.limit, 100, 1000);
        return ok({ channels: all.slice(off, off + limit), response_metadata: { next_cursor: cursorOut(off + limit, all.length) } });
      }
      case "conversations.info": {
        const c = this.channelFor(p.channel, false);
        return "status" in c ? c : ok({ channel: c });
      }
      case "conversations.history": {
        const c = this.channelFor(p.channel, true);
        if ("status" in c) return c;
        const rl = this.limited(method, token);
        if (rl) return rl;
        const off = cursorIn(p.cursor);
        if (off === null) return fail("invalid_cursor");
        const inclusive = bool(p.inclusive);
        const oldest = p.oldest !== undefined ? Number(p.oldest) : -Infinity;
        const latest = p.latest !== undefined ? Number(p.latest) : Infinity;
        const top = this.messages[c.id]
          .filter((m) => !m.thread_ts || m.thread_ts === m.ts || m.subtype === "thread_broadcast")
          .filter((m) => {
            const t = Number(m.ts);
            return inclusive ? t >= oldest && t <= latest : t > oldest && t < latest;
          })
          .reverse();
        const limit = num(p.limit, 100, this.toggles.nonMarketplace ? 15 : 999);
        const page = top.slice(off, off + limit);
        const more = off + limit < top.length;
        return ok({ messages: page, has_more: more, pin_count: 0, response_metadata: { next_cursor: more ? cursorOut(off + limit, top.length) : "" } });
      }
      case "conversations.replies": {
        const c = this.channelFor(p.channel, true);
        if ("status" in c) return c;
        const parent = this.messages[c.id].find((m) => m.ts === p.ts);
        if (!parent || (parent.thread_ts && parent.thread_ts !== parent.ts)) return fail("thread_not_found");
        const rl = this.limited(method, token);
        if (rl) return rl;
        const off = cursorIn(p.cursor);
        if (off === null) return fail("invalid_cursor");
        const oldest = p.oldest !== undefined ? Number(p.oldest) : -Infinity;
        const thread = [parent, ...this.messages[c.id].filter((m) => m.thread_ts === parent.ts && m.ts !== parent.ts && Number(m.ts) > oldest)];
        const limit = num(p.limit, 1000, this.toggles.nonMarketplace ? 15 : 1000);
        const page = thread.slice(off, off + limit);
        const more = off + limit < thread.length;
        return ok({ messages: page, has_more: more, response_metadata: { next_cursor: more ? cursorOut(off + limit, thread.length) : "" } });
      }
      case "users.info": {
        const u = this.users.find((x) => x.id === p.user);
        return u ? ok({ user: u }) : fail("user_not_found");
      }
      case "chat.postMessage": {
        const c = this.channelFor(p.channel, true);
        if ("status" in c) return c;
        const text = typeof p.text === "string" ? p.text : "";
        if (!text.trim()) return fail("no_text");
        if (text.length > 40000) return fail("msg_too_long");
        const threadTs = p.thread_ts ? String(p.thread_ts) : undefined;
        if (threadTs && !this.messages[c.id].some((m) => m.ts === threadTs)) return fail("thread_not_found");
        const m = this.post(c.id, BOT.user, text, { thread_ts: threadTs, broadcast: bool(p.reply_broadcast), bot: true });
        return ok({ channel: c.id, ts: m.ts, message: m });
      }
    }
    return fail("unknown_method");
  }

  // ---- messages and events ---------------------------------------------------------
  private nextTs(): string {
    const now = Date.now() * 1000;
    this.lastTs = Math.max(this.lastTs + 1, now);
    const sec = Math.floor(this.lastTs / 1e6);
    return `${sec}.${String(this.lastTs % 1e6).padStart(6, "0")}`;
  }

  post(channel: string, user: string, text: string, opts: { thread_ts?: string; broadcast?: boolean; bot?: boolean } = {}): SlackMessage {
    const list = this.messages[channel];
    const ts = this.nextTs();
    const parent = opts.thread_ts ? list.find((m) => m.ts === opts.thread_ts) : undefined;
    const m: SlackMessage = {
      type: "message",
      ts,
      user,
      text,
      ...(opts.bot ? { bot_id: BOT.bot } : {}),
      ...(parent ? { thread_ts: parent.ts, parent_user_id: parent.user } : {}),
      ...(parent && opts.broadcast ? { subtype: "thread_broadcast" } : {}),
    };
    list.push(m);
    const ch = this.channels.find((c) => c.id === channel)!;
    const base = { channel, channel_type: ch.is_private ? "group" : "channel" };
    this.emitEvent({ ...m, ...base, event_ts: ts });
    if (parent) {
      parent.thread_ts = parent.ts;
      parent.reply_count = (parent.reply_count ?? 0) + 1;
      parent.latest_reply = ts;
      parent.reply_users = [...new Set([...(parent.reply_users ?? []), user])];
      parent.reply_users_count = parent.reply_users.length;
      const replied: SlackMessage = { type: "message", ...(this.toggles.repliedSubtypeBug ? {} : { subtype: "message_replied" }), hidden: true, ts: this.nextTs(), message: { ...parent }, ...base };
      replied.event_ts = replied.ts;
      this.emitEvent(replied);
    }
    return m;
  }

  private emitEvent(event: SlackMessage): void {
    const ch = this.channels.find((c) => c.id === event.channel);
    if (!ch?.is_member) return;
    for (const s of this.sockets) {
      const payload: EventCallback = { token: "mock-verification", team_id: TEAM.id, api_app_id: BOT.app, event: event as EventCallback["event"], type: "event_callback", event_id: `Ev${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`, event_time: Math.floor(Date.now() / 1000) };
      this.send(s, { type: "events_api", envelope_id: randomUUID(), payload, accepts_response_payload: false, retry_attempt: 0, retry_reason: "" });
    }
  }

  private send(s: MockSocket, frame: Extract<SocketFrame, { type: "events_api" }>): void {
    this.counters.events++;
    if (Date.now() < this.faults.stallUntil) return;
    const timer = setTimeout(() => {
      s.pending.delete(frame.envelope_id);
      if (!s.open || frame.retry_attempt >= 3) return;
      this.counters.redeliveries++;
      this.send(s, { ...frame, retry_attempt: frame.retry_attempt + 1, retry_reason: "timeout" });
    }, this.redeliverMs);
    timer.unref?.();
    s.pending.set(frame.envelope_id, { frame, timer });
    s.deliver(frame);
  }

  ack(s: MockSocket, envelopeId: string): void {
    const p = s.pending.get(envelopeId);
    if (!p) return;
    if (this.faults.dropAcks > 0) {
      this.faults.dropAcks--;
      return;
    }
    clearTimeout(p.timer);
    s.pending.delete(envelopeId);
    this.counters.acks++;
  }

  stalled(): boolean {
    return Date.now() < this.faults.stallUntil;
  }

  // ---- Socket Mode -----------------------------------------------------------------
  openSocket(url: string): MockSocket {
    const s = new MockSocket(this);
    const ticket = (() => {
      try {
        return new URL(url).searchParams.get("ticket") ?? "";
      } catch {
        return "";
      }
    })();
    if (!this.tickets.delete(ticket)) {
      setTimeout(() => this.dropSocket(s), 0);
      return s;
    }
    this.sockets.add(s);
    s.deliver({ type: "hello", num_connections: this.sockets.size, debug_info: { host: "wss-mock-1", approximate_connection_time: 18060 }, connection_info: { app_id: BOT.app } });
    this.timers();
    return s;
  }

  dropSocket(s: MockSocket): void {
    if (!s.open) return;
    s.open = false;
    for (const p of s.pending.values()) clearTimeout(p.timer);
    s.pending.clear();
    this.sockets.delete(s);
    setTimeout(() => s.emit("close", 1000), 0);
    this.timers();
  }

  disconnectAll(reason: "warning" | "refresh_requested" | "link_disabled", closeAfterMs = 100): void {
    for (const s of [...this.sockets]) {
      s.deliver({ type: "disconnect", reason, debug_info: { host: "wss-mock-1" } });
      const t = setTimeout(() => this.dropSocket(s), closeAfterMs);
      t.unref?.();
    }
  }

  private timers(): void {
    const any = this.sockets.size > 0;
    if (any && !this.pingTimer) {
      this.pingTimer = setInterval(() => {
        if (Date.now() < this.faults.stallUntil) return;
        for (const s of this.sockets) s.emit("ping");
      }, this.pingMs);
      this.pingTimer.unref?.();
    }
    if (any && this.toggles.chatter && !this.chatterTimer) {
      this.chatterTimer = setInterval(() => this.chatter(), this.chatterMs);
      this.chatterTimer.unref?.();
    }
    if (!any || !this.toggles.chatter) {
      if (this.chatterTimer) clearInterval(this.chatterTimer);
      this.chatterTimer = null;
    }
    if (!any && this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  chatter(): SlackMessage {
    const c = CHATTER[this.chatterIndex++ % CHATTER.length];
    return this.post(c.channel, c.user, c.text, c.thread ? { thread_ts: THREAD_TS } : {});
  }

  // ---- admin: faults and toggles -----------------------------------------------------
  admin(input: Record<string, unknown>): Record<string, unknown> {
    const n = (v: unknown, d: number, max: number) => Math.max(0, Math.min(max, Number.isFinite(Number(v)) && v !== undefined ? Number(v) : d));
    switch (input.fault) {
      // {count}: the next count calls get 429; without count, every call for retryAfter
      // seconds does (a rate-limit window, as Slack's per-method limits behave).
      case "ratelimit":
        this.faults.retryAfter = n(input.retryAfter, 3, 120);
        if (input.count !== undefined) this.faults.ratelimit = n(input.count, 1, 100);
        else this.faults.ratelimitUntil = Date.now() + this.faults.retryAfter * 1000;
        break;
      case "latency":
        this.faults.latencyMs = n(input.ms, 1500, 30_000);
        this.faults.latencyUntil = Date.now() + n(input.durationMs, 10_000, 300_000);
        break;
      case "disconnect":
        this.disconnectAll(input.reason === "warning" ? "warning" : "refresh_requested", input.reason === "warning" ? 1000 : 100);
        break;
      case "drop_ack":
        this.faults.dropAcks = n(input.count, 1, 100);
        break;
      case "stall":
        this.faults.stallUntil = Date.now() + n(input.ms, 25_000, 300_000);
        break;
      case "post": {
        const channel = String(input.channel ?? "C0PROJECT1");
        if (!this.messages[channel]) throw new Error(`no channel ${channel}`);
        this.post(channel, String(input.user ?? "U0ALICE01"), String(input.text ?? "Hello from the mock"), input.thread_ts ? { thread_ts: String(input.thread_ts) } : {});
        break;
      }
      case undefined:
        break;
      default:
        throw new Error("fault must be ratelimit, latency, disconnect, drop_ack, stall or post");
    }
    const set = (input.set ?? {}) as Record<string, unknown>;
    for (const k of ["nonMarketplace", "repliedSubtypeBug", "chatter"] as const) if (typeof set[k] === "boolean") this.toggles[k] = set[k] as boolean;
    if (input.reset) {
      Object.assign(this.faults, { ratelimit: 0, ratelimitUntil: 0, latencyMs: 0, latencyUntil: 0, dropAcks: 0, stallUntil: 0 });
      this.limiter.clear();
    }
    this.timers();
    return { ok: true, toggles: { ...this.toggles }, faults: { ...this.faults }, sockets: this.sockets.size, counters: this.counters };
  }

  close(): void {
    for (const s of [...this.sockets]) this.dropSocket(s);
    if (this.chatterTimer) clearInterval(this.chatterTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.chatterTimer = this.pingTimer = null;
  }
}
