// Slack widget data source. Each watch loads its view (channel list, channel history or
// thread) over the Web API, then follows Socket Mode events for it. One socket per
// account is shared by every widget on that account (AccountLink).
//
// Status mapping (specs/plugin-widgets.md):
//   auth.test ok and data loaded, socket up ............................. live
//   429 (Retry-After), missed socket heartbeat, disconnect frame ......... stale, then retry/reconnect
//   after a reconnect: backfill with conversations.history oldest=<last ts seen>
//   auth / scope / channel errors (invalid_auth, token_revoked, …) ...... error
//
// Accounts are names; tokens never leave the server. "mock", "mock-revoked" and
// "mock-noscope" use the in-process mock (./mock); BUNNY_SLACK_ACCOUNTS (JSON
// {"name":{"botToken":"xoxb-…","appToken":"xapp-…","label":"…"}}) adds real workspaces.

import { SLACK_TS_RE, type SlackConfig, type SlackData, type SlackMsg } from "../../../shared/widgets/slack";
import type { WidgetEmit, WidgetOption, WidgetSource } from "../types";
import { FATAL_SLACK_ERRORS, SlackApiError, type SlackChannel, type SlackMessage } from "./api";
import { LiveSlackClient, MockSlackClient, type SlackClient, type SocketConn } from "./client";
import { MockSlack, type MockOptions } from "./mock/server";

export interface SlackAccount {
  name: string;
  label: string;
  kind: "mock" | "live";
  botToken: string;
  appToken: string | null;
}

export function slackAccounts(env: Record<string, string | undefined> = process.env): SlackAccount[] {
  const out: SlackAccount[] = [
    { name: "mock", label: "Mock workspace (T0MOCK001)", kind: "mock", botToken: "xoxb-mock-valid", appToken: "xapp-mock" },
    { name: "mock-revoked", label: "Mock workspace, revoked token", kind: "mock", botToken: "xoxb-mock-revoked", appToken: "xapp-mock" },
    { name: "mock-noscope", label: "Mock workspace, missing scopes", kind: "mock", botToken: "xoxb-mock-noscope", appToken: "xapp-mock" },
  ];
  const raw = env.BUNNY_SLACK_ACCOUNTS;
  if (raw) {
    try {
      for (const [name, a] of Object.entries(JSON.parse(raw) as Record<string, { botToken?: string; appToken?: string; label?: string }>)) {
        if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name) || name.startsWith("mock") || !a.botToken) continue;
        out.push({ name, label: a.label ?? name, kind: "live", botToken: a.botToken, appToken: a.appToken ?? null });
      }
    } catch {
      /* a malformed BUNNY_SLACK_ACCOUNTS adds nothing */
    }
  }
  return out;
}

function reasonOf(e: unknown): { reason: string; fatal: boolean; retryAfter?: number } {
  if (e instanceof SlackApiError) {
    if (e.code === "ratelimited") return { reason: `ratelimited (retry in ${e.extra.retryAfter ?? 30}s)`, fatal: false, retryAfter: e.extra.retryAfter ?? 30 };
    const needed = e.extra.needed ? ` (needs ${e.extra.needed})` : "";
    return { reason: `${e.code}${needed}`, fatal: FATAL_SLACK_ERRORS.has(e.code) };
  }
  return { reason: (e as Error)?.message ?? String(e), fatal: false };
}

interface Sub {
  onUp(): void;
  onDown(reason: string): void;
  onEvent(ev: SlackMessage & { type: string }): void;
}

// One Socket Mode connection per account, shared by its widgets, with reconnects and a
// heartbeat watchdog (any frame or WebSocket ping counts as a beat).
class AccountLink {
  private conn: SocketConn | null = null;
  private readonly subs = new Set<Sub>();
  private lastBeat = 0;
  private openedAt = 0;
  up = false;
  downReason = "connecting";
  private connecting = false;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  constructor(
    private readonly client: SlackClient,
    private readonly heartbeatMs: number,
  ) {}

  retain(sub: Sub): void {
    this.subs.add(sub);
    if (this.up) sub.onUp();
    if (this.subs.size === 1) this.start();
  }

  // True when that was the last widget: the socket and timers are gone.
  release(sub: Sub): boolean {
    this.subs.delete(sub);
    if (this.subs.size) return false;
    this.stop();
    return true;
  }

  healthy(): boolean {
    return this.up && Date.now() - this.lastBeat < this.heartbeatMs;
  }

  private start(): void {
    if (!this.watchdog) {
      this.watchdog = setInterval(() => {
        if (this.up && Date.now() - this.lastBeat >= this.heartbeatMs) this.down(`missed heartbeat (${Math.round(this.heartbeatMs / 1000)}s)`, true);
        // Connected but no hello: give up on this connection and open another.
        else if (!this.up && this.conn && Date.now() - this.openedAt >= this.heartbeatMs) this.down("no hello from Socket Mode", true, 1000);
      }, Math.max(250, Math.floor(this.heartbeatMs / 3)));
      this.watchdog.unref?.();
    }
    void this.connect();
  }

  private stop(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.retry) clearTimeout(this.retry);
    this.watchdog = this.retry = null;
    this.up = false;
    const c = this.conn;
    this.conn = null;
    c?.close();
  }

  private down(reason: string, reconnect: boolean, delayMs = 0): void {
    const wasUp = this.up;
    this.up = false;
    this.downReason = reason;
    const c = this.conn;
    this.conn = null;
    c?.close();
    if (wasUp || reconnect) for (const s of this.subs) s.onDown(reason);
    if (reconnect && this.subs.size) this.schedule(delayMs);
  }

  private schedule(ms: number): void {
    if (this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.connect();
    }, ms);
    this.retry.unref?.();
  }

  private async connect(): Promise<void> {
    if (this.connecting || this.conn || !this.subs.size) return;
    this.connecting = true;
    try {
      let mine: SocketConn | null = null;
      mine = await this.client.connect({
        onHello: () => {
          if (this.conn !== mine) return;
          this.attempt = 0;
          this.up = true;
          this.lastBeat = Date.now();
          for (const s of this.subs) s.onUp();
        },
        onBeat: () => {
          if (this.conn === mine) this.lastBeat = Date.now();
        },
        onEvent: (ev) => {
          if (this.conn !== mine) return;
          for (const s of this.subs) s.onEvent(ev);
        },
        // Slack asks for a new connection: open it at once.
        onDisconnect: (reason) => {
          if (this.conn === mine) this.down(`disconnected (${reason})`, true, 0);
        },
        onClose: () => {
          if (this.conn === mine) this.down("socket closed", true, Math.min(30_000, 500 * 2 ** this.attempt++));
        },
      });
      if (!this.subs.size) mine.close();
      else {
        this.conn = mine;
        this.openedAt = Date.now();
      }
    } catch (e) {
      const r = reasonOf(e);
      for (const s of this.subs) s.onDown(r.reason);
      this.schedule(r.retryAfter ? r.retryAfter * 1000 : r.fatal ? 60_000 : Math.min(30_000, 1000 * 2 ** this.attempt++));
    } finally {
      this.connecting = false;
    }
  }
}

export interface SlackSourceOptions {
  mock?: MockSlack;
  mockOptions?: MockOptions;
  accounts?: SlackAccount[];
  // No socket frame or ping for this long: stale, reconnect. Mock pings every 5 s.
  heartbeatMs?: { mock: number; live: number };
  // How often a healthy widget re-confirms "live" (feeds the hub's stale deadline).
  confirmMs?: number;
  // How many recent channel messages a widget keeps.
  keep?: number;
}

export type SlackSource = WidgetSource<SlackConfig> & { mock: MockSlack; accounts: SlackAccount[]; close(): void; stats(): { watches: number; links: number; mockSockets: number } };

export function slackSource(opts: SlackSourceOptions = {}): SlackSource {
  const mock = opts.mock ?? new MockSlack(opts.mockOptions);
  const accounts = opts.accounts ?? slackAccounts();
  const heartbeat = opts.heartbeatMs ?? { mock: 15_000, live: 90_000 };
  const confirmMs = opts.confirmMs ?? 5000;
  const keep = opts.keep ?? 50;
  const clients = new Map<string, SlackClient>();
  const links = new Map<string, AccountLink>();
  const names = new Map<string, Map<string, string>>();
  const resyncs = new Set<{ kind: "mock" | "live"; fn: () => void }>();

  const account = (name: string) => {
    const a = accounts.find((x) => x.name === name);
    if (!a) throw new SlackApiError("unknown_account", "config", {});
    return a;
  };
  const clientFor = (a: SlackAccount): SlackClient => {
    let c = clients.get(a.name);
    if (!c) clients.set(a.name, (c = a.kind === "mock" ? new MockSlackClient(mock, a.botToken, a.appToken) : new LiveSlackClient(a.botToken, a.appToken)));
    return c;
  };
  const linkFor = (a: SlackAccount): AccountLink => {
    let l = links.get(a.name);
    if (!l) links.set(a.name, (l = new AccountLink(clientFor(a), heartbeat[a.kind])));
    return l;
  };
  // Display names, cached per account (users.info once per user).
  const userName = async (a: SlackAccount, client: SlackClient, id: string | undefined): Promise<string> => {
    if (!id) return "bot";
    let m = names.get(a.name);
    if (!m) names.set(a.name, (m = new Map()));
    const hit = m.get(id);
    if (hit) return hit;
    try {
      const u = await client.userInfo(id);
      const n = (u.profile.display_name || u.real_name || u.name) + (u.deleted ? " (deactivated)" : "");
      m.set(id, n);
      return n;
    } catch {
      return id;
    }
  };

  function watch(config: SlackConfig, emit: WidgetEmit): () => void {
    let a: SlackAccount;
    try {
      a = account(config.account);
    } catch {
      emit({ status: "error", reason: `unknown_account: ${config.account}` });
      return () => {};
    }
    if (config.thread_ts && !config.channel) {
      emit({ status: "error", reason: "thread_ts needs a channel" });
      return () => {};
    }
    const client = clientFor(a);
    const link = linkFor(a);
    let disposed = false;
    let team = "";
    let chan: SlackChannel | null = null;
    let synced = false;
    let blocked: string | null = null; // waiting out a 429 or a failed load
    let fatal: string | null = null;
    let loading = false;
    let again = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let lastTs = "";
    let channelsData: SlackData | null = null;
    let parent: SlackMsg | null = null;
    const msgs = new Map<string, SlackMsg>();

    const toMsg = async (m: SlackMessage): Promise<SlackMsg> => ({
      ts: m.ts,
      user: m.user,
      userName: await userName(a, client, m.user),
      text: m.text ?? "",
      ...(m.thread_ts ? { thread_ts: m.thread_ts } : {}),
      ...(m.reply_count ? { reply_count: m.reply_count } : {}),
      ...(m.subtype === "thread_broadcast" ? { broadcast: true } : {}),
      ...(m.bot_id ? { bot: true } : {}),
    });
    const seen = (ts: string) => {
      if (!lastTs || Number(ts) > Number(lastTs)) lastTs = ts;
    };
    const data = (): SlackData | null => {
      if (!config.channel) return channelsData;
      if (!chan) return null;
      const channel = { id: chan.id, name: chan.name, is_private: chan.is_private };
      const list = [...msgs.values()].sort((x, y) => Number(x.ts) - Number(y.ts));
      if (config.thread_ts) return { view: "thread", team, channel, parent, messages: list };
      return { view: "channel", team, channel, messages: list.slice(-keep) };
    };
    const publish = () => {
      if (disposed || fatal) return;
      if (blocked) emit({ status: "stale", data: data(), reason: blocked });
      else if (!link.up && link.downReason === "connecting") emit({ status: "connecting", data: data(), reason: "connecting to Socket Mode" });
      else if (!link.up) emit({ status: "stale", data: data(), reason: link.downReason });
      else emit({ status: "live", data: data() });
    };
    const fail = (e: unknown) => {
      // A widget deleted while its call was in flight schedules nothing.
      if (disposed) return;
      const r = reasonOf(e);
      if (r.fatal) {
        fatal = r.reason;
        emit({ status: "error", reason: r.reason });
        return;
      }
      blocked = r.reason;
      publish();
      if (retry) clearTimeout(retry);
      retry = setTimeout(() => {
        retry = null;
        void load();
      }, (r.retryAfter ?? 5) * 1000);
      retry.unref?.();
    };

    // First load, or a backfill of what was missed while the socket was down.
    async function load(): Promise<void> {
      if (disposed || fatal) return;
      if (loading) {
        again = true;
        return;
      }
      loading = true;
      try {
        if (!team) team = (await client.authTest()).team;
        if (!config.channel) {
          const list = await client.allConversations();
          channelsData = { view: "channels", team, channels: list.map((c) => ({ id: c.id, name: c.name, is_private: c.is_private, is_member: c.is_member, num_members: c.num_members })) };
        } else {
          if (!chan) chan = await client.conversationInfo(config.channel);
          if (config.thread_ts) {
            // A thread is short: re-read it whole (oldest= would drop the parent).
            const all: SlackMessage[] = [];
            let cursor = "";
            for (let i = 0; i < 20; i++) {
              const page = await client.replies(config.channel, config.thread_ts, { cursor: cursor || undefined, limit: 200 });
              all.push(...page.items);
              cursor = page.nextCursor;
              if (!cursor) break;
            }
            const [head, ...rest] = all;
            parent = head ? await toMsg(head) : null;
            msgs.clear();
            for (const m of rest) {
              msgs.set(m.ts, await toMsg(m));
              seen(m.ts);
            }
          } else {
            // Backfill pages forward from the last ts seen; the first load takes the latest page.
            let cursor = "";
            for (let i = 0; i < 10; i++) {
              const page = await client.history(config.channel, { limit: lastTs ? 100 : 30, cursor: cursor || undefined, ...(lastTs ? { oldest: lastTs } : {}) });
              for (const m of page.items) {
                msgs.set(m.ts, await toMsg(m));
                seen(m.ts);
              }
              cursor = page.nextCursor;
              if (!lastTs || !cursor) break;
            }
            for (const ts of [...msgs.keys()].sort((x, y) => Number(x) - Number(y)).slice(0, Math.max(0, msgs.size - keep))) msgs.delete(ts);
          }
        }
        synced = true;
        blocked = null;
        publish();
      } catch (e) {
        fail(e);
      } finally {
        loading = false;
        if (again && !disposed) {
          again = false;
          void load();
        }
      }
    }

    const onEvent = async (ev: SlackMessage & { type: string }) => {
      if (disposed || ev.type !== "message" || ev.channel !== config.channel || !synced) return;
      // message_replied (its subtype may be missing: Slack's documented bug) and
      // message_changed carry the updated message nested; never show them as new messages.
      if (ev.message) {
        const inner = ev.message;
        const cur = msgs.get(inner.ts);
        if (cur) msgs.set(inner.ts, { ...cur, text: inner.text ?? cur.text, ...(inner.reply_count ? { reply_count: inner.reply_count } : {}) });
        if (parent && inner.ts === parent.ts) parent = { ...parent, ...(inner.reply_count ? { reply_count: inner.reply_count } : {}) };
        publish();
        return;
      }
      if (ev.subtype === "message_deleted") return;
      const isReply = !!ev.thread_ts && ev.thread_ts !== ev.ts;
      if (config.thread_ts) {
        if (!isReply || ev.thread_ts !== config.thread_ts) return;
      } else if (isReply && ev.subtype !== "thread_broadcast") {
        const p = msgs.get(ev.thread_ts!);
        if (p) msgs.set(p.ts, { ...p, reply_count: (p.reply_count ?? 0) + 1 });
        publish();
        return;
      }
      msgs.set(ev.ts, await toMsg(ev));
      seen(ev.ts);
      if (!config.thread_ts) for (const ts of [...msgs.keys()].sort((x, y) => Number(x) - Number(y)).slice(0, Math.max(0, msgs.size - keep))) msgs.delete(ts);
      publish();
    };

    const sub: Sub = {
      onUp: () => {
        // (Re)connected: backfill what the socket missed (the first load is already running).
        if (synced || !loading) void load();
        else publish();
      },
      onDown: () => publish(),
      onEvent: (ev) => void onEvent(ev),
    };
    emit({ status: "connecting" });
    link.retain(sub);
    void load();
    const confirm = setInterval(() => {
      if (synced && !blocked && !fatal && link.healthy()) emit({ status: "live" });
      else if (synced && !fatal && !link.up) publish();
    }, confirmMs);
    confirm.unref?.();
    const resync = { kind: a.kind, fn: () => void load() };
    resyncs.add(resync);
    return () => {
      disposed = true;
      clearInterval(confirm);
      if (retry) clearTimeout(retry);
      resyncs.delete(resync);
      if (link.release(sub) && links.get(a.name) === link) links.delete(a.name);
    };
  }

  async function options(field: string, config: SlackConfig): Promise<WidgetOption[]> {
    if (field === "account") return accounts.map((a) => ({ value: a.name, label: a.label }));
    const a = account(config.account);
    const client = clientFor(a);
    if (field === "channel") {
      const list = await client.allConversations();
      return list
        .sort((x, y) => Number(y.is_member) - Number(x.is_member) || x.name.localeCompare(y.name))
        .map((c) => ({ value: c.id, label: `${c.is_private ? "" : "#"}${c.name}${c.is_private ? " (private)" : ""}${c.is_member ? "" : " (bot not a member)"}` }));
    }
    if (field === "thread_ts") {
      if (!config.channel) return [];
      const page = await client.history(config.channel, { limit: 100 });
      return page.items
        .filter((m) => (m.reply_count ?? 0) > 0)
        .map((m) => {
          const t = (m.text ?? "").replace(/\s+/g, " ");
          return { value: m.ts, label: `${t.length > 48 ? `${t.slice(0, 47)}…` : t} · ${m.reply_count} replies` };
        });
    }
    return [];
  }

  async function action(config: SlackConfig, name: string, input: Record<string, unknown>): Promise<unknown> {
    if (name !== "post") throw new Error("slack widget actions: post");
    if (!config.channel) throw new Error("pick a channel before posting");
    const text = typeof input.text === "string" ? input.text.slice(0, 4000) : "";
    if (config.thread_ts && !SLACK_TS_RE.test(config.thread_ts)) throw new Error("bad thread_ts");
    try {
      const out = await clientFor(account(config.account)).postMessage(config.channel, text, config.thread_ts ? { thread_ts: config.thread_ts } : {});
      return { ok: true, ts: out.ts };
    } catch (e) {
      throw new Error(reasonOf(e).reason);
    }
  }

  // Mock controls: faults, toggles, a message as a user. A 429 or latency fault also
  // makes every mock widget resync at once, so the fault shows up on the next call.
  function admin(input: Record<string, unknown>): unknown {
    const out = mock.admin(input);
    if (input.fault === "ratelimit" || input.fault === "latency" || input.resync) for (const r of resyncs) if (r.kind === "mock") r.fn();
    return out;
  }

  return {
    id: "slack",
    watch,
    options,
    action,
    admin,
    mock,
    accounts,
    close: () => mock.close(),
    stats: () => ({ watches: resyncs.size, links: links.size, mockSockets: mock.sockets.size }),
  };
}
