import type { Editor, TLFrameShape, TLShape, TLShapeId } from "tldraw";

// An unbound inner frame must never inherit an outer frame's conversation UI.
export function conversationFrameOf(editor: Pick<Editor, "getShape">, shape: TLShape | undefined): TLFrameShape | null {
  let current = shape;
  while (current) {
    if (current.type === "frame") return current as TLFrameShape;
    current = editor.getShape(current.parentId as TLShapeId);
  }
  return null;
}
