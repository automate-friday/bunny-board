// Copying text out of the sidebar (and anything else marked `data-native-copy`) copies
// the text. tldraw listens for `copy` and `cut` on the document and, while its editor is
// focused with shapes selected, cancels the event and copies the shapes instead. Opening a
// frame's conversation selects that frame, and dragging over sidebar text does not move
// focus off the canvas, so Cmd+C put the frame on the clipboard, not the selected text
// (and Cmd+X deleted the frame). When the page's text selection lies inside a marked
// region, the event stops at the window, before tldraw sees it, and the browser copies the
// selection as usual.
export const NATIVE_COPY_ATTR = "data-native-copy";

type SelectionLike = Pick<Selection, "isCollapsed" | "rangeCount" | "anchorNode" | "focusNode">;

const inRegion = (node: Node | null): boolean => {
  const el = node && (node.nodeType === 1 ? (node as Element) : node.parentElement);
  return !!el?.closest?.(`[${NATIVE_COPY_ATTR}]`);
};

/** The selection is non-empty text that starts and ends inside a `data-native-copy` region. */
export function selectionWantsNativeCopy(sel: SelectionLike | null | undefined): boolean {
  if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
  return inRegion(sel.anchorNode) && inRegion(sel.focusNode);
}

export function installNativeCopy(win: Window = window): () => void {
  const onClip = (e: Event) => {
    if (selectionWantsNativeCopy(win.getSelection())) e.stopImmediatePropagation();
  };
  // Capture on the window runs before tldraw's document listeners.
  win.addEventListener("copy", onClip, true);
  win.addEventListener("cut", onClip, true);
  return () => {
    win.removeEventListener("copy", onClip, true);
    win.removeEventListener("cut", onClip, true);
  };
}
