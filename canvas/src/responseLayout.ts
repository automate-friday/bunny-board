// The footer under each completed response in the conversation (Sidebar.tsx, ResponseFooter.tsx),
// after Paseo 0.11.4's AssistantTurnFooter: a response is everything after one input (your
// message, or a board change the board sent) up to the next input or the end of the
// conversation, and its footer goes under its last row, whatever that row is (a reply, a tool
// group, a Thinking row). Fork cuts at the response's latest assistant message (Paseo's
// boundary); Copy copies the response's assistant text as Markdown. No React here, so the unit
// tests can bundle it.

import type { TranscriptRow } from "../../shared/components/transcript";
import type { DisplayUnit } from "./paseo/grouping";
import { forkableRow, messageTime } from "./forkPoint";

type Row = Pick<TranscriptRow, "kind" | "id" | "ack" | "text" | "at" | "item">;

// Rows that start a response: what the person (or the board) sent the agent.
export function isInputRow(row: Pick<TranscriptRow, "kind">): boolean {
  return row.kind === "user" || row.kind === "plugin:board-delta";
}

export function unitRows<R>(unit: DisplayUnit<R>): readonly R[] {
  return unit.kind === "row" ? [unit.row] : [...unit.hidden, ...unit.visible];
}

export interface ResponseFooterInfo<R> {
  // The response's first unit (for state that belongs to the response, such as Raw text).
  key: string;
  // When its last row was written.
  at?: string;
  // The assistant text, messages joined by a blank line ("" when there is none).
  copyText: string;
  // The latest assistant message, when it can be forked from.
  forkRow?: R & { id: string };
  // It has assistant messages (Raw text applies).
  hasText: boolean;
}

export interface ResponseLayout<R> {
  // For each unit, the key of the response it belongs to (null: an input row).
  responseOf: (string | null)[];
  // Footers by the index of the unit they go under.
  footers: Map<number, ResponseFooterInfo<R>>;
}

// `active`: a turn is running; the newest response (nothing sent after it) gets no footer yet.
export function layoutResponses<R extends Row>(units: readonly DisplayUnit<R>[], keyOf: (unit: DisplayUnit<R>, index: number) => string, { active }: { active: boolean }): ResponseLayout<R> {
  const responseOf: (string | null)[] = [];
  const footers = new Map<number, ResponseFooterInfo<R>>();
  let start = -1;
  const close = (end: number) => {
    if (start < 0) return;
    const rows = units.slice(start, end + 1).flatMap((u) => unitRows(u));
    const from = start;
    start = -1;
    // Nothing but the agent's silent "seen": no footer.
    if (rows.every((r) => r.ack)) return;
    const said = rows.filter((r) => r.kind === "assistant" && !r.ack);
    const latest = said.at(-1);
    const copyText = said
      .map((r) => (r.item?.text ?? r.text ?? "").trim())
      .filter(Boolean)
      .join("\n\n");
    footers.set(end, { key: keyOf(units[from], from), at: rows.at(-1)?.at, copyText, forkRow: latest && forkableRow(latest) ? latest : undefined, hasText: said.length > 0 });
  };
  units.forEach((unit, i) => {
    const input = unit.kind === "row" && isInputRow(unit.row);
    if (input) {
      close(i - 1);
      responseOf.push(null);
      return;
    }
    if (start < 0) start = i;
    responseOf.push(keyOf(units[start], start));
  });
  if (!active) close(units.length - 1);
  return { responseOf, footers };
}

// The footer's time: "10:03" today, "11 Nov, 10:03" before.
export function footerTime(at: string | undefined, now = Date.now(), locale?: string): string {
  const ms = at ? Date.parse(at) : Number.NaN;
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  if (d.toDateString() === new Date(now).toDateString()) return d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  return messageTime(at, locale);
}

// --- joining older history to the live rows ---------------------------------------------------

// A timeline row id is base64url JSON [agent, epoch, seqStart, seqEnd] (server/timeline-pages.ts).
export function rowSeq(id: string | undefined): { epoch: string; seq: number } | null {
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
  try {
    const b64 = id.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
    const x = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    return Array.isArray(x) && typeof x[1] === "string" && Number.isSafeInteger(x[2]) ? { epoch: x[1], seq: x[2] } : null;
  } catch {
    return null;
  }
}

// Earlier pages, then the live rows: the older rows are the ones before the live window's
// first row, so the live rows (a streaming reply among them) keep updating while the reader
// is up in the history.
export function joinHistory<R extends Pick<TranscriptRow, "id" | "at" | "item">>(older: readonly R[] | null, live: readonly R[]): R[] {
  if (!older?.length) return [...live];
  if (!live.length) return [...older];
  const first = live[0];
  const keyOf = (r: R) => r.item?.key ?? r.id;
  const k = keyOf(first);
  const at = k ? older.findIndex((r) => keyOf(r) === k) : -1;
  if (at >= 0) return [...older.slice(0, at), ...live];
  const s = rowSeq(first.id);
  if (s) {
    const seqs = older.map((r) => rowSeq(r.id));
    if (seqs.every((q) => q && q.epoch === s.epoch)) return [...older.filter((_, i) => seqs[i]!.seq < s.seq), ...live];
  }
  return [...older.filter((r) => r.at < first.at), ...live];
}
