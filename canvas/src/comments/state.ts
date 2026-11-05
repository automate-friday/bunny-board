// Comment UI state and the one write path for comment threads (page meta, outside undo).

import { atom, type Editor, StateNode, type TLPage, type TLShape, uniqueId, type VecLike } from "tldraw";
import { type CommentAnchor, moveThread, personId, readMarksFor, readThreads, setReadMark, type Threads, type Who } from "../../../shared/comments";

export const COMMENT_TOOL = "comment";

export interface Draft {
  anchor: CommentAnchor;
}

// One open thread (or a new-comment draft) at a time, as in Figma.
export const openThread = atom<string | null>("comment-open", null);
export const draft = atom<Draft | null>("comment-draft", null);
// "Show comments" (Shift+C): pins on the canvas outside comment mode. Off by default, as in Figma.
export const showPins = atom<boolean>("comment-show-pins", localStorage.getItem("paseo-comments-show") === "1");
export const showResolved = atom<boolean>("comment-show-resolved", false);
// The thread whose pin is hovered: its shape or area is outlined.
export const hoverThread = atom<string | null>("comment-hover", null);
// An area being dragged out in comment mode (page space).
export const areaDrag = atom<{ x: number; y: number; w: number; h: number } | null>("comment-area-drag", null);

export function setShowPins(on: boolean) {
  showPins.set(on);
  localStorage.setItem("paseo-comments-show", on ? "1" : "0");
}

// The author is the board name (?as=, or the saved name), not the browser: the same person
// on a phone and a laptop can edit their comments and shares one read state.
export function who(): Who {
  const userName = window.__board?.userName || "Anonymous";
  return { userId: personId(userName), userName };
}

export const newId = () => uniqueId();
export const nowIso = () => new Date().toISOString();

export function pageThreads(editor: Editor, page?: TLPage): Threads {
  return readThreads((page ?? editor.getCurrentPage()).meta);
}

// Apply fn to the current page's meta. Not undoable (Figma comments are not in undo
// history) and allowed on locked shapes and locked layouts: comments do not change layout.
export function writeComments(editor: Editor, fn: (meta: unknown) => Record<string, unknown>): boolean {
  const page = editor.getCurrentPage();
  if (editor.getIsReadonly()) {
    window.dispatchEvent(new CustomEvent("paseo-comment-error", { detail: "This board is read-only." }));
    return false;
  }
  try {
    const meta = fn(page.meta);
    editor.run(() => editor.updatePage({ id: page.id, meta: meta as TLPage["meta"] }), { history: "ignore", ignoreShapeLock: true });
    return true;
  } catch (e) {
    window.dispatchEvent(new CustomEvent("paseo-comment-error", { detail: (e as Error).message }));
    return false;
  }
}

// Read marks are in the page meta (synced, per person), so they follow you across devices.
export function readMarks(editor: Editor): Record<string, string> {
  return readMarksFor(editor.getCurrentPage().meta, who().userId);
}
export function markRead(editor: Editor, threadId: string, at: string | null) {
  if ((readMarks(editor)[threadId] ?? null) === at || editor.getIsReadonly()) return;
  writeComments(editor, (meta) => setReadMark(meta, who().userId, threadId, at));
}

// The topmost shape under a page point; the pin follows it. Frames count when the point
// is inside them, so a pin dropped on a frame's background follows the frame.
export function shapeUnder(editor: Editor, point: VecLike): TLShape | null {
  const shapes = editor.getCurrentPageShapesSorted();
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (editor.isShapeHidden(s)) continue;
    if (editor.isPointInShape(s, point, { hitInside: true, margin: 0 })) return s;
  }
  return null;
}

export function anchorAt(editor: Editor, point: VecLike): CommentAnchor {
  const shape = shapeUnder(editor, point);
  if (!shape) return { shapeId: null, x: point.x, y: point.y, pageX: point.x, pageY: point.y };
  const local = editor.getPointInShapeSpace(shape, point);
  return { shapeId: shape.id, x: local.x, y: local.y, pageX: point.x, pageY: point.y };
}

// An area attaches to the topmost shape that holds all of it (usually its frame).
export function anchorForArea(editor: Editor, box: { x: number; y: number; w: number; h: number }): CommentAnchor {
  const shapes = editor.getCurrentPageShapesSorted();
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (editor.isShapeHidden(s)) continue;
    const b = editor.getShapePageBounds(s);
    if (!b || box.x < b.minX || box.y < b.minY || box.x + box.w > b.maxX || box.y + box.h > b.maxY) continue;
    const tl = editor.getPointInShapeSpace(s, { x: box.x, y: box.y });
    const br = editor.getPointInShapeSpace(s, { x: box.x + box.w, y: box.y + box.h });
    return { shapeId: s.id, x: tl.x, y: tl.y, w: Math.abs(br.x - tl.x), h: Math.abs(br.y - tl.y), pageX: box.x, pageY: box.y };
  }
  return { shapeId: null, x: box.x, y: box.y, w: box.w, h: box.h, pageX: box.x, pageY: box.y };
}

// The four page-space corners of an area (rotated with its shape).
export function areaCorners(editor: Editor, a: CommentAnchor): { x: number; y: number }[] | null {
  if (!a.w || !a.h) return null;
  const local = [{ x: a.x, y: a.y }, { x: a.x + a.w, y: a.y }, { x: a.x + a.w, y: a.y + a.h }, { x: a.x, y: a.y + a.h }];
  const shape = a.shapeId ? editor.getShape(a.shapeId as TLShape["id"]) : undefined;
  if (shape && editor.getAncestorPageId(shape) === editor.getCurrentPageId()) {
    const m = editor.getShapePageTransform(shape);
    return local.map((p) => m.applyToPoint(p));
  }
  return [{ x: a.pageX, y: a.pageY }, { x: a.pageX + a.w, y: a.pageY }, { x: a.pageX + a.w, y: a.pageY + a.h }, { x: a.pageX, y: a.pageY + a.h }];
}

// Where the pin sits: the comment's point, or an area's top-right corner.
export function pinPagePoint(editor: Editor, a: CommentAnchor): { x: number; y: number } {
  const corners = areaCorners(editor, a);
  if (corners) return corners[1];
  return anchorPagePoint(editor, a);
}

export function anchorPagePoint(editor: Editor, a: CommentAnchor): { x: number; y: number } {
  if (a.shapeId) {
    const shape = editor.getShape(a.shapeId as TLShape["id"]);
    // A shape moved to another page leaves its pins at their last point on this one.
    if (shape && editor.getAncestorPageId(shape) === editor.getCurrentPageId()) {
      const p = editor.getShapePageTransform(shape).applyToPoint({ x: a.x, y: a.y });
      return { x: p.x, y: p.y };
    }
  }
  return { x: a.pageX, y: a.pageY };
}

export function closeAll() {
  openThread.set(null);
  draft.set(null);
}

// Comment mode (C). Clicking empty canvas or a shape drops a new comment there; panning
// (wheel, space-drag, trackpad) keeps working. Esc closes the open thread, then leaves.
export class CommentTool extends StateNode {
  static override id = COMMENT_TOOL;
  override onEnter() {
    this.editor.setCursor({ type: "cross", rotation: 0 });
    this.editor.selectNone();
  }
  override onExit() {
    draft.set(null);
    areaDrag.set(null);
    this.start = null;
  }
  private start: { x: number; y: number } | null = null;
  override onPointerDown() {
    if (this.editor.getIsReadonly()) return;
    // A click with a thread or draft open just closes it (Figma).
    if (openThread.get() || draft.get()) {
      closeAll();
      return;
    }
    const p = this.editor.inputs.getCurrentPagePoint();
    this.start = { x: p.x, y: p.y };
  }
  override onPointerMove() {
    if (!this.start || !this.editor.inputs.getIsPointing()) return;
    const p = this.editor.inputs.getCurrentPagePoint();
    const s = this.start;
    // Drag past a few screen pixels: comment on an area instead of a point.
    if (!areaDrag.get() && Math.hypot(p.x - s.x, p.y - s.y) * this.editor.getZoomLevel() < 6) return;
    areaDrag.set({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
  }
  override onPointerUp() {
    const s = this.start;
    this.start = null;
    if (!s) return;
    const area = areaDrag.get();
    areaDrag.set(null);
    if (area && area.w > 2 && area.h > 2) draft.set({ anchor: anchorForArea(this.editor, area) });
    else draft.set({ anchor: anchorAt(this.editor, s) });
  }
  override onCancel() {
    this.start = null;
    areaDrag.set(null);
    if (openThread.get() || draft.get()) closeAll();
    else this.editor.setCurrentTool("select");
  }
}

// Deleting a shape leaves its pins where the shape last was (not where they were dropped).
// Runs in the deleting tab, before the shape is gone, so the transform is still known.
export function installCommentAnchorKeeper(editor: Editor): () => void {
  return editor.sideEffects.registerBeforeDeleteHandler("shape", (shape) => {
    for (const page of editor.getPages()) {
      const threads = Object.values(readThreads(page.meta)).filter((t) => t.anchor.shapeId === shape.id);
      if (!threads.length) continue;
      const p = editor.getShapePageTransform(shape);
      let meta: unknown = page.meta;
      for (const t of threads) {
        const at = p.applyToPoint({ x: t.anchor.x, y: t.anchor.y });
        meta = moveThread(meta, t.id, { shapeId: null, x: at.x, y: at.y, pageX: at.x, pageY: at.y });
      }
      editor.updatePage({ id: page.id, meta: meta as TLPage["meta"] });
    }
  });
}
