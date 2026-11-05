// Fixture workspace for the mock Slack API (specs/plugin-widgets.md › Plugin 2).
//   Team T0MOCK001, bot U0BOT0001 / B0BOT0001, users Alice, Bob and Carol (deleted).
//   #general C0GENERAL1: 250 messages (pagination).
//   #project C0PROJECT1: thread 1730000000.000100 with 4 replies + 1 reply_broadcast.
//   #private G0PRIVATE1: private, the bot is not a member (channel_not_found).
//   #random  C0RANDOM01: public, the bot is not a member (not_in_channel).

import type { SlackChannel, SlackMessage, SlackUser } from "../api";

export const TEAM = { id: "T0MOCK001", name: "Mock Workspace", domain: "mock-workspace" };
export const BOT = { user: "U0BOT0001", bot: "B0BOT0001", name: "bunny-bot", app: "A0MOCKAPP1" };
export const THREAD_TS = "1730000000.000100";

// token → granted scopes; the revoked one fails auth outright.
export const TOKENS: Record<string, { kind: "bot" | "app" | "revoked"; scopes: string[] }> = {
  "xoxb-mock-valid": { kind: "bot", scopes: ["channels:read", "groups:read", "channels:history", "groups:history", "users:read", "chat:write"] },
  "xoxb-mock-noscope": { kind: "bot", scopes: ["chat:write"] },
  "xoxb-mock-revoked": { kind: "revoked", scopes: [] },
  "xapp-mock": { kind: "app", scopes: ["connections:write"] },
};

export function users(): SlackUser[] {
  const u = (id: string, name: string, real: string, extra: Partial<SlackUser> = {}): SlackUser => ({
    id,
    team_id: TEAM.id,
    name,
    deleted: false,
    real_name: real,
    is_bot: false,
    profile: { display_name: name, real_name: real },
    ...extra,
  });
  return [
    u(BOT.user, BOT.name, "Bunny Bot", { is_bot: true }),
    u("U0ALICE01", "alice", "Alice Chen"),
    u("U0BOB0001", "bob", "Bob Okafor"),
    u("U0CAROL01", "carol", "Carol Diaz", { deleted: true }),
  ];
}

function channel(id: string, name: string, opts: { priv?: boolean; member: boolean; general?: boolean; members: number; purpose: string }): SlackChannel {
  return {
    id,
    name,
    is_channel: !opts.priv,
    is_group: !!opts.priv,
    is_im: false,
    is_private: !!opts.priv,
    is_archived: false,
    is_general: !!opts.general,
    is_member: opts.member,
    created: 1700000000,
    creator: "U0ALICE01",
    name_normalized: name,
    num_members: opts.members,
    topic: { value: "", creator: "", last_set: 0 },
    purpose: { value: opts.purpose, creator: "U0ALICE01", last_set: 1700000000 },
  };
}

export function channels(): SlackChannel[] {
  return [
    channel("C0GENERAL1", "general", { member: true, general: true, members: 4, purpose: "Company-wide announcements" }),
    channel("C0PROJECT1", "project", { member: true, members: 3, purpose: "The bunny widget project" }),
    channel("C0RANDOM01", "random", { member: false, members: 2, purpose: "Off-topic" }),
    channel("G0PRIVATE1", "private", { priv: true, member: false, members: 2, purpose: "Private planning" }),
  ];
}

export const ts = (sec: number, micro = 100) => `${sec}.${String(micro).padStart(6, "0")}`;

const msg = (t: string, user: string, text: string, extra: Partial<SlackMessage> = {}): SlackMessage => ({ type: "message", ts: t, user, text, ...extra });

// Every channel's messages, oldest first. Replies sit in the same list with thread_ts.
export function messages(): Record<string, SlackMessage[]> {
  const general: SlackMessage[] = [];
  const who = ["U0ALICE01", "U0BOB0001", "U0CAROL01"];
  for (let i = 0; i < 250; i++) general.push(msg(ts(1729000000 + i * 600), who[i % 3], `General update #${i + 1}`));
  const replies: Array<[number, string, string, boolean?]> = [
    [60, "U0BOB0001", "I can take the mock server."],
    [120, "U0ALICE01", "Great. Match docs.slack.dev shapes exactly, please."],
    [180, BOT.user, "Pagination uses response_metadata.next_cursor; the last page is \"\"."],
    [240, "U0BOB0001", "Rate limits come back as HTTP 429 with Retry-After."],
    [300, "U0ALICE01", "Ship the widget behind the tray first.", true],
  ];
  const thread = replies.map(([d, user, text, broadcast]) =>
    msg(ts(1730000000 + d), user, text, { thread_ts: THREAD_TS, parent_user_id: "U0ALICE01", ...(broadcast ? { subtype: "thread_broadcast" } : {}) }),
  );
  const project: SlackMessage[] = [
    msg(ts(1729990000), "U0ALICE01", "Kick-off: widgets on the bunny board!"),
    msg(ts(1729995000), "U0BOB0001", "Spec is in specs/plugin-widgets.md"),
    msg(THREAD_TS, "U0ALICE01", "Thread: who builds the Slack widget?", {
      thread_ts: THREAD_TS,
      reply_count: thread.length,
      reply_users_count: 3,
      latest_reply: thread.at(-1)!.ts,
      reply_users: ["U0BOB0001", "U0ALICE01", BOT.user],
    }),
    ...thread,
    msg(ts(1730001000), "U0BOB0001", "Mock fixtures are ready for review."),
  ];
  return {
    C0GENERAL1: general,
    C0PROJECT1: project,
    C0RANDOM01: [msg(ts(1729900000), "U0BOB0001", "Anyone seen the carrots?")],
    G0PRIVATE1: [msg(ts(1729900000), "U0ALICE01", "Secret plans")],
  };
}

export const CHATTER: Array<{ channel: string; user: string; text: string; thread?: boolean }> = [
  { channel: "C0PROJECT1", user: "U0BOB0001", text: "Pushed the Socket Mode reconnect fix." },
  { channel: "C0PROJECT1", user: "U0ALICE01", text: "Reviewing it now.", thread: true },
  { channel: "C0GENERAL1", user: "U0ALICE01", text: "Lunch at 12:30 today." },
  { channel: "C0PROJECT1", user: "U0ALICE01", text: "The status dot went amber during the 429 test, then green again." },
  { channel: "C0PROJECT1", user: "U0BOB0001", text: "Backfill after reconnect works: no gaps.", thread: true },
  { channel: "C0PROJECT1", user: "U0BOB0001", text: "Can someone try the revoked-token account?" },
  { channel: "C0GENERAL1", user: "U0BOB0001", text: "Reminder: demo on Friday." },
  { channel: "C0PROJECT1", user: "U0ALICE01", text: "Looks great on the preview board.", thread: true },
];
