// Resizing a picked-up shape from one of its handles (phone shell). Shared by the handle
// elements (ResizeHandles.tsx) and the canvas gestures (editGestures.ts), which take a touch
// that lands within reach of a handle but not on its element (a near miss, or whatever iOS hit
// testing does) as that handle's drag, before it could move the shape or pan the canvas.
// - Boxes, frames, arrows, pen marks: free, through tldraw's own resize (editor.resizeShape),
//   from where the drag started, so it follows the finger 1:1 without drifting.
// - Images keep their aspect (tldraw's own rule); text's side handles change its width (it
//   re-wraps), its corners scale it, as on desktop.
// - Stickies keep their aspect: tldraw's notes do not resize by default (resizeMode "none"),
//   so the phone scales them through their `scale` prop, as tldraw's "scale" mode would.
// One undo step per drag (marked on the first move).

import type { Box as TLBox, Editor, Mat, TLShape, TLShapeId } from "tldraw";
import { aspectLocked, type Box, type Handle, type Pt, resizeBox } from "./editModel";

// Everything about the shape is read when the drag starts: tldraw caches geometry by id, so
// reading it during the drag would give the already-resized bounds and compound each move.
type Start = { handle: Handle; start: Pt; shape: TLShape; page: Box; bounds: TLBox; transform: Mat; zoom: number; marked: boolean };

export type Resizing = { move(now: Pt): void };

// Resize mode (editGestures.ts): its drags and pinches are one undo step, whatever their number.
let session: { marked: boolean } | null = null;
export function beginResizeSession() {
  session = { marked: false };
}
export function endResizeSession() {
  session = null;
}

export function startResize(editor: Editor, id: TLShapeId, handle: Handle, at: Pt): Resizing | null {
  const shape = editor.getShape(id);
  const page = editor.getShapePageBounds(id);
  if (!shape || !page) return null;
  const d: Start = { handle, start: at, shape, page: { x: page.x, y: page.y, w: page.w, h: page.h }, bounds: editor.getShapeGeometry(shape).bounds.clone(), transform: editor.getShapePageTransform(shape).clone(), zoom: editor.getZoomLevel(), marked: false };
  return { move: (now) => resize(editor, d, now) };
}

function resize(editor: Editor, d: Start, now: Pt) {
  const a = editor.screenToPage(d.start), b = editor.screenToPage(now);
  const locked = aspectLocked(d.shape.type, d.handle);
  const next = resizeBox(d.handle, d.page, b.x - a.x, b.y - a.y, 16 / d.zoom, locked);
  if (!d.marked) {
    if (next.scale.x === 1 && next.scale.y === 1) return;
    d.marked = true;
    if (!session?.marked) editor.markHistoryStoppingPoint("phone resize");
    if (session) session.marked = true;
  }
  const s = d.shape;
  if (s.type === "note") {
    const scale = ((s.props as { scale?: number }).scale ?? 1) * next.scale.x;
    const at = editor.getPointInParentSpace(s.id, { x: next.box.x, y: next.box.y });
    editor.updateShape({ id: s.id, type: s.type, x: at.x, y: at.y, props: { scale } });
    return;
  }
  editor.resizeShape(s.id, next.scale, {
    initialShape: s,
    initialBounds: d.bounds,
    initialPageTransform: d.transform,
    scaleOrigin: next.origin,
    dragHandle: d.handle,
    mode: "resize_bounds",
    isAspectRatioLocked: locked,
  });
}

// Where the picked-up shape's handles are on screen now (ResizeHandles publishes them as it
// renders), for the canvas gestures' near-miss rule.
let targets: { handle: Handle; at: Pt }[] = [];
export function setHandleTargets(next: { handle: Handle; at: Pt }[]) {
  targets = next;
}
// The handle within `reach` px of a touch, the nearest first.
export function handleNear(p: Pt, reach: number): Handle | null {
  let best: { handle: Handle; d: number } | null = null;
  for (const t of targets) {
    const d = Math.max(Math.abs(t.at.x - p.x), Math.abs(t.at.y - p.y));
    if (d <= reach && (!best || d < best.d)) best = { handle: t.handle, d };
  }
  return best?.handle ?? null;
}
