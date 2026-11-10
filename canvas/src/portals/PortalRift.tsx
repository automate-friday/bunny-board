// The portal: a window under the sticky, edged in the sticky's colour, through which the
// destination is live and editable. Its editor is a second tldraw editor on a local copy
// of the board's own store (mirror.ts), not on a second sync connection: a click, a move,
// typing into a sticky or a new shape edits the real content at the destination through
// the board's store, and the board's sync sends it on like any other edit. Its camera is
// its own: wheel or a drag on empty space pans the view through the portal.
// It is built once (prewarmed when the board has portal stickies) and then kept mounted:
// closing hides it and pauses the mirror, opening catches the mirror up, frames the
// destination and shows it, so opening costs a frame, not a new editor.
// It is view state only: a DOM overlay, never a shape. No continuous animation or
// filters; it re-renders only when its own state (open sticky, tool, focus) changes;
// following the sticky as the board pans is a direct style write, and its editor
// re-measures its screen position when that settles or the pointer comes in.
import { TLDRAW_LICENSE_KEY } from "../tldraw-license";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Box, type Editor, react, type TLAnyShapeUtilConstructor, type TLEventInfo, type TLShapeId, Tldraw, useQuickReactor, useValue } from "tldraw";
import { PortalMirror } from "./mirror";
import { installEditKeyBuffer } from "../editKeyBuffer";
import { portalOf } from "../../../shared/portal";
import { installLayoutGuard } from "../locks";
import { livePortal, PortalIcon, portalBounds, portalColor, portalLabel } from "./Portals";

const stop = (e: React.SyntheticEvent) => e.stopPropagation();
const RIFT_W = 580;
const RIFT_H = 380;
const TOOLS = [
  { id: "select", label: "Select", icon: <path d="M6 3l12 9-5.5 1L16 20l-2.5 1-2.6-6.5L6 18z" /> },
  { id: "note", label: "Sticky", icon: <path d="M5 4h14v10l-5 6H5zM14 20v-6h5" /> },
  { id: "text", label: "Text", icon: <path d="M5 6V4h14v2M12 4v16M9 20h6" /> },
  { id: "draw", label: "Draw", icon: <path d="M4 18c3-6 5 2 8-4s4-8 8-6" /> },
] as const;

type Props = {
  board: Editor;
  /** The open portal's sticky, or null: built and hidden. */
  noteId: string | null;
  shapeUtils: TLAnyShapeUtilConstructor[];
  onJump(): void;
  onClose(): void;
  toast(text: string): void;
};

export const PortalRift = memo(function PortalRift({ board, noteId, shapeUtils, onJump, onClose, toast }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [inner, setInner] = useState<Editor | null>(null);
  const mirror = useMemo(() => new PortalMirror(board), [board]);
  useEffect(() => () => mirror.dispose(), [mirror]);
  const open = noteId !== null;
  // Strings, so board edits that leave them unchanged do not re-render the rift.
  const label = useValue("portal-rift-label", () => {
    const p = noteId ? portalOf(board.getShape(noteId as TLShapeId)) : null;
    return p ? portalLabel(board, p) : "";
  }, [board, noteId]);
  const color = useValue("portal-rift-color", () => (noteId ? portalColor(board, board.getShape(noteId as TLShapeId)) : "#7c66ff"), [board, noteId]);
  const tool = useValue("portal-rift-tool", () => inner?.getCurrentToolId() ?? "select", [inner]);
  const [focused, setFocused] = useState(false);
  const target = () => {
    const p = noteId ? livePortal(board, board.getShape(noteId as TLShapeId)) : null;
    return p ? portalBounds(board, p) : null;
  };

  const frame = (ed: Editor, animate: boolean) => {
    const b = target();
    if (!b) return;
    ed.zoomToBounds(new Box(b.x, b.y, b.w, b.h), { inset: 28, targetZoom: 1, ...(animate ? { animation: { duration: 220 } } : {}) });
  };
  // Open: catch the copy up, measure, frame the destination, then show (all before the
  // next paint). Close: pause the mirror and leave the editor idle.
  useLayoutEffect(() => {
    if (!inner) return;
    if (noteId) {
      mirror.resume();
      place();
      inner.updateViewportScreenBounds(inner.getContainer());
      inner.selectNone();
      inner.setCurrentTool("select");
      frame(inner, false);
    } else {
      if (inner.getEditingShapeId()) inner.complete();
      inner.selectNone();
      inner.blur({ blurContainer: false });
      mirror.pause();
      setFocused(false);
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: on open/close only.
  }, [inner, noteId, mirror]);

  // One editor has the keyboard at a time: the rift while you work in it, the board after
  // you click outside. Esc in the rift first leaves editing, then the selection, then closes.
  useEffect(() => {
    if (!inner || !open) return;
    const onDown = (e: PointerEvent) => {
      const inside = !!wrap.current?.contains(e.target as Node);
      if (inside) {
        if (!focused) {
          board.blur({ blurContainer: false });
          inner.focus({ focusContainer: false });
          setFocused(true);
        }
      } else if (focused) {
        inner.blur({ blurContainer: false });
        board.focus({ focusContainer: false });
        setFocused(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !focused) return;
      if (inner.getEditingShapeId() || inner.getSelectedShapeIds().length || inner.getCurrentToolId() !== "select") return;
      onClose();
    };
    // Capture: decide from the state before tldraw's own Esc handling clears it.
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [inner, board, focused, onClose, open]);
  // Closing hands the keyboard back to the board.
  useEffect(() => {
    if (!open) board.focus({ focusContainer: false });
  }, [board, open]);

  // The wheel stays in the rift (the board pans on a native listener on its container).
  // Pointer events are stopped at React level below: a native stop here would also keep
  // them from React's root listener, and so from the rift's own editor.
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const swallow = (e: Event) => e.stopPropagation();
    el.addEventListener("wheel", swallow);
    return () => el.removeEventListener("wheel", swallow);
  }, []);

  const onMount = useCallback((ed: Editor) => {
    setInner(ed);
    (window as unknown as { __portalEditor?: Editor }).__portalEditor = ed;
    ed.user.updateUserPreferences({ name: board.user.getName() });
    ed.setCameraOptions({ wheelBehavior: "pan" });
    // A drag on empty space pans through the portal (the hand tool for that one drag);
    // on a shape it selects, moves and edits it as on the board.
    let panning = false;
    const onBefore = (info: TLEventInfo) => {
      if (info.type !== "pointer" || info.name !== "pointer_down" || info.button !== 0) return;
      if (info.target !== "canvas" || ed.getCurrentToolId() !== "select" || info.shiftKey) return;
      const at = ed.screenToPage(info.point);
      if (ed.getShapeAtPoint(at, { hitInside: false, margin: 4 / ed.getZoomLevel() })) return;
      panning = true;
      ed.setCurrentTool("hand");
    };
    const onAfter = (info: TLEventInfo) => {
      if (!panning || info.type !== "pointer" || info.name !== "pointer_up") return;
      panning = false;
      ed.setCurrentTool("select");
    };
    ed.on("before-event", onBefore);
    ed.on("event", onAfter);
    const stopGuard = installLayoutGuard(ed, toast);
    // Keys typed before the sticky's text box has focus are replayed, not dropped.
    const stopKeys = installEditKeyBuffer(ed);
    // The sticky being typed into is never overwritten from the board mid-edit, and the
    // edit is sent to the board the moment it ends.
    const stopEditing = react("portal-editing", () => mirror.setEditing(ed.getEditingShapeId()));
    return () => {
      stopKeys();
      stopEditing();
      ed.off("before-event", onBefore);
      ed.off("event", onAfter);
      stopGuard();
    };
  }, [board, toast, mirror]);

  // Follow the sticky: written straight to the element as the board camera moves (no
  // React render). The rift's editor re-measures its screen bounds once the movement
  // settles, and at once when the pointer comes in (that is when its mapping matters).
  const measure = useCallback(() => {
    if (inner) inner.updateViewportScreenBounds(inner.getContainer());
  }, [inner]);
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const place = useCallback(() => {
      const el = wrap.current;
      const b = noteId ? board.getShapePageBounds(noteId as TLShapeId) : null;
      if (!el || !b) return;
      const vb = board.getViewportScreenBounds();
      const bl = board.pageToViewport({ x: b.minX, y: b.maxY });
      const w = Math.min(RIFT_W, vb.w - 16);
      const h = Math.min(RIFT_H, vb.h - 120);
      const sw = b.w * board.getZoomLevel();
      const x = Math.round(Math.max(8, Math.min(bl.x + sw / 2 - w / 2, vb.w - w - 8)));
      const y = Math.round(Math.max(8, Math.min(bl.y + 22, vb.h - h - 72)));
      el.style.transform = `translate(${x}px, ${y}px)`;
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
      clearTimeout(settle.current);
      settle.current = setTimeout(measure, 120);
  }, [board, noteId, measure]);
  useLayoutEffect(place, [place]);
  useQuickReactor("portal-rift-position", place, [place]);
  useEffect(() => () => clearTimeout(settle.current), []);
  return (
    <div
      ref={wrap}
      className={`bunny-portal-rift${open ? " open" : ""}${focused ? " focused" : ""}`}
      data-testid={open ? "portal-window" : "portal-window-hidden"}
      data-note={noteId ?? ""}
      aria-hidden={!open}
      style={{ "--portal": color } as React.CSSProperties}
      onPointerEnter={measure}
      onPointerDownCapture={measure}
      onPointerDown={stop}
      onPointerUp={stop}
      onPointerMove={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
      onTouchStart={stop}
      onTouchEnd={stop}
    >
      <div className="bunny-portal-inside">
        <Tldraw licenseKey={TLDRAW_LICENSE_KEY} store={mirror.store} shapeUtils={shapeUtils} hideUi autoFocus={false} onMount={onMount} />
      </div>
      <div className="bunny-portal-chip" data-testid="portal-chip">
        <PortalIcon size={14} />
        <span className="bunny-portal-title">{label}</span>
        <button type="button" className="primary" data-testid="portal-window-jump" title="Move the board there (Back returns here)" onClick={onJump}>
          Jump there
        </button>
        <button type="button" data-testid="portal-recenter" title="Recentre on the destination" onClick={() => inner && frame(inner, true)}>
          Recentre
        </button>
        <button type="button" className="icon" data-testid="portal-collapse" title="Close the portal (Esc)" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="bunny-portal-tools" data-testid="portal-tools">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            title={t.label}
            data-testid={`portal-tool-${t.id}`}
            className={tool === t.id ? "on" : ""}
            onClick={() => {
              inner?.setCurrentTool(t.id);
              inner?.focus({ focusContainer: false });
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {t.icon}
            </svg>
          </button>
        ))}
      </div>
    </div>
  );
});
