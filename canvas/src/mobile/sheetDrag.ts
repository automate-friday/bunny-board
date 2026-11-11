// Phone sheets (thread, search, tiles): drags that follow the finger and land by position and
// speed. Reported on iOS: "When I try to swipe up it swipes down or gets cut off". The old swipe
// treated any drag under 28 px as a tap (a tap on a grip closed the sheet or stepped its size,
// wrapping from full to peek) and snapped by position alone.
//
// A drag starts after 4 px of vertical movement, follows the finger 1:1 from where it
// started, and on release `snapSheet` picks the stop nearest to where the sheet would coast to
// (position + velocity x 180 ms), or closes it when that is well below the lowest stop. Taps
// do nothing. Pure parts are unit-tested (test/mobile-shell.test.ts).

import { useCallback, useRef } from "react";
import { multiTouch } from "./boardGestures";

export type Snap = { kind: "stop"; height: number; index: number } | { kind: "close" };

// height: the sheet's height now (px); velocity: px/ms, positive when the sheet grows (finger
// moving up); stops: heights, ascending; closeBelow: projected heights under this close.
export function snapSheet(height: number, velocity: number, stops: readonly number[], closeBelow = -Infinity): Snap {
  const projected = height + velocity * 180;
  if (projected < closeBelow) return { kind: "close" };
  let index = 0;
  for (let i = 1; i < stops.length; i++) if (Math.abs(stops[i] - projected) < Math.abs(stops[index] - projected)) index = i;
  return { kind: "stop", height: stops[index], index };
}

// Velocity from the last ~100 ms of samples (px/ms, positive = finger moving up).
export function upVelocity(samples: readonly { y: number; t: number }[]): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  let first = samples[0];
  for (const s of samples) if (last.t - s.t <= 100) {
    first = s;
    break;
  }
  const dt = last.t - first.t;
  return dt > 0 ? (first.y - last.y) / dt : 0;
}

type Handlers = {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerCancel: (e: React.PointerEvent) => void;
  style: React.CSSProperties;
};

// Drag handlers for a grip or header. `move(up)` gets the finger's travel since the press
// (px, positive = up); `end(up, velocity)` on release, only for a real drag.
export function useVerticalDrag(move: (up: number) => void, end: (up: number, velocity: number) => void): Handlers {
  const state = useRef<{ id: number; y: number; samples: { y: number; t: number }[]; dragging: boolean } | null>(null);
  const cbs = useRef({ move, end });
  cbs.current = { move, end };
  return {
    onPointerDown: (e) => {
      if ((e.target as HTMLElement).closest("button,input,textarea,a,select,[data-no-drag]")) return;
      state.current = { id: e.pointerId, y: e.clientY, samples: [{ y: e.clientY, t: e.timeStamp }], dragging: false };
    },
    onPointerMove: (e) => {
      const s = state.current;
      if (!s || s.id !== e.pointerId) return;
      // A second finger came down: a pinch, not this drag (it springs back, never commits).
      if (multiTouch()) {
        state.current = null;
        if (s.dragging) cbs.current.move(0);
        return;
      }
      if (!s.dragging) {
        if (Math.abs(e.clientY - s.y) < 4) return;
        s.dragging = true;
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      }
      e.preventDefault();
      s.samples.push({ y: e.clientY, t: e.timeStamp });
      if (s.samples.length > 12) s.samples.shift();
      cbs.current.move(s.y - e.clientY);
    },
    onPointerUp: (e) => {
      const s = state.current;
      state.current = null;
      if (!s || s.id !== e.pointerId || !s.dragging) return;
      s.samples.push({ y: e.clientY, t: e.timeStamp });
      cbs.current.end(s.y - e.clientY, upVelocity(s.samples));
    },
    onPointerCancel: (e) => {
      const s = state.current;
      state.current = null;
      if (s?.dragging) cbs.current.end(s.y - (s.samples.at(-1)?.y ?? s.y), 0);
      void e;
    },
    // The browser must not scroll, zoom or rubber-band while a grip is dragged (iOS Safari).
    style: { touchAction: "none", overscrollBehavior: "contain", userSelect: "none", WebkitUserSelect: "none" },
  };
}

// Phone dialog sheets (New agent, New frame/page, Rename, Move). Reported on iOS: "Can't dismiss
// the drawer by swiping and it moves up like this when I swipe down": the grip was decoration,
// and a swipe the sheet did not use scrolled the page behind it, which carried the sheet (fixed
// to the visual viewport) up and left a gap below it.
//
// A downward drag on the sheet follows the finger and, on release, closes it past a distance
// or on a downward flick; otherwise it springs back. In the scrolling form a drag only starts
// when the form is at its top (otherwise the form scrolls), and never from a text field. A move
// the sheet does not use never reaches the page: only a scrolling area inside the sheet moves.

// down: finger travel since the drag began (px, positive = down); velocity: px/ms, positive =
// down; height: the sheet's height (px).
export function dismissOnRelease(down: number, velocity: number, height: number): boolean {
  return down > Math.min(140, height * 0.3) || (velocity > 0.5 && down > 24);
}

// The nearest element between `target` and `sheet` that scrolls vertically, or null.
function scrollerOf(target: Element | null, sheet: HTMLElement): HTMLElement | null {
  for (let n = target as HTMLElement | null; n && n !== sheet; n = n.parentElement) {
    if (n.scrollHeight > n.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(n).overflowY)) return n;
  }
  return null;
}

// Ref callback for the sheet element. `close` runs once the sheet has slid away; `enabled`
// false (e.g. while a start is in flight) keeps the sheet put.
export function useSwipeDismiss(close: () => void, enabled = true): (sheet: HTMLElement | null) => void {
  const cbs = useRef({ close, enabled });
  cbs.current = { close, enabled };
  const detach = useRef<(() => void) | null>(null);
  return useCallback((sheet: HTMLElement | null) => {
    detach.current?.();
    detach.current = null;
    if (!sheet) return;
    type Drag = { y0: number; x0: number; samples: { y: number; t: number }[]; claimed: boolean; scroller: HTMLElement | null; mayDismiss: boolean };
    let s: Drag | null = null;
    let leaving = false;
    const place = (dy: number, animate: boolean) => {
      sheet.style.transition = animate ? "transform .2s ease-out" : "none";
      sheet.style.transform = dy > 0 ? `translateY(${dy}px)` : "";
    };
    const abandon = () => {
      if (s?.claimed) place(0, true);
      s = null;
    };
    const start = (e: TouchEvent) => {
      if (leaving) return;
      if (e.touches.length !== 1) return abandon();
      const t = e.touches[0];
      const target = e.target as Element;
      const scroller = scrollerOf(target, sheet);
      const field = !!target.closest?.("input,textarea,select,[contenteditable=true],[data-no-drag]");
      s = { y0: t.clientY, x0: t.clientX, samples: [{ y: t.clientY, t: e.timeStamp }], claimed: false, scroller, mayDismiss: cbs.current.enabled && !field && !(scroller && scroller.scrollTop > 0) };
    };
    const move = (e: TouchEvent) => {
      if (leaving) return void (e.cancelable && e.preventDefault());
      if (!s) return;
      if (e.touches.length !== 1) return abandon();
      const t = e.touches[0];
      const dy = t.clientY - s.y0;
      const dx = t.clientX - s.x0;
      if (!s.claimed) {
        if (s.mayDismiss && dy > 6 && dy > Math.abs(dx)) s.claimed = true;
        else {
          if (Math.abs(dy) > 6 || Math.abs(dx) > 6) s.mayDismiss = false;
          // Outside a scrolling area the page behind must not move.
          if (!s.scroller && e.cancelable) e.preventDefault();
          return;
        }
      }
      if (e.cancelable) e.preventDefault();
      s.samples.push({ y: t.clientY, t: e.timeStamp });
      if (s.samples.length > 12) s.samples.shift();
      place(dy, false);
    };
    const end = (e: TouchEvent) => {
      const d = s;
      s = null;
      if (!d?.claimed) return;
      const last = e.changedTouches[0];
      if (last) d.samples.push({ y: last.clientY, t: e.timeStamp });
      const down = (last?.clientY ?? d.samples[d.samples.length - 1].y) - d.y0;
      const h = sheet.getBoundingClientRect().height;
      if (e.type === "touchend" && cbs.current.enabled && dismissOnRelease(down, -upVelocity(d.samples), h)) {
        leaving = true;
        place(h + 40, true);
        (document.activeElement as HTMLElement | null)?.blur?.();
        setTimeout(() => cbs.current.close(), 180);
      } else place(0, true);
    };
    sheet.addEventListener("touchstart", start, { passive: true });
    sheet.addEventListener("touchmove", move, { passive: false });
    sheet.addEventListener("touchend", end);
    sheet.addEventListener("touchcancel", end);
    detach.current = () => {
      sheet.removeEventListener("touchstart", start);
      sheet.removeEventListener("touchmove", move);
      sheet.removeEventListener("touchend", end);
      sheet.removeEventListener("touchcancel", end);
    };
  }, []);
}
