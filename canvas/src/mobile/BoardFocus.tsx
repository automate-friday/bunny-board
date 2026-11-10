import { AppIcon } from "../components/AppIcon";
// Phone: "View full board" from a focused frame. A small, low-emphasis map button in the top
// bar (the quick-switch strip stays the main way between frames) animates out to the board
// view, the Maps-style overview where a tap on a frame opens it. The frame you came from
// stays outlined there, with "← <frame>" to go straight back.

import { type Editor, type TLShapeId, useValue } from "tldraw";
import { MIN_K } from "./editModel";
import { fitInBand, MOBILE_ZOOM_STEPS } from "./mobileMode";
import { clusterAround, neighbourhood } from "./placement";
import { whereOnBoard } from "./Reveal";
import "./boardFocus.css";

export function FullBoardButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="bm-fullboard" data-testid="mobile-full-board" aria-label="View the full board" title="View the full board" onClick={onClick}>
      <AppIcon name="map" size={22} />
    </button>
  );
}

// The frame you came from, outlined on the board view (follows the camera; touches pass through).
export function FocusOutline({ editor, frameId }: { editor: Editor; frameId: string }) {
  const r = useValue(
    "mobile-focus-outline",
    () => {
      const id = frameId as TLShapeId;
      if (!editor.getShape(id) || editor.getAncestorPageId(id) !== editor.getCurrentPageId()) return null;
      const b = editor.getShapePageBounds(id);
      if (!b) return null;
      const tl = editor.pageToViewport({ x: b.x, y: b.y });
      const br = editor.pageToViewport({ x: b.x + b.w, y: b.y + b.h });
      // At least 28 px across, so a frame far smaller than that on a huge page still shows.
      const w = Math.max(28, br.x - tl.x + 8), h = Math.max(28, br.y - tl.y + 8);
      return { left: (tl.x + br.x) / 2 - w / 2, top: (tl.y + br.y) / 2 - h / 2, width: w, height: h };
    },
    [editor, frameId],
  );
  return r ? <div className="bm-focus-outline" data-testid="mobile-focus-outline" data-frame-id={frameId} style={r} aria-hidden="true" /> : null;
}

// The board view's camera: the current page's content fitted between the top bar and the
// bottom dock (any zoom, even below the board's lowest step, down to MIN_K of it: tldraw's own
// zoomToFit stops at the lowest step, which on a wide page left the camera on the empty middle
// of the page). A page too big even for that is centred on `focus` (the frame you came from), so
// the view is never blank. Returns where the camera went, for the proofs.
export const READABLE_ZOOM = 0.02;
export function fitBoard(editor: Editor, focus: string | null, animate = true): { z: number; target: "page" | "cluster" | "focus" } | null {
  const pageBox = editor.getCurrentPageBounds();
  if (!pageBox) return null;
  const vp = editor.getViewportScreenBounds();
  const top = Math.max(64, (document.querySelector(".bm-top")?.getBoundingClientRect().bottom ?? 56) + 8) - vp.y;
  const dock = document.querySelector(".bm-dock")?.getBoundingClientRect();
  const bottom = Math.max(dock ? vp.y + vp.h - dock.top : 0, 120) + 8;
  const zFor = (b: { w: number; h: number }) => fitInBand({ w: vp.w, h: vp.h }, { x: 0, y: 0, w: b.w, h: b.h }, { top, bottom }, 16).z;
  const floor = MOBILE_ZOOM_STEPS[0] * MIN_K * editor.getBaseZoom();
  const onPage = focus && editor.getShape(focus as TLShapeId) && editor.getAncestorPageId(focus as TLShapeId) === editor.getCurrentPageId();
  const f = onPage ? editor.getShapePageBounds(focus as TLShapeId) ?? null : null;
  // The whole page when it can be read; else the cluster of content around the frame you came
  // from (content spread far apart); else that frame, centred, at the lowest zoom.
  let target: "page" | "cluster" | "focus" = "page";
  let box: { x: number; y: number; w: number; h: number } = pageBox;
  if (zFor(pageBox) < READABLE_ZOOM) {
    const tops = editor.getSortedChildIdsForParent(editor.getCurrentPageId()).flatMap((id) => editor.getShapePageBounds(id) ?? []);
    const cluster = clusterAround(tops, f);
    if (cluster && zFor(cluster) >= floor) { target = "cluster"; box = cluster; }
    else if (f) { target = "focus"; box = f; }
  }
  const z = fitBox(editor, box, animate, floor);
  return { z, target };
}

// The camera that shows `box` between the top bar and the bottom dock (at any zoom down to
// `floor`). Shared by the full-board fit and Show on board.
function bars(editor: Editor) {
  const vp = editor.getViewportScreenBounds();
  const top = Math.max(64, (document.querySelector(".bm-top")?.getBoundingClientRect().bottom ?? 56) + 8) - vp.y;
  const dock = document.querySelector(".bm-dock")?.getBoundingClientRect();
  const bottom = Math.max(dock ? vp.y + vp.h - dock.top : 0, 120) + 8;
  return { vp, top, bottom };
}
export function fitBox(editor: Editor, box: { x: number; y: number; w: number; h: number }, animate = true, floor = MOBILE_ZOOM_STEPS[0] * MIN_K * editor.getBaseZoom()): number {
  const { vp, top, bottom } = bars(editor);
  const z = Math.max(floor, fitInBand({ w: vp.w, h: vp.h }, { x: 0, y: 0, w: box.w, h: box.h }, { top, bottom }, 16).z);
  const band = Math.max(40, vp.h - top - bottom);
  editor.setCamera({ x: vp.w / 2 / z - (box.x + box.w / 2), y: (top + band / 2) / z - (box.y + box.h / 2), z }, animate ? { animation: { duration: 450 } } : { immediate: true });
  return z;
}

// Show on board: the frame among its neighbours, on the live board view.
export function fitAround(editor: Editor, id: string, animate = true): number | null {
  const b = editor.getShapePageBounds(id as TLShapeId);
  if (!b) return null;
  const page = editor.getAncestorPageId(id as TLShapeId);
  if (page && page !== editor.getCurrentPageId()) editor.setCurrentPage(page);
  const others = editor.getCurrentPageShapes().filter((s) => s.type === "frame" && s.id !== id).flatMap((s) => editor.getShapePageBounds(s.id) ?? []);
  return fitBox(editor, neighbourhood(b, others), animate);
}

// "<name> · right of <neighbour> · <page>" for a moment over the board view; it never takes touches.
export function FocusLabel({ editor, frameId }: { editor: Editor; frameId: string }) {
  const name = useValue("focus-label-name", () => String((editor.getShape(frameId as TLShapeId)?.props as { name?: string } | undefined)?.name ?? ""), [editor, frameId]);
  return (
    <div className="bm-focus-label" data-testid="mobile-focus-label" aria-live="polite">
      <b>{name}</b> · {whereOnBoard(editor, frameId)}
    </div>
  );
}
