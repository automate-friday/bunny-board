// Phone shell: rename the open frame (tap its title in the header). The frame's name is also
// its agent's name in Paseo: the board server carries a frame rename over (frame-names.ts),
// as on desktop. A small sheet on the visual viewport, so the keyboard never covers Save.

import { useEffect, useRef, useState } from "react";
import type { Editor, TLFrameShape, TLPageId, TLShapeId } from "tldraw";
import { moveFramesToPage, newPage } from "../moveFrames";
import { usePages } from "./pages";
import { cleanName } from "../../../shared/frame-names";
import { useVisibleViewport } from "./StartSheet";
import "./startSheet.css";
import "./tellBunny.css";
import { askReveal } from "./Reveal";
import { useModalHold } from "./modalHold";

// Also the frame's sheet for reorganising: "Move on board" (the board view with the frame
// already picked up, editGestures.ts) and "Move to page" (moveFrames.ts).
export function RenameSheet({ editor, frameId, close, moveOnBoard }: { editor: Editor; frameId: string; close: () => void; moveOnBoard?: () => void }) {
  useModalHold();
  const frame = editor.getShape(frameId as TLShapeId) as TLFrameShape | undefined;
  const [name, setName] = useState(frame?.props.name ?? "");
  const vp = useVisibleViewport();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const t = setTimeout(() => input.current?.select(), 60);
    return () => clearTimeout(t);
  }, []);
  const next = cleanName(name);
  const pages = usePages(editor);
  const here = editor.getShape(frameId as TLShapeId) ? editor.getAncestorPageId(frameId as TLShapeId) : undefined;
  const [moveError, setMoveError] = useState("");
  const toPage = (pageId: TLPageId) => {
    const r = moveFramesToPage(editor, [frameId as TLShapeId], pageId);
    if (r.ok) close();
    else setMoveError(r.reason);
  };
  const save = () => {
    const f = editor.getShape(frameId as TLShapeId) as TLFrameShape | undefined;
    if (f && next && next !== f.props.name) editor.updateShape<TLFrameShape>({ id: f.id, type: "frame", props: { name: next } });
    (document.activeElement as HTMLElement | null)?.blur?.();
    close();
  };
  return (
    <div className="bm-start-layer" data-mobile-ui data-testid="mobile-rename" style={{ top: vp.top, height: vp.height }}>
      <div className="bm-start-scrim" onPointerDown={close} />
      <form className="bm-start-sheet" role="dialog" aria-modal="true" aria-label="Rename" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") close(); }} onSubmit={(e) => { e.preventDefault(); save(); }}>
        <div className="bm-start-head">
          <span className="bm-grip-bar" aria-hidden="true" />
          <b>Rename</b>
          <small>{frame?.meta && (frame.meta as { paseo?: { agentId?: string } }).paseo?.agentId ? "The agent's name changes too" : "This frame's name"}</small>
        </div>
        <div className="bm-start-body">
          <button type="button" className="bm-tell-link" data-testid="mobile-show-on-board" onClick={() => { close(); askReveal(frameId); }}>
            ◎ Show on board
          </button>
          {moveOnBoard ? (
            <button type="button" className="bm-tell-link" data-testid="mobile-move-on-board" onClick={() => { close(); moveOnBoard(); }}>
              ✥ Move on board
            </button>
          ) : null}
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
            {moveError ? <small role="alert">{moveError}</small> : null}
          </div>
          <input ref={input} data-testid="mobile-rename-input" className="bm-start-input" type="text" maxLength={80} enterKeyHint="done" autoComplete="off" aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="bm-start-foot">
          <button type="button" className="bm-start-cancel" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="bm-start-go" data-testid="mobile-rename-save" disabled={!next}>
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
