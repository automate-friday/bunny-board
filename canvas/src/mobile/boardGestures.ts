// Phone board view ("View full board", ⋯ Show on board): the whole screen moves the camera.
// Reported on the live board: the board view "doesn't let me interact with the board or zoom
// in". The board view's canvas only took touches that began on the canvas itself; a drag or
// pinch that began on the dock (its grip and the space around its buttons), the frame label or
// the outline, or below the page's layout viewport (Safari's bar area) went nowhere, and on a
// 390x664 phone the bottom third of the screen is the dock. Here a gesture that starts on any
// non-control surface outside the canvas pans (one finger) or pinch-zooms (two fingers) the
// camera too. Buttons keep their taps; the dock's grip keeps its one-finger swipe up for the
// frames, and a second finger turns that swipe into a pinch.

import type { Editor } from "tldraw";

type Cam = { x: number; y: number; z: number };
type Pt = { x: number; y: number };

// A one-finger move of the board by (dx, dy) screen px.
export function panCamera(cam: Cam, dx: number, dy: number): Cam {
  return { x: cam.x + dx / cam.z, y: cam.y + dy / cam.z, z: cam.z };
}

// Two fingers from (a0, b0) to (a1, b1), in viewport px: the page point under the first
// midpoint stays under the fingers' midpoint, scaled by how far the fingers spread.
// `clamp` bounds the zoom (the editor's own steps).
export function pinchCamera(cam: Cam, a0: Pt, b0: Pt, a1: Pt, b1: Pt, clamp: (z: number) => number = (z) => z): Cam {
  const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y) || 1;
  const d1 = Math.hypot(b1.x - a1.x, b1.y - a1.y) || 1;
  const z = clamp(cam.z * (d1 / d0));
  const m0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
  const m1 = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 };
  // screen = (page + cam) * z  →  the page point under m0 now:
  const px = m0.x / cam.z - cam.x, py = m0.y / cam.z - cam.y;
  return { x: m1.x / z - px, y: m1.y / z - py, z };
}

const CONTROLS = "button,a,input,textarea,select,label,[role=button],[role=menuitem],[role=menu],[role=dialog],[contenteditable=true],.bm-scrim,[data-no-camera]";

const TEXT_AND_SHEETS = "input,textarea,select,[contenteditable=true],[role=menu],[role=dialog],.bm-scrim,[data-no-camera]";

// Whether a touch that starts on `target` belongs to the board camera (outside the canvas,
// not on a control). `fingers`: touches down now. The grip's one-finger drag is its own.
export function cameraSurface(target: Element | null, canvas: Element, fingers: number): boolean {
  if (!target) return true; // below the layout viewport: nothing there but the board
  if (canvas.contains(target)) return false; // tldraw's own hand tool
  // Two fingers are a pinch wherever they land on the dock, its buttons included (never a tap);
  // text fields, menus and sheets keep theirs.
  if (fingers >= 2) return !target.closest(TEXT_AND_SHEETS);
  if (target.closest(CONTROLS)) return false;
  return !target.closest(".bm-grip");
}

// Another finger is down: one-finger drags (sheet and dock grips) stand down for it.
let touchesDown = 0;
export const multiTouch = () => touchesDown > 1;
if (typeof window !== "undefined") {
  const count = (e: TouchEvent) => { touchesDown = e.touches.length; };
  for (const t of ["touchstart", "touchend", "touchcancel"] as const) window.addEventListener(t, count, { capture: true, passive: true });
}

// Installs the board-view surface gestures; returns the remover.
export function attachBoardSurface(editor: Editor): () => void {
  const canvas = editor.getContainer();
  let g: { cam: Cam; pts: Map<number, Pt>; start: Map<number, Pt> } | null = null;
  const vp = () => editor.getViewportScreenBounds();
  const local = (t: Touch): Pt => ({ x: t.clientX - vp().x, y: t.clientY - vp().y });
  const clamp = (z: number) => {
    const o = editor.getCameraOptions();
    const base = editor.getBaseZoom();
    const steps = o.zoomSteps;
    return Math.min(Math.max(z, steps[0] * base), steps[steps.length - 1] * base);
  };
  // A new finger count (start or lift): the gesture continues from the camera as it is now.
  const restart = (e: TouchEvent) => {
    const pts = new Map<number, Pt>();
    for (const t of Array.from(e.touches)) pts.set(t.identifier, local(t));
    g = pts.size ? { cam: { ...editor.getCamera() }, pts, start: new Map(pts) } : null;
  };
  const onStart = (e: TouchEvent) => {
    if (g) return restart(e);
    // Decided by the gesture's first finger (a second finger joining tldraw's own pan stays its).
    const first = e.touches[0];
    if (!first) return;
    const target = first.target instanceof Element ? first.target : document.elementFromPoint(first.clientX, first.clientY);
    // A touch outside the window's layout viewport targets the document itself.
    const el = target === document.documentElement || target === document.body ? null : target;
    if (!cameraSurface(el, canvas, e.touches.length)) return;
    restart(e);
  };
  const onMove = (e: TouchEvent) => {
    if (!g) return;
    if (e.cancelable) e.preventDefault();
    const now = Array.from(e.touches).filter((t) => g?.start.has(t.identifier));
    if (now.length >= 2) {
      const [a, b] = now;
      const s = editor.getCamera();
      const next = pinchCamera(g.cam, g.start.get(a.identifier) as Pt, g.start.get(b.identifier) as Pt, local(a), local(b), clamp);
      if (next.x !== s.x || next.y !== s.y || next.z !== s.z) editor.setCamera(next, { immediate: true });
    } else if (now.length === 1) {
      const t = now[0];
      const p0 = g.start.get(t.identifier) as Pt;
      const p = local(t);
      editor.setCamera(panCamera(g.cam, p.x - p0.x, p.y - p0.y), { immediate: true });
    }
  };
  const onEnd = (e: TouchEvent) => {
    if (!g) return;
    if (e.touches.length) restart(e);
    else g = null;
  };
  const opts = { capture: true, passive: false } as const;
  window.addEventListener("touchstart", onStart, opts);
  window.addEventListener("touchmove", onMove, opts);
  window.addEventListener("touchend", onEnd, opts);
  window.addEventListener("touchcancel", onEnd, opts);
  return () => {
    window.removeEventListener("touchstart", onStart, opts);
    window.removeEventListener("touchmove", onMove, opts);
    window.removeEventListener("touchend", onEnd, opts);
    window.removeEventListener("touchcancel", onEnd, opts);
  };
}
