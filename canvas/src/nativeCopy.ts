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

/** A link copies as its label only; write "label (url)" into the plain text so a pasted
 * selection keeps the address. Rich (HTML) paste keeps the anchors. True when it set data. */
export function copyWithLinkUrls(sel: Selection, data: DataTransfer, doc: Document): boolean {
  const holder = doc.createElement("div");
  for (let r = 0; r < sel.rangeCount; r++) holder.append(sel.getRangeAt(r).cloneContents());
  let text = sel.toString(), from = 0, changed = false;
  for (const a of holder.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const label = a.textContent ?? "", href = a.getAttribute("href") ?? "";
    if (!label.trim() || label === href || label === href.replace(/^mailto:/, "")) continue;
    const at = text.indexOf(label, from);
    if (at < 0) continue;
    const swap = `${label} (${href})`;
    text = text.slice(0, at) + swap + text.slice(at + label.length); from = at + swap.length; changed = true;
  }
  if (!changed) return false;
  data.setData("text/plain", text);
  data.setData("text/html", holder.innerHTML);
  return true;
}

export function installNativeCopy(win: Window = window): () => void {
  const onClip = (e: Event) => {
    const sel = win.getSelection();
    if (!selectionWantsNativeCopy(sel)) return;
    e.stopImmediatePropagation();
    const data = (e as ClipboardEvent).clipboardData;
    if (e.type === "copy" && sel && data && copyWithLinkUrls(sel, data, win.document)) e.preventDefault();
  };
  // Capture on the window runs before tldraw's document listeners.
  win.addEventListener("copy", onClip, true);
  win.addEventListener("cut", onClip, true);
  return () => {
    win.removeEventListener("copy", onClip, true);
    win.removeEventListener("cut", onClip, true);
  };
}
