// Slack widget: an account's channel list, one channel's history, or one thread, kept in
// sync over Socket Mode. The config names an account by reference ("mock", or a name
// from BUNNY_SLACK_ACCOUNTS); tokens stay on the board server (server/widgets/slack).

import { T } from "@tldraw/validate";
import type { WidgetManifest, WidgetState } from "./types";

export interface SlackConfig {
  account: string;
  channel?: string;
  thread_ts?: string;
}

export interface SlackMsg {
  ts: string;
  user?: string;
  userName: string;
  text: string;
  thread_ts?: string;
  reply_count?: number;
  // A thread reply also sent to the channel ("Also send to #channel").
  broadcast?: boolean;
  bot?: boolean;
}

export interface SlackChannelRow {
  id: string;
  name: string;
  is_private: boolean;
  is_member: boolean;
  num_members?: number;
}

export type SlackData =
  | { view: "channels"; team: string; channels: SlackChannelRow[] }
  | { view: "channel"; team: string; channel: { id: string; name: string; is_private: boolean }; messages: SlackMsg[] }
  | { view: "thread"; team: string; channel: { id: string; name: string; is_private: boolean }; parent: SlackMsg | null; messages: SlackMsg[] };

const pattern = (re: RegExp, what: string) =>
  T.string.check((v) => {
    if (!re.test(v)) throw new Error(`must be ${what}`);
  });

export const SLACK_TS_RE = /^\d{10}\.\d{6}$/;

function clip(t: string, n = 60): string {
  const one = t.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

export const slackWidget: WidgetManifest<SlackConfig, SlackData> = {
  id: "slack",
  label: "Slack",
  icon: "message",
  description: "A live Slack channel or thread (or an account's channel list).",
  tagline: "A Slack channel or thread, live, next to the work it is about.",
  about: "Shows one Slack channel's messages, one thread's replies, or an account's channel list, and keeps them up to date as people post. You can reply from the widget. Agents can add one and point it at the right channel or thread for you.",
  whyItMatters: "Put the customer's or teammate's thread beside the frame where an agent is working on their request. Everyone looking at the board sees the latest message without switching apps, and the agent can be told to move the widget to a new thread when the conversation moves.",
  category: "Communication",
  permissions: [
    { kind: "data", text: "Reads channel lists, channel history and thread replies of the Slack accounts the board server holds tokens for (or the built-in mock account)." },
    { kind: "network", text: "The board server talks to slack.com (Web API and Socket Mode). Tokens stay on the server; the browser never sees them." },
    { kind: "data", text: "Posts a message to the channel or thread when you send one from the widget." },
  ],
  media: [
    { kind: "image", src: "/plugin-media/slack/channel.png", caption: "A channel's history, live (mock workspace)." },
    { kind: "image", src: "/plugin-media/slack/thread.png", caption: "Pointed at one thread: only its replies." },
    { kind: "video", src: "/plugin-media/slack/clip.webm", poster: "/plugin-media/slack/channel.png", caption: "A new message arrives in the channel while you watch (mock workspace)." },
  ],
  version: "1.0.0",
  size: { w: 380, h: 440 },
  // Socket Mode pings confirm freshness every few seconds; 20 s without one is stale.
  staleMs: 20_000,
  fields: [
    { key: "account", label: "Account", kind: "select", required: true, help: "A Slack account the board server holds a token for, e.g. mock" },
    { key: "channel", label: "Channel", kind: "select", dependsOn: ["account"], help: "A channel id, e.g. C0PROJECT1; leave out for the channel list" },
    { key: "thread_ts", label: "Thread", kind: "select", dependsOn: ["account", "channel"], help: "A thread's parent ts, e.g. 1730000000.000100; leave out for the whole channel" },
  ],
  configProps: {
    account: pattern(/^[a-z0-9][a-z0-9-]{0,39}$/, "an account name like mock"),
    channel: T.optional(pattern(/^[CGD][A-Z0-9]{2,20}$/, "a Slack channel id like C0PROJECT1")),
    thread_ts: T.optional(pattern(SLACK_TS_RE, "a Slack message ts like 1730000000.000100")),
  },
  defaults: () => ({ account: "" }),
  configured: (c) => c.account.length > 0,
  summary(c, s) {
    const d = s?.data;
    const name = d && d.view !== "channels" ? `#${d.channel.name}` : c.channel;
    if (c.thread_ts) return `${name ?? "?"} › thread`;
    if (c.channel) return name ?? c.channel;
    return d?.view === "channels" ? d.team : c.account;
  },
  describe(_c, s: WidgetState<SlackData> | null) {
    const d = s?.data;
    if (!d) return "";
    if (d.view === "channels") return `${d.channels.length} channels: ${d.channels.slice(0, 6).map((x) => `#${x.name}`).join(" ")}`;
    const last = d.messages.at(-1);
    const latest = last ? `latest ${last.userName}: ${clip(last.text)}` : "no messages";
    if (d.view === "thread") return `thread ${JSON.stringify(clip(d.parent?.text ?? "", 40))} with ${d.messages.length} replies; ${latest}`;
    return `${d.messages.length} recent messages; ${latest}`;
  },
};
