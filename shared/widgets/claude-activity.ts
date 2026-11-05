// "Claude Code activity" widget: the subagents and background processes (background Bash,
// Monitor) of one Claude Code cloud session. The data comes from the session's own event
// stream, the same source and polling as its cloud session card (server/cloud-sessions.ts):
// every minute, every 3 s for 5 minutes after "Open session". Statuses come from the events
// (task_started / task_progress / task_updated / task_notification, and a subagent's tool
// result), never from guesses. When the stream holds no task events the widget says so.
//
// Event shapes (claude CLI 2.1.x, its SDK system messages):
//   {type:"system", subtype:"task_started", task_id, tool_use_id, task_type ("local_agent" =
//     subagent, "local_bash" = background Bash or Monitor), description, subagent_type}
//   {type:"system", subtype:"task_progress", task_id, summary, last_tool_name, usage:{duration_ms}}
//   {type:"system", subtype:"task_updated", task_id, patch:{status, end_time, error}}
//   {type:"system", subtype:"task_notification", task_id, status ("completed" | "failed" |
//     "killed" | "stopped"), summary ('Background command "…" completed (exit code 0)')}
// plus the assistant's tool_use blocks (Agent / Task / Bash / Monitor input: command,
// description, subagent_type, run_in_background) and the user's tool_result blocks.

import { T } from "@tldraw/validate";
import type { WidgetManifest } from "./types";

export interface ClaudeActivityConfig {
  session: string;
}

export type ActivityKind = "subagent" | "bash" | "monitor";
export type ActivityStatus = "running" | "done" | "failed" | "stopped" | "exited";

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  // Subagent: its description (and type); process: its command.
  name: string;
  detail: string;
  status: ActivityStatus;
  exitCode: number | null;
  startedAt: string | null;
  endedAt: string | null;
  lastLine: string;
}

export interface ClaudeActivityData {
  // false: the event stream holds no task events, so these cannot be shown (reason says so).
  available: boolean;
  reason?: string;
  subagents: ActivityItem[];
  processes: ActivityItem[];
  // How many events were read, and whether that reached the session's first event.
  scanned: number;
  complete: boolean;
  sessionStatus?: string;
  readAt: string;
}

// A compacted event, as `cloud-task session --activity` prints it (bin/cloud-session.mjs).
export interface ActivityEvent {
  t: string; // payload type: system | assistant | user
  at: string | null;
  st?: string; // system subtype
  task_id?: string;
  task_type?: string;
  tool_use_id?: string;
  description?: string;
  subagent_type?: string;
  status?: string;
  summary?: string;
  last_tool_name?: string;
  patch?: { status?: string; end_time?: number | string; error?: string };
  uses?: Array<{ id: string; name: string; command?: string; description?: string; subagent_type?: string; bg?: boolean }>;
  results?: Array<{ id: string; err?: boolean; text?: string }>;
}

const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);
const one = (s: unknown, max = 160) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const iso = (v: unknown, fallback: string | null) => (typeof v === "number" ? new Date(v).toISOString() : typeof v === "string" && v ? v : fallback);

function finished(status: string | undefined, kind: ActivityKind, err?: boolean): ActivityStatus | null {
  switch (status) {
    case "completed":
      return kind === "subagent" ? "done" : "exited";
    case "failed":
      return kind === "subagent" ? "failed" : "exited";
    case "killed":
    case "stopped":
      return "stopped";
    case "running":
    case "pending":
      return "running";
    default:
      return err ? "failed" : null;
  }
}

// Events oldest first -> the session's subagents and background processes.
// scanned: how many raw events were read (compaction drops the ones that matter to nobody here).
export function parseActivity(events: ActivityEvent[], opts: { complete: boolean; scanned?: number; sessionStatus?: string; now?: number } = { complete: false }): ClaudeActivityData {
  const uses = new Map<string, NonNullable<ActivityEvent["uses"]>[number] & { at: string | null }>();
  const items = new Map<string, ActivityItem>();
  const byToolUse = new Map<string, string>();
  let taskEvents = 0;
  let systemEvents = 0;
  for (const e of events) {
    if (e.t === "assistant") for (const u of e.uses ?? []) uses.set(u.id, { ...u, at: e.at });
    if (e.t === "system") systemEvents++;
    if (e.t === "system" && e.st === "task_started" && e.task_id) {
      taskEvents++;
      const use = e.tool_use_id ? uses.get(e.tool_use_id) : undefined;
      const kind: ActivityKind = e.task_type === "local_agent" || e.task_type === "remote_agent" || e.subagent_type || (use && SUBAGENT_TOOLS.has(use.name)) ? "subagent" : use?.name === "Monitor" ? "monitor" : "bash";
      const name = kind === "subagent" ? one(e.description || use?.description || "subagent") : one(use?.command || e.description || "background command");
      const detail = kind === "subagent" ? one(e.subagent_type || use?.subagent_type || "") : one(use?.command && e.description && e.description !== use.command ? e.description : "");
      items.set(e.task_id, { id: e.task_id, kind, name, detail, status: "running", exitCode: null, startedAt: e.at, endedAt: null, lastLine: "" });
      if (e.tool_use_id) byToolUse.set(e.tool_use_id, e.task_id);
      continue;
    }
    const it = e.task_id ? items.get(e.task_id) : undefined;
    if (e.t === "system" && e.st === "task_progress" && e.task_id) {
      taskEvents++;
      if (it) it.lastLine = one(e.summary || (e.last_tool_name ? `using ${e.last_tool_name}` : it.lastLine));
      continue;
    }
    if (e.t === "system" && e.st === "task_updated" && e.task_id) {
      taskEvents++;
      if (it && e.patch?.status) {
        const s = finished(e.patch.status, it.kind);
        if (s) it.status = s;
        if (s && s !== "running") it.endedAt = iso(e.patch.end_time, e.at);
        if (e.patch.error) it.lastLine = one(e.patch.error);
      }
      continue;
    }
    if (e.t === "system" && e.st === "task_notification" && e.task_id) {
      taskEvents++;
      const target = it ?? (e.tool_use_id && byToolUse.get(e.tool_use_id) ? items.get(byToolUse.get(e.tool_use_id)!) : undefined);
      if (!target) {
        // Started before the events read: known from its end only.
        const kind: ActivityKind = /^Agent "/.test(e.summary ?? "") ? "subagent" : "bash";
        items.set(e.task_id, { id: e.task_id, kind, name: one((e.summary ?? "").replace(/^(Background command|Agent) "(.*?)".*$/, "$2") || e.task_id), detail: "started before the events read", status: finished(e.status, kind) ?? "done", exitCode: null, startedAt: null, endedAt: e.at, lastLine: one(e.summary) });
        continue;
      }
      const s = finished(e.status, target.kind);
      if (s) target.status = s;
      target.endedAt = target.endedAt ?? e.at;
      const code = /exit code (\d+)/.exec(e.summary ?? "");
      if (code) target.exitCode = Number(code[1]);
      if (e.summary) target.lastLine = one(e.summary);
      continue;
    }
    // A subagent's result ends it (foreground subagents need no task events for that).
    if (e.t === "user") {
      for (const r of e.results ?? []) {
        const id = byToolUse.get(r.id);
        const target = id ? items.get(id) : undefined;
        const use = uses.get(r.id);
        if (target?.kind === "subagent" && target.status === "running" && !use?.bg) {
          target.status = r.err ? "failed" : "done";
          target.endedAt = e.at;
          if (r.text) target.lastLine = one(r.text);
        } else if (!target && use && SUBAGENT_TOOLS.has(use.name) && !use.bg) {
          items.set(r.id, { id: r.id, kind: "subagent", name: one(use.description || "subagent"), detail: one(use.subagent_type ?? ""), status: r.err ? "failed" : "done", exitCode: null, startedAt: use.at, endedAt: e.at, lastLine: one(r.text ?? "") });
        }
      }
    }
  }
  // Foreground subagents still waiting for their result.
  const resulted = new Set(events.flatMap((e) => (e.t === "user" ? (e.results ?? []).map((r) => r.id) : [])));
  for (const [id, u] of uses) {
    if (SUBAGENT_TOOLS.has(u.name) && !u.bg && !byToolUse.has(id) && !items.has(id) && !resulted.has(id))
      items.set(id, { id, kind: "subagent", name: one(u.description || "subagent"), detail: one(u.subagent_type ?? ""), status: "running", exitCode: null, startedAt: u.at, endedAt: null, lastLine: "" });
  }
  const all = [...items.values()];
  const readAt = new Date(opts.now ?? Date.now()).toISOString();
  const scanned = Math.max(opts.scanned ?? 0, events.length);
  const base = { scanned, complete: opts.complete, sessionStatus: opts.sessionStatus, readAt };
  const subagents = all.filter((i) => i.kind === "subagent");
  const processes = all.filter((i) => i.kind !== "subagent");
  // No task events, and no system events at all: the stream does not carry them, so an empty
  // list would be a guess. (System events but no tasks: genuinely none in what was read.)
  if (!taskEvents && !systemEvents && !all.length)
    return { ...base, available: false, reason: scanned ? "this session's event stream has no task events, so its subagents and background processes cannot be shown" : "the session has no events yet", subagents: [], processes: [] };
  return { ...base, available: true, subagents, processes };
}

const session = T.string.check((v) => {
  if (v !== "" && !/^session_[A-Za-z0-9_-]{4,120}$/.test(v)) throw new Error("session must be a Claude Code cloud session id (session_…)");
});

const running = (d: ClaudeActivityData) => [...d.subagents, ...d.processes].filter((i) => i.status === "running").length;

export const claudeActivityWidget: WidgetManifest<ClaudeActivityConfig, ClaudeActivityData> = {
  id: "claude-activity",
  label: "Claude Code activity",
  icon: "activity",
  description: "Subagents and background processes (Bash, Monitor) of a Claude Code cloud session, from its own events.",
  tagline: "What a Claude Code cloud session is doing in the background.",
  about: "Lists a cloud session's subagents and background processes (long Bash commands, Monitor watches) with their status, how long they have run and their last line, read from the session's own events.",
  whyItMatters: "A cloud session can look idle while a subagent or a test run is still going. Pinned next to its session card, this shows whether work is still running or finished, so you know whether to wait, check in or move on.",
  category: "Agents",
  permissions: [
    { kind: "network", text: "Reads the session's events from claude.ai through the board's cloud session poller (every minute, every 3 s after Open session)." },
    { kind: "data", text: "Reads only the session named in its settings." },
  ],
  media: [
    { kind: "image", src: "/plugin-media/claude-activity/running.png", caption: "A subagent and a background sleep, both running." },
    { kind: "image", src: "/plugin-media/claude-activity/done.png", caption: "Both finished: subagent done, command exited 0." },
    { kind: "video", src: "/plugin-media/claude-activity/clip.webm", poster: "/plugin-media/claude-activity/running.png", caption: "From running to done (session events from a stub API)." },
  ],
  version: "1.0.0",
  size: { w: 360, h: 280 },
  // Polled every minute (every 3 s after Open session on its card): stale after 2.5 misses.
  staleMs: 150_000,
  fields: [{ key: "session", label: "Session", kind: "text", required: true, placeholder: "session_…", help: "The cloud session id (from its claude.ai/code link)" }],
  configProps: { session },
  defaults: () => ({ session: "" }),
  configured: (c) => /^session_/.test(c.session),
  summary: (c, s) => (s?.data ? `${running(s.data)} running` : c.session ? c.session.slice(0, 18) : "not set up"),
  describe: (_c, s) => {
    const d = s?.data;
    if (!d) return "";
    if (!d.available) return d.reason ?? "activity not available";
    const n = (xs: ActivityItem[]) => `${xs.length} (${xs.filter((i) => i.status === "running").length} running)`;
    return `subagents ${n(d.subagents)}; background processes ${n(d.processes)}`;
  },
};
