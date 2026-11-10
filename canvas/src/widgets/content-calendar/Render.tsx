// Content calendar widget body: the Postiz posts in the configured week or month. A week
// shows a strip of the seven days (with a count each) above a day-by-day agenda; a month
// shows the agenda alone. Each post: time, channel, status and a short text preview.
// Read-only: nothing here changes a post. Days and times are in the board server's
// calendar zone (data.timeZone), so the widget, board_read and Postiz agree on the dates.

import type React from "react";
import { useEffect, useRef } from "react";
import type { CalendarPost, CalendarPostStatus, ContentCalendarData } from "../../../../shared/widgets/content-calendar";
import { hhmm, WEEKDAYS, zonedParts } from "../../../../shared/widgets/content-calendar";
import type { WidgetBodyProps } from "../registry";

const STATUS: Record<CalendarPostStatus, { text: string; fg: string; bg: string }> = {
  scheduled: { text: "scheduled", fg: "light-dark(#1d5fbf, hsl(216 74% 74%))", bg: "light-dark(#e6efff, hsl(218 45% 21%))" },
  draft: { text: "draft", fg: "light-dark(#6b6f80, var(--bunny-muted))", bg: "light-dark(#eeeff3, var(--bunny-raised))" },
  published: { text: "published", fg: "light-dark(#1f7a43, hsl(144 59% 74%))", bg: "light-dark(#e3f5ea, var(--bunny-raised))" },
  error: { text: "failed", fg: "light-dark(#b42318, hsl(4 76% 74%))", bg: "light-dark(#fdecea, var(--bunny-raised))" },
};

const PROVIDER: Record<string, string> = {
  x: "X",
  linkedin: "LinkedIn",
  "linkedin-page": "LinkedIn",
  bluesky: "Bluesky",
  threads: "Threads",
  instagram: "Instagram",
  "instagram-standalone": "Instagram",
  facebook: "Facebook",
  mastodon: "Mastodon",
  youtube: "YouTube",
  tiktok: "TikTok",
  reddit: "Reddit",
  pinterest: "Pinterest",
  discord: "Discord",
  slack: "Slack",
  telegram: "Telegram",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface Day {
  key: string;
  label: string;
  dow: number;
  d: number;
  today: boolean;
  posts: CalendarPost[];
}

function dayKey(at: string | number, tz: string) {
  const p = zonedParts(at, tz);
  return { key: `${p.y}-${p.m}-${p.d}`, p };
}

// Every day of the range (week) or only the days with posts (month), in order.
function days(d: ContentCalendarData): Day[] {
  const today = dayKey(d.readAt, d.timeZone).key;
  const out = new Map<string, Day>();
  if (d.range === "week") {
    // Step by 25 h from noon-ish to land once in each calendar day, DST or not.
    let t = Date.parse(d.from) + 12 * 3_600_000;
    for (let i = 0; i < 7; i++) {
      const { key, p } = dayKey(t, d.timeZone);
      if (!out.has(key)) out.set(key, { key, label: `${WEEKDAYS[p.dow]} ${p.d} ${MONTHS[p.m - 1]}`, dow: p.dow, d: p.d, today: key === today, posts: [] });
      t += 24 * 3_600_000;
    }
  }
  for (const post of d.posts) {
    const { key, p } = dayKey(post.at, d.timeZone);
    let day = out.get(key);
    if (!day) {
      day = { key, label: `${WEEKDAYS[p.dow]} ${p.d} ${MONTHS[p.m - 1]}`, dow: p.dow, d: p.d, today: key === today, posts: [] };
      out.set(key, day);
    }
    day.posts.push(post);
  }
  return [...out.values()];
}

function Pill({ status }: { status: CalendarPostStatus }) {
  const s = STATUS[status];
  return (
    <span data-testid="calendar-status" style={{ color: s.fg, background: s.bg, borderRadius: 9, padding: "1px 7px", fontSize: 10, fontWeight: 650, whiteSpace: "nowrap" }}>
      {s.text}
    </span>
  );
}

function Post({ p, tz }: { p: CalendarPost; tz: string }) {
  return (
    <PostLink p={p}>
      <span style={{ fontVariantNumeric: "tabular-nums", color: "light-dark(#334, var(--bunny-ink))", fontWeight: 600, width: 38, flexShrink: 0 }}>{hhmm(p.at, tz)}</span>
      <div style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <span style={{ fontWeight: 600, color: "light-dark(#223, var(--bunny-ink))", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }} title={p.channel}>
            {p.channel}
          </span>
          <span style={{ color: "light-dark(#889, var(--bunny-muted))", fontSize: 10, whiteSpace: "nowrap" }}>{PROVIDER[p.provider] ?? p.provider}{p.repeats ? " · repeats" : ""}</span>
          <span style={{ flex: 1 }} />
          <Pill status={p.status} />
        </div>
        <div data-testid="calendar-preview" style={{ color: "light-dark(#556, var(--bunny-muted))", fontSize: 11, lineHeight: 1.35, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }} title={p.preview}>
          {p.preview || <i style={{ color: "light-dark(#99a, var(--bunny-muted))" }}>no text</i>}
        </div>
        {p.error ? <div style={{ color: STATUS.error.fg, fontSize: 10.5 }}>{p.error}</div> : null}
      </div>
    </PostLink>
  );
}

// A row opens the post in Postiz (its preview page; the editor has no URL of its own) in a
// new tab. Without a Postiz URL on the board server it is a plain row. Read-only either way.
function PostLink({ p, children }: { p: CalendarPost; children: React.ReactNode }) {
  const style: React.CSSProperties = { display: "flex", gap: 8, padding: "5px 4px", margin: "0 -4px", borderTop: "1px solid light-dark(#eef0f5, var(--bunny-line))", borderRadius: 6, color: "inherit", textDecoration: "none" };
  const data = { "data-testid": "calendar-post", "data-status": p.status, "data-channel": p.channelId, "data-at": p.at };
  const href = p.previewUrl ?? p.calendarUrl;
  if (!href) return <div {...data} style={style}>{children}</div>;
  return (
    <a {...data} className="calendar-post-link" href={href} target="_blank" rel="noopener noreferrer" title="Open this post in Postiz (new tab)" style={{ ...style, cursor: "pointer" }}>
      {children}
    </a>
  );
}

function WeekStrip({ list }: { list: Day[] }) {
  return (
    <div data-testid="calendar-strip" style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4, padding: "2px 0 6px" }}>
      {list.map((d) => {
        const counts = d.posts.reduce<Record<string, number>>((a, p) => ({ ...a, [p.status]: (a[p.status] ?? 0) + 1 }), {});
        return (
          <div key={d.key} data-testid="calendar-day-cell" style={{ border: `1px solid ${d.today ? "light-dark(#7aa7ff, hsl(220 35% 39%))" : "light-dark(#e4e6ee, var(--bunny-line))"}`, background: d.today ? "light-dark(#f2f6ff, var(--bunny-surface))" : "light-dark(#fafbfc, var(--bunny-surface))", borderRadius: 6, padding: "3px 0 4px", textAlign: "center" }}>
            <div style={{ fontSize: 9.5, color: "light-dark(#889, var(--bunny-muted))", textTransform: "uppercase", letterSpacing: 0.3 }}>{WEEKDAYS[d.dow]}</div>
            <div style={{ fontSize: 13, fontWeight: 650, color: d.today ? "light-dark(#1d5fbf, hsl(216 74% 74%))" : "light-dark(#334, var(--bunny-ink))" }}>{d.d}</div>
            <div style={{ display: "flex", justifyContent: "center", gap: 2, minHeight: 6, marginTop: 1 }}>
              {(Object.keys(STATUS) as CalendarPostStatus[]).flatMap((st) => Array.from({ length: Math.min(3, counts[st] ?? 0) }, (_, i) => <span key={`${st}${i}`} style={{ width: 5, height: 5, borderRadius: 3, background: STATUS[st].fg }} />))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ContentCalendarBody({ state, config }: WidgetBodyProps) {
  const d = state?.data as ContentCalendarData | null;
  const scroller = useRef<HTMLDivElement>(null);
  // Open at today (or the next day with posts), once per range shown; later refreshes keep
  // wherever the person scrolled to.
  const opened = d ? `${d.range}:${d.from}:${config?.channel ?? ""}` : "";
  useEffect(() => {
    const el = scroller.current;
    const target = el?.querySelector<HTMLElement>('[data-upcoming="1"]');
    if (el && target) el.scrollTop = Math.max(0, target.offsetTop - 2);
  }, [opened]);
  if (!d) return <div style={{ color: "light-dark(#778, var(--bunny-muted))", padding: 12 }}>{state?.status === "error" ? state.reason : "Reading the content calendar…"}</div>;
  const list = days(d);
  const period = d.range === "month" ? "this month" : "this week";
  const missing = config?.channel && !d.channel;
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = Date.parse(d.readAt);
  const withPosts = list.filter((day) => day.posts.length);
  const upcoming = withPosts.find((day) => day.today || day.posts.some((p) => Date.parse(p.at) >= now))?.key;
  return (
    <div data-testid="calendar-body" data-range={d.range} style={{ padding: "4px 12px 6px", display: "flex", flexDirection: "column", font: "12px system-ui, sans-serif", height: "100%", boxSizing: "border-box", pointerEvents: "all" }}>
      {d.range === "week" ? <WeekStrip list={list} /> : null}
      {missing ? <div style={{ color: "light-dark(#b42318, hsl(4 76% 74%))", padding: "4px 0" }}>Channel {JSON.stringify(config.channel)} is not in Postiz.</div> : null}
      <div ref={scroller} data-testid="calendar-agenda" style={{ flex: 1, minHeight: 0, overflowY: "auto", position: "relative" }} onWheel={(e) => e.stopPropagation()}>
        {!d.posts.length ? (
          <div data-testid="calendar-empty" style={{ color: "light-dark(#778, var(--bunny-muted))", padding: "18px 4px", textAlign: "center", lineHeight: 1.5 }}>
            No posts {period}
            {d.channel ? ` on ${d.channel.name}` : ""}.
            <br />
            <span style={{ fontSize: 11, color: "light-dark(#99a, var(--bunny-muted))" }}>
              {d.channels.length ? `${d.channels.length} channel${d.channels.length === 1 ? "" : "s"} connected in Postiz.` : "No channels connected in Postiz yet."}
            </span>
          </div>
        ) : (
          withPosts.map((day) => (
            <div key={day.key} data-testid="calendar-day" data-upcoming={day.key === upcoming ? "1" : undefined} style={{ paddingTop: 4 }}>
              <div style={{ fontWeight: 650, color: day.today ? "light-dark(#1d5fbf, hsl(216 74% 74%))" : "light-dark(#334, var(--bunny-ink))", padding: "2px 0" }}>
                {day.label}
                {day.today ? " · today" : ""}
                {day.posts[0]?.calendarUrl ? (
                  <a data-testid="calendar-day-link" href={day.posts[0].calendarUrl} target="_blank" rel="noopener noreferrer" title="Open this week in the Postiz calendar (new tab)" style={{ float: "right", fontWeight: 500, fontSize: 10.5, color: "light-dark(#1d5fbf, hsl(216 74% 74%))", textDecoration: "none" }}>
                    week in Postiz
                  </a>
                ) : null}
              </div>
              {day.posts.map((p) => (
                <Post key={p.id} p={p} tz={d.timeZone} />
              ))}
            </div>
          ))
        )}
      </div>
      <style>{".calendar-post-link:hover{background:#f4f7fd}"}</style>
      <div style={{ color: "light-dark(#99a, var(--bunny-muted))", fontSize: 10, paddingTop: 5, borderTop: "1px solid light-dark(#eef0f5, var(--bunny-line))" }}>
        {d.posts.length} post{d.posts.length === 1 ? "" : "s"} {period} · Postiz{d.source === "mock" ? " (mock sample calendar)" : ""} · read-only · read {hhmm(d.readAt, d.timeZone)}
        {d.timeZone !== localTz ? ` · times in ${d.timeZone}` : ""}
      </div>
    </div>
  );
}
