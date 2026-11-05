// Cloud session card: one cloud builder run (a Claude Code cloud session or a Codex cloud
// task) that a frame agent dispatched with `bin/cloud-task start`. cloud-task pins it into
// the calling frame itself (POST …/cloud), and the board server keeps its status current
// (server/cloud-sessions.ts): the PR found for the session on GitHub, its checks, merged
// or closed, and the builder's own state where it can be read. The agent does not update it.
//
// Unlike the transcript and link cards, the status lives on the shape: board_read, the
// frame's "not done yet" status and every canvas see the same values, and they change at
// most once a poll (about a minute), not per streamed token.
//
// Kept free of React and `tldraw` so the server bundle can import it.

import { createShapePropsMigrationIds, createShapePropsMigrationSequence } from "@tldraw/tlschema";
import { T } from "@tldraw/validate";

export const CLOUD_SESSION_TYPE = "cloud-session" as const;

// unknown: the builder's own state cannot be read (the card says why in detail); nothing is guessed.
// Claude cards take their state from the session itself (starting … idle, ended when it is
// archived); the PR is a second line and never ends them. Codex tasks, whose state can only be
// read until there is a PR, still use pr / merged / closed.
export const CLOUD_STATES = ["starting", "working", "waiting", "idle", "pr", "merged", "closed", "failed", "unknown", "ended"] as const;
export type CloudState = (typeof CLOUD_STATES)[number];

// States after which nothing more happens: the poller stops and the frame may look done.
export const CLOUD_FINAL: ReadonlySet<CloudState> = new Set(["merged", "closed", "failed", "ended"]);

export const CLOUD_STATE_TEXT: Record<CloudState, string> = {
  starting: "starting",
  working: "working",
  waiting: "waiting for input",
  idle: "idle",
  pr: "PR open",
  merged: "merged",
  closed: "PR closed",
  failed: "failed",
  unknown: "status unknown",
  ended: "session ended",
};

export const PR_STATES = ["", "open", "merged", "closed"] as const;
export type PrState = (typeof PR_STATES)[number];

// What the cloud session itself reports (Claude: the sessions API via `cloud-task session`).
// "" before the first read, and for Codex tasks; "unreachable" when the API could not be read.
export const SESSION_STATUSES = ["", "running", "idle", "requires_action", "pending", "archived", "failed", "unreachable"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export interface CloudSessionProps {
  provider: "claude" | "codex";
  // Claude: session_…; Codex: task_….
  session: string;
  // The session (or task) page.
  url: string;
  // GitHub owner/name the PR is looked for in.
  repo: string;
  // First line of the task, for people.
  title: string;
  state: CloudState;
  // One short line under the state: check counts, an error, "no PR yet".
  detail: string;
  branch: string;
  // 0 until a PR exists.
  pr: number;
  prUrl: string;
  checksPass: number;
  checksFail: number;
  checksPending: number;
  // Epoch ms: when it was dispatched, the newest activity seen (PR update, push, a relayed
  // message), and the last time the server looked.
  startedAt: number;
  activityAt: number;
  checkedAt: number;
  // The session's own state and its newest message (who wrote it, and a snippet).
  sessionStatus: SessionStatus;
  message: string;
  messageRole: "" | "user" | "assistant";
  // The newest PR linked to the session: "" until there is one.
  prState: PrState;
  w: number;
  h: number;
}

const bounded = (max: number) =>
  T.string.check((v) => {
    if (v.length > max) throw new Error(`Must be at most ${max} characters`);
  });
const count = T.number.check((v) => {
  if (!Number.isInteger(v) || v < 0) throw new Error("Must be a non-negative integer");
});

export const cloudSessionShapeProps = {
  provider: T.literalEnum("claude", "codex"),
  session: bounded(200),
  url: bounded(500),
  repo: bounded(200),
  title: bounded(200),
  state: T.literalEnum(...CLOUD_STATES),
  detail: bounded(300),
  branch: bounded(250),
  pr: count,
  prUrl: bounded(500),
  checksPass: count,
  checksFail: count,
  checksPending: count,
  startedAt: count,
  activityAt: count,
  checkedAt: count,
  sessionStatus: T.literalEnum(...SESSION_STATUSES),
  message: bounded(240),
  messageRole: T.literalEnum("", "user", "assistant"),
  prState: T.literalEnum(...PR_STATES),
  w: T.nonZeroNumber,
  h: T.nonZeroNumber,
};

export const cloudSessionVersions = createShapePropsMigrationIds(CLOUD_SESSION_TYPE, { AddSessionState: 1 });

// 1: the session's own state, newest message and the PR's own state (cards pinned before have
// none). A Claude card that a merged or closed PR had finished is live again: only the session
// ending finishes it now.
export const cloudSessionMigrations = createShapePropsMigrationSequence({
  sequence: [
    {
      id: cloudSessionVersions.AddSessionState,
      up: (props: Record<string, unknown>) => {
        props.sessionStatus = "";
        props.message = "";
        props.messageRole = "";
        const st = props.state;
        props.prState = st === "merged" || st === "closed" ? st : props.pr ? "open" : "";
        if (props.provider === "claude" && (st === "merged" || st === "closed" || st === "pr")) props.state = "unknown";
        if (typeof props.h === "number" && props.h < 170) props.h = 170;
      },
      down: (props: Record<string, unknown>) => {
        delete props.sessionStatus;
        delete props.message;
        delete props.messageRole;
        if (props.state === "idle" || props.state === "unknown" || props.state === "ended") props.state = props.prState === "merged" || props.prState === "closed" ? props.prState : "working";
        delete props.prState;
      },
    },
  ],
});

export const CLOUD_SESSION_SIZE = { w: 340, h: 170 } as const;

export function cloudSessionDefaults(init: Partial<CloudSessionProps> = {}): CloudSessionProps {
  const now = Date.now();
  return {
    provider: "claude",
    session: "",
    url: "",
    repo: "",
    title: "",
    state: "starting",
    detail: "",
    branch: "",
    pr: 0,
    prUrl: "",
    checksPass: 0,
    checksFail: 0,
    checksPending: 0,
    startedAt: now,
    activityAt: now,
    checkedAt: 0,
    sessionStatus: "",
    message: "",
    messageRole: "",
    prState: "",
    ...CLOUD_SESSION_SIZE,
    ...init,
  };
}

// Session ids and urls cloud-task hands over. Only claude.ai and chatgpt.com pages open
// from the card.
export const CLOUD_SESSION_ID_RE = /^(?:(session|task)_[A-Za-z0-9_-]{4,120}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;
export const CLOUD_URL_RE = /^https:\/\/(?:(claude\.ai\/code\/session_|chatgpt\.com\/codex\/tasks\/task_)[A-Za-z0-9_-]{4,120}|chatgpt\.com\/local\/[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\?hostId=durable)$/;
export const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

export function isActive(state: string): boolean {
  return !CLOUD_FINAL.has(state as CloudState);
}

// Whether the card keeps its frame from looking done: it is not finished, and it is not a
// session resting after its PR landed (or was closed).
export function holdsFrame(p: Pick<CloudSessionProps, "state" | "prState">): boolean {
  return isActive(p.state) && !(p.state === "idle" && (p.prState === "merged" || p.prState === "closed"));
}

export function prText(p: Pick<CloudSessionProps, "pr" | "prState" | "checksPass" | "checksFail" | "checksPending">): string {
  if (!p.pr) return "";
  if (p.prState === "merged") return `PR #${p.pr} merged`;
  if (p.prState === "closed") return `PR #${p.pr} closed`;
  return `PR #${p.pr} open · ${checksText(p)}`;
}

export function checksText(p: Pick<CloudSessionProps, "checksPass" | "checksFail" | "checksPending">): string {
  const total = p.checksPass + p.checksFail + p.checksPending;
  if (!total) return "no checks yet";
  if (p.checksFail) return `${p.checksFail} check${p.checksFail > 1 ? "s" : ""} failing`;
  if (p.checksPending) return `checks running (${p.checksPass}/${total} passed)`;
  return `checks passed (${p.checksPass}/${total})`;
}

function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 36 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}
export { ago as cloudAgo };

// One line for board_read.
export function cloudSessionOutline(p: CloudSessionProps, now = Date.now()): string {
  const who = p.provider === "codex" ? "Codex cloud task" : "Claude Code cloud session";
  const pr = p.pr ? ` · ${prText(p)} ${p.prUrl}` : "";
  const detail = p.detail ? ` · ${p.detail}` : "";
  const msg = p.message ? ` · latest ${p.messageRole === "user" ? "from the user" : "from the session"}: ${JSON.stringify(p.message.slice(0, 80))}` : "";
  return `${who} ${JSON.stringify(p.title || p.session)}: ${CLOUD_STATE_TEXT[p.state] ?? p.state}${pr}${detail}${msg} · last activity ${ago(p.activityAt, now)} · ${p.url}`;
}
