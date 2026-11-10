import { type Editor, type TLShapeId } from "tldraw";
import { CHECKLIST_TYPE, checklistDefaults } from "./shape";
import { DRAG_MIME, placeBeside } from "../place";
export function ChecklistDragSource({ editor, frameId, enabled = false }: { editor: Editor; frameId: string; enabled?: boolean }) {
  return <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", fontSize: 12 }}>
    <span data-testid="drag-checklist" draggable={enabled} aria-disabled={!enabled} onDragStart={e => { if (!enabled) { e.preventDefault(); return; } e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ type: CHECKLIST_TYPE, props: checklistDefaults() })); e.dataTransfer.effectAllowed = "copy"; }} style={{ border: "1px dashed light-dark(#b8a45c, hsl(47 35% 39%))", borderRadius: 6, padding: "4px 8px", cursor: enabled ? "grab" : "default", color: enabled ? "light-dark(#665821, hsl(48 51% 74%))" : "light-dark(#888, var(--bunny-muted))" }}>⠿ Drag checklist to board</span>
    <button type="button" disabled={!enabled} onClick={() => placeBeside(editor, frameId as TLShapeId, CHECKLIST_TYPE, { ...checklistDefaults() })}>Add checklist</button>
    {!enabled ? <small>Checklist sharing needs a server update.</small> : null}
  </div>;
}
