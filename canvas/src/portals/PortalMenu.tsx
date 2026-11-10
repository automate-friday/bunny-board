// Context-menu items for people: draw an arrow from a sticky to whatever it should link to,
// right-click the arrow and choose "Make portal" (the arrow becomes the sticky's portal).
// A sticky with a portal offers "Jump through portal" and "Remove portal".
import { useState } from "react";
import { type Editor, type TLArrowBinding, type TLArrowShape, type TLShape, type TLShapeId, TldrawUiMenuItem, useEditor } from "tldraw";
import { type PortalTarget, portalOf } from "../../../shared/portal";
import { jumpThrough, livePortal } from "./Portals";

/** For an arrow that starts on a sticky: that sticky and the portal its end describes. */
export function arrowPortal(editor: Editor, shape: TLShape | undefined): { noteId: TLShapeId; arrowId: TLShapeId; portal: PortalTarget } | null {
  if (!shape || shape.type !== "arrow") return null;
  const arrow = shape as TLArrowShape;
  const bindings = editor.getBindingsFromShape<TLArrowBinding>(arrow, "arrow");
  const start = bindings.find((b) => b.props.terminal === "start");
  const end = bindings.find((b) => b.props.terminal === "end");
  const note = start ? editor.getShape(start.toId) : undefined;
  if (!note || note.type !== "note") return null;
  if (end && end.toId !== note.id) return { noteId: note.id, arrowId: arrow.id, portal: { id: end.toId } };
  // Unbound end: the area around where the arrow points.
  const t = editor.getShapePageTransform(arrow.id);
  const pt = t.applyToPoint(arrow.props.end);
  return { noteId: note.id, arrowId: arrow.id, portal: { x: Math.round(pt.x - 240), y: Math.round(pt.y - 160), w: 480, h: 320 } };
}

export function setPortal(editor: Editor, noteId: TLShapeId, portal: PortalTarget | null) {
  const note = editor.getShape(noteId);
  if (!note) return;
  const { portal: _old, ...rest } = (note.meta ?? {}) as Record<string, unknown>;
  editor.updateShape({ id: noteId, type: "note", meta: portal ? { ...rest, portal } : rest } as never);
}

export function PortalMenuItems() {
  const editor = useEditor();
  // Fixed when the menu opens (right click selects what is under the pointer).
  const [sel] = useState(() => editor.getOnlySelectedShape() ?? undefined);
  const [make] = useState(() => arrowPortal(editor, sel));
  // "Remove portal" also for a portal whose target was deleted; jumping needs the target.
  const has = sel && portalOf(sel) ? sel.id : null;
  const live = sel && livePortal(editor, sel) ? sel.id : null;
  return (
    <>
      {make ? (
        <TldrawUiMenuItem
          id="bunny-make-portal"
          label="Make portal"
          onSelect={() => {
            editor.run(() => {
              setPortal(editor, make.noteId, make.portal);
              editor.deleteShapes([make.arrowId]);
              editor.select(make.noteId);
            });
          }}
        />
      ) : null}
      {live ? <TldrawUiMenuItem id="bunny-jump-portal" label="Jump through portal" onSelect={() => {
            jumpThrough(editor, live);
          }} /> : null}
      {has ? <TldrawUiMenuItem id="bunny-remove-portal" label="Remove portal" onSelect={() => setPortal(editor, has, null)} /> : null}
    </>
  );
}
