// In-process fake of the Postiz public API (the read endpoints the widget uses), matching
// Postiz v2.25.3's shapes (./api.ts). Deterministic: the sample posts sit at fixed offsets
// from Monday 00:00 of the week holding `now` in `timeZone`, so this week always has posts
// and the same clock always gives the same calendar.
//
// Keys: "mock-valid" works; anything else is 401 {msg: "Invalid API key"}, no key is
// 401 {msg: "No API Key found"}. admin({fault: "down"}) makes every request fail like a
// refused connection until admin({fault: "up"}); {latencyMs} delays answers.

import { calendarRange } from "../../../shared/widgets/content-calendar";
import type { PostizIntegration, PostizPost, PostizState } from "./api";
import type { HttpReply } from "./client";

export const MOCK_POSTIZ_KEY = "mock-valid";

export const MOCK_INTEGRATIONS: PostizIntegration[] = [
  { id: "cm-int-x-0001", name: "Automate Friday", identifier: "x", picture: null, disabled: false, profile: "automatefriday" },
  { id: "cm-int-li-0002", name: "Automate Friday (LinkedIn)", identifier: "linkedin-page", picture: null, disabled: false, profile: "automate-friday" },
  { id: "cm-int-bs-0003", name: "automatefriday.bsky.social", identifier: "bluesky", picture: null, disabled: false, profile: "automatefriday.bsky.social" },
  { id: "cm-int-th-0004", name: "Threads (paused)", identifier: "threads", picture: null, disabled: true, profile: "automatefriday" },
];

interface Sample {
  id: string;
  // Days and minutes after Monday 00:00 of the anchor week (negative: earlier weeks).
  day: number;
  at: string; // "HH:MM"
  integration: string;
  state: PostizState;
  content: string;
  error?: string;
  intervalInDays?: number;
}

const SAMPLES: Sample[] = [
  { id: "post-m1", day: -4, at: "09:00", integration: "cm-int-x-0001", state: "PUBLISHED", content: "<p>Last week's recap: three automations we shipped for a dental clinic.</p>" },
  { id: "post-01", day: 0, at: "09:30", integration: "cm-int-li-0002", state: "PUBLISHED", content: "<p>Monday kickoff: what we are automating this week, and why the boring jobs go first.</p>" },
  { id: "post-02", day: 1, at: "12:15", integration: "cm-int-x-0001", state: "PUBLISHED", content: "<p>Thread: how an agent keeps a whiteboard tidy while it works (thread)</p>" },
  { id: "post-03", day: 2, at: "08:45", integration: "cm-int-bs-0003", state: "ERROR", content: "<p>New on the blog: running a content calendar on a phone.</p>", error: "Bluesky session expired; reconnect the channel" },
  { id: "post-04", day: 3, at: "10:00", integration: "cm-int-li-0002", state: "QUEUE", content: "<p>Case study: <strong>40 hours a month</strong> back for a 6-person agency.</p><p>Here is what we automated.</p>" },
  { id: "post-05", day: 3, at: "16:30", integration: "cm-int-x-0001", state: "QUEUE", content: "<p>Friday is for automation. What is the one task you would hand to an agent tomorrow?</p>" },
  { id: "post-06", day: 4, at: "09:00", integration: "cm-int-bs-0003", state: "QUEUE", content: "<p>Automate Friday #42 is out: agents, whiteboards &amp; a self-hosted Postiz.</p>" },
  { id: "post-07", day: 5, at: "11:00", integration: "cm-int-x-0001", state: "DRAFT", content: "<p>Draft: weekend reading list (needs links)</p>" },
  { id: "post-08", day: 9, at: "10:00", integration: "cm-int-li-0002", state: "QUEUE", content: "<p>Next week: a live build of a lead-intake agent.</p>" },
  { id: "post-r1", day: 0, at: "08:00", integration: "cm-int-th-0004", state: "QUEUE", content: "<p>Weekly: what's new this week</p>", intervalInDays: 7 },
];

const DAY = 86_400_000;

export interface MockPostizOptions {
  now?: () => number;
  timeZone?: string;
  latencyMs?: number;
  // The key it accepts (default MOCK_POSTIZ_KEY).
  apiKey?: string;
  // No channels and no posts, like a fresh Postiz.
  empty?: boolean;
}

export class MockPostiz {
  private down = false;
  private latencyMs: number;
  readonly requests: Array<{ path: string; query: Record<string, string> }> = [];
  private readonly now: () => number;
  private readonly timeZone: string;
  private readonly apiKey: string;
  private readonly empty: boolean;

  constructor(opts: MockPostizOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.timeZone = opts.timeZone ?? "UTC";
    this.latencyMs = opts.latencyMs ?? 0;
    this.apiKey = opts.apiKey ?? MOCK_POSTIZ_KEY;
    this.empty = !!opts.empty;
  }

  integrations(): PostizIntegration[] {
    return this.empty ? [] : MOCK_INTEGRATIONS;
  }

  // The stored posts (repeating ones once, at their first date).
  posts(): PostizPost[] {
    if (this.empty) return [];
    const monday = calendarRange("week", this.now(), this.timeZone).from;
    const byId = new Map(MOCK_INTEGRATIONS.map((i) => [i.id, i]));
    return SAMPLES.map((s) => {
      const [h, m] = s.at.split(":").map(Number);
      // Wall-clock offsets from Monday; good to the minute across a DST change within a week.
      const at = new Date(monday + s.day * DAY + (h * 60 + m) * 60_000).toISOString();
      const i = byId.get(s.integration)!;
      return {
        id: s.id,
        content: s.content,
        publishDate: at,
        releaseURL: s.state === "PUBLISHED" ? `https://example.invalid/${i.identifier}/${s.id}` : null,
        releaseId: s.state === "PUBLISHED" ? s.id : null,
        state: s.state,
        error: s.error ?? null,
        intervalInDays: s.intervalInDays ?? null,
        group: `group-${s.id}`,
        creationMethod: "API",
        settings: null,
        tags: [],
        integration: { id: i.id, providerIdentifier: i.identifier, name: i.name, picture: i.picture },
      };
    });
  }

  admin(input: Record<string, unknown>): { ok: true; down: boolean; latencyMs: number } {
    if (input.fault === "down") this.down = true;
    if (input.fault === "up") this.down = false;
    if (input.latencyMs !== undefined) this.latencyMs = Math.max(0, Math.min(30_000, Number(input.latencyMs) || 0));
    return { ok: true, down: this.down, latencyMs: this.latencyMs };
  }

  async request(path: string, query: Record<string, string>, apiKey: string): Promise<HttpReply> {
    this.requests.push({ path, query });
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
    if (this.down) throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    const json = (status: number, body: unknown): HttpReply => ({ status, text: JSON.stringify(body) });
    if (!apiKey) return json(401, { msg: "No API Key found" });
    if (apiKey !== this.apiKey) return json(401, { msg: "Invalid API key" });
    if (path === "/is-connected") return json(200, { connected: true });
    if (path === "/integrations") {
      const g = query.group;
      return json(200, this.integrations().filter((i) => !g || i.customer?.id === g));
    }
    if (path === "/posts") {
      const bad: string[] = [];
      const isDate = (v: string | undefined) => !!v && /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(v) && Number.isFinite(Date.parse(v));
      if (!isDate(query.startDate)) bad.push("startDate must be a valid ISO 8601 date string");
      if (!isDate(query.endDate)) bad.push("endDate must be a valid ISO 8601 date string");
      if (bad.length) return json(400, { statusCode: 400, message: bad, error: "Bad Request" });
      const start = Date.parse(query.startDate);
      const end = Date.parse(query.endDate);
      const out: PostizPost[] = [];
      for (const p of this.posts()) {
        const t = Date.parse(p.publishDate);
        if (!p.intervalInDays) {
          if (t >= start && t <= end) out.push(p);
          continue;
        }
        // As Postiz does: every occurrence from the first date up to endDate, including ones
        // before startDate (callers filter to their range).
        for (let at = t; at <= end; at += p.intervalInDays * DAY) out.push({ ...p, publishDate: new Date(at).toISOString(), actualDate: p.publishDate });
      }
      return json(200, { posts: out });
    }
    return json(404, { message: `Cannot GET /public/v1${path}`, error: "Not Found", statusCode: 404 });
  }
}
