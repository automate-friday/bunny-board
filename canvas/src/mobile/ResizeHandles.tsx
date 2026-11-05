// Resize handles on the picked-up shape (phone shell; editModel.ts has the geometry, resize.ts
// the resizing). Drawn small, with HANDLE_HIT (44 px) touch targets, in screen space so they
// keep their size at any zoom, above the lift and the canvas. They are shell elements outside
// tldraw's container, and they capture their pointer and stop it, so a handle drag never
// reaches tldraw or the shell's canvas gestures: the canvas cannot pan and the shape does not
// move while one is dragged. On a side too short for two targets they sit outside the shape.

import { useEffect, useRef } from "react";
import type { Editor, TLShapeId } from "tldraw";
import { type Handle, HANDLE_HIT, handlePoint, handlesFor, type Pt } from "./editModel";
import { type Resizing, setHandleTargets, startResize } from "./resize";

// `pointer`: -1 once iOS cancelled it (or before it came); `touch`: the finger's touch id.
type Drag = { pointer: number; touch?: number; handle: Handle; resizing: Resizing };

export function ResizeHandles({ editor, id, rect }: { editor: Editor; id: TLShapeId; rect: { left: number; top: number; width: number; height: number } }) {
  const drag = useRef<Drag | null>(null);
  useEffect(() => () => setHandleTargets([]), []);
  // A second finger anywhere (a pinch that started on a handle) ends the handle's drag: the
  // pinch is tldraw's, as it is for a move.
  useEffect(() => {
    const onTouch = (e: TouchEvent) => {
      if (e.touches.length > 1) drag.current = null;
    };
    window.addEventListener("touchstart", onTouch, { capture: true, passive: true });
    return () => window.removeEventListener("touchstart", onTouch, true);
  }, []);
  // The same handles for the whole drag (a text that re-wraps taller would otherwise gain corners).
  const shown = useRef<Handle[]>([]);
  const shape = editor.getShape(id);
  if (!shape) return null;
  const handles = drag.current ? shown.current : handlesFor(shape.type, { w: rect.width, h: rect.height });
  shown.current = handles;
  const begin = (h: Handle, pointer: number, at: Pt, touch?: number) => {
    const resizing = startResize(editor, id, h, at);
    if (resizing) drag.current = { pointer, touch, handle: h, resizing };
  };
  setHandleTargets(handles.map((h) => ({ handle: h, at: handlePoint(h, rect) })));
  return (
    <>
      {handles.map((h) => {
        const p = handlePoint(h, rect);
        const corner = h.includes("_");
        return (
          <div
            key={h}
            className="bm-handle"
            data-mobile-ui
            data-testid={`mobile-handle-${h}`}
            data-handle={h}
            data-corner={corner ? "1" : "0"}
            style={{ left: p.x - HANDLE_HIT / 2, top: p.y - HANDLE_HIT / 2, width: HANDLE_HIT, height: HANDLE_HIT }}
            // Pointer events drive the drag; touch events carry it on if iOS Safari cancels the
            // pointer (pointercancel) while the finger is still on the handle.
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
              begin(h, e.pointerId, { x: e.clientX, y: e.clientY });
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d || d.pointer !== e.pointerId) return;
              e.preventDefault();
              d.resizing.move({ x: e.clientX, y: e.clientY });
            }}
            onPointerUp={(e) => {
              if (drag.current?.pointer === e.pointerId) drag.current = null;
            }}
            onPointerCancel={(e) => {
              const d = drag.current;
              if (!d || d.pointer !== e.pointerId) return;
              if (d.touch !== undefined) d.pointer = -1;
              else drag.current = null;
            }}
            onTouchStart={(e) => {
              e.stopPropagation();
              const t = e.changedTouches[0];
              if (!t) return;
              if (drag.current && drag.current.handle === h) drag.current.touch = t.identifier;
              else if (!drag.current) begin(h, -1, { x: t.clientX, y: t.clientY }, t.identifier);
            }}
            onTouchMove={(e) => {
              const d = drag.current;
              const t = d && Array.from(e.changedTouches).find((x) => x.identifier === d.touch);
              if (d && t && d.pointer === -1) d.resizing.move({ x: t.clientX, y: t.clientY });
            }}
            onTouchEnd={(e) => {
              const d = drag.current;
              if (d && Array.from(e.changedTouches).some((x) => x.identifier === d.touch)) drag.current = null;
            }}
            onTouchCancel={() => {
              drag.current = null;
            }}
          >
            <span />
          </div>
        );
      })}
    </>
  );
}
