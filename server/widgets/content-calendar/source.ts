// Content calendar data source: reads a self-hosted Postiz's channels and the posts in the
// configured week or month once a minute, and reports them as the widget's data. Read-only.
//
// Board server settings (environment; never in the widget config or the document):
//   POSTIZ_URL       the Postiz URL, e.g. https://postiz.example.com (the public
//                    API is found under /api/public/v1 or /public/v1), or "mock" for the
//                    built-in sample calendar (./mock), or "mock-empty" for a Postiz with no
//                    channels or posts
//   POSTIZ_API_KEY   the Postiz public API key (Settings › Public API); optional for "mock"
//   POSTIZ_PUBLIC_URL  the Postiz web app as people's browsers reach it, for "Open in Postiz"
//                    and post links (default: POSTIZ_URL; none for the mock unless set)
//   POSTIZ_TIMEZONE  the zone weeks and days are counted in (default: the server's)
//   POSTIZ_POLL_SEC  how often to read, 15-600 seconds (default 60)
//
// Status mapping:
//   channels and posts read ........................................ live
//   unreachable (refused, timeout, 5xx, not JSON) with data shown ..... stale  postiz_unreachable (…)
//   unreachable before any data ...................................... error  postiz_unreachable (…)
//   401 from Postiz ................................................... error  invalid_key (…)
//   POSTIZ_URL / POSTIZ_API_KEY unset ................................. error  not_configured (…)
// Every failure retries at the next poll.

import {
  type CalendarChannel,
  type CalendarPost,
  type CalendarPostStatus,
  type ContentCalendarConfig,
  type ContentCalendarData,
  calendarRange,
  postizCalendarUrl,
  postizPreviewUrl,
  postPreview,
  validTimeZone,
} from "../../../shared/widgets/content-calendar";
import type { WidgetEmit, WidgetOption, WidgetSource } from "../types";
import { PostizApiError, type PostizIntegration, type PostizPost, type PostizState } from "./api";
import { LivePostizClient, MockPostizClient, type PostizClient } from "./client";
import { MOCK_POSTIZ_KEY, MockPostiz } from "./mock";

const STATUS: Record<PostizState, CalendarPostStatus> = { QUEUE: "scheduled", DRAFT: "draft", PUBLISHED: "published", ERROR: "error" };

export interface ContentCalendarOptions {
  env?: Record<string, string | undefined>;
  now?: () => number;
  pollMs?: number;
  // Tests: use this client instead of one built from the environment.
  client?: PostizClient;
  timeZone?: string;
}

export type PostizSetup = { kind: "mock" | "live"; client: PostizClient; mock: MockPostiz | null } | { error: string };

export function postizSetup(env: Record<string, string | undefined>, now: () => number, timeZone: string): PostizSetup {
  const url = (env.POSTIZ_URL ?? "").trim();
  const key = (env.POSTIZ_API_KEY ?? "").trim();
  if (url === "mock" || url === "mock-empty") {
    const mock = new MockPostiz({ now, timeZone, empty: url === "mock-empty" });
    return { kind: "mock", client: new MockPostizClient(mock, key || MOCK_POSTIZ_KEY), mock };
  }
  if (!url || !key) return { error: `not_configured (set ${!url ? "POSTIZ_URL" : ""}${!url && !key ? " and " : ""}${!key ? "POSTIZ_API_KEY" : ""} on the board server)` };
  if (!/^https?:\/\/[^/\s]+/i.test(url)) return { error: "not_configured (POSTIZ_URL must be an http(s) URL)" };
  return { kind: "live", client: new LivePostizClient(url, key), mock: null };
}

// The Postiz web app's base for links people click: POSTIZ_PUBLIC_URL, else POSTIZ_URL (a
// mock has none unless POSTIZ_PUBLIC_URL is set). An API path (/api, /public/v1) is dropped;
// only a plain http(s) URL without credentials, query or fragment is used. Only this URL
// reaches the canvas, never the key.
export function postizPublicBase(env: Record<string, string | undefined>): string | null {
  const url = (env.POSTIZ_URL ?? "").trim();
  const raw = (env.POSTIZ_PUBLIC_URL ?? "").trim() || (url.startsWith("mock") ? "" : url);
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || u.search || u.hash) return null;
    const path = u.pathname.replace(/\/+$/, "").replace(/(\/api)?(\/public\/v1)?$/, "");
    return `${u.origin}${path}`;
  } catch {
    return null;
  }
}

function toChannel(i: PostizIntegration): CalendarChannel {
  return { id: i.id, name: i.name, provider: i.identifier, disabled: !!i.disabled };
}

// A config's channel: an integration id, else a name, profile or provider (any case).
export function findChannel(channels: PostizIntegration[], wanted: string | undefined): PostizIntegration | undefined {
  if (!wanted) return undefined;
  const w = wanted.trim().toLowerCase().replace(/^@/, "");
  return channels.find((c) => c.id === wanted) ?? channels.find((c) => c.name.toLowerCase() === w) ?? channels.find((c) => (c.profile ?? "").toLowerCase() === w) ?? channels.find((c) => c.identifier.toLowerCase() === w);
}

function toPost(p: PostizPost, base: string | null, timeZone: string): CalendarPost {
  const at = Date.parse(p.publishDate);
  const week = calendarRange("week", at, timeZone);
  return {
    id: p.actualDate ? `${p.id}@${p.publishDate}` : p.id,
    at: new Date(p.publishDate).toISOString(),
    channelId: p.integration?.id ?? "",
    channel: p.integration?.name ?? "unknown channel",
    provider: p.integration?.providerIdentifier ?? "",
    status: STATUS[p.state] ?? "draft",
    preview: postPreview(p.content),
    ...(p.state === "ERROR" && p.error ? { error: String(p.error).slice(0, 200) } : {}),
    ...(p.releaseURL && /^https?:\/\//.test(p.releaseURL) ? { url: p.releaseURL } : {}),
    ...(p.intervalInDays ? { repeats: true } : {}),
    ...(base ? { previewUrl: postizPreviewUrl(base, p.id), calendarUrl: postizCalendarUrl(base, "week", week.from, week.to, timeZone) } : {}),
  };
}

export async function readCalendar(client: PostizClient, config: ContentCalendarConfig, now: number, timeZone: string, base: string | null = null): Promise<ContentCalendarData> {
  const { from, to } = calendarRange(config.range, now, timeZone);
  // Postiz's endDate is inclusive; the range is [from, to).
  const [integrations, posts] = await Promise.all([client.integrations(), client.posts({ startDate: new Date(from).toISOString(), endDate: new Date(to - 1).toISOString() })]);
  const ch = findChannel(integrations, config.channel);
  const shown = posts
    .filter((p) => {
      const t = Date.parse(p.publishDate);
      return t >= from && t < to;
    })
    .filter((p) => !config.channel || (ch ? p.integration?.id === ch.id : false))
    .map((p) => toPost(p, base, timeZone))
    .sort((a, b) => a.at.localeCompare(b.at) || a.channel.localeCompare(b.channel));
  return {
    range: config.range,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    timeZone,
    source: client.kind,
    channels: integrations.map(toChannel),
    ...(ch ? { channel: toChannel(ch) } : {}),
    posts: shown,
    readAt: new Date(now).toISOString(),
    ...(base ? { calendarUrl: postizCalendarUrl(base, config.range, from, to, timeZone) } : {}),
  };
}

function reasonOf(e: unknown): { reason: string; code: string } {
  if (e instanceof PostizApiError) return { code: e.code, reason: e.detail ? `${e.code} (${e.detail.slice(0, 120)})` : e.code };
  return { code: "postiz_unreachable", reason: `postiz_unreachable (${((e as Error)?.message ?? String(e)).slice(0, 120)})` };
}

export function contentCalendarSource(opts: ContentCalendarOptions = {}): WidgetSource<ContentCalendarConfig> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const timeZone = validTimeZone(opts.timeZone) ? opts.timeZone : validTimeZone(env.POSTIZ_TIMEZONE) ? env.POSTIZ_TIMEZONE : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const publicBase = postizPublicBase(env);
  const pollMs = opts.pollMs ?? Math.max(15, Math.min(600, Number(env.POSTIZ_POLL_SEC) || 60)) * 1000;
  // Built on first use, so the environment is read when a widget first needs it.
  let setup: PostizSetup | null = opts.client ? { kind: opts.client.kind, client: opts.client, mock: null } : null;
  const get = (): PostizSetup => (setup ??= postizSetup(env, now, timeZone));

  return {
    id: "content-calendar",
    watch(config, emit: WidgetEmit) {
      const s = get();
      if ("error" in s) {
        emit({ status: "error", reason: s.error });
        return () => {};
      }
      let stopped = false;
      let hadData = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const tick = async () => {
        timer = null;
        try {
          const data = await readCalendar(s.client, config, now(), timeZone, publicBase);
          if (stopped) return;
          hadData = true;
          emit({ status: "live", data });
        } catch (e) {
          if (stopped) return;
          const r = reasonOf(e);
          emit({ status: r.code === "postiz_unreachable" && hadData ? "stale" : "error", reason: r.reason });
        }
        if (stopped) return;
        timer = setTimeout(tick, pollMs);
        timer.unref?.();
      };
      void tick();
      return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
      };
    },
    async options(field) {
      if (field !== "channel") return [];
      const s = get();
      if ("error" in s) return [];
      const list = await s.client.integrations();
      return list.map((i): WidgetOption => ({ value: i.id, label: `${i.name} (${i.identifier}${i.disabled ? ", disabled" : ""})` }));
    },
    // Mock calendar only: {fault: "down" | "up", latencyMs}.
    admin(input) {
      const s = get();
      if ("error" in s || !s.mock) return null;
      return s.mock.admin(input);
    },
  };
}
