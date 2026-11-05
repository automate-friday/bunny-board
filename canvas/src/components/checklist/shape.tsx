import { checklistShapeProps, checklistMigrations } from "../../../../shared/components/checklist";
import { BaseBoxShapeUtil, HTMLContainer, uniqueId, type TLBaseShape, type RecordProps, useEditor, useValue } from "tldraw";

import { CHECKLIST_TYPE, checklistDefaults, type ChecklistProps } from "./model";
export { CHECKLIST_TYPE, checklistDefaults, checklistProps } from "./model";
declare module "tldraw" { interface TLGlobalShapePropsMap { checklist: ChecklistProps } }
export type ChecklistShape = TLBaseShape<typeof CHECKLIST_TYPE, ChecklistProps>;
function ChecklistRender({ shape }: { shape: ChecklistShape }) {
  const editor = useEditor();
  const readOnly = useValue("checklist-readonly", () => editor.getIsReadonly() || editor.isShapeOrAncestorLocked(shape), [editor, shape]);
  const update = (patch: Partial<ChecklistProps>) => { if (!readOnly) editor.updateShape<ChecklistShape>({ id: shape.id, type: CHECKLIST_TYPE, props: patch }); };
  return <section data-testid="checklist-card" style={{ width: "100%", height: "100%", overflowY: "auto", background: "#fffef6", border: "1px solid #c5ba7c", borderRadius: 10, padding: 12, boxSizing: "border-box", pointerEvents: "all", font: "13px system-ui" }} onPointerDown={e => { if ((e.target as HTMLElement).closest("input,button")) e.stopPropagation(); }} onKeyDown={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}>
    <input aria-label="Checklist title" value={shape.props.title} disabled={readOnly} maxLength={200} onChange={e => update({ title: e.target.value })} style={{ width: "100%", boxSizing: "border-box", background: "transparent", border: "none", fontWeight: 650, fontSize: 16 }} />
    <div style={{ color: "#786d38", margin: "6px 0" }}>{shape.props.items.filter(i => i.checked).length} of {shape.props.items.length} done</div>
    {shape.props.items.map(item => <div key={item.id} style={{ display: "flex", gap: 6, margin: "6px 0" }}>
      <input type="checkbox" aria-label={`Complete ${item.text}`} checked={item.checked} disabled={readOnly} onChange={e => { const current = editor.getShape<ChecklistShape>(shape.id); if (current) update({ items: current.props.items.map(i => i.id === item.id ? { ...i, checked: e.target.checked } : i) }); }} />
      <input aria-label={`Task ${item.id}`} value={item.text} disabled={readOnly} maxLength={1000} onChange={e => { const current = editor.getShape<ChecklistShape>(shape.id); if (current) update({ items: current.props.items.map(i => i.id === item.id ? { ...i, text: e.target.value } : i) }); }} style={{ flex: 1, minWidth: 0, background: "transparent", border: "none", textDecoration: item.checked ? "line-through" : "none" }} />
      <button type="button" aria-label={`Remove ${item.text}`} disabled={readOnly} onClick={() => { const current = editor.getShape<ChecklistShape>(shape.id); if (current) update({ items: current.props.items.filter(i => i.id !== item.id) }); }}>×</button>
    </div>)}
    <button type="button" disabled={readOnly || shape.props.items.length >= 100} onClick={() => { const current = editor.getShape<ChecklistShape>(shape.id); if (current && current.props.items.length < 100) update({ items: [...current.props.items, { id: uniqueId(), text: "New task", checked: false }] }); }}>Add item</button>
  </section>;
}
export class ChecklistShapeUtil extends BaseBoxShapeUtil<ChecklistShape> {
  static override type = CHECKLIST_TYPE;
  static override props: RecordProps<ChecklistShape> = checklistShapeProps;
  static override migrations = checklistMigrations;
  override getDefaultProps() { return checklistDefaults(); }
  override canEdit() { return false; }
  override component(shape: ChecklistShape) { return <HTMLContainer id={shape.id} style={{ width: shape.props.w, height: shape.props.h }}><ChecklistRender shape={shape} /></HTMLContainer>; }
  override getIndicatorPath(shape: ChecklistShape) { const p = new Path2D(); p.roundRect(0, 0, shape.props.w, shape.props.h, 10); return p; }
}
