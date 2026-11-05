// SlackClient: the Web API calls and Socket Mode connection the Slack widget needs.
// One implementation (SlackWebClient) speaks the documented wire format; it runs over a
// transport. MockSlackClient uses the in-process mock (./mock) and LiveSlackClient uses
// fetch + WebSocket against slack.com. Both pass the same contract suite
// (test/slack-contract.ts), so the mock is held to Slack's public shapes.

import WebSocket from "ws";
import { type AuthTest, type EventCallback, type Page, SlackApiError, type SlackChannel, type SlackMessage, type SlackUser, type SocketFrame } from "./api";
import type { MockSlack } from "./mock/server";

export type Params = Record<string, string | number | boolean | undefined>;

export interface HttpReply {
  status: number;
  headers: Record<string, string>;
  // biome-ignore lint/suspicious/noExplicitAny: Slack JSON, checked per method.
  body: any;
}

// Minimal WebSocket surface (ws and the mock socket both provide it).
export interface SocketLike {
  on(ev: "message", fn: (data: string | Buffer) => void): unknown;
  on(ev: "ping", fn: () => void): unknown;
  on(ev: "close", fn: (code?: number) => void): unknown;
  on(ev: "error", fn: (e: Error) => void): unknown;
  send(data: string): void;
  close(): void;
}

export interface SlackTransport {
  call(method: string, token: string, params: Params): Promise<HttpReply>;
  openSocket(url: string): SocketLike;
}

export interface SocketHandlers {
  onHello(): void;
  onEvent(event: EventCallback["event"], payload: EventCallback): void;
  // A sign of life: any frame or WebSocket ping.
  onBeat(): void;
  onDisconnect(reason: string): void;
  onClose(): void;
}

export interface SocketConn {
  close(): void;
  // Envelopes acked so far (contract test proof).
  readonly acked: number;
}

export interface SlackClient {
  readonly kind: "mock" | "live";
  authTest(): Promise<AuthTest>;
  conversationsList(opts?: { types?: string; limit?: number; cursor?: string; exclude_archived?: boolean }): Promise<Page<SlackChannel>>;
  allConversations(types?: string): Promise<SlackChannel[]>;
  conversationInfo(channel: string): Promise<SlackChannel>;
  history(channel: string, opts?: { limit?: number; cursor?: string; oldest?: string; latest?: string; inclusive?: boolean }): Promise<Page<SlackMessage>>;
  replies(channel: string, ts: string, opts?: { limit?: number; cursor?: string; oldest?: string }): Promise<Page<SlackMessage>>;
  userInfo(user: string): Promise<SlackUser>;
  postMessage(channel: string, text: string, opts?: { thread_ts?: string; reply_broadcast?: boolean }): Promise<{ channel: string; ts: string; message: SlackMessage }>;
  connect(handlers: SocketHandlers): Promise<SocketConn>;
}

export class SlackWebClient implements SlackClient {
  constructor(
    readonly kind: "mock" | "live",
    private readonly botToken: string,
    private readonly appToken: string | null,
    private readonly transport: SlackTransport,
  ) {}

  // biome-ignore lint/suspicious/noExplicitAny: Slack JSON.
  async call(method: string, params: Params = {}, token = this.botToken): Promise<any> {
    const r = await this.transport.call(method, token, params);
    if (r.status === 429) throw new SlackApiError("ratelimited", method, { retryAfter: Number(r.headers["retry-after"] ?? 30), status: 429 });
    if (r.status >= 400 && !r.body?.error) throw new SlackApiError(`http_${r.status}`, method, { status: r.status });
    if (!r.body?.ok) throw new SlackApiError(String(r.body?.error ?? "unknown_error"), method, { needed: r.body?.needed, provided: r.body?.provided });
    return r.body;
  }

  async authTest(): Promise<AuthTest> {
    return this.call("auth.test");
  }

  async conversationsList(opts: { types?: string; limit?: number; cursor?: string; exclude_archived?: boolean } = {}): Promise<Page<SlackChannel>> {
    const b = await this.call("conversations.list", { types: opts.types ?? "public_channel,private_channel", limit: opts.limit ?? 200, cursor: opts.cursor, exclude_archived: opts.exclude_archived ?? true });
    return { items: b.channels, nextCursor: b.response_metadata?.next_cursor ?? "" };
  }

  async allConversations(types?: string): Promise<SlackChannel[]> {
    const out: SlackChannel[] = [];
    let cursor = "";
    for (let i = 0; i < 50; i++) {
      const page = await this.conversationsList({ types, cursor: cursor || undefined });
      out.push(...page.items);
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  async conversationInfo(channel: string): Promise<SlackChannel> {
    return (await this.call("conversations.info", { channel })).channel;
  }

  async history(channel: string, opts: { limit?: number; cursor?: string; oldest?: string; latest?: string; inclusive?: boolean } = {}): Promise<Page<SlackMessage>> {
    const b = await this.call("conversations.history", { channel, ...opts });
    return { items: b.messages, nextCursor: b.response_metadata?.next_cursor ?? "", hasMore: !!b.has_more };
  }

  async replies(channel: string, ts: string, opts: { limit?: number; cursor?: string; oldest?: string } = {}): Promise<Page<SlackMessage>> {
    const b = await this.call("conversations.replies", { channel, ts, ...opts });
    return { items: b.messages, nextCursor: b.response_metadata?.next_cursor ?? "", hasMore: !!b.has_more };
  }

  async userInfo(user: string): Promise<SlackUser> {
    return (await this.call("users.info", { user })).user;
  }

  async postMessage(channel: string, text: string, opts: { thread_ts?: string; reply_broadcast?: boolean } = {}) {
    const b = await this.call("chat.postMessage", { channel, text, ...opts });
    return { channel: b.channel, ts: b.ts, message: b.message };
  }

  // Socket Mode: apps.connections.open with the app-level token, then one WebSocket.
  // Every events_api envelope is acked with {envelope_id} before it is handled.
  async connect(h: SocketHandlers): Promise<SocketConn> {
    if (!this.appToken) throw new SlackApiError("no_app_token", "apps.connections.open");
    const { url } = await this.call("apps.connections.open", {}, this.appToken);
    const ws = this.transport.openSocket(url);
    let acked = 0;
    let closed = false;
    const seen = new Set<string>();
    ws.on("ping", () => h.onBeat());
    ws.on("error", () => undefined);
    ws.on("close", () => {
      if (closed) return;
      closed = true;
      h.onClose();
    });
    ws.on("message", (raw) => {
      let f: SocketFrame;
      try {
        f = JSON.parse(String(raw));
      } catch {
        return;
      }
      h.onBeat();
      if (f.type === "hello") h.onHello();
      else if (f.type === "disconnect") h.onDisconnect(f.reason);
      else if (f.type === "events_api") {
        ws.send(JSON.stringify({ envelope_id: f.envelope_id }));
        acked++;
        // A redelivery (retry_attempt > 0) of an event already handled is acked, not replayed.
        if (seen.has(f.payload.event_id)) return;
        seen.add(f.payload.event_id);
        if (seen.size > 2000) seen.delete(seen.values().next().value as string);
        h.onEvent(f.payload.event, f.payload);
      }
    });
    return {
      close() {
        if (closed) return;
        closed = true;
        ws.close();
      },
      get acked() {
        return acked;
      },
    };
  }
}

export class MockSlackClient extends SlackWebClient {
  constructor(mock: MockSlack, botToken: string, appToken: string | null = "xapp-mock") {
    super("mock", botToken, appToken, { call: (m, t, p) => mock.request(m, t, p), openSocket: (url) => mock.openSocket(url) });
  }
}

// The real Slack Web API (form-encoded POSTs with a bearer token) and Socket Mode.
export class LiveSlackClient extends SlackWebClient {
  constructor(botToken: string, appToken: string | null, base = "https://slack.com/api") {
    super("live", botToken, appToken, {
      async call(method, token, params) {
        const form = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) if (v !== undefined) form.set(k, String(v));
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 15_000);
        const res = await fetch(`${base}/${method}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" }, body: form.toString(), signal: ctl.signal }).finally(() => clearTimeout(timer));
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
        let body: unknown = null;
        try {
          body = await res.json();
        } catch {
          body = { ok: false, error: `http_${res.status}` };
        }
        return { status: res.status, headers, body };
      },
      openSocket: (url) => new WebSocket(url) as unknown as SocketLike,
    });
  }
}
