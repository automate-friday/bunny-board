import { DefaultStylePanel, type TLUiStylePanelProps, useEditor, useValue } from "tldraw";

// The style panel appears only when there is something to style: a selection, or a
// drawing tool that will use the next style. With nothing selected it hid the
// top-right of the board for no reason.
const IDLE_TOOLS = new Set(["select", "hand", "zoom", "laser"]);

export function BoardStylePanel(props: TLUiStylePanelProps) {
  const editor = useEditor();
  const show = useValue(
    "bunny style panel visible",
    () => editor.getSelectedShapeIds().length > 0 || !IDLE_TOOLS.has(editor.getCurrentToolId()),
    [editor],
  );
  return show ? <DefaultStylePanel {...props} /> : null;
}
