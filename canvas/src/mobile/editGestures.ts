// Phone shell editing gestures (feedback from an iPhone, 2026-11-03: "the majority of the time I want to pan
// and zoom around, and then rearrange boxes separate").
// - The hand tool stays on: one finger pans, two pinch. A tap never moves or selects a shape.
// - Press and hold (HOLD_MS) on a shape picks it up: it lifts, the phone buzzes, and it follows
//   the finger. It stays picked up after the finger lifts (sticky): touch it again to drag it
//   again; a tap on empty canvas (or Done) drops it. Panning and pinching still work meanwhile.
// - Arrow mode (from + Add): tap the start, then the end (shapes or bare points).
// Pointer events are read on window, capture phase, before tldraw (and the shell's own tap
// handlers) see them; a drag of the picked-up shape is kept from tldraw entirely, so it never
// pans. Pinch zoom is tldraw's touch-event gesture, which this leaves alone.

import { useSyncExternalStore } from "react";
import { type Editor, getDroppedShapesToNewParents, getPointerInfo, kickoutOccludedShapes, react, type TLShape, type TLShapeId } from "tldraw";
import { deviceLock } from "../locks";
import { type ArrowEnd, cameraToFill, dragTo, HANDLE_HIT, HOLD_MS, HOLD_SLOP, isDoubleTap, isTap, moved, type Pt } from "./editModel";
import { immersiveNow } from "./Immersive";
import { beginResizeSession, endResizeSession, handleNear, type Resizing, startResize } from "./resize";

// A touch on the canvas this close to a picked-up shape's handle (centre to centre, px) is that
// handle's: a little past the handle's own target, so a near miss resizes rather than moving
// the shape or panning the canvas.
const HANDLE_REACH = HANDLE_HIT / 2 + 10;

export type EditState = {
  held: TLShapeId | null; // the picked-up shape
  dragging: boolean; // a finger is moving it now
  sheet: boolean; // the + Add sheet is open
  arrow: { from: ArrowEnd | null } | null; // arrow mode, and its first end once tapped
  zoomBack: { x: number; y: number; z: number } | null; // the camera before a double-tap zoom
  // What a finger does to the picked-up shape: "move" it (drag on it), or "resize" it (a drag
  // anywhere scales it from its top-left, a pinch anywhere scales it; the canvas stays put).
  mode: "move" | "resize";
  // The full-board overview: pan and zoom only (no pick-up, no + Add), like a map.
  board: boolean;
};

let state: EditState = { held: null, dragging: false, sheet: false, arrow: null, zoomBack: null, mode: "move", board: false };
const listeners = new Set<() => void>();
export function setEdit(patch: Partial<EditState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}
export const getEdit = () => state;
// Outside React (the touch trace): called on every change.
export function onEdit(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function useEdit(): EditState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getEdit,
    getEdit,
  );
}

// The thread sheet, while it is up (at any of its stops, the lowest one included).
export const SHEET = '[data-testid="sidebar"][data-sheet="1"]';
// The top of whatever covers the bottom of the screen: the thread sheet, or the shell's bar.
export function coverTop(): number {
  const tops = [document.querySelector(".bm-dock"), document.querySelector(SHEET)].flatMap((e) => (e ? [e.getBoundingClientRect().top] : []));
  return tops.length ? Math.min(...tops) : window.innerHeight;
}

// The screen band between the shell's top bar and whatever covers the bottom (client px).
export function visibleBand(): { top: number; bottom: number } {
  const top = Math.max(document.querySelector(".bm-top")?.getBoundingClientRect().bottom ?? 56, document.querySelector(".bm-switch")?.getBoundingClientRect().bottom ?? 0);
  return { top, bottom: coverTop() };
}

const ZOOM_ANIMATION = { animation: { duration: 260 } } as const;

// Double tap on a shape: zoom so it fills the screen width. Double tap again: back to where
// the camera was.
function zoomToggle(editor: Editor, id: TLShapeId | null) {
  const back = state.zoomBack;
  if (back) {
    setEdit({ zoomBack: null });
    editor.setCamera(back, ZOOM_ANIMATION);
    return;
  }
  const b = id ? editor.getShapePageBounds(id) : null;
  if (!b) return;
  const vp = editor.getViewportScreenBounds();
  const band = visibleBand();
  const c = editor.getCamera();
  setEdit({ zoomBack: { x: c.x, y: c.y, z: c.z } });
  editor.setCamera(cameraToFill({ w: vp.w, h: vp.h }, b, { top: band.top - vp.y, bottom: band.bottom - vp.y }), ZOOM_ANIMATION);
}

// The shape a finger is on: the topmost, with a thumb-sized margin, never the frame the phone
// is looking into (that is the whiteboard itself) and never a locked shape.
export function shapeAt(editor: Editor, screen: Pt, opts: { exclude?: string | null; frames?: boolean } = {}): TLShape | null {
  const page = editor.screenToPage(screen);
  const zoom = editor.getZoomLevel() || 1;
  return (
    editor.getShapeAtPoint(page, {
      hitInside: true,
      hitLabels: true,
      hitFrameInside: !!opts.frames,
      margin: 12 / zoom,
      filter: (s) => s.id !== opts.exclude && !s.isLocked,
    }) ?? null
  );
}

// Whether a screen point is on (or within `px` screen px of) a shape.
function onShape(editor: Editor, id: TLShapeId, screen: Pt, px = 14): boolean {
  const b = editor.getShapePageBounds(id);
  if (!b) return false;
  const p = editor.screenToPage(screen);
  const m = px / (editor.getZoomLevel() || 1);
  return p.x >= b.x - m && p.x <= b.x + b.w + m && p.y >= b.y - m && p.y <= b.y + b.h + m;
}

// After a move or a new shape: into the frame it now sits on, or out of the one it left
// (what tldraw's own select tool does at the end of a drag).
export function settle(editor: Editor, id: TLShapeId) {
  const shape = editor.getShape(id);
  if (!shape) return;
  const { reparenting } = getDroppedShapesToNewParents(editor, [shape]);
  for (const [parentId, children] of reparenting) editor.reparentShapes(children, parentId);
  kickoutOccludedShapes(editor, [id]);
}

// The lift outline is the selection: tldraw's own selection would bring up desktop chrome
// (a frame's toolbar) that the phone shell has no use for.
const buzz = () => {
  try {
    navigator.vibrate?.(18);
  } catch {
    // Not on iOS Safari; the lift (or the mode label) shows it.
  }
};

export function pickUp(editor: Editor, id: TLShapeId | null) {
  if (id) {
    editor.selectNone();
    buzz();
  }
  endResizeSession();
  setEdit({ held: id, dragging: false, mode: "move" });
}

// Move <-> Resize for the picked-up shape (the Resize chip, or a second long-press on it).
// A resize session is one undo step, whatever number of drags and pinches it takes.
export function setMode(mode: EditState["mode"]) {
  if (!state.held || state.mode === mode) return;
  if (mode === "resize") beginResizeSession();
  else endResizeSession();
  buzz();
  setEdit({ mode, dragging: false });
}

export function drop(editor: Editor) {
  if (state.held) pickUp(editor, null);
}

// Touch devices start with a lock of their own (locks.ts) so a stray finger cannot move
// anything. In the phone shell nothing moves without a deliberate hold, so the shell lifts that
// lock while it is up (and puts it back after). The board's own "Lock layout" still holds.
export function liftDeviceLock(): () => void {
  const was = deviceLock.get();
  const stop = react("phone-shell-device-lock", () => {
    if (deviceLock.get()) deviceLock.set(false);
  });
  return () => {
    stop();
    deviceLock.set(was);
  };
}

type Opts = {
  // The open frame in frame mode (never picked up by a hold inside it), else null.
  frameId: () => string | null;
  // Board mode: whole frames can be picked up.
  frames: () => boolean;
  // A tap in arrow mode.
  onArrowTap: (end: ArrowEnd) => void;
};

export function installEditGestures(editor: Editor, opts: Opts): () => void {
  const container = editor.getContainer();
  const fingers = new Set<number>();
  // `touch`: iOS Safari cancelled this finger's pointer (it took the touch for a gesture of
  // its own) while the finger stayed down; the hold and the drag carry on from touch events.
  let down: (Pt & { t: number; id: number; tldraw: boolean; touch?: boolean }) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // The last tap (for a double tap), and a second tap of ours in progress.
  let lastTap: (Pt & { t: number }) | null = null;
  let second: (Pt & { t: number; id: number; target: TLShapeId | null }) | null = null;
  // The finger dragging the held shape, where it started (in the shape's parent space) and
  // where the shape was then. `tldraw` is whether tldraw saw this finger go down.
  // `moved`: the history mark is set on the first move, so a pick-up alone is not an undo step.
  let drag: { id: number; start: Pt; origin: Pt; tldraw: boolean; moved: boolean; touch?: boolean; at: Pt } | null = null;
  // A second long-press on the held shape (no movement for HOLD_MS) switches Move <-> Resize.
  let again: ReturnType<typeof setTimeout> | null = null;
  const clearAgain = () => {
    if (again) clearTimeout(again);
    again = null;
  };
  // A two-finger pinch in Resize mode: the two touches, their starting distance, and the resize
  // (from the bottom-right corner, so the top-left stays).
  let pinch: { a: number; b: number; dist: number; r: Resizing; br: Pt; w: number; h: number } | null = null;
  // The single finger on the canvas, from touch events (they keep coming after a pointercancel).
  let finger: { id: number; at: Pt } | null = null;
  // A handle dragged from a canvas touch (the near-miss rule).
  // `at`: where the finger went down; a lift without moving is a tap (it drops the shape).
  // `mode`: from Resize mode (a drag anywhere), where a tap does nothing (it does not drop).
  let resizing: { id: number; r: Resizing; at: Pt; moved: boolean; touch?: boolean; mode?: boolean } | null = null;
  let touches = 0;
  // Every finger down, by touch id, where it is (touch events see fingers anywhere: on the
  // canvas, a handle or a bar).
  const activeTouches = new Map<number, Pt>();
  // Another finger than the one at `p` is down: its touch is somewhere else. (By position, not
  // by count: under load this finger's own touchstart can come before its pointerdown.)
  const otherFinger = (p: Pt) => [...activeTouches.values()].some((t) => Math.hypot(t.x - p.x, t.y - p.y) > 24);

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const swallow = (e: Event) => {
    e.stopImmediatePropagation();
    e.stopPropagation();
    if (e.cancelable) e.preventDefault();
  };
  // A lift that is ours (a tap that drops, an arrow end) of a touch tldraw saw start: keep it
  // from the shell's own tap handlers, but let tldraw finish the touch, or its hand tool would
  // stay mid-pan and drag the board with the next finger.
  const consumeUp = (e: PointerEvent) => {
    swallow(e);
    editor.dispatch({ type: "pointer", target: "canvas", name: "pointer_up", ...getPointerInfo(editor, e) });
  };
  const onCanvas = (e: PointerEvent) => e.target instanceof Node && container.contains(e.target) && !(e.target as Element).closest?.("[data-mobile-ui]");
  const handOn = () => editor.getCurrentToolId() === "hand";

  const startDrag = (id: number, screen: Pt, tldraw: boolean) => {
    const held = state.held;
    const shape = held ? editor.getShape(held) : null;
    if (!shape) return;
    drag = { id, start: editor.getPointInParentSpace(shape, editor.screenToPage(screen)), origin: { x: shape.x, y: shape.y }, tldraw, moved: false, at: screen };
    setEdit({ dragging: true });
  };
  const endDrag = () => {
    if (!drag) return;
    const wasMoved = drag.moved;
    drag = null;
    if (state.held && wasMoved) settle(editor, state.held);
    setEdit({ dragging: false });
  };

  const moveHeld = (screen: Pt) => {
    if (!drag) return;
    // Still within a finger's jitter: not a move yet (it may be a second long-press).
    if (!drag.moved && !moved(drag.at, screen)) return;
    clearAgain();
    const id = state.held;
    const shape = id ? editor.getShape(id) : null;
    if (!shape) return;
    const now = editor.getPointInParentSpace(shape, editor.screenToPage(screen));
    const at = dragTo(drag.origin, drag.start, now);
    if (at.x === shape.x && at.y === shape.y) return;
    if (!drag.moved) {
      drag.moved = true;
      editor.markHistoryStoppingPoint("phone move");
    }
    editor.updateShape({ id: shape.id, type: shape.type, x: at.x, y: at.y });
  };

  const onDown = (e: PointerEvent) => {
    if (!onCanvas(e)) return;
    // The first finger of a new gesture: whatever an earlier one left behind (a lost pointerup)
    // must not make this one look like the second finger of a pinch.
    if (e.isPrimary) fingers.clear();
    fingers.add(e.pointerId);
    clearTimer();
    // Resize mode: every finger on the canvas is the resize's. One finger drags the size from
    // the top-left anchor; a second makes it a pinch (touch events, below). tldraw sees none of
    // it, so the canvas neither pans nor zooms.
    if (state.held && state.mode === "resize" && !state.arrow) {
      swallow(e);
      down = null;
      clearAgain();
      const p = { x: e.clientX, y: e.clientY };
      if (fingers.size > 1 || (e.pointerType === "touch" && otherFinger(p))) {
        resizing = null;
        return;
      }
      const r = startResize(editor, state.held, "bottom_right", p);
      resizing = r ? { id: e.pointerId, r, at: p, moved: false, mode: true } : null;
      // A long-press on the shape itself goes back to Move.
      if (onShape(editor, state.held, p, 0)) {
        const id = e.pointerId;
        again = setTimeout(() => {
          again = null;
          if (resizing && resizing.id === id && !resizing.moved) {
            resizing = null;
            setMode("move");
          }
        }, HOLD_MS);
      }
      return;
    }
    // A finger already down elsewhere (off the canvas too, on a handle say): this one is the
    // second finger of a pinch, not a touch of its own.
    if (fingers.size > 1 || (e.pointerType === "touch" && otherFinger({ x: e.clientX, y: e.clientY }))) {
      // A second finger: pinch and two-finger pan are tldraw's; any drag stops where it is.
      endDrag();
      resizing = null;
      down = null;
      second = null;
      lastTap = null;
      return;
    }
    if (!handOn()) return;
    const p = { x: e.clientX, y: e.clientY };
    // The second tap of a double tap on a shape (or any double tap after one zoomed): ours,
    // so tldraw does not also zoom in a step.
    if (!state.arrow && isDoubleTap(lastTap, { ...p, t: Date.now() })) {
      lastTap = null;
      const target = state.zoomBack ? null : (shapeAt(editor, p, { exclude: opts.frameId(), frames: opts.frames() })?.id ?? null);
      if (state.zoomBack || target) {
        swallow(e);
        down = null;
        second = { ...p, t: Date.now(), id: e.pointerId, target };
        return;
      }
    }
    // On the picked-up shape itself: move it. Off it but near one of its handles: resize, ahead
    // of panning (a tiny shape's handles sit just outside it, so their reach overlaps its body).
    if (state.held && !state.arrow && !onShape(editor, state.held, p, 0)) {
      const h = handleNear(p, HANDLE_REACH);
      const r = h ? startResize(editor, state.held, h, p) : null;
      if (r) {
        swallow(e);
        down = null;
        resizing = { id: e.pointerId, r, at: p, moved: false };
        return;
      }
    }
    // Touch the picked-up shape again: drag it straight away, and keep tldraw from panning. Held
    // still for HOLD_MS instead: a second long-press, into Resize mode.
    if (state.held && !state.arrow && onShape(editor, state.held, p)) {
      swallow(e);
      down = null;
      startDrag(e.pointerId, p, false);
      clearAgain();
      const id = e.pointerId;
      again = setTimeout(() => {
        again = null;
        if (drag && drag.id === id && !drag.moved && fingers.size <= 1) {
          drag = null;
          setMode("resize");
        }
      }, HOLD_MS);
      return;
    }
    down = { ...p, t: Date.now(), id: e.pointerId, tldraw: true };
    // The board overview is a map: a hold does not pick anything up (only inside a frame).
    if (state.arrow || opts.frames() || immersiveNow()) return;
    timer = setTimeout(() => {
      timer = null;
      holdDone(true);
    }, HOLD_MS);
  };

  // The hold is over: pick up the shape under it. `fingerDown`: the finger is still on the glass
  // (from the timer), so it carries on dragging; false when the finger lifted first because the
  // timer ran late (a busy main thread can hold a 450 ms timer back by hundreds of ms).
  const holdDone = (fingerDown: boolean) => {
    const d = down;
    if (!d || fingers.size > 1 || otherFinger(d) || !handOn()) return;
    const hit = shapeAt(editor, d, { exclude: opts.frameId(), frames: opts.frames() });
    if (!hit) return;
    // tldraw's hand tool is waiting to pan this finger: stand it down, then the finger is ours.
    editor.cancel();
    pickUp(editor, hit.id);
    down = null;
    if (!fingerDown) return;
    startDrag(d.id, d, true);
    if (drag && d.touch) drag.touch = true;
  };
  // Held long enough and still within the hold's drift, but the timer has not run yet.
  const lateHold = (d: { t: number } & Pt, at: Pt) => !!timer && Date.now() - d.t >= HOLD_MS && !moved(d, at, HOLD_SLOP);

  const onMove = (e: PointerEvent) => {
    if (second && e.pointerId === second.id) return swallow(e);
    if (state.held && state.mode === "resize" && !resizing && onCanvas(e)) return swallow(e);
    if (resizing && e.pointerId === resizing.id) {
      swallow(e);
      const p = { x: e.clientX, y: e.clientY };
      if (!resizing.moved && !moved(resizing.at, p)) return;
      resizing.moved = true;
      clearAgain();
      resizing.r.move(p);
      return;
    }
    if (drag && e.pointerId === drag.id) {
      swallow(e);
      moveHeld({ x: e.clientX, y: e.clientY });
      return;
    }
    if (down && e.pointerId === down.id && moved(down, { x: e.clientX, y: e.clientY }, HOLD_SLOP)) clearTimer();
  };

  const onUp = (e: PointerEvent) => {
    const wasFinger = fingers.delete(e.pointerId);
    clearAgain();
    if (state.held && state.mode === "resize" && onCanvas(e)) swallow(e);
    if (resizing && e.pointerId === resizing.id) {
      swallow(e);
      // A tap near a handle (no drag) is still a tap off the shape: it drops it. In Resize mode
      // a tap does nothing (Done or the chip leaves the mode).
      if (!resizing.moved && !resizing.mode) drop(editor);
      resizing = null;
      return;
    }
    if (second && e.pointerId === second.id) {
      const sec = second;
      second = null;
      swallow(e);
      if (isTap(sec, { x: e.clientX, y: e.clientY, t: Date.now() })) zoomToggle(editor, sec.target);
      return;
    }
    if (drag && e.pointerId === drag.id) {
      // tldraw saw this finger go down (a hold), so let it see the lift and finish its own
      // bookkeeping; otherwise the whole touch was ours.
      if (!drag.tldraw) swallow(e);
      endDrag();
      return;
    }
    const d = down;
    if (!d || d.id !== e.pointerId) return;
    if (lateHold(d, { x: e.clientX, y: e.clientY })) {
      clearTimer();
      holdDone(false);
      return;
    }
    down = null;
    clearTimer();
    if (!wasFinger || fingers.size || !isTap(d, { x: e.clientX, y: e.clientY, t: Date.now() })) return;
    lastTap = { x: d.x, y: d.y, t: Date.now() };
    if (state.arrow) {
      consumeUp(e);
      const hit = shapeAt(editor, d, { exclude: opts.frameId(), frames: opts.frames() });
      const b = hit ? editor.getShapePageBounds(hit.id) : null;
      opts.onArrowTap(hit && b ? { shapeId: hit.id, point: b.center } : { shapeId: null, point: editor.screenToPage(d) });
      return;
    }
    // A tap off the picked-up shape drops it (and does nothing else, such as opening a frame).
    if (state.held && !onShape(editor, state.held, d)) {
      consumeUp(e);
      drop(editor);
    }
  };

  const onCancel = (e: PointerEvent) => {
    fingers.delete(e.pointerId);
    if (second?.id === e.pointerId) second = null;
    // iOS Safari cancels a pointer when it decides the touch is its own gesture, but the finger
    // is still down and its touch events keep coming: carry on from those.
    // (A touch pointer that lifted ends with pointerup, so a cancelled one is a finger still
    // down, whether or not its touchstart has been seen yet.)
    const still = e.pointerType === "touch" && activeTouches.size <= 1;
    if (resizing && e.pointerId === resizing.id) {
      if (still) resizing.touch = true;
      else resizing = null;
      return;
    }
    if (drag && e.pointerId === drag.id) {
      if (still) drag.touch = true;
      else endDrag();
      return;
    }
    if (down?.id === e.pointerId) {
      if (still && timer) {
        down.touch = true;
        return;
      }
      down = null;
    }
    clearTimer();
  };

  const touchOf = (e: TouchEvent) => (finger ? [...e.changedTouches].find((t) => t.identifier === finger?.id) : undefined);
  const onTouchStart = (e: TouchEvent) => {
    touches = e.touches.length;
    for (const t of Array.from(e.changedTouches)) activeTouches.set(t.identifier, { x: t.clientX, y: t.clientY });
    // Resize mode, a second finger: a pinch anywhere scales the shape from its top-left.
    if (state.held && state.mode === "resize" && !pinch && activeTouches.size >= 2) {
      const [[a, pa], [b, pb]] = [...activeTouches.entries()];
      const page = editor.getShapePageBounds(state.held);
      const dist = Math.hypot(pa.x - pb.x, pa.y - pb.y);
      if (page && dist > 10) {
        const br = editor.pageToScreen({ x: page.x + page.w, y: page.y + page.h });
        const r = startResize(editor, state.held, "bottom_right", br);
        const z = editor.getZoomLevel();
        if (r) {
          clearAgain();
          resizing = null;
          pinch = { a, b, dist, r, br, w: page.w * z, h: page.h * z };
        }
      }
    }
    const t = e.changedTouches[0];
    finger = touches === 1 && t && e.target instanceof Node && container.contains(e.target) ? { id: t.identifier, at: { x: t.clientX, y: t.clientY } } : null;
  };
  const onTouchMove = (e: TouchEvent) => {
    for (const c of Array.from(e.changedTouches)) if (activeTouches.has(c.identifier)) activeTouches.set(c.identifier, { x: c.clientX, y: c.clientY });
    if (pinch) {
      const pa = activeTouches.get(pinch.a), pb = activeTouches.get(pinch.b);
      if (pa && pb) {
        const f = Math.hypot(pa.x - pb.x, pa.y - pb.y) / pinch.dist;
        pinch.r.move({ x: pinch.br.x + pinch.w * (f - 1), y: pinch.br.y + pinch.h * (f - 1) });
      }
      return;
    }
    const t = touchOf(e);
    if (!t) return;
    const p = { x: t.clientX, y: t.clientY };
    if (resizing?.touch) {
      if (!resizing.moved && !moved(resizing.at, p)) return;
      resizing.moved = true;
      resizing.r.move(p);
      return;
    }
    if (drag?.touch) {
      moveHeld(p);
      return;
    }
    if (down?.touch && moved(down, p, HOLD_SLOP)) {
      clearTimer();
      down = null;
    }
  };
  const onTouchEnd = (e: TouchEvent) => {
    touches = e.touches.length;
    const t = touchOf(e);
    for (const c of Array.from(e.changedTouches)) activeTouches.delete(c.identifier);
    if (pinch && (!activeTouches.has(pinch.a) || !activeTouches.has(pinch.b))) pinch = null;
    // A cancelled pointer whose touchstart came late: this is still the one finger.
    const lifted = t ?? (down?.touch && activeTouches.size === 0 ? e.changedTouches[0] : undefined);
    if (!lifted) return;
    finger = null;
    if (resizing?.touch) resizing = null;
    if (drag?.touch) endDrag();
    if (down?.touch) {
      if (lateHold(down, { x: lifted.clientX, y: lifted.clientY })) {
        clearTimer();
        holdDone(false);
        return;
      }
      clearTimer();
      down = null;
    }
  };

  // Resize mode: tldraw's own touch gestures (its pinch zoom) and Safari's page gestures must
  // not see the fingers that resize. (Window, capture phase: tldraw listens on its container.)
  const inResize = (e: Event) => !!state.held && state.mode === "resize" && e.target instanceof Node && container.contains(e.target);
  const blockTouch = (e: Event) => {
    if (!inResize(e)) return;
    e.stopPropagation();
    if (e.type === "touchmove" && e.cancelable) e.preventDefault();
  };
  const blockGesture = (e: Event) => {
    if (state.held && state.mode === "resize") e.preventDefault();
  };

  // No long-press menu or callout over a hold.
  const onContext = (e: Event) => {
    if (e.target instanceof Node && container.contains(e.target) && (timer || drag || state.held)) e.preventDefault();
  };

  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onCancel, true);
  window.addEventListener("contextmenu", onContext, true);
  window.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
  for (const t of ["touchstart", "touchmove", "touchend", "touchcancel"]) window.addEventListener(t, blockTouch, { capture: true, passive: false });
  for (const t of ["gesturestart", "gesturechange"]) window.addEventListener(t, blockGesture, { capture: true, passive: false });
  window.addEventListener("touchmove", onTouchMove, { capture: true, passive: true });
  window.addEventListener("touchend", onTouchEnd, { capture: true, passive: true });
  window.addEventListener("touchcancel", onTouchEnd, { capture: true, passive: true });
  return () => {
    clearTimer();
    endDrag();
    window.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancel, true);
    window.removeEventListener("contextmenu", onContext, true);
    window.removeEventListener("touchstart", onTouchStart, true);
    clearAgain();
    for (const t of ["touchstart", "touchmove", "touchend", "touchcancel"]) window.removeEventListener(t, blockTouch, true);
    for (const t of ["gesturestart", "gesturechange"]) window.removeEventListener(t, blockGesture, true);
    window.removeEventListener("touchmove", onTouchMove, true);
    window.removeEventListener("touchend", onTouchEnd, true);
    window.removeEventListener("touchcancel", onTouchEnd, true);
  };
}
