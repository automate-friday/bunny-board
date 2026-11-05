// Stamp tool (FigJam-style): pick a stamp from the standard set, click any shape to attach
// it. The stamp is parented to that shape, so it moves and is deleted with it. A click
// places it at once and offers an optional note; holding the click opens the note first
// and places the stamp with it on Enter. Placing is one undo step.

import { atom, createShapeId, type Editor, StateNode, type TLShape, type TLShapeId, type VecLike } from "tldraw";
import { type StampKind, STAMP_TYPE, stampKindProps, stampKindSize, stampSpot, cleanNote } from "../../../../shared/components/stamp";

export const STAMP_TOOL = "stamp";
const HOLD_MS = 450;

export const stampKind = atom<StampKind>("stamp-kind", "needs-change");
// The note field: for a placed stamp, or for a held click (placed when the note is saved).
export type NoteTarget = { mode: "placed"; stampId: TLShapeId } | { mode: "pending"; targetId: TLShapeId; point: VecLike; kind: StampKind };
export const noteFor = atom<NoteTarget | null>("stamp-note", null);
// A short hint under the picker ("Click a shape to stamp it").
export const stampHint = atom<string | null>("stamp-hint", null);

export function stampBy(editor: Editor): string {
  return (window.__board?.userName || editor.user.getName() || "").trim() || "you";
}

// The topmost shape under a page point that can take a stamp (not a stamp or an arrow).
export function stampTargetAt(editor: Editor, point: VecLike): TLShape | null {
  const shapes = editor.getCurrentPageShapesSorted();
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (s.type === STAMP_TYPE || s.type === "arrow" || editor.isShapeHidden(s)) continue;
    if (editor.isPointInShape(s, point, { hitInside: true, margin: 0 })) return s;
  }
  return null;
}

// Attach a stamp to a shape at a page point (or its top-right corner). Returns its id.
export function placeStamp(editor: Editor, targetId: TLShapeId, kind: StampKind, opts: { point?: VecLike | null; note?: string; by?: string; now?: number } = {}): TLShapeId | null {
  const target = editor.getShape(targetId);
  if (!target) return null;
  const props = stampKindProps({ kind, by: opts.by ?? stampBy(editor), at: opts.now ?? Date.now(), target: targetId, note: opts.note });
  const bounds = editor.getShapeGeometry(target).bounds;
  const local = opts.point ? editor.getPointInShapeSpace(target, opts.point) : null;
  const n = editor.getSortedChildIdsForParent(targetId).filter((id) => editor.getShape(id)?.type === STAMP_TYPE).length;
  const spot = stampSpot({ w: bounds.w, h: bounds.h }, props, local, n);
  const id = createShapeId();
  editor.markHistoryStoppingPoint("stamp");
  editor.run(
    () => {
      // Parented to the target: x/y are in its space, and it moves and goes with it.
      editor.createShape({ id, type: STAMP_TYPE, parentId: targetId, x: spot.x, y: spot.y, props } as never);
    },
    { ignoreShapeLock: true },
  );
  return id;
}

export function setStampNote(editor: Editor, stampId: TLShapeId, note: string): void {
  const s = editor.getShape(stampId) as (TLShape & { props: { kind: StampKind | ""; note: string; w: number; h: number } }) | undefined;
  if (!s || !s.props.kind) return;
  const clean = cleanNote(note);
  if (clean === s.props.note) return;
  editor.updateShape({ id: stampId, type: STAMP_TYPE, props: { note: clean, ...stampKindSize(s.props.kind, clean) } } as never);
}

export class StampTool extends StateNode {
  static override id = STAMP_TOOL;
  private down: { targetId: TLShapeId; point: VecLike } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  override onEnter() {
    this.editor.setCursor({ type: "cross", rotation: 0 });
    this.editor.selectNone();
    stampHint.set("Click a shape to stamp it. Hold to add a note first.");
  }
  override onExit() {
    this.clear();
    noteFor.set(null);
    stampHint.set(null);
  }
  private clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.down = null;
  }
  override onPointerDown() {
    if (this.editor.getIsReadonly()) return;
    // A click with the note field open just closes it (its text is kept: see NotePopover).
    if (noteFor.get()) {
      noteFor.set(null);
      return;
    }
    const p = this.editor.inputs.getCurrentPagePoint();
    const target = stampTargetAt(this.editor, p);
    if (!target) {
      stampHint.set("Stamps go on a shape: click a sticky, card, frame or other shape.");
      return;
    }
    this.down = { targetId: target.id, point: { x: p.x, y: p.y } };
    this.timer = setTimeout(() => {
      const d = this.down;
      this.clear();
      if (d) noteFor.set({ mode: "pending", targetId: d.targetId, point: d.point, kind: stampKind.get() });
    }, HOLD_MS);
  }
  override onPointerMove() {
    const d = this.down;
    if (!d) return;
    const p = this.editor.inputs.getCurrentPagePoint();
    if (Math.hypot(p.x - d.point.x, p.y - d.point.y) * this.editor.getZoomLevel() > 6) this.clear();
  }
  override onPointerUp() {
    const d = this.down;
    this.clear();
    if (!d) return;
    const id = placeStamp(this.editor, d.targetId, stampKind.get(), { point: d.point });
    if (id) {
      noteFor.set({ mode: "placed", stampId: id });
      stampHint.set("Stamped. Add a note, or click another shape.");
    }
  }
  override onCancel() {
    this.clear();
    if (noteFor.get()) noteFor.set(null);
    else this.editor.setCurrentTool("select");
  }
}
