// Content calendar widget: the posts scheduled in a self-hosted Postiz (the content
// calendar on AF Phone), as a week or month agenda. Read-only: the widget never creates,
// edits, deletes or publishes a post. The Postiz URL and API key live on the board server
// only (POSTIZ_URL / POSTIZ_API_KEY, server/widgets/content-calendar); the config names a
// range and optionally one channel, and the data carries posts, never the key.

import { T } from "@tldraw/validate";
import type { WidgetManifest, WidgetState } from "./types";

export type CalendarRange = "week" | "month";

export interface ContentCalendarConfig {
  range: CalendarRange;
  // A Postiz integration (channel) id, or its name; leave out for every channel.
  channel?: string;
}

// Postiz post states QUEUE / DRAFT / PUBLISHED / ERROR, in plain words.
export type CalendarPostStatus = "scheduled" | "draft" | "published" | "error";

export interface CalendarChannel {
  id: string;
  name: string;
  // Postiz provider identifier, e.g. "x", "linkedin", "bluesky".
  provider: string;
  disabled: boolean;
}

export interface CalendarPost {
  id: string;
  // When it goes (or went) out, ISO.
  at: string;
  channelId: string;
  channel: string;
  provider: string;
  status: CalendarPostStatus;
  // The post's text, tags stripped, on one line and clipped.
  preview: string;
  // Postiz's own error text for a failed post.
  error?: string;
  // The published post's link, when Postiz has one.
  url?: string;
  // A repeating post (Postiz intervalInDays): this is one of its occurrences.
  repeats?: boolean;
  // Links into the Postiz web app (only when the board server knows its URL):
  // the post's preview page, and the calendar's week view at the post's date.
  previewUrl?: string;
  calendarUrl?: string;
}

export interface ContentCalendarData {
  range: CalendarRange;
  // The range read, [from, to) as ISO times, and the zone its days are counted in.
  from: string;
  to: string;
  timeZone: string;
  source: "mock" | "live";
  channels: CalendarChannel[];
  // The configured channel when one is set and found.
  channel?: CalendarChannel;
  posts: CalendarPost[];
  readAt: string;
  // The Postiz calendar on the range shown, for "Open in Postiz" (POSTIZ_PUBLIC_URL, else
  // POSTIZ_URL, on the board server). Never carries the API key.
  calendarUrl?: string;
}

// --- Dates in a named time zone (no date library on either side) -------------------

export interface ZonedParts {
  y: number;
  m: number; // 1-12
  d: number;
  hh: number;
  mm: number;
  // 0 = Monday … 6 = Sunday
  dow: number;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const fmtCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
    fmtCache.set(timeZone, f);
  }
  return f;
}

export function validTimeZone(tz: string | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function zonedParts(t: number | string, timeZone: string): ZonedParts {
  const ms = typeof t === "number" ? t : Date.parse(t);
  const p: Record<string, string> = {};
  for (const x of partsFormatter(timeZone).formatToParts(new Date(ms))) p[x.type] = x.value;
  const dowUS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday);
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), hh: Number(p.hour) % 24, mm: Number(p.minute), dow: dowUS };
}

// The instant of local midnight on y-m-d (month 1-12, days may overflow) in timeZone.
export function zonedMidnight(y: number, m: number, d: number, timeZone: string): number {
  const wall = Date.UTC(y, m - 1, d);
  let t = wall;
  // Two passes settle the offset, including across a DST change.
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(t, timeZone);
    const seen = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
    const next = t - (seen - wall);
    if (next === t) break;
    t = next;
  }
  return t;
}

// The week (Monday 00:00 to the next Monday) or month holding `now`, in timeZone.
export function calendarRange(range: CalendarRange, now: number, timeZone: string): { from: number; to: number } {
  const p = zonedParts(now, timeZone);
  if (range === "month") return { from: zonedMidnight(p.y, p.m, 1, timeZone), to: zonedMidnight(p.y, p.m + 1, 1, timeZone) };
  return { from: zonedMidnight(p.y, p.m, p.d - p.dow, timeZone), to: zonedMidnight(p.y, p.m, p.d - p.dow + 7, timeZone) };
}

const pad = (n: number) => String(n).padStart(2, "0");

// "Thu 10:00" in timeZone.
export function shortWhen(at: string | number, timeZone: string): string {
  const p = zonedParts(at, timeZone);
  return `${WEEKDAYS[p.dow]} ${pad(p.hh)}:${pad(p.mm)}`;
}

export function hhmm(at: string | number, timeZone: string): string {
  const p = zonedParts(at, timeZone);
  return `${pad(p.hh)}:${pad(p.mm)}`;
}

export { WEEKDAYS };

// --- Manifest ----------------------------------------------------------------------

const range = T.literalEnum("week", "month");
const channel = T.string.check((v) => {
  if (v.length > 120) throw new Error("channel must be at most 120 characters");
  if (/[\u0000-\u001f]/.test(v)) throw new Error("channel must be one line");
});

function nextScheduled(d: ContentCalendarData): CalendarPost | undefined {
  const now = Date.parse(d.readAt);
  return d.posts.find((p) => p.status === "scheduled" && Date.parse(p.at) >= now);
}

// Postiz web app links (v2.25.3): the calendar reads startDate / endDate (YYYY-MM-DD) and
// display (week | month | day | list) from /launches; a post's preview page is
// /p/<post id>?share=true. The post editor is a modal with no URL of its own.
export function ymd(t: number | string, timeZone: string): string {
  const p = zonedParts(t, timeZone);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

export function postizCalendarUrl(base: string, display: CalendarRange, from: number, to: number, timeZone: string): string {
  return `${base}/launches?startDate=${ymd(from, timeZone)}&endDate=${ymd(to - 1, timeZone)}&display=${display}`;
}

export function postizPreviewUrl(base: string, postId: string): string {
  return `${base}/p/${encodeURIComponent(postId)}?share=true`;
}

export const contentCalendarWidget: WidgetManifest<ContentCalendarConfig, ContentCalendarData> = {
  id: "content-calendar",
  label: "Content calendar",
  icon: "calendar",
  description: "Posts scheduled in the Postiz content calendar this week or month (read-only).",
  tagline: "The social posts lined up in Postiz, on the board.",
  about: "Shows the posts in your self-hosted Postiz content calendar for this week or this month: when each goes out, on which channel, whether it is a draft, scheduled, published or failed, and the start of its text. It refreshes every minute and never changes a post.",
  whyItMatters: "When an agent drafts or schedules posts, it can put the calendar next to its work so you see what it lined up, on which channel and when, without opening Postiz. A failed post shows in red with Postiz's reason, so nobody finds out from a quiet feed.",
  category: "Marketing",
  permissions: [
    { kind: "network", text: "The board server reads the Postiz public API (channels and posts for the range shown) once a minute. The API key stays on the server; the browser never sees it." },
    { kind: "data", text: "Read-only: it lists channels and posts and never creates, edits, deletes or publishes one." },
  ],
  media: [
    { kind: "image", src: "/plugin-media/content-calendar/week.png", caption: "This week's posts by day, with channel and status (mock Postiz)." },
    { kind: "video", src: "/plugin-media/content-calendar/clip.webm", poster: "/plugin-media/content-calendar/week.png", caption: "An agent adds the calendar; week, month and one channel (mock Postiz)." },
  ],
  version: "1.0.0",
  size: { w: 420, h: 480 },
  // Polled every minute: stale after two and a half missed reads.
  staleMs: 150_000,
  fields: [
    {
      key: "range",
      label: "Range",
      kind: "select",
      help: "week (default) or month",
      choices: [
        { value: "week", label: "This week" },
        { value: "month", label: "This month" },
      ],
    },
    { key: "channel", label: "Channel", kind: "select", help: "A Postiz channel id or name; leave out for every channel" },
  ],
  configProps: { range, channel: T.optional(channel) },
  defaults: () => ({ range: "week" }),
  configured: () => true,
  summary(c, s) {
    const ch = s?.data?.channel?.name ?? c.channel;
    return ch ? `${c.range} · ${ch}` : c.range;
  },
  describe(c, s: WidgetState<ContentCalendarData> | null) {
    const d = s?.data;
    if (!d) return "";
    const period = d.range === "month" ? "this month" : "this week";
    const count = (st: CalendarPostStatus) => d.posts.filter((p) => p.status === st).length;
    const scheduled = count("scheduled");
    const next = nextScheduled(d);
    const head = `${scheduled} scheduled ${period}${next ? `, next: ${next.channel} ${shortWhen(next.at, d.timeZone)}` : ""}`;
    const others = (["draft", "published", "error"] as const)
      .map((st) => [st, count(st)] as const)
      .filter(([, n]) => n > 0)
      .map(([st, n]) => `${n} ${st === "error" ? "failed" : st}`);
    const where = c.channel && !d.channel ? ` (channel ${JSON.stringify(c.channel)} not found)` : "";
    if (!d.posts.length) return `no posts ${period}${where}; ${d.channels.length} channel${d.channels.length === 1 ? "" : "s"} in Postiz`;
    return `${head}${others.length ? ` (${others.join(", ")})` : ""}${where}`;
  },
  // "Open in Postiz": the calendar on the range shown. Editing happens there, not here.
  headerLink(_c, s) {
    const href = s?.data?.calendarUrl;
    return href ? { href, label: "Open in Postiz", title: "Open this calendar in Postiz (new tab) to create, edit or reschedule posts" } : null;
  },
};

// Postiz post content is HTML; the widget shows plain text.
export function postPreview(html: string, max = 140): string {
  const text = String(html ?? "")
    .replace(/<\s*(br|\/p|\/div|\/li)\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
