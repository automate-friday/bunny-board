// The phone's start drafts: the empty "New agent" frame drawn under the start sheet. Start
// clears its mark (StartSheet), Cancel removes it; a draft that got neither (the tab reloaded or
// was killed while the sheet was up) is removed later by the shell. Frames from before the
// mark: an empty frame named "New agent" with no binding at all is the same leftover.

import type { Editor, TLShapeId } from "tldraw";

export const DRAFT_STALE_MS = 2 * 60_000;

type Rec = { name: string; children: number; meta: Record<string, unknown> };
// Pure, for the unit tests: which of these frames are leftovers.
export function isLeftoverDraft(f: Rec, userId: string, now: number): boolean {
  if (f.children > 0 || f.meta.paseo !== undefined) return false;
  const draft = f.meta.phoneDraft as { by?: string; at?: number } | undefined;
  if (draft) return draft.by === userId && now - (draft.at ?? 0) > DRAFT_STALE_MS;
  return f.name === "New agent";
}

export function leftoverDrafts(editor: Editor, ids: readonly string[], userId: string, now: number): string[] {
  return ids.filter((id) => {
    const s = editor.getShape(id as TLShapeId);
    if (s?.type !== "frame") return false;
    return isLeftoverDraft({ name: String((s.props as { name?: string }).name ?? ""), children: editor.getSortedChildIdsForParent(s.id).length, meta: (s.meta ?? {}) as Record<string, unknown> }, userId, now);
  });
}
