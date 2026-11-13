import { checklistProps, checklistOutline, type ChecklistItem } from '../shared/components/checklist';
import { measuredTextBounds } from "../shared/text-bounds";
import type { CloudProvider } from "../shared/cloud-provider";
// Plain helpers over tldraw records: text extraction, geometry, parent chains,
// and builders for the shapes agents write. No room or Paseo state here.

import { createBindingId, createShapeId, toRichText } from "@tldraw/tlschema";
import { getIndexAbove, ZERO_INDEX_KEY } from "@tldraw/utils";
import { LINK_TYPE, linkDefaults } from "../shared/components/link";

// biome-ignore lint/suspicious/noExplicitAny: tldraw records are validated by the schema, not by TS here.
export type Rec = Record<string, any> & { id: string; typeName: string };
export type RecMap = Map<string, Rec>;

export type Author = { kind: "human"; userId: string; name?: string } | { kind: "agent"; agentId: string };

export type FrameStatus = "requested" | "idle" | "running" | "needs-permission" | "archived" | "error";
export type DeltaMode = "live" | "on-demand" | "manual";

export interface FramePaseoMeta {
  compressionOffer?: { w: number; h: number; shapeIds: string[] };
  compression?: { messageId: string; archiveId: string; w: number; h: number; status: "pending" | "complete" };
  relink?: {agentId:string;host?:string;reason:"restored-or-copied";requiresConfirmation:true};
  request?:
    | { kind: "create"; cwd?: string; provider?: string; host?: string; workspaceId?: string; context?: "board" | "repo"; prompt?: string; cloud?: boolean; cloudProvider?: CloudProvider; thinkingOptionId?: string; requestedAt: number; by?: string }
    | { kind: "link"; agentId: string; requestedAt: number; by?: string };
  remoteStart?: import("./remote-start").RemoteStartIntent;
  workspaceSetup?: {phase: "provisioning"|"fallback"|"queued"|"ready";mode:"plain"|"repo"|"stored";workspaceId?:string;cwd?:string;reason?:string;fallbackFrom?:string;startedAt?:number};
  bindRetry?: {attempt:number;nextAt:number;lastError:string};
  agentId?: string;
  workspaceId?: string;
  status?: FrameStatus;
  // Server-owned, beside status "error": the daemon says there is no such agent
  // (shared/frame-lifecycle.ts). Absent on an errored frame = a failed turn.
  activity?: "missing";
  // Provider subagents (Claude background Tasks) still running; display only.
  subagents?: number;
  // Cloud session cards in the frame still running (server/cloud-sessions.ts); display only.
  cloudSessions?: number;
  mode?: DeltaMode;
  lastDeltaAt?: number;
  pendingDeltas?: number;
  error?: string;
  boundAt?: number;
  linked?: boolean;
  queue?: string[];
  deltaDelivery?: {operationId:string;status:'sending'|'accepted'|'unknown';at:number;text:string;deltas:string[];intro:boolean};
  pendingText?: Array<[string,{before:Rec|null;wasInside:boolean;adopted?:boolean}]>;
  // Linked agents: when the first delta (with the one-line board explanation) went out.
  introducedAt?: number;
  // Linked agents: the board introduction (importIntro) has not gone out yet.
  introPending?: boolean;
  // Another machine's agent (af-network host id, e.g. "mac-2"); deltas and replies go
  // through `af-network send`, the card through `af-network read`.
  host?: string;
  // The last af-network receipt for a remote frame's delta or reply.
  lastReceipt?: { delivery: string; at: number; traceId?: string; error?: string };
  // "Restart with board tools": the agent this frame was bound to before.
  previousAgentId?: string;
  // Started by "Fork conversation to new frame" (frame-fork.ts): the frame and agent it branched
  // from, and for "Fork from here" the time of the message it branched at.
  forkOf?: { frameId: string; agentId: string; at?: string };
  // Set while a restart is creating the new agent: the binding to restore if the new
  // agent never appears (the server stopped mid-restart).
  restart?: { from: string; at: number; prev: Record<string, unknown> };
  // The last title the frame and its Paseo agent agreed on (frame-names.ts).
  syncedName?: string;
  // The provisional title Bunny cut from the request when the frame had none (frame-names.ts);
  // while the frame still shows it, the agent is asked to rename and a Paseo title wins.
  autoName?: string;
  // Started with "Use cloud agent": a cloud builder does the coding (skills/cloud-dev).
  cloud?: boolean;
  // Which cloud builder; absent on frames bound before the choice existed (= Claude).
  cloudProvider?: CloudProvider;
}

export const STATUS_COLOR: Record<FrameStatus, string> = {
  requested: "violet",
  idle: "green",
  running: "blue",
  "needs-permission": "orange",
  archived: "grey",
  error: "red",
};

// --- text ------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: TipTap JSON.
function richTextToPlain(node: any): string {
  if (!node) return "";
  if (typeof node.text === "string") return node.text;
  if (!Array.isArray(node.content)) return "";
  const parts = node.content.map(richTextToPlain);
  // Paragraph-level nodes join with newlines; inline nodes concatenate.
  const block = node.type === "doc" || node.type === "bulletList" || node.type === "orderedList";
  return parts.join(block ? "\n" : "");
}

export function shapeText(s: Rec): string {
  if (s.type === "checklist") return checklistOutline(s.props);
  if (s.type === "frame") return String(s.props?.name ?? "");
  if (s.props?.richText) return richTextToPlain(s.props.richText).trim();
  if (typeof s.props?.text === "string") return s.props.text;
  if (s.type === "bookmark" || s.type === "embed") return String(s.props?.url ?? "");
  if (s.type === "image") return String(s.props?.altText ?? "");
  if (s.type === "transcript") return `agent ${s.props?.agentId ?? "?"}`;
  if (s.type === "link") return `board ${s.props?.board ?? "?"}${s.props?.frameId ? ` frame ${s.props.frameId}` : ""}${s.props?.title ? ` ${s.props.title}` : ""}`;
  return "";
}

export function quote(text: string, max = 80): string {
  const one = text.replace(/\s+/g, " ").trim();
  return `"${one.length > max ? `${one.slice(0, max - 1)}…` : one}"`;
}

// Like quote, but keeps line breaks (brain dumps, lists) for agents that only see text.
export function quoteLines(text: string, max = 2000): string {
  const t = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return `"${t.length > max ? `${t.slice(0, max - 1)}…` : t}"`;
}

export function kindLabel(s: Rec): string {
  if (s.type === "geo") return s.props?.geo === "rectangle" ? "box" : String(s.props?.geo ?? "geo");
  if (s.type === "note") return "sticky";
  if (s.type === "transcript") return "transcript card";
  if (s.type === "link") return "board link";
  return String(s.type);
}

export function describeShape(s: Rec, max = 80): string {
  const t = shapeText(s);
  return t ? `${kindLabel(s)} ${quote(t, max)}` : `${kindLabel(s)} (${s.id})`;
}

// --- text measurement estimates ----------------------------------------------
// The server cannot measure text, and tldraw only grows a note (props.growY) in the tab
// that edits it: a note written by the server keeps its 200 px box while its text
// spills over its neighbours. These estimates were fitted in Chromium against real
// tldraw 5.2 notes (font "draw"): size m wraps at ~13 characters per line, 30 px per
// line, 32 px of padding, so a 200 px note holds about 12 words and then grows about
// 30 px per extra line. They err on the tall side (see proof/b1).

export const NOTE_SIZE = 200;
const NOTE_PADDING = 32;
const NOTE_TEXT: Record<string, { cpl: number; lh: number }> = {
  s: { cpl: 16.5, lh: 24.3 },
  m: { cpl: 13, lh: 30 },
  l: { cpl: 11, lh: 35.1 },
  xl: { cpl: 9, lh: 43.5 },
};
// Plain text shapes (FONT_SIZES: s 18, m 24, l 36, xl 44 px).
const TEXT_FONT: Record<string, number> = { s: 18, m: 24, l: 36, xl: 44 };

// Greedy word wrap: how many lines `text` takes at `cpl` characters per line.
export function wrapLines(text: string, cpl: number): number {
  let lines = 0;
  for (const para of text.split("\n")) {
    lines++;
    let cur = 0;
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const n = [...word].length;
      if (cur === 0) cur = n;
      else if (cur + 1 + n <= cpl) cur += 1 + n;
      else {
        lines++;
        cur = n;
      }
      while (cur > cpl) {
        lines++;
        cur -= Math.floor(cpl);
      }
    }
  }
  return Math.max(1, lines);
}

// Estimated rendered height of a note (unscaled), at least the 200 px square.
export function estimateNoteHeight(text: string, size = "m"): number {
  const t = NOTE_TEXT[size] ?? NOTE_TEXT.m;
  if (!text.trim()) return NOTE_SIZE;
  return Math.max(NOTE_SIZE, Math.ceil(wrapLines(text, t.cpl) * t.lh + NOTE_PADDING));
}

// growY a note needs for its text (what tldraw would store after measuring it).
export function noteGrowY(text: string, size = "m"): number {
  return Math.max(0, estimateNoteHeight(text, size) - NOTE_SIZE);
}

// Label height of a box/ellipse of width w (labels use the note's font metrics).
export function geoGrowY(text: string, w: number, h: number, geo = "rectangle", size = "m"): number {
  if (!text.trim()) return 0;
  const t = NOTE_TEXT[size] ?? NOTE_TEXT.m;
  const inner = Math.max(20, (geo === "ellipse" ? w * 0.7 : w) - NOTE_PADDING);
  const cpl = Math.max(3, (inner / (NOTE_SIZE - NOTE_PADDING)) * t.cpl);
  return Math.max(0, Math.ceil(wrapLines(text, cpl) * t.lh + NOTE_PADDING - h));
}

function textBox(s: Rec): { w: number; h: number } {
  const p = s.props ?? {};
  const scale = typeof p.scale === "number" ? p.scale : 1;
  const fs = TEXT_FONT[p.size] ?? TEXT_FONT.m;
  const charW = fs * 0.55;
  const lh = Math.ceil(fs * 1.5);
  const text = shapeText(s);
  const w = typeof p.w === "number" ? p.w : 100;
  if (p.autoSize) {
    const longest = Math.max(1, ...text.split("\n").map((l) => [...l].length));
    return { w: Math.max(w, Math.min(2000, Math.ceil(longest * charW) + 8)) * scale, h: Math.max(1, text.split("\n").length) * lh * scale };
  }
  const cpl = Math.max(4, Math.floor((w - 8) / charW));
  return { w: w * scale, h: wrapLines(text, cpl) * lh * scale };
}

// --- geometry --------------------------------------------------------------

export function shapeSize(s: Rec): { w: number; h: number } {
  const measured = measuredTextBounds(s as Rec & { type: string });
  if (measured) return measured;
  const p = s.props ?? {};
  const scale = typeof p.scale === "number" ? p.scale : 1;
  switch (s.type) {
    case "note":
      // A person's note was measured by their tab (growY is right). Agent notes take the
      // taller of growY and the estimate: those written before the estimate existed
      // have growY 0 whatever their length.
      if (s.meta?.author?.kind === "human") return { w: NOTE_SIZE * scale, h: (NOTE_SIZE + (p.growY ?? 0)) * scale };
      return { w: NOTE_SIZE * scale, h: Math.max(NOTE_SIZE + (p.growY ?? 0), estimateNoteHeight(shapeText(s), p.size)) * scale };
    case "geo":
      return { w: p.w * scale, h: (p.h + Math.max(p.growY ?? 0, geoGrowY(shapeText(s), p.w, p.h, p.geo, p.size))) * scale };
    case "text":
      return textBox(s);
    case "arrow": {
      const xs = [p.start?.x ?? 0, p.end?.x ?? 0];
      const ys = [p.start?.y ?? 0, p.end?.y ?? 0];
      return { w: Math.max(1, Math.max(...xs) - Math.min(...xs)), h: Math.max(1, Math.max(...ys) - Math.min(...ys)) };
    }
    case "draw":
    case "highlight":
    case "line":
      return { w: 1, h: 1 };
    default:
      return { w: p.w ?? 1, h: p.h ?? 1 };
  }
}

export function isShape(r: Rec | undefined | null): r is Rec {
  return !!r && r.typeName === "shape";
}

// Page-space top-left of a shape (rotation ignored: prototype edge).
export function absPos(records: RecMap, s: Rec): { x: number; y: number } {
  let x = s.x;
  let y = s.y;
  let parent = records.get(s.parentId);
  let guard = 0;
  while (isShape(parent) && guard++ < 50) {
    x += parent.x;
    y += parent.y;
    parent = records.get(parent.parentId);
  }
  return { x, y };
}

export function ancestors(records: RecMap, s: Rec): string[] {
  const out: string[] = [];
  let p = records.get(s.parentId);
  let guard = 0;
  while (isShape(p) && guard++ < 50) {
    out.push(p.id);
    p = records.get(p.parentId);
  }
  return out;
}

// The bound frame that owns a shape: the nearest ancestor frame carrying meta.paseo.agentId
// (or a request). A bound frame does not own itself.
export function owningBoundFrame(records: RecMap, s: Rec): string | null {
  for (const id of ancestors(records, s)) {
    const f = records.get(id);
    if (f?.type === "frame" && (f.meta?.paseo?.agentId || f.meta?.paseo?.request)) return id;
  }
  return null;
}

export function isInsideFrame(records: RecMap, s: Rec, frameId: string): boolean {
  return ancestors(records, s).includes(frameId);
}

export function gridCell(cx: number, cy: number, w: number, h: number): string {
  const col = cx < w / 3 ? "left" : cx > (2 * w) / 3 ? "right" : "centre";
  const row = cy < h / 3 ? "top" : cy > (2 * h) / 3 ? "bottom" : "middle";
  if (row === "middle" && col === "centre") return "centre";
  if (row === "middle") return `middle-${col}`;
  return `${row}-${col}`;
}

// --- builders --------------------------------------------------------------

export interface ShapeSpec {
  type: "note" | "text" | "box" | "ellipse" | "arrow" | "frame" | "image" | "bookmark" | "link" | "checklist";
  // link: target board id and (optional) frame on it
  title?: string;
  items?: ChecklistItem[];
  board?: string;
  frameId?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  text?: string;
  color?: string;
  fill?: string;
  url?: string;
  // arrow endpoints: a shape id in scope, or a frame-relative point
  from?: { id?: string; x?: number; y?: number };
  to?: { id?: string; x?: number; y?: number };
  parentId?: string;
  assetId?: string;
  // note: a portal to a shape on this board or a page-space area (shared/portal.ts)
  portal?: unknown;
}

export const COLORS = [
  "black",
  "grey",
  "light-violet",
  "violet",
  "blue",
  "light-blue",
  "yellow",
  "orange",
  "green",
  "light-green",
  "light-red",
  "red",
  "white",
] as const;

function color(c: string | undefined, fallback: string): string {
  return c && (COLORS as readonly string[]).includes(c) ? c : fallback;
}

export function nextIndex(records: RecMap, parentId: string): string {
  let max: string = ZERO_INDEX_KEY;
  for (const r of records.values()) {
    if (r.typeName === "shape" && r.parentId === parentId && r.index > max) max = r.index;
  }
  return getIndexAbove(max as never);
}

export function baseShape(type: string, parentId: string, index: string, x: number, y: number, props: object, meta: object): Rec {
  return {
    id: createShapeId(),
    typeName: "shape",
    type,
    x,
    y,
    rotation: 0,
    index,
    parentId,
    isLocked: false,
    opacity: 1,
    props,
    meta,
  };
}

// Size a shape will take once built (text-driven heights are estimates).
export function defaultSize(spec: ShapeSpec): { w: number; h: number } {
  const text = spec.text ?? "";
  switch (spec.type) {
    case "note":
      return { w: NOTE_SIZE, h: estimateNoteHeight(text) };
    case "text":
      return textBox({ id: "", typeName: "shape", type: "text", props: { w: spec.w ?? 240, autoSize: !spec.w, size: "m", richText: toRichText(text) } });
    case "arrow":
      return { w: 1, h: 1 };
    case "frame":
      return { w: spec.w ?? 400, h: spec.h ?? 300 };
    case "bookmark":
      return { w: spec.w ?? 300, h: spec.h ?? 320 };
    case "checklist":
      return { w: spec.w ?? 320, h: spec.h ?? 240 };
    case "link":
      return { w: spec.w ?? 320, h: spec.h ?? 110 };
    case "box":
    case "ellipse": {
      const w = spec.w ?? 220;
      const h = spec.h ?? 120;
      return { w, h: h + geoGrowY(text, w, h, spec.type === "box" ? "rectangle" : "ellipse") };
    }
    default:
      return { w: spec.w ?? 220, h: spec.h ?? 120 };
  }
}

export function buildShape(spec: ShapeSpec, parentId: string, index: string, x: number, y: number, meta: object): Rec {
  const text = spec.text ?? "";
  switch (spec.type) {
    case "note":
      return baseShape("note", parentId, index, x, y, {
        color: color(spec.color, "yellow"),
        labelColor: "black",
        size: "m",
        font: "draw",
        fontSizeAdjustment: 1,
        align: "middle",
        verticalAlign: "middle",
        // What a tab would measure; without it the text spills out of a 200 px box.
        growY: noteGrowY(text),
        url: "",
        richText: toRichText(text),
        scale: 1,
        textLastEditedBy: null,
      }, meta);
    case "text":
      return baseShape("text", parentId, index, x, y, {
        color: color(spec.color, "black"),
        size: "m",
        font: "draw",
        textAlign: "start",
        w: spec.w ?? 240,
        richText: toRichText(text),
        scale: 1,
        autoSize: !spec.w,
      }, meta);
    case "box":
    case "ellipse":
      return baseShape("geo", parentId, index, x, y, {
        geo: spec.type === "box" ? "rectangle" : "ellipse",
        dash: "draw",
        url: "",
        w: spec.w ?? 220,
        h: spec.h ?? 120,
        growY: geoGrowY(text, spec.w ?? 220, spec.h ?? 120, spec.type === "box" ? "rectangle" : "ellipse"),
        scale: 1,
        labelColor: color(spec.color, "black"),
        color: color(spec.color, "black"),
        fill: ["none", "semi", "solid", "pattern", "fill", "lined-fill"].includes(spec.fill ?? "") ? spec.fill : "none",
        size: "m",
        font: "draw",
        align: "middle",
        verticalAlign: "middle",
        richText: toRichText(text),
      }, meta);
    case "frame":
      return baseShape("frame", parentId, index, x, y, {
        w: spec.w ?? 400,
        h: spec.h ?? 300,
        name: text,
        color: color(spec.color, "black"),
      }, meta);
    case "bookmark":
      return baseShape("bookmark", parentId, index, x, y, {
        w: spec.w ?? 300,
        h: spec.h ?? 320,
        assetId: null,
        url: spec.url ?? "",
      }, meta);
    case "checklist": {
      const props = checklistProps(spec);
      return baseShape("checklist", parentId, index, x, y, props, meta);
    }
    case "link":
      return baseShape(LINK_TYPE, parentId, index, x, y, { ...linkDefaults(spec.board ?? "", spec.frameId ?? "", (spec.text ?? "").slice(0, 120)), w: spec.w ?? 320, h: spec.h ?? 110 }, meta);
    case "image":
      return baseShape("image", parentId, index, x, y, {
        w: spec.w ?? 320,
        h: spec.h ?? 240,
        playing: true,
        url: "",
        assetId: spec.assetId ?? null,
        crop: null,
        flipX: false,
        flipY: false,
        altText: text,
      }, meta);
    default:
      throw new Error(`unsupported shape type ${spec.type}`);
  }
}

export function buildArrow(
  parentId: string,
  index: string,
  start: { x: number; y: number },
  end: { x: number; y: number },
  text: string,
  c: string | undefined,
  meta: object,
): Rec {
  return baseShape("arrow", parentId, index, start.x, start.y, {
    kind: "arc",
    labelColor: color(c, "black"),
    color: color(c, "black"),
    fill: "none",
    dash: "solid",
    size: "m",
    arrowheadStart: "none",
    arrowheadEnd: "arrow",
    font: "draw",
    start: { x: 0, y: 0 },
    end: { x: end.x - start.x, y: end.y - start.y },
    bend: 0,
    richText: toRichText(text),
    labelPosition: 0.5,
    scale: 1,
    elbowMidPoint: 0.5,
  }, meta);
}

export function buildArrowBinding(arrowId: string, toId: string, terminal: "start" | "end"): Rec {
  return {
    id: createBindingId(),
    typeName: "binding",
    type: "arrow",
    fromId: arrowId,
    toId,
    props: { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: "none" },
    meta: {},
  };
}
