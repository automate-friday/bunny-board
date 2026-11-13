// What the page around a frame says, for the next-step suggestions (quickStartPrompts.ts):
// the page's name, the frame's name, its stickies' text, how many images and links it holds,
// and the nearest other frames with their agent's status and a few of their notes (the
// server adds what those agents reported). Read when a start form opens; it goes to the
// suggestion model unless suggestions are switched off.
import type { Editor, TLFrameShape, TLShape, TLShapeId } from "tldraw";
import { richTextPlain } from "./mobile/fuzzySearch";
import type { PageContext } from "./quickStartPrompts";

const GENERIC = /^(frame|new agent|untitled)?\s*\d*$/i;
const NEAR_FRAMES = 12;
const NOTES_PER_FRAME = 4;

// `frameId` null: the page alone (the empty-board hint).
export function pageContext(editor: Editor, frameId: string | null): PageContext {
  const frame = frameId ? (editor.getShape(frameId as TLShapeId) as TLFrameShape | undefined) : undefined;
  const page = editor.getCurrentPage().name.trim();
  const ctx: PageContext = { page: /^page\s*\d*$/i.test(page) ? "" : page, frame: "", stickies: [], images: 0, links: 0, board: [] };
  if (!frame) return ctx;
  ctx.frame = GENERIC.test(frame.props.name.trim()) ? "" : frame.props.name.trim();
  // The text of the notes in a frame (nested frames included), up to `max`.
  const notesIn = (id: TLShapeId, max: number, into: string[] = [], tally?: PageContext) => {
    for (const childId of editor.getSortedChildIdsForParent(id)) {
      const s = editor.getShape(childId) as TLShape | undefined;
      if (!s) continue;
      const props = s.props as Record<string, unknown>;
      if (s.type === "note" || s.type === "text") {
        const t = (props.richText ? richTextPlain(props.richText) : "").replace(/\s+/g, " ").trim();
        if (t && into.length < max) into.push(t.slice(0, 160));
      } else if (s.type === "image" || s.type === "video") { if (tally) tally.images++; }
      else if (s.type === "bookmark" || s.type === "embed") { if (tally) tally.links++; }
      else if (s.type === "frame") notesIn(s.id, max, into, tally);
    }
    return into;
  };
  ctx.stickies = notesIn(frame.id, 20, [], ctx);
  const here = editor.getShapePageBounds(frame.id)?.center;
  ctx.board = editor
    .getCurrentPageShapes()
    .filter((s): s is TLFrameShape => s.type === "frame" && s.id !== frame.id && s.parentId === frame.parentId)
    .map((s) => ({ s, d: here ? (editor.getShapePageBounds(s.id)?.center.dist(here) ?? Infinity) : 0 }))
    .sort((a, b) => a.d - b.d)
    .slice(0, NEAR_FRAMES * 2)
    .map(({ s }) => {
      const name = s.props.name.trim();
      return { id: s.id as string, name: GENERIC.test(name) ? "" : name, status: (s.meta as { paseo?: { status?: string } } | undefined)?.paseo?.status ?? "", notes: notesIn(s.id, NOTES_PER_FRAME).map((t) => t.slice(0, 140)) };
    })
    .filter((f) => f.name || f.notes.length || f.status)
    .slice(0, NEAR_FRAMES);
  return ctx;
}
