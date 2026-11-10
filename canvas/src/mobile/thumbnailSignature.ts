import type { Editor, TLShapeId } from "tldraw";

// Content and viewer theme jointly identify an exported thumbnail.
export function contentSignature(editor: Editor, id: string): string {
  const parts: string[] = [];
  const walk = (pid: string, depth: number) => {
    const s = editor.getShape(pid as TLShapeId);
    if (!s) return;
    parts.push(JSON.stringify([s.id, s.type, Math.round(s.x), Math.round(s.y), s.rotation, s.props]));
    if (depth < 4) for (const c of editor.getSortedChildIdsForParent(pid as TLShapeId)) walk(c, depth + 1);
  };
  walk(id, 0);
  let h = 2166136261;
  const str = parts.join("|");
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return `${editor.user.getIsDarkMode() ? "dark" : "light"}:${str.length}:${(h >>> 0).toString(36)}`;
}

