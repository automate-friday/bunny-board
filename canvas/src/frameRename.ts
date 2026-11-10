// Renaming a frame on the desktop canvas: double-click its title, type, Enter or click away.
//
// tldraw starts editing the frame on the second click's pointerdown and focuses the name
// input at once, but the browser's default action for that same click's mousedown then moves
// focus to the canvas container (the label it landed on is not focusable). The input stays
// open with no caret, and what is typed goes to the canvas instead. (tldraw 5.2.2 does this on
// a stock page too.) The mousedown of a click on the heading of the frame being renamed keeps
// the focus where it is; a click inside the input itself still places the caret as usual.
import type { Editor } from "tldraw";

type Target = { closest(selector: string): unknown } | null;

// Whether a mousedown on `target` should keep focus on the name input of the frame being edited.
export function keepsRenameFocus(editing: { id: string; type: string } | null | undefined, target: Target): boolean {
  if (!editing || editing.type !== "frame" || !target) return false;
  if (target.closest(".tl-frame-name-input")) return false;
  return !!target.closest(`[data-shape-id="${editing.id}"] .tl-frame-heading`);
}

export function installFrameRenameFocus(editor: Editor): () => void {
  const onMouseDown = (e: MouseEvent) => {
    const id = editor.getEditingShapeId();
    const shape = id ? editor.getShape(id) : undefined;
    if (keepsRenameFocus(shape, e.target instanceof Element ? e.target : null)) e.preventDefault();
  };
  window.addEventListener("mousedown", onMouseDown, true);
  return () => window.removeEventListener("mousedown", onMouseDown, true);
}
