// The current page's frames, shared by every hook that only cares about frames (review
// badges, empty-board hint, queued/paused badges, comment @-mentions). It still rescans
// the page on every document change, but returns the previous array while the frame
// records are the same, so an agent rewriting a note does not invalidate frame consumers.
import { perfCount } from "./perf";
import { type Computed, computed, type Editor, isUninitialized, type TLFrameShape } from "tldraw";

const pageFramesByEditor = new WeakMap<Editor, Computed<TLFrameShape[]>>();

export function pageFrames(editor: Editor): Computed<TLFrameShape[]> {
  let c = pageFramesByEditor.get(editor);
  if (!c) {
    c = computed<TLFrameShape[]>("page-frames", (prev) => {
      perfCount("page-frames");
      const next = editor.getCurrentPageShapes().filter((s): s is TLFrameShape => s.type === "frame");
      if (!isUninitialized(prev) && prev.length === next.length && prev.every((f, i) => f === next[i])) return prev;
      return next;
    });
    pageFramesByEditor.set(editor, c);
  }
  return c;
}
