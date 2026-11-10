// Compact text outline of a frame or a whole board (design section 4).

import { componentOutline, type OutlineContext } from "../shared/components";
import { isAreaPortal, portalOf } from "../shared/portal";
import { childBoxes, freeGridSlot, overlappingPairs } from "./layout";
import {
  absPos,
  ancestors,
  describeShape,
  gridCell,
  isShape,
  kindLabel,
  quote,
  type Rec,
  type RecMap,
  shapeSize,
  shapeText,
} from "./records";

const MAX_CHARS = 12_000;

function sortReading(a: Rec, b: Rec): number {
  const rowA = Math.round(a.y / 80);
  const rowB = Math.round(b.y / 80);
  return rowA - rowB || a.x - b.x;
}

function children(records: RecMap, parentId: string): Rec[] {
  const out: Rec[] = [];
  for (const r of records.values()) if (isShape(r) && r.parentId === parentId) out.push(r);
  return out.sort(sortReading);
}

function authorTag(s: Rec): string {
  const a = s.meta?.author;
  if (!a) return "";
  return a.kind === "agent" ? " [agent]" : " [human]";
}

function arrowEnds(records: RecMap, arrow: Rec): { from?: Rec; to?: Rec } {
  const out: { from?: Rec; to?: Rec } = {};
  for (const r of records.values()) {
    if (r.typeName !== "binding" || r.type !== "arrow" || r.fromId !== arrow.id) continue;
    const target = records.get(r.toId);
    if (r.props?.terminal === "start") out.from = target;
    else out.to = target;
  }
  return out;
}

// The frame (bound or not) a shape sits in, for naming a portal target.
function enclosingFrame(records: RecMap, s: Rec): Rec | null {
  let p = records.get(s.parentId);
  let guard = 0;
  while (isShape(p) && guard++ < 50) {
    if (p.type === "frame") return p;
    p = records.get(p.parentId);
  }
  return null;
}

function areaInFrame(records: RecMap, p: { x: number; y: number; w: number; h: number }, f: Rec): boolean {
  const a = absPos(records, f);
  const cx = p.x + p.w / 2;
  const cy = p.y + p.h / 2;
  return cx >= a.x && cy >= a.y && cx <= a.x + f.props.w && cy <= a.y + f.props.h;
}

/** " ⤳ portal → …" for a sticky that links somewhere, else "". */
export function portalSuffix(records: RecMap, s: Rec): string {
  const p = portalOf(s as never);
  if (!p) return "";
  if (isAreaPortal(p)) {
    // Name the frame the area's centre falls in, if any.
    const cx = p.x + p.w / 2;
    const cy = p.y + p.h / 2;
    let inFrame: Rec | null = null;
    for (const r of records.values()) {
      if (!isShape(r) || r.type !== "frame") continue;
      const a = absPos(records, r);
      if (cx >= a.x && cy >= a.y && cx <= a.x + r.props.w && cy <= a.y + r.props.h) inFrame = r;
    }
    const where = inFrame ? ` in frame ${quote(inFrame.props.name || "(unnamed)", 40)} (${inFrame.id})` : "";
    return ` ⤳ portal → area @page(${p.x},${p.y}) ${p.w}x${p.h}${where}`;
  }
  const t = records.get(p.id);
  // The target was deleted: the link stays in meta (an undo brings it back), but it leads nowhere.
  if (!isShape(t)) return ` ⤳ portal → missing target (${p.id})`;
  if (t.type === "frame") return ` ⤳ portal → frame ${quote(t.props.name || "(unnamed)", 40)} (${t.id})`;
  const f = enclosingFrame(records, t);
  return ` ⤳ portal → ${describeShape(t, 40)} (${t.id})${f ? ` in frame ${quote(f.props.name || "(unnamed)", 40)} (${f.id})` : ""}`;
}

function frameHeader(f: Rec): string {
  const p = f.meta?.paseo ?? {};
  const bits = [`${Math.round(f.props.w)}x${Math.round(f.props.h)}`];
  if (p.agentId) bits.push(`agent ${p.agentId}`);
  if (p.status) bits.push(`status ${p.status}`);
  if (p.subagents) bits.push(`${p.subagents} subagent${p.subagents > 1 ? "s" : ""} still running`);
  if (p.mode) bits.push(`mode ${p.mode}`);
  return `frame ${quote(f.props.name || "(unnamed)")} (${f.id}) ${bits.join(" · ")}`;
}

function outlineChildren(records: RecMap, frame: Rec, depth: number, lines: string[], ctx: OutlineContext | null): void {
  const pad = "  ".repeat(depth);
  const kids = children(records, frame.id);
  const w = frame.props.w;
  const h = frame.props.h;
  const arrows: Rec[] = [];
  for (const s of kids) {
    if (s.type === "arrow") {
      arrows.push(s);
      continue;
    }
    const size = shapeSize(s);
    const cell = gridCell(s.x + size.w / 2, s.y + size.h / 2, w, h);
    const pos = `@(${Math.round(s.x)},${Math.round(s.y)}) ${Math.round(size.w)}x${Math.round(size.h)}`;
    if (s.type === "frame") {
      const bound = s.meta?.paseo?.agentId;
      lines.push(`${pad}[${cell}] ${frameHeader(s)} ${pos}${bound ? " (nested bound frame, summarised)" : ""}`);
      if (!bound) outlineChildren(records, s, depth + 1, lines, ctx);
      continue;
    }
    const comp = componentOutline(s as never, ctx);
    if (comp && s.type === "stamp") {
      // A stamp is a mark on top of other shapes, not a card: nothing to write around.
      lines.push(`${pad}[${cell}] ${comp} (${s.id}) ${pos}${authorTag(s)}`);
      continue;
    }
    if (comp) {
      // Cards are big; say plainly that their rectangle is taken.
      lines.push(`${pad}[${cell}] ${comp} (${s.id}) ${pos} [occupied: write around it]${authorTag(s)}`);
    } else {
      const col = s.props?.color ? ` ${s.props.color}` : "";
      lines.push(`${pad}[${cell}] ${kindLabel(s)}${col} ${shapeText(s) ? quote(shapeText(s), 200) : ""} (${s.id}) ${pos}${authorTag(s)}${portalSuffix(records, s)}`);
    }
    // Stamps attached to this shape (its children), with their response state.
    for (const st of children(records, s.id)) if (st.type === "stamp") lines.push(`${pad}  ↳ ${componentOutline(st as never, ctx)} (${st.id})${authorTag(st)}`);
  }
  for (const a of arrows) {
    const { from, to } = arrowEnds(records, a);
    const label = shapeText(a);
    const f = from ? describeShape(from) : "point";
    const t = to ? describeShape(to) : "point";
    lines.push(`${pad}arrow ${f} → ${t}${label ? ` ${quote(label)}` : ""} (${a.id})${authorTag(a)}`);
  }
  if (kids.length === 0) lines.push(`${pad}(empty)`);
  const pairs = overlappingPairs(records, frame.id);
  if (pairs.length) {
    const shown = pairs.slice(0, 4).map(([a, b]) => `${describeShape(a, 30)} (${a.id}) and ${describeShape(b, 30)} (${b.id})`);
    lines.push(
      `${pad}⚠ ${pairs.length} overlapping pair${pairs.length === 1 ? "" : "s"} in this frame: ${shown.join("; ")}${pairs.length > 4 ? "; …" : ""}. Call board_layout({strategy:'grid'}) to re-flow your shapes (a person's shapes and cards stay put).`,
    );
  }
}

// Next free 200x200 slots on the 240 px grid (where a new sticky can go).
function freeSlots(records: RecMap, frame: Rec, n: number): string[] {
  const boxes: Array<{ x: number; y: number; w: number; h: number }> = childBoxes(records, frame.id);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const s = freeGridSlot(boxes, { w: frame.props.w, h: frame.props.h }, { w: 200, h: 200 });
    if (!s) break;
    out.push(`(${s.x},${s.y})`);
    boxes.push({ ...s, w: 200, h: 200 });
  }
  return out;
}

function cap(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  return `${text.slice(0, MAX_CHARS)}\n… truncated (${text.length} chars). Use format:"json" with ids to narrow.`;
}

export function frameOutline(records: RecMap, frameId: string, ctx: OutlineContext | null = null): string {
  const frame = records.get(frameId);
  if (!frame || frame.type !== "frame") return `frame ${frameId} not found`;
  const free = freeSlots(records, frame, 3);
  const lines = [
    frameHeader(frame),
    "Positions are frame-relative (x right, y down; origin = frame top-left). Sizes include text growth (estimated).",
    free.length ? `Free sticky slots on the 240 px grid: ${free.join(" ")}.` : "No free 200x200 slot left: link more content with a portal sticky (board_write note with portal:{id}) to where there is room, grow the frame with board_frame({resize}), or tidy it with board_layout.",
  ];
  // Stickies elsewhere on the board that are portals into this frame, listed before the
  // frame's contents so the outline's length cap never drops them: the other side of a
  // link always shows.
  const inbound: string[] = [];
  for (const r of records.values()) {
    if (r.type !== "note" || !isShape(r) || ancestors(records, r).includes(frameId)) continue;
    const p = portalOf(r as never);
    if (!p) continue;
    const hit = isAreaPortal(p) ? areaInFrame(records, p, frame) : p.id === frameId || (records.get(p.id) ? ancestors(records, records.get(p.id)!) : []).includes(frameId);
    if (!hit) continue;
    const f = enclosingFrame(records, r);
    inbound.push(`  ${describeShape(r, 40)} (${r.id})${f ? ` in frame ${quote(f.props.name || "(unnamed)", 40)} (${f.id})` : ""}${portalSuffix(records, r)}`);
  }
  if (inbound.length) lines.push(`Portals into this frame from elsewhere (${inbound.length}):`, ...inbound.slice(0, 20), ...(inbound.length > 20 ? [`  … and ${inbound.length - 20} more`] : []));
  outlineChildren(records, frame, 1, lines, ctx);
  return cap(lines.join("\n"));
}

export function boardOutline(records: RecMap, ownFrameId?: string): string {
  const lines: string[] = [];
  const pages = [...records.values()].filter((r) => r.typeName === "page");
  for (const page of pages) {
    lines.push(`page ${quote(page.name)} (${page.id})`);
    for (const s of children(records, page.id)) {
      const abs = absPos(records, s);
      const size = shapeSize(s);
      const pos = `@page(${Math.round(abs.x)},${Math.round(abs.y)}) ${Math.round(size.w)}x${Math.round(size.h)}`;
      if (s.type === "frame") {
        const n = children(records, s.id).length;
        const mine = s.id === ownFrameId ? " ← YOUR FRAME" : "";
        lines.push(`  ${frameHeader(s)} ${pos} · ${n} shapes${mine}`);
        for (const r of records.values()) {
          if (r.type !== "note" || !isShape(r) || enclosingFrame(records, r)?.id !== s.id) continue;
          const suffix = portalSuffix(records, r);
          if (suffix) lines.push(`    ${describeShape(r, 40)} (${r.id})${suffix}`);
        }
      } else if (s.type !== "arrow") {
        lines.push(`  ${describeShape(s)} (${s.id}) ${pos} (unframed)${portalSuffix(records, s)}`);
      }
    }
  }
  return cap(lines.join("\n"));
}
