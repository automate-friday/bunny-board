import type { Editor, TLShape, TLShapeId } from "tldraw";

// Which frame(s) "Archive frame" acts on (FrameArchive.tsx, the board context menu).
// Pure on the editor's read API, so test/archive-target.test.ts can drive it.

type ReadEditor = Pick<Editor, "getSelectedShapes" | "getZoomLevel" | "getCurrentPageShapesSorted" | "isPointInShape" | "getShapePageBounds" | "getShape">;

// The selected frames, when the selection is only frames.
export function framesToArchive(editor: ReadEditor): TLShapeId[] {
  const sel = editor.getSelectedShapes();
  const frames = sel.filter((s) => s.type === "frame").map((s) => s.id);
  return frames.length === sel.length ? frames : [];
}

// The frame a right-click at `point` means: the innermost frame under it (its body, a
// shape inside it, or its name label just above the top-left corner). That is the frame
// tldraw selects there and the frame panel shows, nested or not, bound or not; the menu
// item names it. Its parent is one right-click away, on the parent's own body or label.
export function frameAtPoint(editor: ReadEditor, point: { x: number; y: number }): TLShapeId | null {
  const zoom = editor.getZoomLevel();
  const hits = editor.getCurrentPageShapesSorted().filter((s) => {
    if (s.type !== "frame") return false;
    if (editor.isPointInShape(s, point, { hitInside: true })) return true;
    const b = editor.getShapePageBounds(s.id);
    return !!b && point.x >= b.x && point.x <= b.x + Math.min(b.w, 320 / zoom) && point.y >= b.y - 32 / zoom && point.y < b.y;
  });
  const depth = (s: TLShape) => {
    let d = 0;
    for (let p = editor.getShape(s.parentId as TLShapeId); p && d < 50; p = editor.getShape(p.parentId as TLShapeId)) d++;
    return d;
  };
  let best: TLShape | null = null;
  for (const h of hits) if (!best || depth(h) > depth(best)) best = h;
  return best?.id ?? null;
}

// What a context menu opened at `point` archives: two or more selected frames, else the
// frame under the pointer, else a lone selected frame.
export function archiveTargets(editor: ReadEditor, point: { x: number; y: number }): TLShapeId[] {
  const selected = framesToArchive(editor);
  if (selected.length > 1) return selected;
  const under = frameAtPoint(editor, point);
  return under ? [under] : selected;
}

