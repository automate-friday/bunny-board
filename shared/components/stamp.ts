// Stamps: standard, structured reactions a person attaches to any shape (FigJam-style),
// that reach the agent of the frame the shape sits in as their own message type, not as a
// text delta. Six fixed kinds with fixed meanings (STAMP_KINDS), an optional one-line note,
// and a response state the agent moves along: sent → seen → acting → done.
//
// A stamp is an ordinary document shape parented to the shape it is attached to, so it
// moves with it, is deleted with it, syncs to every tab and persists with the board.
//
// v1 stamps (the retired stamp-button widget, PR #61) are the same shape with kind "":
// a free label in a colour. They still load and render; the migration below gives them an
// empty kind, note and state.
//
// Kept free of React and `tldraw` so the server bundle can import it.

import { createShapePropsMigrationIds, createShapePropsMigrationSequence } from "@tldraw/tlschema";
import { T } from "@tldraw/validate";

export const STAMP_TYPE = "stamp" as const;

// tldraw's colour names (the style panel's palette).
export const STAMP_COLORS = ["black", "grey", "light-violet", "violet", "blue", "light-blue", "yellow", "orange", "green", "light-green", "light-red", "red", "white"] as const;
export type StampColor = (typeof STAMP_COLORS)[number];

// tldraw's light-theme solid values.
export const STAMP_HEX: Record<StampColor, string> = {
  black: "#1d1d1d",
  grey: "#9fa8b2",
  "light-violet": "#e085f4",
  violet: "#ae3ec9",
  blue: "#4465e9",
  "light-blue": "#4ba1f1",
  yellow: "#f1ac4b",
  orange: "#e16919",
  green: "#099268",
  "light-green": "#4cb05e",
  "light-red": "#f87777",
  red: "#e03131",
  white: "#ffffff",
};

// --- the standard set ------------------------------------------------------------------

export const STAMP_KINDS = ["approve", "needs-change", "question", "do-next", "stop", "love-it"] as const;
export type StampKind = (typeof STAMP_KINDS)[number];

export interface StampKindInfo {
  label: string;
  color: StampColor;
  // A line icon (canvas/src/components/stamp/icons.tsx); never an emoji.
  icon: string;
  // What it asks of the agent, in the words the agent is told (opener, MCP, each message).
  meaning: string;
  // Short hint for people in the stamp picker.
  hint: string;
}

export const STAMP_KIND_INFO: Record<StampKind, StampKindInfo> = {
  approve: { label: "Approve", color: "green", icon: "check", meaning: "proceed: go ahead with that item as it is", hint: "Go ahead" },
  "needs-change": { label: "Needs change", color: "orange", icon: "pencil", meaning: "revise that item", hint: "Revise this" },
  question: { label: "Question", color: "blue", icon: "question", meaning: "answer a question about that item (see the note, or ask what is unclear)", hint: "Answer about this" },
  "do-next": { label: "Do next", color: "violet", icon: "flag", meaning: "prioritise that item: do it next, before other open work", hint: "Prioritise this" },
  stop: { label: "Stop", color: "red", icon: "stop", meaning: "halt your current work now, and say where you stopped", hint: "Halt now" },
  "love-it": { label: "Love it", color: "light-red", icon: "heart", meaning: "keep this direction: more like that item", hint: "Keep this direction" },
};

export function isStampKind(v: unknown): v is StampKind {
  return typeof v === "string" && (STAMP_KINDS as readonly string[]).includes(v);
}

// --- response state ----------------------------------------------------------------------

// "" before delivery: no agent bound to the frame, a v1 stamp, or one an agent placed.
// failed: the board could not deliver it (the outbox gave up).
export const STAMP_STATES = ["", "sent", "seen", "acting", "done", "failed"] as const;
export type StampState = (typeof STAMP_STATES)[number];

export const STAMP_STATE_TEXT: Record<StampState, string> = { "": "", sent: "sent", seen: "seen", acting: "acting", done: "done", failed: "not delivered" };

// The order states move in; a state never goes back (a late "seen" after "done" is ignored).
const STATE_RANK: Record<StampState, number> = { "": 0, failed: 1, sent: 2, seen: 3, acting: 4, done: 5 };
export function advancesTo(from: StampState, to: StampState): boolean {
  if (to === "failed") return from === "sent";
  return STATE_RANK[to] > STATE_RANK[from];
}

export function isOpenStamp(p: { kind: string; state: string }): boolean {
  return p.kind !== "" && p.state !== "done";
}

// --- the shape ---------------------------------------------------------------------------

export const STAMP_LABEL_MAX = 24;
export const STAMP_BY_MAX = 60;
export const STAMP_NOTE_MAX = 200;

// v1 marks lean like a rubber stamp; v2 stamps sit straight.
export const STAMP_ROTATION = (-8 * Math.PI) / 180;

export interface StampProps {
  // v1: the free label. v2: the kind's label (kept so old tabs and outlines read well).
  label: string;
  color: StampColor;
  // Who placed it: a person's board name, an agent's frame name, or "you".
  by: string;
  // When (ms since epoch).
  at: number;
  // The shape it is attached to (its parent), or "" (a v1 stamp beside its widget).
  target: string;
  w: number;
  h: number;
  // v2: one of STAMP_KINDS; "" for a v1 stamp.
  kind: "" | StampKind;
  // Optional one-line note.
  note: string;
  state: StampState;
}

export const stampLabel = T.string.check((v) => {
  if (!v.trim()) throw new Error("label must not be blank");
  if ([...v].length > STAMP_LABEL_MAX) throw new Error(`label must be at most ${STAMP_LABEL_MAX} characters`);
  if (/[\n\r\t]/.test(v)) throw new Error("label must be one line");
});

export const stampColor = T.literalEnum(...STAMP_COLORS);

export const stampNote = T.string.check((v) => {
  if ([...v].length > STAMP_NOTE_MAX) throw new Error(`note must be at most ${STAMP_NOTE_MAX} characters`);
  if (/[\n\r]/.test(v)) throw new Error("note must be one line");
});

export const stampShapeProps = {
  label: stampLabel,
  color: stampColor,
  by: T.string.check((v) => {
    if ([...v].length > STAMP_BY_MAX) throw new Error(`by must be at most ${STAMP_BY_MAX} characters`);
  }),
  at: T.number.check((v) => {
    if (!Number.isFinite(v) || v < 0) throw new Error("at must be a time in ms");
  }),
  target: T.string,
  w: T.nonZeroNumber,
  h: T.nonZeroNumber,
  kind: T.literalEnum("", ...STAMP_KINDS),
  note: stampNote,
  state: T.literalEnum(...STAMP_STATES),
};

const versions = createShapePropsMigrationIds(STAMP_TYPE, { AddKindNoteState: 1 });

export const stampMigrations = createShapePropsMigrationSequence({
  sequence: [
    {
      id: versions.AddKindNoteState,
      up(props: Record<string, unknown>) {
        props.kind = "";
        props.note = "";
        props.state = "";
      },
      down(props: Record<string, unknown>) {
        delete props.kind;
        delete props.note;
        delete props.state;
      },
    },
  ],
});

// v1 mark size: the label sets the width (uppercase, wide letter spacing).
export function stampSize(label: string): { w: number; h: number } {
  return { w: Math.round(Math.max(120, [...label].length * 17 + 44)), h: 74 };
}

// v2 stamp: a pill with the kind's icon and label, a state badge, and the note under it.
export function stampKindSize(kind: StampKind, note = ""): { w: number; h: number } {
  const labelW = 30 + [...STAMP_KIND_INFO[kind].label].length * 7.6 + 30;
  const noteW = note ? Math.min(220, 16 + [...note].length * 6.2) : 0;
  return { w: Math.round(Math.max(labelW, noteW)), h: note ? 46 : 28 };
}

export function stampTime(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function cleanName(by: string): string {
  return [...(by.trim() || "you")].slice(0, STAMP_BY_MAX).join("");
}

export function cleanNote(note: unknown): string {
  return typeof note === "string" ? [...note.replace(/\s+/g, " ").trim()].slice(0, STAMP_NOTE_MAX).join("") : "";
}

// Props for a new v2 stamp. State starts empty: the board server sets "sent" once it has
// handed the stamp to the frame's agent.
export function stampKindProps(input: { kind: StampKind; by: string; at: number; target: string; note?: string }): StampProps {
  const info = STAMP_KIND_INFO[input.kind];
  const note = cleanNote(input.note);
  return { label: info.label, color: info.color, by: cleanName(input.by), at: input.at, target: input.target, kind: input.kind, note, state: "", ...stampKindSize(input.kind, note) };
}

// Where a stamp sits on its target, in the target's own coordinates: centred on the click
// point when there is one, else on the top-right corner, stepping down for each stamp the
// target already has so they stay readable.
export function stampSpot(target: { w: number; h: number }, size: { w: number; h: number }, at?: { x: number; y: number } | null, n = 0): { x: number; y: number } {
  if (at) return { x: at.x - size.w / 2, y: at.y - size.h / 2 };
  return { x: Math.max(0, target.w - size.w * 0.75), y: -size.h * 0.45 + n * (size.h + 4) };
}

// --- what the agent gets -----------------------------------------------------------------

export interface StampEvent {
  kind: "stamp";
  id: string;
  stamp: StampKind;
  target: { id: string; type: string; text: string };
  by: string;
  at: string;
  note?: string;
}

export const STAMP_MESSAGE_PREFIX = "Stamp";

export function stampEvent(id: string, p: Pick<StampProps, "kind" | "by" | "at" | "note">, target: { id: string; type: string; text: string }): StampEvent {
  if (!isStampKind(p.kind)) throw new Error("not a v2 stamp");
  return { kind: "stamp", id, stamp: p.kind, target, by: p.by, at: new Date(p.at).toISOString(), ...(p.note ? { note: p.note } : {}) };
}

function q(text: string, max = 60): string {
  const one = text.replace(/\s+/g, " ").trim();
  return JSON.stringify(one.length > max ? `${one.slice(0, max - 1)}…` : one);
}

// The message the agent sees, e.g. `Stamp needs-change on sticky "Ship it" by Sam: revise
// that item.`, then the structured event as one JSON line and how to answer.
export function stampMessage(e: StampEvent, link: string): string {
  const what = e.target.text ? `${e.target.type} ${q(e.target.text)}` : `${e.target.type} ${e.target.id}`;
  return [
    `${STAMP_MESSAGE_PREFIX} ${e.stamp} on ${what} by ${e.by}: ${STAMP_KIND_INFO[e.stamp].meaning}.${e.note ? ` Note: ${q(e.note, STAMP_NOTE_MAX)}` : ""}`,
    JSON.stringify(e),
    e.stamp === "love-it" || e.stamp === "approve"
      ? `Mark it handled with board_stamp {action:"resolve", id:"${e.id}"} (no reply needed). Open: ${link}`
      : `When you start on it, board_stamp {action:"ack", id:"${e.id}"}; when it is handled, board_stamp {action:"resolve", id:"${e.id}"}. Open: ${link}`,
  ].join("\n");
}

// A note added after the stamp went out.
export function stampNoteMessage(id: string, kind: StampKind, targetText: string, by: string, note: string): string {
  return `${STAMP_MESSAGE_PREFIX} note: ${by} added a note to the ${kind} stamp ${id}${targetText ? ` on ${q(targetText)}` : ""}: ${q(note, STAMP_NOTE_MAX)}\n${JSON.stringify({ kind: "stamp-note", id, stamp: kind, by, note })}`;
}

// board_read: `stamp needs-change by Sam 13:42 [seen] on shape:abc note "…"`; v1 stamps read
// `stamp LGTM by Sam 13:42 on shape:abc` as before.
export function stampOutline(p: Pick<StampProps, "label" | "by" | "at" | "target"> & Partial<Pick<StampProps, "kind" | "note" | "state">>): string {
  const name = p.kind ? p.kind : p.label;
  const state = p.kind ? ` [${p.state ? STAMP_STATE_TEXT[p.state] : "not sent"}]` : "";
  return `stamp ${name} by ${p.by || "you"} ${stampTime(p.at)}${state}${p.target ? ` on ${p.target}` : ""}${p.note ? ` note ${q(p.note, 80)}` : ""}`;
}

// The fixed meanings, for the agent opener and the MCP description.
export function stampMeanings(): string {
  return STAMP_KINDS.map((k) => `${k} = ${STAMP_KIND_INFO[k].meaning}`).join("; ");
}
