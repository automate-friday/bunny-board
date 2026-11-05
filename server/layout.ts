// Where imported frames go: a grid of fixed-size slots (4 per row) starting at a point,
// skipping any slot that would overlap something already on the page.

import { b64Vecs } from "@tldraw/tlschema";
import { absPos, isShape, type Rec, type RecMap, shapeSize } from "./records";

export const IMPORT_FRAME = { w: 900, h: 600 } as const;
export const IMPORT_GAP = 60;
export const IMPORT_PER_ROW = 4;
// Breathing room kept around existing shapes (text and notes are measured by the
// browser, so the server's sizes are estimates).
const MARGIN = 20;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function overlaps(a: Box, b: Box, margin = 0): boolean {
  return a.x < b.x + b.w + margin && a.x + a.w + margin > b.x && a.y < b.y + b.h + margin && a.y + a.h + margin > b.y;
}

// Local box of one shape (origin at its x/y, before rotation). The server cannot measure
// text, so text and notes are estimates; the canvas sends its measured bounds with an
// import, and those are used as well.
function localBox(r: Rec): Box {
  const p = r.props ?? {};
  const scale = typeof p.scale === "number" ? p.scale : 1;
  const bbox = (pts: Array<{ x: number; y: number }>, sx: number, sy: number): Box => {
    if (!pts.length) return { x: 0, y: 0, w: 1, h: 1 };
    const xs = pts.map((q) => q.x * sx);
    const ys = pts.map((q) => q.y * sy);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(1, Math.max(...xs) - x), h: Math.max(1, Math.max(...ys) - y) };
  };
  if (r.type === "draw" || r.type === "highlight") {
    const pts: Array<{ x: number; y: number }> = [];
    for (const seg of p.segments ?? []) {
      try {
        if (typeof seg.path === "string") pts.push(...b64Vecs.decodePoints(seg.path, seg.dim ?? 3));
        else if (Array.isArray(seg.points)) pts.push(...seg.points);
      } catch {
        /* unreadable segment: skip */
      }
    }
    return bbox(pts, scale * (p.scaleX ?? 1), scale * (p.scaleY ?? 1));
  }
  if (r.type === "line") return bbox(Object.values(p.points ?? {}) as Array<{ x: number; y: number }>, scale, scale);
  if (r.type === "arrow") {
    const s = shapeSize(r);
    return { x: Math.min(p.start?.x ?? 0, p.end?.x ?? 0), y: Math.min(p.start?.y ?? 0, p.end?.y ?? 0), w: s.w, h: s.h };
  }
  const s = shapeSize(r);
  return { x: 0, y: 0, w: s.w, h: s.h };
}

function rotated(b: Box, rot: number): Box {
  if (!rot) return b;
  const c = Math.cos(rot);
  const sn = Math.sin(rot);
  const pts = [
    [b.x, b.y],
    [b.x + b.w, b.y],
    [b.x, b.y + b.h],
    [b.x + b.w, b.y + b.h],
  ].map(([x, y]) => ({ x: x * c - y * sn, y: x * sn + y * c }));
  const xs = pts.map((q) => q.x);
  const ys = pts.map((q) => q.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

function union(boxes: Box[]): Box | null {
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
}

export function pageBox(records: RecMap, r: Rec, children: Map<string, Rec[]>, depth = 0): Box | null {
  // Groups have no size of their own: the union of what they hold.
  if (r.type === "group") return depth > 20 ? null : union((children.get(r.id) ?? []).map((c) => pageBox(records, c, children, depth + 1)).filter((b): b is Box => !!b));
  const at = absPos(records, r);
  const b = rotated(localBox(r), r.rotation ?? 0);
  return { x: at.x + b.x, y: at.y + b.y, w: b.w, h: b.h };
}

// Page bounds of every top-level shape (children sit inside their frames and groups).
export function topLevelBounds(records: RecMap, pageId: string): Box[] {
  const children = new Map<string, Rec[]>();
  for (const r of records.values()) {
    if (!isShape(r)) continue;
    const list = children.get(r.parentId) ?? [];
    list.push(r);
    children.set(r.parentId, list);
  }
  const out: Box[] = [];
  for (const r of children.get(pageId) ?? []) {
    const b = pageBox(records, r, children);
    if (b && [b.x, b.y, b.w, b.h].every(Number.isFinite)) out.push(b);
  }
  return out;
}

// n slots, row-major on a 4-wide grid anchored at `origin`. Occupied cells are skipped,
// so the grid keeps its shape and nothing lands on an existing shape or another slot.
// Without an origin the grid starts below everything on the page, left-aligned.
export function gridSlots(existing: Box[], n: number, origin?: { x: number; y: number }, size: { w: number; h: number } = IMPORT_FRAME): Box[] {
  let start = origin;
  if (!start) {
    if (!existing.length) start = { x: 0, y: 0 };
    else {
      const minX = Math.min(...existing.map((b) => b.x));
      const maxY = Math.max(...existing.map((b) => b.y + b.h));
      start = { x: minX, y: maxY + 120 };
    }
  }
  const pitchX = size.w + IMPORT_GAP;
  const pitchY = size.h + IMPORT_GAP;
  const slots: Box[] = [];
  for (let cell = 0; slots.length < n && cell < n + 400; cell++) {
    const col = cell % IMPORT_PER_ROW;
    const row = Math.floor(cell / IMPORT_PER_ROW);
    const box = { x: Math.round(start.x + col * pitchX), y: Math.round(start.y + row * pitchY), w: size.w, h: size.h };
    if (existing.some((b) => overlaps(box, b, MARGIN))) continue;
    slots.push(box);
  }
  // Pathological pages (a huge shape under every cell): fall back to below everything.
  if (slots.length < n) {
    const all = [...existing, ...slots];
    const maxY = Math.max(0, ...all.map((b) => b.y + b.h));
    const have = slots.length;
    for (let k = 0; k < n - have; k++) {
      slots.push({ x: Math.round(start.x + (k % IMPORT_PER_ROW) * pitchX), y: Math.round(maxY + 120 + Math.floor(k / IMPORT_PER_ROW) * pitchY), w: size.w, h: size.h });
    }
  }
  return slots;
}

// --- inside a frame: the 240 px grid, overlap checks and board_layout ---------------

// Agents place shapes on a 240 px grid inside their frame: columns at x = 20, 260, 500,
// …, rows at y = 50, 290, 530, … (a 200 px note plus a 40 px gap). The top 50 px are
// left for a headline.
export const GRID = { x0: 20, y0: 50, step: 240 } as const;

// Shapes that occupy space inside a frame. Arrows, freehand marks and stamps are annotations
// drawn over other shapes, so they neither block writes nor get laid out.
export function occupies(r: Rec): boolean {
  return isShape(r) && !["arrow", "draw", "highlight", "line", "stamp"].includes(r.type);
}

export interface Placed extends Box {
  id: string;
}

// Frame-local boxes of the shapes directly inside `parentId`.
export function childBoxes(records: RecMap, parentId: string): Array<Placed & { rec: Rec }> {
  const out: Array<Placed & { rec: Rec }> = [];
  for (const r of records.values()) {
    if (r.parentId !== parentId || !occupies(r)) continue;
    const b = rotated(localBox(r), r.rotation ?? 0);
    out.push({ id: r.id, x: r.x + b.x, y: r.y + b.y, w: b.w, h: b.h, rec: r });
  }
  return out;
}

// First grid anchor (row by row) where a w x h shape fits inside the frame without
// touching anything in `boxes` (kept `margin` apart), or null if the frame is full.
export function freeGridSlot(boxes: Box[], frame: { w: number; h: number }, size: { w: number; h: number }, margin = 20): { x: number; y: number } | null {
  for (let y = GRID.y0; y + size.h <= frame.h; y += GRID.step / 2) {
    for (let x = GRID.x0; x + size.w <= frame.w; x += GRID.step) {
      const box = { x, y, w: size.w, h: size.h };
      if (!boxes.some((b) => overlaps(box, b, margin))) return { x, y };
    }
  }
  return null;
}

// Pairs of shapes inside one parent whose boxes overlap (for the outline's warning).
export function overlappingPairs(records: RecMap, parentId: string): Array<[Rec, Rec]> {
  const boxes = childBoxes(records, parentId);
  const out: Array<[Rec, Rec]> = [];
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      // Ignore slivers: tldraw shapes on a tight grid touch at their edges.
      if (overlaps(a, b, -2)) out.push([a.rec, b.rec]);
    }
  return out;
}

export type LayoutStrategy = "grid" | "columns";

// board_layout: new frame-local positions for `items` (in reading order), keeping clear
// of `fixed` (shapes that stay where they are). Columns are as wide as the typical
// (median) shape, 200 px for notes, so a wide headline or card spans several columns
// instead of widening all of them. `grid` fills rows left to right, each row as tall as
// its tallest shape; `columns` drops each shape where its columns are shortest
// (masonry), which packs notes of mixed heights tighter. Returns the positions, any
// shape it could not place, and the height the frame needs.
export function layoutPositions(
  items: Array<{ id: string; w: number; h: number }>,
  fixed: Box[],
  frameW: number,
  strategy: LayoutStrategy,
  gap: number,
  maxH = 6000,
): { positions: Placed[]; unplaced: string[]; height: number } {
  const x0 = GRID.x0;
  const y0 = GRID.y0;
  const widths = items.map((i) => i.w).sort((a, b) => a - b);
  const cellW = Math.max(20, widths[Math.floor((widths.length - 1) / 2)] ?? 200);
  const cols = Math.max(1, Math.floor((frameW - 2 * x0 + gap) / (cellW + gap)));
  const colX = (c: number) => x0 + c * (cellW + gap);
  const spanOf = (w: number) => Math.min(cols, Math.max(1, Math.ceil((w + gap) / (cellW + gap))));
  const positions: Placed[] = [];
  const unplaced: string[] = [];
  const hits = (b: Box) => [...fixed, ...positions].filter((f) => overlaps(b, f, gap / 2 - 1));
  // Lowest y >= y where the box is clear, stepping past whatever is in the way.
  const settle = (x: number, y: number, w: number, h: number): number => {
    let cy = y;
    for (let guard = 0; guard < 500 && cy <= maxH; guard++) {
      const hs = hits({ x, y: cy, w, h });
      if (!hs.length) return cy;
      cy = Math.max(...hs.map((f) => f.y + f.h)) + gap;
    }
    return Number.POSITIVE_INFINITY;
  };
  if (strategy === "columns") {
    const bottom: number[] = Array.from({ length: cols }, () => y0);
    for (const it of items) {
      const span = spanOf(it.w);
      let best: { c: number; y: number } | null = null;
      for (let c = 0; c + span <= cols; c++) {
        const top = Math.max(...bottom.slice(c, c + span));
        const y = settle(colX(c), top, it.w, it.h);
        if (!best || y < best.y - 0.5) best = { c, y };
      }
      if (!best || !Number.isFinite(best.y) || best.y + it.h > maxH || colX(best.c) + it.w > frameW) {
        unplaced.push(it.id);
        continue;
      }
      positions.push({ id: it.id, x: colX(best.c), y: best.y, w: it.w, h: it.h });
      for (let c = best.c; c < best.c + span; c++) bottom[c] = best.y + it.h + gap;
    }
  } else {
    let rowY = y0;
    let rowH = 0;
    let col = 0;
    for (const it of items) {
      const span = spanOf(it.w);
      let placed = false;
      for (let guard = 0; guard < 4000 && rowY + it.h <= maxH; guard++) {
        if (col + span > cols) {
          rowY += (rowH || 20) + (rowH ? gap : 0);
          rowH = 0;
          col = 0;
          continue;
        }
        const box = { x: colX(col), y: rowY, w: it.w, h: it.h };
        if (box.x + box.w <= frameW && !hits(box).length) {
          positions.push({ id: it.id, ...box });
          rowH = Math.max(rowH, it.h);
          col += span;
          placed = true;
          break;
        }
        col++;
      }
      if (!placed) unplaced.push(it.id);
    }
  }
  const height = Math.max(0, ...positions.map((p) => p.y + p.h), ...fixed.map((f) => f.y + f.h)) + 20;
  return { positions, unplaced, height };
}
