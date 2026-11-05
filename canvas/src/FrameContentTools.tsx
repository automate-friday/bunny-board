import { Box, createShapeId, fitFrameToContent, startEditingShapeWithRichText, toRichText, type TLFrameShape, useEditor, useValue } from "tldraw";
import { useContext } from "react";
import { ReviewTools } from "./ReviewRegion";
import { freeTextSlot } from "./frameContent";
import { layoutLockedHere } from "./locks";
import { BoardUiCtx } from "./ui";

export function FrameContentTools({ frame }: { frame: TLFrameShape }) {
  const editor = useEditor();
  const ui = useContext(BoardUiCtx);
  const locked = useValue("frame-content-locked", () => layoutLockedHere(editor) || editor.isShapeOrAncestorLocked(frame), [editor, frame]);
  const fit = () => {
    if (layoutLockedHere(editor) || editor.isShapeOrAncestorLocked(frame)) return;
    const children = editor.getSortedChildIdsForParent(frame.id);
    if (children.some((id) => editor.isShapeOrAncestorLocked(id))) { ui.toast("Unlock child shapes before fitting this frame"); return; }
    if (!children.length) { ui.toast("This frame has no content to fit"); return; }
    // Headings sit above nested frames; reserve their screen height at this zoom.
    let headingHeight = 24;
    for (const id of children) {
      const el = document.querySelector(`[data-shape-id="${CSS.escape(id)}"] .tl-frame-heading`);
      if (el) headingHeight = Math.max(headingHeight, el.getBoundingClientRect().height);
    }
    editor.markHistoryStoppingPoint("fit frame contents");
    fitFrameToContent(editor, frame.id, { padding: Math.max(24, (headingHeight + 12) / editor.getZoomLevel()) });
  };
  const addText = () => {
    const live = editor.getShape<TLFrameShape>(frame.id);
    if (!live || editor.isShapeOrAncestorLocked(live)) return;
    const occupied = editor.getSortedChildIdsForParent(live.id).flatMap((id) => {
      const child = editor.getShape(id);
      if (!child) return [];
      const b = Box.FromPoints(editor.getShapeLocalTransform(child).applyToPoints(editor.getShapeGeometry(child).vertices));
      return [{ x: b.x, y: b.y, w: b.w, h: b.h }];
    });
    for (const childId of editor.getSortedChildIdsForParent(live.id)) {
      const el = document.querySelector(`[data-shape-id="${CSS.escape(childId)}"] .tl-frame-heading`);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      const points = [{ x: rect.left, y: rect.top }, { x: rect.right, y: rect.top }, { x: rect.right, y: rect.bottom }, { x: rect.left, y: rect.bottom }];
      const bounds = Box.FromPoints(points.map((point) => editor.getPointInShapeSpace(live, editor.screenToPage(point))));
      occupied.push({ x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h });
    }
    const slot = freeTextSlot(live.props.w, live.props.h, occupied);
    if (!slot) { ui.toast("No free text space in this frame. Enlarge it or move content first."); return; }
    const id = createShapeId();
    editor.markHistoryStoppingPoint("add text inside frame");
    editor.createShape({ id, type: "text", parentId: live.id, x: slot.x, y: slot.y, props: { richText: toRichText(""), autoSize: false, w: slot.w } });
    editor.select(id);
    startEditingShapeWithRichText(editor, id);
  };
  return <details data-testid="frame-tools"><summary style={{cursor:"pointer"}}>Frame tools</summary><div style={{display:"flex",gap:6,flexWrap:"wrap",paddingTop:6}}>
    <ReviewTools frame={frame} />
    <button type="button" data-testid="frame-add-text" onClick={addText} disabled={editor.isShapeOrAncestorLocked(frame)} title="Create text in free space inside this frame; T then click also creates text">Add text inside</button>
    <button type="button" data-testid="frame-fit-content" onClick={fit} disabled={locked} title={locked ? "Unlock layout before fitting" : "Fit measured content, with room for nested frame headings"}>Fit contents</button>
  </div></details>;
}
