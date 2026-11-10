// Keys typed right after entering text editing are not lost. A double-click (or Enter)
// starts editing a sticky, but tldraw mounts and focuses its rich-text editor a moment
// later; keys pressed in between land on the page and are dropped, so a fast typist, or
// anyone on a loaded machine, loses the first characters ("Typed" became "ped" at 20 ms
// per key with the CPU throttled; on the live board at load 27, "ortal" was left of
// "Edited through portal"). While this editor is focused and editing a shape but its text
// box is not focused yet, characters, Backspace, select-all and Escape are held here and
// replayed in order as soon as the text box is ready, before any later key.
//
// Only a shape with rich text gets a text box to wait for. A frame's name is a plain <input>
// in its heading, and other editable shapes (links, widgets, stamps) have none; holding keys
// for them waited forever and swallowed every key, so frames could not be renamed.
//
// Keys aimed at any other text field (the sidebar reply box, the start form, the phone's rename
// sheet, a header title) are never held either. Clicking the reply box (or the start form, a
// transcript card's box…) while a sticky is still being edited leaves tldraw in
// its editing state, because those fields stop the pointerdown before tldraw sees it. The
// sticky's text box is then not focused, so without this check every key typed into the
// reply box was swallowed here, and dictation tools such as Wispr Flow (simulated paste and
// keystrokes) landed nothing, or only part of their text, in the field.
import type { Editor, TLShape } from "tldraw";

type Held = { text: string } | { selectAll: true } | { backspace: true } | { escape: true };

// Whether keys are held for the shape being edited: only while a rich-text box is still to come.
export function waitsForTextBox(shape: Pick<TLShape, "props"> | null | undefined): boolean {
  return !!shape && typeof shape.props === "object" && shape.props !== null && "richText" in shape.props;
}

// A text field that already has focus takes its own keys (not the canvas container, which tldraw
// focuses, and not the rich-text box, which is ready and handled above).
export function isOwnTextField(el: { tagName?: string; isContentEditable?: boolean; type?: string } | null | undefined): boolean {
  if (!el) return false;
  const tag = (el.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") return !["button", "checkbox", "radio", "range", "submit", "reset", "file", "color"].includes((el.type ?? "text").toLowerCase());
  return el.isContentEditable === true;
}

export function installEditKeyBuffer(editor: Editor): () => void {
  let held: Held[] = [];
  let polling = 0;
  const box = () => {
    const rte = editor.getRichTextEditor();
    const dom = (rte as { view?: { dom?: Element } } | null)?.view?.dom;
    return rte && dom && dom.contains(document.activeElement) ? rte : null;
  };
  const drain = (): boolean => {
    if (!held.length) return true;
    if (!editor.getEditingShapeId()) {
      held = [];
      return true;
    }
    const rte = box();
    if (!rte) return false;
    const queue = held;
    held = [];
    let escape = false;
    for (const h of queue) {
      if ("text" in h) rte.commands.insertContent(h.text);
      else if ("selectAll" in h) rte.commands.selectAll();
      else if ("backspace" in h) rte.commands.deleteSelection() || rte.commands.joinBackward() || rte.commands.deleteRange({ from: Math.max(0, rte.state.selection.from - 1), to: rte.state.selection.from });
      else escape = true;
    }
    if (escape) editor.complete();
    return true;
  };
  const poll = () => {
    polling = 0;
    if (!drain()) polling = requestAnimationFrame(poll);
  };
  const onKey = (e: KeyboardEvent) => {
    const editing = editor.getEditingShapeId();
    if (!editor.getInstanceState().isFocused || !editing) return;
    // Ready: replay anything held first, so this key lands after it.
    if (box()) {
      drain();
      return;
    }
    if (!waitsForTextBox(editor.getShape(editing))) return;
    // Focus is in another field (the reply box, the start form, a rename box): the key is that field's.
    if (isOwnTextField(e.target as HTMLElement | null) || isOwnTextField(document.activeElement as HTMLElement | null)) return;
    let h: Held | null = null;
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "a") h = { selectAll: true };
    else if (e.metaKey || e.ctrlKey || e.altKey) return;
    else if (e.key.length === 1) h = { text: e.key };
    else if (e.key === "Backspace") h = { backspace: true };
    else if (e.key === "Escape" && held.length) h = { escape: true };
    if (!h) return;
    e.preventDefault();
    e.stopPropagation();
    const last = held[held.length - 1];
    if ("text" in h && last && "text" in last) last.text += h.text;
    else held.push(h);
    if (!polling) polling = requestAnimationFrame(poll);
  };
  window.addEventListener("keydown", onKey, true);
  return () => {
    window.removeEventListener("keydown", onKey, true);
    cancelAnimationFrame(polling);
  };
}
