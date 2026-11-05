// Phone editing (editGestures.ts, AddSheet.tsx): the pure parts, unit-tested in
// test/mobile-edit.test.ts.

// A finger that stays within SLOP px for HOLD_MS picks up the shape under it. A touch that
// lifts within SLOP px and TAP_MS is a tap; anything that moves further is a pan.
export const HOLD_MS = 450;
// A finger is never perfectly still: a hold allows this much drift (a tap still uses SLOP).
export const HOLD_SLOP = 14;
export const TAP_MS = 400;
export const SLOP = 8;

export type Pt = { x: number; y: number };

export const moved = (a: Pt, b: Pt, slop = SLOP) => Math.hypot(b.x - a.x, b.y - a.y) > slop;

export function isTap(down: Pt & { t: number }, up: Pt & { t: number }): boolean {
  return !moved(down, up) && up.t - down.t <= TAP_MS;
}

// New shapes keep a thumb-friendly size on screen whatever the zoom: the tldraw `scale` prop
// that shows a shape at `screen` times its natural size at this zoom, clamped to 0.5..8.
export function scaleFor(zoom: number, screen = 1): number {
  const z = zoom > 0 && Number.isFinite(zoom) ? zoom : 1;
  return Math.min(8, Math.max(0.5, screen / z));
}

// A box `w` x `h` screen px, in page units, centred on `at` (page).
export function boxAt(at: Pt, zoom: number, w = 120, h = 80): { x: number; y: number; w: number; h: number } {
  const s = scaleFor(zoom);
  return { x: at.x - (w * s) / 2, y: at.y - (h * s) / 2, w: w * s, h: h * s };
}

// One end of an arrow being added: a shape (bound to it) or a bare point on the page.
export type ArrowEnd = { shapeId: string | null; point: Pt };

// The arrow shape for two ends: placed at the start, `end` relative to it. Two taps on the
// same shape, or on the same spot, make no arrow.
export function arrowBetween(from: ArrowEnd, to: ArrowEnd): { x: number; y: number; end: Pt } | null {
  if (from.shapeId && from.shapeId === to.shapeId) return null;
  if (!from.shapeId && !to.shapeId && !moved(from.point, to.point, 1)) return null;
  return { x: from.point.x, y: from.point.y, end: { x: to.point.x - from.point.x, y: to.point.y - from.point.y } };
}

// The parent-space position of a dragged shape: where it started plus how far the finger went
// (both measured in the parent's space, so a shape inside a frame follows the finger exactly).
export function dragTo(origin: Pt, startInParent: Pt, nowInParent: Pt): Pt {
  return { x: origin.x + nowInParent.x - startInParent.x, y: origin.y + nowInParent.y - startInParent.y };
}

// Zoom on the phone ("I can't zoom in enough to read things").
// The phone keeps few zoom steps (MOBILE_ZOOM_STEPS, 0.1x to 2x, from #109): tldraw pre-renders
// its hatch patterns for every power of two up to last / first, so a wide range is slow to
// start. Inside a frame tldraw also multiplies the steps by the frame's fit zoom, so they
// topped out near 0.8x real zoom. Instead of a wider range, the range slides (readingZoom.ts):
// the steps times a power of two `k`, picked from the zoom now. Near the top of the range it
// moves up, near the bottom it moves back down, between k = 1 (the board's own range) and the
// k whose top reaches READ_ZOOM real zoom. last / first stays exactly the same (a power of two
// scales without rounding), so tldraw never pre-renders its patterns again.
export const READ_ZOOM = 8;
export const SLIDE_UP = 0.75; // past this share of the top, move up
export const SLIDE_DOWN = 1.5; // under this many times the bottom, move down

// `zoom`: the real zoom now; `base`: tldraw's base zoom (1, or a frame's fit zoom); `k`: the
// multiplier in use. Returns the multiplier to use.
// Below the board's own range (k < 1) only by an explicit jump (jumpK: "view the full board" on a
// page too big for its lowest step); zooming in from there brings the range back up to 1.
export const MIN_K = 1 / 32;
export function jumpK(steps: readonly number[], zoom: number, base: number): number {
  const lo = steps[0] * (base > 0 && Number.isFinite(base) ? base : 1);
  return zoom >= lo ? 1 : Math.max(MIN_K, 2 ** Math.floor(Math.log2(zoom / lo)));
}
export function readingK(steps: readonly number[], zoom: number, base: number, k: number, want = READ_ZOOM): number {
  const b = base > 0 && Number.isFinite(base) ? base : 1;
  const lo = steps[0] * b, hi = steps[steps.length - 1] * b;
  if (Number.isFinite(k) && k > 0 && k < 1) {
    let low = Math.max(MIN_K, 2 ** Math.round(Math.log2(k)));
    while (low < 1 && zoom >= 2 * lo * low) low *= 2;
    if (low < 1) return low;
  }
  const ceil = 2 ** Math.max(0, Math.ceil(Math.log2(want / hi)));
  let next = Number.isFinite(k) && k >= 1 ? 2 ** Math.round(Math.log2(k)) : 1;
  next = Math.min(next, ceil);
  while (next < ceil && zoom >= SLIDE_UP * hi * next) next *= 2;
  while (next > 1 && zoom <= SLIDE_DOWN * lo * next) next /= 2;
  return next;
}

// Double tap within DOUBLE_MS and DOUBLE_PX of the first tap.
export const DOUBLE_MS = 320;
export const DOUBLE_PX = 40;
export function isDoubleTap(first: (Pt & { t: number }) | null, second: Pt & { t: number }): boolean {
  return !!first && second.t - first.t <= DOUBLE_MS && !moved(first, second, DOUBLE_PX);
}

// The camera that shows a shape (page bounds) across the screen width with `margin` px each
// side, centred in the band between `top` and `bottom` (screen px from the viewport's top); a
// shape taller than the band shows its top.
export function cameraToFill(view: { w: number; h: number }, shape: { x: number; y: number; w: number; h: number }, band: { top: number; bottom: number }, margin = 12): { x: number; y: number; z: number } {
  const z = (view.w - 2 * margin) / Math.max(1, shape.w);
  const bandH = Math.max(40, band.bottom - band.top);
  const cy = shape.h * z <= bandH ? shape.y + shape.h / 2 : shape.y + (bandH / 2 - margin) / z;
  return { x: view.w / 2 / z - (shape.x + shape.w / 2), y: (band.top + bandH / 2) / z - cy, z };
}

// Resize handles on a picked-up shape ("the touch to move is better but I can't resize it").
export type Handle = "top_left" | "top" | "top_right" | "right" | "bottom_right" | "bottom" | "bottom_left" | "left";
export const CORNERS: Handle[] = ["top_left", "top_right", "bottom_right", "bottom_left"];
export const EDGES: Handle[] = ["top", "right", "bottom", "left"];
export const HANDLE_HIT = 44; // touch target, CSS px (drawn smaller)
export type Box = { x: number; y: number; w: number; h: number };

// Which handles a shape gets. Images and stickies keep their aspect (corners only); text gets
// its width on the side handles (plus corners, which scale it, as on desktop, once it is tall
// enough for both); boxes, frames and the rest get all eight. Edge handles need room: the side
// must be at least `room` screen px (two touch targets, so corner and edge targets just meet).
export function handlesFor(type: string, screen: { w: number; h: number }, room = HANDLE_HIT * 2): Handle[] {
  if (type === "image" || type === "video" || type === "note") return [...CORNERS];
  // Text a line or two tall: its width is what changes, and corner targets would cover the sides.
  if (type === "text" && screen.h < room) return ["right", "left"];
  const sides = type === "text" ? (["right", "left"] as Handle[]) : EDGES;
  return [...CORNERS, ...sides.filter((h) => (h === "left" || h === "right" ? screen.h : screen.w) >= room)];
}

export const aspectLocked = (type: string, handle: Handle) => type === "image" || type === "video" || type === "note" || (type === "text" && CORNERS.includes(handle));

// Dragging `handle` of `box` (page units) by (dx, dy) page units: the new box, the point that
// stays put (the opposite corner or edge), and the scale. The handle follows the finger 1:1;
// a box never gets smaller than `min` on either side (no flipping). With `locked`, the larger
// of the two scales wins, as tldraw does.
export function resizeBox(handle: Handle, box: Box, dx: number, dy: number, min: number, locked = false): { box: Box; origin: Pt; scale: Pt } {
  const left = handle.includes("left"), right = handle.includes("right"), top = handle.startsWith("top"), bottom = handle.startsWith("bottom");
  let sx = left ? (box.w - dx) / box.w : right ? (box.w + dx) / box.w : 1;
  let sy = top ? (box.h - dy) / box.h : bottom ? (box.h + dy) / box.h : 1;
  sx = Math.max(min / box.w, sx);
  sy = Math.max(min / box.h, sy);
  if (locked) {
    const corner = (left || right) && (top || bottom);
    const s = corner ? Math.max(sx, sy) : left || right ? sx : sy;
    sx = sy = Math.max(min / Math.min(box.w, box.h), s);
  }
  const origin = { x: left ? box.x + box.w : right ? box.x : box.x + box.w / 2, y: top ? box.y + box.h : bottom ? box.y : box.y + box.h / 2 };
  const w = box.w * sx, h = box.h * sy;
  return { box: { x: origin.x + (box.x - origin.x) * sx, y: origin.y + (box.y - origin.y) * sy, w, h }, origin, scale: { x: sx, y: sy } };
}

// Handle centres on screen for a screen rect. On a side shorter than two touch targets the
// handles move out by half a target, so their targets sit outside the shape: on a tiny shape
// (a sticky ~22 px across at frame fit) targets centred on its corners would cover all of it,
// and a touch meant to move it would grab a handle instead.
export function handlePoint(handle: Handle, r: { left: number; top: number; width: number; height: number }, hit = HANDLE_HIT): Pt {
  const ox = r.width < hit * 2 ? hit / 2 : 0, oy = r.height < hit * 2 ? hit / 2 : 0;
  const x = handle.includes("left") ? r.left - ox : handle.includes("right") ? r.left + r.width + ox : r.left + r.width / 2;
  const y = handle.startsWith("top") ? r.top - oy : handle.startsWith("bottom") ? r.top + r.height + oy : r.top + r.height / 2;
  return { x, y };
}

// Done / Delete sit above the bar unless a handle's touch target would land on them; then
// they go under the top bar. `chips`: their zone at the bottom (top and bottom, screen px).
export function chipsSide(points: Pt[], bottomZone: { top: number; bottom: number }, topZone: { top: number; bottom: number }, hit = HANDLE_HIT): "bottom" | "top" {
  const hits = (z: { top: number; bottom: number }) => points.some((p) => p.y + hit / 2 > z.top && p.y - hit / 2 < z.bottom);
  return hits(bottomZone) && !hits(topZone) ? "top" : "bottom";
}
