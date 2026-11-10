// Phone shell editing (editGestures.ts has the touch rules): the picked-up shape's lift, the
// Done / Delete chips, the + Add sheet (Text, Box, Arrow, Sticky, Pen), arrow mode, and the
// bar's + Add, Undo and Redo buttons. Mounted by MobileShell while its bottom bar is up.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createShapeId, type Editor, type TLShapeId, toRichText, useValue } from "tldraw";
import { coverTop, drop, getEdit, installEditGestures, liftDeviceLock, neighbourFrames, pickUp, pushNeighbours, SHEET, setEdit, setMode, settle, useEdit, visibleBand } from "./editGestures";
import { overlappingFrames } from "./framePush";
import { type ArrowEnd, arrowBetween, boxAt, chipsSide, handlePoint, handlesFor, type Pt, scaleFor } from "./editModel";
import { ResizeHandles } from "./ResizeHandles";
import { useLandscape } from "./Immersive";
import { installTouchTrace, touchTraceWanted } from "./touchTrace";
import { nextUndoWord } from "./undoLabel";
import "./edit.css";

const UNDO_CHIP_MS = 8000;

// The screen point in the middle of what is visible between the top bar and the bottom bar.
function visibleCentre(): Pt {
  const { top, bottom } = visibleBand();
  return { x: window.innerWidth / 2, y: (top + bottom) / 2 };
}

// Where whatever covers the bottom starts (the bar, or the thread sheet at any of its stops),
// from the bottom of the window, kept up to date as it changes
// (the thread peek grows and shrinks).
function useDockHeight(threadOpen: boolean): number {
  const [h, setH] = useState(160);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the thread opening or closing swaps what covers the bottom.
  useLayoutEffect(() => {
    const covers = [document.querySelector(".bm-dock"), document.querySelector(SHEET)].filter((e): e is Element => !!e);
    const read = () => setH(Math.max(0, window.innerHeight - coverTop()));
    read();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(read) : null;
    for (const c of covers) ro?.observe(c);
    window.addEventListener("resize", read);
    // The sheet also moves between its stops by position; follow it while it settles.
    const t = setInterval(read, 250);
    return () => {
      ro?.disconnect();
      clearInterval(t);
      window.removeEventListener("resize", read);
    };
  }, [threadOpen]);
  return h;
}

type Kind = "text" | "box" | "sticky";

// A new shape in the middle of the screen (inside the open frame when it lands on it), then
// picked up so a touch-and-drag puts it where it belongs.
function addShape(editor: Editor, kind: Kind, text: string) {
  const at = editor.screenToPage(visibleCentre());
  const zoom = editor.getZoomLevel();
  const id = createShapeId();
  editor.markHistoryStoppingPoint(`phone add ${kind}`);
  if (kind === "box") {
    const b = boxAt(at, zoom);
    editor.createShape({ id, type: "geo", x: b.x, y: b.y, props: { geo: "rectangle", w: b.w, h: b.h, richText: toRichText(text), scale: 1 } });
  } else if (kind === "sticky") {
    const scale = scaleFor(zoom, 0.5);
    editor.createShape({ id, type: "note", x: at.x - 100 * scale, y: at.y - 100 * scale, props: { richText: toRichText(text), scale } });
  } else {
    const scale = scaleFor(zoom);
    editor.createShape({ id, type: "text", x: at.x - 60 * scale, y: at.y - 16 * scale, props: { richText: toRichText(text), scale, autoSize: true } });
  }
  settle(editor, id);
  editor.bringToFront([id]);
  editor.setCurrentTool("hand");
  pickUp(editor, id);
}

function addArrow(editor: Editor, from: ArrowEnd, to: ArrowEnd): TLShapeId | null {
  const a = arrowBetween(from, to);
  if (!a) return null;
  const id = createShapeId();
  editor.markHistoryStoppingPoint("phone add arrow");
  editor.createShape({ id, type: "arrow", x: a.x, y: a.y, props: { start: { x: 0, y: 0 }, end: a.end, scale: scaleFor(editor.getZoomLevel(), 0.8) } });
  for (const [terminal, end] of [["start", from] as const, ["end", to] as const]) {
    if (end.shapeId) editor.createBinding({ type: "arrow", fromId: id, toId: end.shapeId as TLShapeId, props: { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: "none" } });
  }
  settle(editor, id);
  editor.bringToFront([id]);
  return id;
}

export function MobileEdit({ editor, frameId, board, threadOpen = false }: { editor: Editor; frameId: string | null; board: boolean; threadOpen?: boolean }) {
  const edit = useEdit();
  const tool = useValue("mobile-edit-tool", () => editor.getCurrentToolId(), [editor]);
  const dockH = useDockHeight(threadOpen);
  // Undo is in the bottom bar, which the thread sheet covers. While the sheet is up, a phone
  // edit (move, resize, delete, add, pen) leaves an Undo chip for UNDO_CHIP_MS; a held shape
  // always has one beside Delete and Done.
  const canUndo = useValue("mobile-edit-can-undo", () => editor.getCanUndo(), [editor]);
  // What one tap takes back ("Undo push", then "Undo resize"): one visible step per tap.
  const undoWhat = useValue("mobile-edit-undo-word", () => nextUndoWord(editor), [editor]);
  const undoText = canUndo && undoWhat ? `Undo ${undoWhat}` : "Undo";
  const [editedAt, setEditedAt] = useState(0);
  useEffect(
    () =>
      editor.store.listen(
        () => {
          // The pick-up's own selection change is session state, not the document: not an edit.
          setEditedAt(Date.now());
        },
        { source: "user", scope: "document" },
      ),
    [editor],
  );
  const [, tick] = useState(0);
  const recentEdit = threadOpen && Date.now() - editedAt < UNDO_CHIP_MS;
  useEffect(() => {
    if (!recentEdit) return;
    const t = setTimeout(() => tick((n) => n + 1), UNDO_CHIP_MS - (Date.now() - editedAt) + 20);
    return () => clearTimeout(t);
  }, [recentEdit, editedAt]);
  // While something is picked up, the floating Bunny button steps aside: on the board view it sits
  // where the held shape's chips go.
  useEffect(() => {
    document.documentElement.classList.toggle("bm-holding", !!edit.held);
    return () => document.documentElement.classList.remove("bm-holding");
  }, [edit.held]);
  const live = useRef({ frameId, board });
  live.current = { frameId, board };

  useEffect(() => {
    const stop = installEditGestures(editor, {
      frameId: () => live.current.frameId,
      frames: () => live.current.board,
      onArrowTap: (end) => {
        const from = getEdit().arrow?.from;
        if (!from) return setEdit({ arrow: { from: end } });
        // A second tap on the same shape or spot keeps waiting for the end.
        if (!arrowBetween(from, end)) return;
        addArrow(editor, from, end);
        setEdit({ arrow: null });
      },
    });
    const relock = liftDeviceLock();
    // ?touchdebug=1: record what this phone sends (touchTrace.ts, server/touch-debug.ts).
    const stopTrace = touchTraceWanted() ? installTouchTrace(editor, new URLSearchParams(window.location.search).get("board") ?? "main") : () => undefined;
    return () => {
      stop();
      stopTrace();
      relock();
      drop(editor);
      setEdit({ sheet: false, arrow: null, dragging: false, zoomBack: null, board: false });
    };
  }, [editor]);

  // Another tool (the pen), a shape that went away (undo, an agent, another person) or a new
  // frame drops what is held.
  const heldGone = useValue("mobile-held-gone", () => !!edit.held && !editor.getShape(edit.held), [editor, edit.held]);
  useEffect(() => {
    if (heldGone) setEdit({ held: null, dragging: false });
  }, [heldGone]);
  useEffect(() => {
    if (tool !== "hand") {
      drop(editor);
      if (getEdit().arrow) setEdit({ arrow: null });
    }
  }, [editor, tool]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new frame or mode starts clean.
  // A map (pan and zoom only, no pick-up, no + Add): the board overview, and landscape
  // (Immersive.tsx, which also keeps the hand tool while it lasts).
  const landscape = useLandscape();
  const map = board || landscape;
  useEffect(() => {
    drop(editor);
    setEdit({ arrow: null, zoomBack: null, board: map, sheet: false });
    // The board overview is pan and zoom only: the hand tool, whatever was on before.
    if (board && editor.getCurrentToolId() !== "hand") editor.setCurrentTool("hand");
  }, [editor, frameId, board, map]);

  const lift = useValue(
    "mobile-held-bounds",
    () => {
      if (!edit.held) return null;
      const b = editor.getShapePageBounds(edit.held);
      if (!b) return null;
      const tl = editor.pageToScreen({ x: b.x, y: b.y });
      const br = editor.pageToScreen({ x: b.x + b.w, y: b.y + b.h });
      return { left: tl.x - 6, top: tl.y - 6, width: Math.max(12, br.x - tl.x + 12), height: Math.max(12, br.y - tl.y + 12) };
    },
    [editor, edit.held],
  );
  // The held shape's size (page units), for Resize mode's live readout.
  const size = useValue("mobile-held-size", () => {
    const b = edit.held ? editor.getShapePageBounds(edit.held) : null;
    return b ? `${Math.round(b.w)} × ${Math.round(b.h)}` : "";
  }, [editor, edit.held]);
  // A held frame: the neighbour frames it overlaps now, on screen (a faint outline each, and the
  // "Push neighbours aside" chip while there are any).
  const crowded = useValue(
    "mobile-held-overlaps",
    () => {
      const b = edit.held && editor.getShape(edit.held)?.type === "frame" ? editor.getShapePageBounds(edit.held) : null;
      if (!b || !edit.held) return [];
      return overlappingFrames({ id: edit.held, x: b.x, y: b.y, w: b.w, h: b.h }, neighbourFrames(editor, edit.held)).map((o) => {
        const tl = editor.pageToScreen({ x: o.x, y: o.y });
        const br = editor.pageToScreen({ x: o.x + o.w, y: o.y + o.h });
        return { id: o.id, left: tl.x, top: tl.y, width: br.x - tl.x, height: br.y - tl.y };
      });
    },
    [editor, edit.held],
  );
  const resizing = edit.mode === "resize";
  const from = edit.arrow?.from ?? null;
  const fromAt = useValue("mobile-arrow-from", () => (from ? editor.pageToScreen(from.point) : null), [editor, from]);
  // The picked-up shape on screen (without the lift's 6 px margin), for its resize handles.
  const shown = lift && edit.held && !edit.dragging ? { left: lift.left + 6, top: lift.top + 6, width: lift.width - 12, height: lift.height - 12 } : null;
  const heldType = edit.held ? editor.getShape(edit.held)?.type ?? "" : "";
  const heldFrame = heldType === "frame";
  // Done / Delete above the bar, or under the top bar when a handle would sit on them.
  const vh = typeof window === "undefined" ? 844 : window.innerHeight;
  const band = visibleBand();
  const side = shown
    ? chipsSide(
        handlesFor(heldType, { w: shown.width, h: shown.height }).map((h) => handlePoint(h, shown)),
        { top: vh - dockH - 10 - 80, bottom: vh - dockH - 10 },
        { top: band.top + 8, bottom: band.top + 88 },
      )
    : "bottom";
  const chips: React.CSSProperties = side === "top" ? { top: band.top + 8 } : { bottom: dockH + 10 };

  return (
    <>
      {crowded.map((r) => (
        <div key={r.id} className="bm-push-outline" data-testid="mobile-push-outline" data-shape-id={r.id} style={{ left: r.left, top: r.top, width: r.width, height: r.height }} aria-hidden="true" />
      ))}
      {lift ? <div className="bm-lift" data-testid="mobile-held" data-shape-id={edit.held} data-dragging={edit.dragging ? "1" : "0"} data-mode={edit.mode} style={lift} aria-hidden="true" /> : null}
      {shown && edit.held ? <ResizeHandles editor={editor} id={edit.held} rect={shown} /> : null}
      {fromAt ? <div className="bm-arrow-from" data-testid="mobile-arrow-from" style={{ left: fromAt.x, top: fromAt.y }} aria-hidden="true" /> : null}

      {edit.held ? (
        <div className="bm-edit-chips" data-mobile-ui data-testid="mobile-held-chips" data-side={side} data-mode={edit.mode} style={chips}>
          {resizing ? (
            <span className="bm-edit-hint bm-edit-resizing" data-testid="mobile-resize-label">
              Resizing: drag to size · Done <b data-testid="mobile-resize-size">{size}</b>
            </span>
          ) : (
            <span className="bm-edit-hint">{heldFrame ? "Drag the frame · hold it again or tap Resize to resize · tap the canvas to drop" : "Drag it · hold it again or tap Resize to resize · tap the canvas to drop"}</span>
          )}
          {crowded.length ? (
            <button type="button" className="bm-edit-push" data-testid="mobile-push" onClick={() => edit.held && pushNeighbours(editor, edit.held)}>
              Push neighbours aside
            </button>
          ) : null}
          <button type="button" className="bm-edit-undo" data-testid="mobile-held-undo" data-undo={undoWhat ?? ""} disabled={!canUndo} onClick={() => editor.undo()} aria-label={undoText}>
            {undoText}
          </button>
          <button type="button" className="bm-edit-resize" data-testid="mobile-resize" aria-pressed={resizing} onClick={() => setMode(resizing ? "move" : "resize")}>
            Resize
          </button>
          {/* A whole frame (its agent, its cards) is not deleted from a chip. */}
          {heldFrame ? null : (
          <button
            type="button"
            className="bm-edit-delete"
            data-testid="mobile-delete"
            onClick={() => {
              const id = getEdit().held;
              if (!id) return;
              editor.markHistoryStoppingPoint("phone delete");
              editor.deleteShapes([id]);
              setEdit({ held: null, dragging: false });
            }}
          >
            Delete
          </button>
          )}
          {/* In Resize mode, Done ends the resize (back to Move); otherwise it drops the shape. */}
          <button type="button" className="bm-edit-done" data-testid="mobile-done" onClick={() => (getEdit().mode === "resize" ? setMode("move") : drop(editor))}>
            Done
          </button>
        </div>
      ) : recentEdit && canUndo && !edit.arrow && tool !== "draw" ? (
        <div className="bm-edit-chips" data-mobile-ui data-testid="mobile-undo-chip" style={chips}>
          <button type="button" className="bm-edit-undo" data-testid="mobile-chip-undo" data-undo={undoWhat ?? ""} onClick={() => editor.undo()} aria-label={undoText}>
            {undoText}
          </button>
        </div>
      ) : edit.arrow ? (
        <div className="bm-edit-chips" data-mobile-ui data-testid="mobile-arrow-mode" style={chips}>
          <span className="bm-edit-hint">{from ? "Now tap where it ends" : "Tap a shape or a spot to start the arrow"}</span>
          <button type="button" className="bm-edit-done" data-testid="mobile-arrow-cancel" onClick={() => setEdit({ arrow: null })}>
            Cancel
          </button>
        </div>
      ) : tool === "draw" ? (
        <div className="bm-edit-chips" data-mobile-ui data-testid="mobile-pen-mode" style={chips}>
          <span className="bm-edit-hint">Drawing · hold a mark later to move or delete it</span>
          <button type="button" className="bm-edit-done" data-testid="mobile-pen-done" onClick={() => editor.setCurrentTool("hand")}>
            Done
          </button>
        </div>
      ) : null}

      {edit.sheet ? <AddSheet editor={editor} close={() => setEdit({ sheet: false })} /> : null}
    </>
  );
}

const ICONS: Record<string, React.ReactNode> = {
  text: <path d="M5 6V4h14v2M12 4v16M9 20h6" />,
  box: <rect x="4" y="6" width="16" height="12" rx="1.5" />,
  arrow: <path d="M4 18L19 5M11 5h8v8" />,
  sticky: <path d="M5 4h14v10l-6 6H5zM13 20v-6h6" />,
  pen: <path d="M4 20l1-4L16 5l3 3L8 19l-4 1zM14 7l3 3" />,
};
const Icon = ({ name }: { name: string }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    {ICONS[name]}
  </svg>
);

function AddSheet({ editor, close }: { editor: Editor; close: () => void }) {
  const [kind, setKind] = useState<Kind | null>(null);
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  // The keyboard only comes up for a focus inside the tap itself (iOS), so render the field
  // now and focus it before the handler returns.
  const ask = (k: Kind) => {
    flushSync(() => setKind(k));
    input.current?.focus();
  };
  const add = () => {
    if (!kind) return;
    if (kind !== "box" && !text.trim()) return;
    addShape(editor, kind, text.trim());
    close();
  };
  const choose = (name: string) => {
    if (name === "text" || name === "sticky") return ask(name);
    if (name === "box") {
      addShape(editor, "box", "");
      return close();
    }
    if (name === "arrow") {
      drop(editor);
      editor.setCurrentTool("hand");
      setEdit({ sheet: false, arrow: { from: null } });
      return;
    }
    drop(editor);
    editor.setCurrentTool("draw");
    close();
  };
  return (
    <>
      <div className="bm-edit-scrim" data-mobile-ui onPointerDown={close} />
      <div className="bm-add-sheet" data-mobile-ui data-testid="mobile-add-sheet" role="dialog" aria-label="Add to the board">
        <span className="bm-grip-bar" aria-hidden="true" />
        {kind ? (
          <form
            className="bm-add-text"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <b>{kind === "text" ? "Text" : "Sticky note"}</b>
            <textarea ref={input} data-testid="mobile-add-input" rows={3} value={text} placeholder={kind === "text" ? "Type the text…" : "Type the note…"} onChange={(e) => setText(e.target.value)} />
            <span className="bm-add-actions">
              <button type="button" onClick={() => setKind(null)}>
                Back
              </button>
              <button type="submit" className="bm-add-go" data-testid="mobile-add-confirm" disabled={!text.trim()}>
                Add {kind === "text" ? "text" : "sticky"}
              </button>
            </span>
          </form>
        ) : (
          <div className="bm-add-grid">
            {(
              [
                ["text", "Text"],
                ["box", "Box"],
                ["arrow", "Arrow"],
                ["sticky", "Sticky"],
                ["pen", "Pen"],
              ] as const
            ).map(([name, label]) => (
              <button key={name} type="button" data-testid={`mobile-add-${name}`} onClick={() => choose(name)}>
                <Icon name={name} />
                <small>{label}</small>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// The bar's + Add.
export function AddButton() {
  const edit = useEdit();
  // Not on the board overview (pan and zoom only); inside a frame.
  if (edit.board) return null;
  return (
    <button type="button" data-testid="mobile-add" aria-pressed={edit.sheet || !!edit.arrow} aria-label="Add text, box, arrow, sticky or pen" onClick={() => setEdit({ sheet: !getEdit().sheet, arrow: null })}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 5v14M5 12h14" />
      </svg>
      <small>Add</small>
    </button>
  );
}

// The bar's Undo and Redo: the editor's own history, as Cmd+Z / Cmd+Shift+Z on desktop.
export function HistoryButtons({ editor }: { editor: Editor }) {
  const canUndo = useValue("mobile-can-undo", () => editor.getCanUndo(), [editor]);
  const canRedo = useValue("mobile-can-redo", () => editor.getCanRedo(), [editor]);
  return (
    <span className="bm-history">
      <button type="button" data-testid="mobile-undo" disabled={!canUndo} aria-label="Undo" onClick={() => editor.undo()}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3" />
        </svg>
      </button>
      <button type="button" data-testid="mobile-redo" disabled={!canRedo} aria-label="Redo" onClick={() => editor.redo()}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3" />
        </svg>
      </button>
    </span>
  );
}
