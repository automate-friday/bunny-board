// "Fork from here" (server/frame-fork.ts): which conversation rows offer it and what to
// tell the person afterwards. No React here, so the unit tests can bundle it.

import type { TranscriptRow } from "../../shared/components/transcript";

// What the fork route answers for a fork from a message.
export interface ForkFromResult {
  frameId: string;
  point?: { at: string; kind: string };
  // The History version copied into the new frame; null when it starts empty.
  contents?: { version: string; at: number; shapes: number; skipped: number } | null;
  empty?: "no-version" | "not-copyable";
}

// A message the person or the agent wrote, with the timeline row id the server cuts at
// (rows of the live stream and of older history pages both carry it). Not tool calls, board
// changes or notices, not the agent's silent "seen", and not a remote conversation's rows
// (they have no id, and those conversations cannot be forked).
export function forkableRow<R extends Pick<TranscriptRow, "kind" | "id" | "ack">>(row: R): row is R & { id: string } {
  return (row.kind === "user" || row.kind === "assistant") && typeof row.id === "string" && row.id !== "" && !row.ack;
}

// The toast after a fork from a message: the plain fork's wording, plus why the frame is
// empty when there was nothing to copy.
export function forkedNotice(result: Pick<ForkFromResult, "contents" | "empty">): string {
  const done = "Forked into a new frame beside this one; its agent starts from the conversation up to that message.";
  if (result.contents) return done;
  return `${done} The frame starts empty: ${result.empty === "not-copyable" ? "its contents from then could not be copied" : "this frame has no saved version from then"}.`;
}

// "11 Nov, 10:03": when the message was written, for the confirmation.
export function messageTime(at: string | undefined, locale?: string): string {
  const ms = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(ms) ? new Date(ms).toLocaleString(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
}
