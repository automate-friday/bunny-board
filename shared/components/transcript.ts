// Transcript card: the parts both the board server and the canvas need. Kept free of
// React and of the `tldraw` package so the server bundle can import it (see README,
// "Why pre-bundled"). The canvas side lives in canvas/src/components/transcript/.
//
// The card's live content (title, status, rows) is never stored on the shape. It is
// rendered from the event stream, so the document only changes when a person moves,
// resizes or toggles the card, and the frame watcher never sees streaming updates.

import { createShapePropsMigrationSequence } from "@tldraw/tlschema";
import { T } from "@tldraw/validate";

export const TRANSCRIPT_TYPE = "transcript" as const;

// Bump when a board component is added or its props change. The canvas sends it on the
// sync socket; the server closes older canvases with CLIENT_TOO_OLD (tldraw then asks the
// person to refresh) instead of letting them choke on records they cannot validate.
// 2: the board link card (shared/components/link.ts).
// 3: checklist shared schema. Coordinate canvas adoption before activation.
// 4: the cloud session card (shared/components/cloud-session.ts).
// 5: the generic plugin widget shape (shared/widgets).
// 6: cloud session card: the session's own state and newest message (a props migration).
// 7: the stamp mark the stamp widget presses (shared/components/stamp.ts).
// 8: stamps v2: kind, note and response state on the stamp shape (a props migration).
export const COMPONENTS_VERSION = 8;

export type TranscriptMode = "compact" | "full";

export interface TranscriptProps {
  agentId: string;
  w: number;
  h: number;
  mode: TranscriptMode;
  follow: boolean;
}

export const transcriptShapeProps = {
  agentId: T.string,
  w: T.nonZeroNumber,
  h: T.nonZeroNumber,
  mode: T.literalEnum("compact", "full"),
  follow: T.boolean,
};

// No migrations yet; the sequence exists so later prop changes can add steps.
export const transcriptMigrations = createShapePropsMigrationSequence({ sequence: [] });

export const TRANSCRIPT_SIZE: Record<TranscriptMode, { w: number; h: number }> = {
  compact: { w: 380, h: 200 },
  full: { w: 420, h: 420 },
};

export function transcriptDefaults(agentId = "", mode: TranscriptMode = "compact"): TranscriptProps {
  return { agentId, ...TRANSCRIPT_SIZE[mode], mode, follow: true };
}

// --- live data shape shared by the server hub and the canvas store ------------------

export type TranscriptStatus = "idle" | "running" | "needs-permission" | "error" | "archived" | "missing";

export interface TranscriptRow {
  id?: string;
  truncated?: boolean;
  kind: string;
  text: string;
  at: string;
  status?: string;
  // The board's opening prompt (the long primer). `text` is then only the user's opening
  // line ("" if there was none) and `full` the whole prompt, for the sidebar.
  primer?: boolean;
  full?: string;
  // An agent's silent acknowledgement of a delta (isSilentAck).
  ack?: boolean;
  // The full (bounded, redacted) Paseo timeline item behind this row, for the sidebar
  // and cards to render like Paseo's app. Absent for remote (af-network) agents, which
  // stay messages-only; renderers fall back to `kind`/`text`.
  item?: TranscriptItem;
}

// A bounded, redacted projection of a Paseo AgentTimelineItem (@getpaseo/protocol
// agent-types). Large strings are cut (output fields keep their tail, others their head)
// and named in `truncatedFields`; the full row comes from the exact-row route.
export interface TranscriptItem {
  // Stable across updates: "tool:<turnId>/<callId>" (Paseo's agentToolCallIdentity),
  // "msg:<messageId>", else "seq:<seqStart>". Rows keep their React key and expanded
  // state while a tool call goes running → completed.
  key: string;
  type: "user_message" | "assistant_message" | "reasoning" | "tool_call" | "todo" | "error" | "notification" | "compaction" | "plugin";
  turnId?: string;
  // tool_call
  callId?: string;
  name?: string;
  status?: "running" | "completed" | "failed" | "canceled" | "loading";
  // The protocol's ToolCallDetail union, with large strings bounded.
  detail?: { type: string; [field: string]: unknown };
  error?: string;
  // messages and reasoning
  text?: string;
  // Markdown images found in assistant text: src is rewritten to the board's file route
  // for local paths; http(s)/data sources pass through.
  images?: { src: string; alt: string }[];
  // todo
  todos?: { text: string; completed: boolean; status?: "pending" | "in_progress" | "completed"; activeForm?: string }[];
  // notification
  level?: "info" | "warning" | "error";
  // compaction
  trigger?: "auto" | "manual";
  preTokens?: number;
  truncatedFields?: string[];
}

// Paseo AgentUsage (turn_completed / agent.lastUsage).
export interface TranscriptUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
  contextWindowMaxTokens?: number;
  contextWindowUsedTokens?: number;
}

// What agents answer to a delta that asks nothing (server/frame-watcher.ts deltaFooter).
// Cards and the sidebar show such a reply as a muted tick, not as a message.
export const SILENT_ACK = "seen";

// "seen", "(no reply)", "*Noted.*" and the like: an acknowledgement, not a reply.
export function isSilentAck(text: string): boolean {
  return /^[\s*_([“"'`]*(seen|no reply|nothing to add|noted|acknowledged)[\s.!)\]*_”"'`]*$/i.test(text);
}

// Marks the board's opening and handoff prompts (server/frame-watcher.ts openingPrompt).
export const PRIMER_MARK = "You are the agent for one frame on a shared tldraw board";

// Marks the introduction an imported conversation gets (server importIntro). Cards show a
// one-line row instead (it holds the frame token and the outline).
export const INTRO_MARK = "put this conversation on his whiteboard";
export const INTRO_ROW = "Board introduction (the board, this frame, how to read and write it)";

// "opening prompt" or "opening prompt: <the user's line>", for one-line displays.
export function primerLabel(row: Pick<TranscriptRow, "text">): string {
  return row.text ? `opening prompt: ${row.text}` : "opening prompt";
}

export interface HostConnection {
  host: string;
  state: "connected" | "connecting" | "reconnecting" | "failed";
  reason?: string;
}

export interface TranscriptSnapshot {
  availability?: "not-loaded";
  connection?: HostConnection;
  agentId: string;
  title: string | null;
  status: TranscriptStatus;
  rows: TranscriptRow[];
  error?: string;
  updatedAt: number;
  // An agent on another machine, read with af-network every 20 s (not live).
  remote?: { host: string; polledAt: number | null; coverage?: "messages-only" | "projected-timeline"; stale?: boolean; staleAfterMs?: number };
  // Local agents only: last usage and the running turn (agent snapshot lastUsage, activeTurn).
  usage?: TranscriptUsage;
  activeTurn?: { turnId: string; startedAt: string | number } | null;
  // Provider subagents (Claude background Tasks) still running after the turn ended.
  subagents?: number;
}

// --- what board_read says about a card ------------------------------------------------

const OUTLINE_CAP = 600;

function oneLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// "transcript of agent <title> (<status>), last N messages: ..." capped at ~600 chars.
export function transcriptOutline(props: Pick<TranscriptProps, "agentId">, snap: TranscriptSnapshot | null): string {
  const id = oneLine(props.agentId, 80);
  const who = snap?.title ? `${JSON.stringify(oneLine(snap.title, 60))} [${id}]` : id;
  if (!snap) return `transcript of agent ${who} (not loaded yet)`;
  const remote=snap.remote?`; remote messages only${snap.remote.stale||!snap.remote.polledAt||Date.now()-snap.remote.polledAt>45000?"; stale":""}`:"";
  const head = `transcript of agent ${who} (${snap.status}${remote})`;
  const msgs = snap.rows.filter((r) => (r.kind === "user" || r.kind === "assistant") && !r.ack);
  if (!msgs.length) return `${head}, no messages yet`;
  // Newest first, within the budget. Agent messages carry the content; user messages
  // are often long board primers, so they get a shorter slice.
  const picked: string[] = [];
  let budget = OUTLINE_CAP - head.length - 30;
  for (let i = msgs.length - 1; i >= 0 && picked.length < 4 && budget > 40; i--) {
    const m = msgs[i];
    const max = Math.min(m.kind === "user" ? 120 : 300, budget - 12);
    const piece = `${m.kind === "user" ? "user" : "agent"}: "${oneLine(m.primer ? `(${primerLabel(m)})` : m.text, max)}"`;
    picked.unshift(piece);
    budget -= piece.length + 3;
  }
  if (!picked.length) return `${head}, messages not shown (outline budget)`;
  return `${head}, last ${picked.length} message${picked.length === 1 ? "" : "s"}: ${picked.join(" | ")}`;
}
