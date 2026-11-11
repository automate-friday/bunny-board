// The board's frames, shared by every hook that only cares about frames (review badges,
// empty-board hint, queued/paused badges, comment @-mentions, the bound-frame index,
// Needs you). Frame ids come from tldraw's incremental store query (it applies each
// change's diff, no page scan), so a document change costs O(frames), not O(shapes), and
// both computeds return the previous array while the frame records are the same: an agent
// rewriting a note does not invalidate frame consumers.
import { perfCount } from "./perf";
import { type Computed, computed, type Editor, isUninitialized, type TLFrameShape, type TLShapeId } from "tldraw";

const allFramesByEditor = new WeakMap<Editor, Computed<TLFrameShape[]>>();
const pageFramesByEditor = new WeakMap<Editor, Computed<TLFrameShape[]>>();

const sameList = (prev: TLFrameShape[], next: TLFrameShape[]) => prev.length === next.length && prev.every((f, i) => f === next[i]);

/** Every frame record in the store, on any page. */
export function allFrames(editor: Editor): Computed<TLFrameShape[]> {
  let c = allFramesByEditor.get(editor);
  if (!c) {
    const ids = editor.store.query.ids("shape", () => ({ type: { eq: "frame" } }));
    c = computed<TLFrameShape[]>("all-frames", (prev) => {
      perfCount("all-frames");
      const next: TLFrameShape[] = [];
      for (const id of ids.get()) {
        const s = editor.getShape<TLFrameShape>(id as TLShapeId);
        if (s) next.push(s);
      }
      return !isUninitialized(prev) && sameList(prev, next) ? prev : next;
    });
    allFramesByEditor.set(editor, c);
  }
  return c;
}

/** The current page's frames (nested ones included). */
export function pageFrames(editor: Editor): Computed<TLFrameShape[]> {
  let c = pageFramesByEditor.get(editor);
  if (!c) {
    const all = allFrames(editor);
    c = computed<TLFrameShape[]>("page-frames", (prev) => {
      perfCount("page-frames");
      const pageId = editor.getCurrentPageId();
      const next = all.get().filter((f) => editor.getAncestorPageId(f) === pageId);
      return !isUninitialized(prev) && sameList(prev, next) ? prev : next;
    });
    pageFramesByEditor.set(editor, c);
  }
  return c;
}
