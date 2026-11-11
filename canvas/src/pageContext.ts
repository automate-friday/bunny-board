// What the page around a frame says, for page-aware QuickStart prompts (quickStartPrompts.ts):
// the frame's name, its stickies' text, how many images and links it holds, and the
// names of the nearest other frames. Read once when a start form opens; nothing leaves
// the browser unless "Smarter with AI" is on.
import type { Editor, TLFrameShape, TLShape, TLShapeId } from "tldraw";
import { richTextPlain } from "./mobile/fuzzySearch";
import type { PageContext } from "./quickStartPrompts";

const GENERIC = /^(frame|new agent|untitled)?\s*\d*$/i;

export function pageContext(editor: Editor, frameId: string): PageContext {
  const frame = editor.getShape(frameId as TLShapeId) as TLFrameShape | undefined;
  const ctx: PageContext = { frame: "", stickies: [], images: 0, links: 0, nearby: [] };
  if (!frame) return ctx;
  ctx.frame = GENERIC.test(frame.props.name.trim()) ? "" : frame.props.name.trim();
  const walk = (id: TLShapeId) => {
    for (const childId of editor.getSortedChildIdsForParent(id)) {
      const s = editor.getShape(childId) as TLShape | undefined;
      if (!s) continue;
      const props = s.props as Record<string, unknown>;
      if (s.type === "note" || s.type === "text") {
        const t = (props.richText ? richTextPlain(props.richText) : "").replace(/\s+/g, " ").trim();
        if (t) ctx.stickies.push(t.slice(0, 160));
      } else if (s.type === "image" || s.type === "video") ctx.images++;
      else if (s.type === "bookmark" || s.type === "embed") ctx.links++;
      else if (s.type === "frame") walk(s.id);
    }
  };
  walk(frame.id);
  ctx.stickies = ctx.stickies.slice(0, 20);
  const here = editor.getShapePageBounds(frame.id)?.center;
  ctx.nearby = editor
    .getCurrentPageShapes()
    .filter((s): s is TLFrameShape => s.type === "frame" && s.id !== frame.id && s.parentId === frame.parentId && !GENERIC.test(s.props.name.trim()))
    .map((s) => ({ name: s.props.name.trim(), d: here ? (editor.getShapePageBounds(s.id)?.center.dist(here) ?? Infinity) : 0 }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 5)
    .map((x) => x.name);
  return ctx;
}
