// Phone shell: "where is it on the board". After a new agent starts (and from Show on board),
// the camera zooms out to the frame among its neighbours, the frame pulses and a label says
// "<name> · right of <neighbour> · <page>" for ~1.5 s, then the camera zooms back into it.

import { useEffect, useSyncExternalStore } from "react";
import { type Editor, type TLShapeId, useValue } from "tldraw";
import { nearestNeighbour, neighbourhood } from "./placement";
import "./reveal.css";
import { useModalHold } from "./modalHold";

export const REVEAL_MS = 1600;

// "Show this frame on the board", from anywhere on the phone (the thread's ⋯ menu, the frame sheet).
let asked: string | null = null;
const listeners = new Set<() => void>();
export function askReveal(frameId: string | null) {
  asked = frameId;
  for (const l of listeners) l();
}
export function useAskedReveal(): string | null {
  return useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => asked);
}

// The other frames on a frame's page, with their bounds.
function pageFrames(editor: Editor, id: string) {
  const page = editor.getAncestorPageId(id as TLShapeId);
  if (!page) return [];
  return [...editor.getPageShapeIds(page)].flatMap((sid) => {
    const s = editor.getShape(sid);
    if (s?.type !== "frame" || s.id === id) return [];
    const b = editor.getShapePageBounds(s.id);
    return b ? [{ id: s.id as string, name: String((s.props as { name?: string }).name || "Untitled frame"), x: b.x, y: b.y, w: b.w, h: b.h }] : [];
  });
}

// "right of “Pricing page” · Page 1", or just the page when the frame is alone there.
export function whereOnBoard(editor: Editor, id: string): string {
  const b = editor.getShapePageBounds(id as TLShapeId);
  const page = editor.getAncestorPageId(id as TLShapeId);
  const pageName = page ? editor.getPage(page)?.name ?? "" : "";
  if (!b) return pageName;
  const n = nearestNeighbour({ id, x: b.x, y: b.y, w: b.w, h: b.h }, pageFrames(editor, id));
  return [n ? `${n.side} “${n.neighbour.name}”` : "on its own", pageName].filter(Boolean).join(" · ");
}

export function Reveal({ editor, frameId, done }: { editor: Editor; frameId: string; done: () => void }) {
  useModalHold();
  const name = useValue("reveal-name", () => String((editor.getShape(frameId as TLShapeId)?.props as { name?: string } | undefined)?.name ?? ""), [editor, frameId]);
  const where = whereOnBoard(editor, frameId);
  // The frame's place on screen, for the pulse.
  const box = useValue(
    "reveal-box",
    () => {
      const b = editor.getShapePageBounds(frameId as TLShapeId);
      if (!b) return null;
      const tl = editor.pageToViewport({ x: b.x, y: b.y });
      const br = editor.pageToViewport({ x: b.x + b.w, y: b.y + b.h });
      return { left: tl.x, top: tl.y, width: br.x - tl.x, height: br.y - tl.y };
    },
    [editor, frameId],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: one reveal per mount.
  useEffect(() => {
    const b = editor.getShapePageBounds(frameId as TLShapeId);
    if (!b) return void done();
    const page = editor.getAncestorPageId(frameId as TLShapeId);
    if (page && page !== editor.getCurrentPageId()) editor.setCurrentPage(page);
    const around = neighbourhood(b, pageFrames(editor, frameId));
    editor.zoomToBounds(around, { inset: 48, animation: { duration: 450 } });
    const back = setTimeout(() => editor.zoomToBounds(b, { inset: 12, animation: { duration: 320 } }), REVEAL_MS);
    const end = setTimeout(done, REVEAL_MS + 360);
    // It never takes touches (pointer-events: none); touching the board ends it early, though
    // not in its first half second (the second tap of a double tap on Start is not a touch on it).
    const from = Date.now() + 500;
    const touched = () => {
      if (Date.now() >= from) done();
    };
    document.addEventListener("pointerdown", touched, { capture: true });
    return () => {
      document.removeEventListener("pointerdown", touched, { capture: true });
      clearTimeout(back);
      clearTimeout(end);
    };
  }, [editor, frameId]);
  return (
    <div className="bm-reveal" data-mobile-ui data-testid="mobile-reveal" aria-live="polite">
      {box ? <div className="bm-reveal-pulse" style={box} /> : null}
      <div className="bm-reveal-label" data-testid="mobile-reveal-label">
        <b>{name}</b> · {where}
      </div>
    </div>
  );
}
