// Placing component shapes on the board: at a drop point (parented to the frame under
// it) or beside a frame (the touch-friendly "Pin to board" button).

import { type Box, createShapeId, type Editor, type TLShape, type TLShapeId, type VecLike } from "tldraw";

export const DRAG_MIME = "application/x-bunny-component";

export interface DragPayload {
  type: string;
  props: Record<string, unknown>;
  // Page units from the card's top-left to the cursor (the widget tray's drag ghost).
  offset?: { x: number; y: number };
}

// Topmost frame whose page bounds contain the point.
export function frameAt(editor: Editor, point: VecLike): TLShape | null {
  const frames = editor.getCurrentPageShapesSorted().filter((s) => s.type === "frame");
  for (let i = frames.length - 1; i >= 0; i--) {
    const b = editor.getShapePageBounds(frames[i]);
    if (b?.containsPoint(point)) return frames[i];
  }
  return null;
}

// Create a component with its top-left at the page point. Dropped inside a frame, it
// becomes that frame's child, nudged so it fits when the frame is big enough.
export function placeAt(editor: Editor, type: string, props: { w: number; h: number } & Record<string, unknown>, point: VecLike): TLShapeId {
  const id = createShapeId();
  const frame = frameAt(editor, point);
  let x = point.x;
  let y = point.y;
  if (frame) {
    const fb = editor.getShapePageBounds(frame) as Box;
    if (fb.w > props.w) x = Math.min(x, fb.maxX - props.w - 10);
    if (fb.h > props.h) y = Math.min(y, fb.maxY - props.h - 10);
  }
  editor.run(() => {
    editor.createShape({ id, type, x, y, props } as never);
    if (frame) editor.reparentShapes([id], frame.id);
    editor.select(id);
  });
  return id;
}

// Beside a frame (to its right), on the page, moving down past anything in the way.
export function placeBeside(editor: Editor, frameId: TLShapeId, type: string, props: { w: number; h: number } & Record<string, unknown>): TLShapeId {
  const fb = editor.getShapePageBounds(frameId);
  const start = fb ? { x: fb.maxX + 40, y: fb.minY } : editor.getViewportPageBounds().center;
  const others = editor
    .getCurrentPageShapes()
    .filter((s) => s.parentId === editor.getCurrentPageId())
    .map((s) => editor.getShapePageBounds(s))
    .filter((b): b is Box => !!b);
  let { x, y } = start;
  for (let i = 0; i < 60; i++) {
    const hit = others.find((b) => x < b.maxX && x + props.w > b.minX && y < b.maxY && y + props.h > b.minY);
    if (!hit) break;
    y = hit.maxY + 20;
  }
  const id = createShapeId();
  editor.run(() => {
    editor.createShape({ id, type, x, y, props } as never);
    editor.select(id);
  });
  return id;
}

export function readDrag(event: DragEvent | React.DragEvent): DragPayload | null {
  const raw = event.dataTransfer?.getData(DRAG_MIME) || event.dataTransfer?.getData("application/x-paseo-board-component");
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as DragPayload;
    return typeof p?.type === "string" && p.props && typeof p.props === "object" ? p : null;
  } catch {
    return null;
  }
}
