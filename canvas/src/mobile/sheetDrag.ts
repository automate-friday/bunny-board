// Phone sheets (thread, search, tiles): drags that follow the finger and land by position and
// speed. Reported on iOS: "When I try to swipe up it swipes down or gets cut off". The old swipe
// treated any drag under 28 px as a tap (a tap on a grip closed the sheet or stepped its size,
// wrapping from full to peek) and snapped by position alone.
//
// A drag starts after 4 px of vertical movement, follows the finger 1:1 from where it
// started, and on release `snapSheet` picks the stop nearest to where the sheet would coast to
// (position + velocity x 180 ms), or closes it when that is well below the lowest stop. Taps
// do nothing. Pure parts are unit-tested (test/mobile-shell.test.ts).

import { useRef } from "react";
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
