// Phone shell: move a frame. From the thread's ⋯ menu ("✥ Move frame…", Sidebar.tsx) and the
// frame's Rename sheet: "Move on board" (the board view with the frame already picked up,
// editGestures.ts) and "Move to page" (moveFrames.ts).

import { useState, useSyncExternalStore } from "react";
import type { Editor, TLFrameShape, TLPageId, TLShapeId } from "tldraw";
import { moveFramesToPage, newPage } from "../moveFrames";
import { useModalHold } from "./modalHold";
import { usePages } from "./pages";
import { useVisibleViewport } from "./StartSheet";
import { useSwipeDismiss } from "./sheetDrag";
import "./startSheet.css";
import "./tellBunny.css";

let asked: string | null = null;
const listeners = new Set<() => void>();
export function askMove(frameId: string | null) {
  asked = frameId;
  for (const l of listeners) l();
}
export function useAskedMove(): string | null {
  return useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => asked);
}

// "Move to page": one chip per other page, and "+ New page".
export function MovePages({ editor, frameId, done }: { editor: Editor; frameId: string; done: () => void }) {
  const pages = usePages(editor);
  const here = editor.getShape(frameId as TLShapeId) ? editor.getAncestorPageId(frameId as TLShapeId) : undefined;
  const [error, setError] = useState("");
  const toPage = (pageId: TLPageId) => {
    const r = moveFramesToPage(editor, [frameId as TLShapeId], pageId);
    if (r.ok) done();
    else setError(r.reason);
  };
  return (
    <div className="bm-move-pages" data-testid="mobile-move-to-page" role="group" aria-label="Move to page">
      <span className="bm-field-label">Move to page</span>
      {pages.filter((p) => p.id !== here).map((p) => (
        <button key={p.id} type="button" className="bm-move-page" data-testid="mobile-move-page" data-page-id={p.id} onClick={() => toPage(p.id as TLPageId)}>
          {p.name}
        </button>
      ))}
      <button type="button" className="bm-move-page" data-testid="mobile-move-new-page" onClick={() => toPage(newPage(editor))}>
        + New page
      </button>
      {error ? <small role="alert">{error}</small> : null}
    </div>
  );
}

export function MoveSheet({ editor, frameId, close, moveOnBoard }: { editor: Editor; frameId: string; close: () => void; moveOnBoard: () => void }) {
  useModalHold();
  const vp = useVisibleViewport();
  const swipe = useSwipeDismiss(close);
  const frame = editor.getShape(frameId as TLShapeId) as TLFrameShape | undefined;
  return (
    <div className="bm-start-layer" data-mobile-ui data-testid="mobile-move-sheet" style={{ top: vp.top, height: vp.height }}>
      <div className="bm-start-scrim" onPointerDown={close} />
      <div ref={swipe} className="bm-start-sheet" role="dialog" aria-modal="true" aria-label="Move frame" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") close(); }}>
        <div className="bm-start-head">
          <span className="bm-grip-bar" aria-hidden="true" />
          <b>Move “{frame?.props.name || "frame"}”</b>
          <small>Everything in it, and its agent, comes along</small>
        </div>
        <div className="bm-start-body">
          <button type="button" className="bm-move-page" data-testid="mobile-move-on-board" onClick={() => { close(); moveOnBoard(); }}>
            ✥ Move on board
          </button>
          <MovePages editor={editor} frameId={frameId} done={close} />
        </div>
        <div className="bm-start-foot">
          <button type="button" className="bm-start-cancel" onClick={close}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
