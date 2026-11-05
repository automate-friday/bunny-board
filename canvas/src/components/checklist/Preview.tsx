import { useMemo, useRef, useState } from "react";
import { Tldraw, createShapeId, defaultShapeUtils, type Editor } from "tldraw";
import { componentShapeUtils, handleComponentDrop } from "../registry";
import { ChecklistDragSource } from "./dragSource";
// Development-only local store for isolated component checks.
export function ChecklistPreview() {
  const [editor, setEditor] = useState<Editor | null>(null);
  const ref = useRef<Editor | null>(null);
  const options = useMemo(() => ({ experimental__onDropOnCanvas: ({ point, event }: { point: { x: number; y: number }; event: React.DragEvent }) => ref.current ? handleComponentDrop(ref.current, point, event) : false }), []);
  return <div style={{ position: "fixed", inset: 0, display: "flex" }}>
    <aside style={{ width: 270, padding: 16, boxSizing: "border-box", font: "14px system-ui" }}><h2>Checklist preview</h2><p>Local test. Changes stay on this device.</p>{editor ? <ChecklistDragSource editor={editor} frameId="shape:preview-frame" enabled /> : null}</aside>
    <div style={{ flex: 1, position: "relative" }}>
      <Tldraw options={options} persistenceKey="c-checklist-preview" shapeUtils={[...defaultShapeUtils, ...componentShapeUtils]} onMount={e => { ref.current = e; (window as unknown as { __editor: Editor }).__editor = e; if (!e.getShape(createShapeId("preview-frame"))) e.createShape({ id: createShapeId("preview-frame"), type: "frame", x: 0, y: 0, props: { name: "Checklist proof", w: 700, h: 500 } }); e.zoomToFit(); setEditor(e); }} />
    </div>
  </div>;
}
