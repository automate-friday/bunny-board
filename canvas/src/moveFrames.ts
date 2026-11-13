// Move whole frames (with what is in them, their agent and portals) to another tldraw page:
// the desktop context menu ("Move to page") and the phone's frame sheet. tldraw's
// moveShapesToPage keeps every shape id, so an agent's binding (frame meta) and portals that
// point at the frame or its shapes still resolve; the board server sees one update per shape.
// Unlike tldraw's own "Move to" it stays on the page you are reorganising and finds the frames
// an empty spot on the target page, so frames moved one by one never land on top of each other.
import { type Editor, PageRecordType, type TLPageId, type TLShapeId } from "tldraw";
import { boardLocks } from "./locks";
import { placeAmong } from "./moveFramesModel";

// The top-level frames of `ids` (a frame inside another moved frame goes with its parent).
function topFrames(editor: Editor, ids: readonly TLShapeId[]): TLShapeId[] {
  const set = new Set(ids);
  return ids.filter((id) => {
    const s = editor.getShape(id);
    if (!s || s.type !== "frame") return false;
    for (let p = editor.getShape(s.parentId as TLShapeId); p; p = editor.getShape(p.parentId as TLShapeId)) if (set.has(p.id)) return false;
    return true;
  });
}

export type MoveResult = { ok: true; moved: TLShapeId[]; pageId: TLPageId } | { ok: false; reason: string };

export function moveFramesToPage(editor: Editor, ids: readonly TLShapeId[], pageId: TLPageId): MoveResult {
  if (boardLocks(editor).get().layout) return { ok: false, reason: "Layout is locked: unlock it to move frames" };
  if (!editor.getPage(pageId)) return { ok: false, reason: "That page no longer exists" };
  const frames = topFrames(editor, ids);
  const fromPage = frames.length ? editor.getAncestorPageId(frames[0]) : undefined;
  if (!frames.length || !fromPage) return { ok: false, reason: "No frame to move" };
  if (fromPage === pageId) return { ok: false, reason: "Already on that page" };
  const viewing = editor.getCurrentPageId();
  const camera = editor.getCamera();
  editor.markHistoryStoppingPoint("move frames to page");
  editor.run(() => {
    // moveShapesToPage works on the current page's shapes.
    if (viewing !== fromPage) editor.setCurrentPage(fromPage);
    editor.moveShapesToPage(frames, pageId);
    // tldraw's move uses paste, which can auto-parent a root frame into a frame
    // already at its incoming position. Free-space placement below would then move
    // it outside that parent's clip path, hiding the frame and everything in it.
    // Restore only the moved roots to page level, preserving their page transforms
    // and intentional descendants. Leave roots alone if tldraw refused the move.
    editor.reparentShapes(frames.filter((id) => editor.getAncestorPageId(id) === pageId), pageId);
    const boxes = frames.map((id) => editor.getShapePageBounds(id)).filter((b): b is NonNullable<typeof b> => !!b);
    if (boxes.length) {
      const x = Math.min(...boxes.map((b) => b.x)), y = Math.min(...boxes.map((b) => b.y));
      const at = { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
      const moved = new Set<string>(frames);
      const others = editor
        .getCurrentPageShapes()
        .filter((s) => s.parentId === pageId && !moved.has(s.id))
        .map((s) => editor.getShapePageBounds(s.id))
        .filter((b): b is NonNullable<typeof b> => !!b);
      const { dx, dy } = placeAmong(at, others);
      if (dx || dy) editor.updateShapes(frames.map((id) => { const s = editor.getShape(id)!; return { id, type: s.type, x: s.x + dx, y: s.y + dy }; }));
    }
    editor.selectNone();
    // Stay where you were reorganising.
    editor.setCurrentPage(viewing);
    editor.setCamera(camera, { immediate: true });
  });
  return { ok: true, moved: frames, pageId };
}

export function newPage(editor: Editor, name?: string): TLPageId {
  const id = PageRecordType.createId();
  editor.createPage({ id, name: name || `Page ${editor.getPages().length + 1}` });
  return id;
}

// Jump to frames just moved: their page, fitted.
export function showMoved(editor: Editor, pageId: TLPageId, ids: readonly TLShapeId[]): void {
  editor.setCurrentPage(pageId);
  editor.select(...ids);
  editor.zoomToSelection({ animation: { duration: 220 } });
}
