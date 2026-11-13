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
import { fitRect } from "./screenPins";
import { B } from "../bunnyTheme";

const stop = (e: React.SyntheticEvent) => e.stopPropagation();
const RIFT_W = 580;
const RIFT_H = 380;
// A frame peek (a frame tab clicked, FrameTabs.tsx) is a larger window in the middle of
// the canvas rather than one hanging under a sticky.
const PEEK_W = 980;
const PEEK_H = 700;
// A peek's conversation pane (the frame's agent thread and reply box) on its right.
const PANE_W = 380;
const FOLDED_W = 44;
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
  /** A frame being peeked at (no sticky): the window opens onto it, centred. */
  frameId?: string | null;
  /** Extra buttons in the title chip (a window's –). */
  extra?: React.ReactNode;
  /** A peek's ⋯ menu items (Pin, Pin to screen, Chat); Recentre joins them there. */
  menu?: React.ReactNode;
  /** A peek's or window's side pane (its conversation), or null for the frame alone. */
  side?: React.ReactNode;
  /** Whether the side pane is unfolded; folded, it is a slim strip with a handle. */
  sideOpen?: boolean;
  /** The side pane widened for reading: 3/4 of the window. */
  sideWide?: boolean;
  onSideToggle?(): void;
  /** A frame pinned to the screen (screenPins.ts): a window at this rectangle (viewport
   *  pixels) instead of a centred peek. Its title chip moves it and its corner resizes it;
   *  Esc only hands the keyboard back. */
  rect?: { x: number; y: number; w: number; h: number } | null;
  onRect?(r: { x: number; y: number; w: number; h: number }): void;
  /** A window's place in the stack (higher is in front), and a pointer down on it. */
  z?: number;
  onFront?(): void;
  shapeUtils: TLAnyShapeUtilConstructor[];
  onJump(): void;
  onClose(): void;
  toast(text: string): void;
};

export const PortalRift = memo(function PortalRift({ board, noteId, frameId = null, extra, menu, side = null, sideOpen = true, sideWide = false, onSideToggle, rect = null, onRect, z, onFront, shapeUtils, onJump, onClose, toast }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [inner, setInner] = useState<Editor | null>(null);
  const mirror = useMemo(() => new PortalMirror(board), [board]);
  useEffect(() => () => mirror.dispose(), [mirror]);
  const peek = noteId === null ? frameId : null;
  const source = noteId ?? peek;
  const open = source !== null;
  const hasSide = !!peek && !!side;
  // The pane's width: unfolded, up to PANE_W (and under half the window); folded, the strip.
  const paneW = (w: number) => (!hasSide ? 0 : !sideOpen ? FOLDED_W : sideWide ? Math.round(w * 0.75) : Math.min(PANE_W, Math.round(w * 0.45)));
  const win = !!rect && !!peek;
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => setMenuOpen(false), [source]);
  const rectRef = useRef(rect);
  rectRef.current = rect;
  const frameIdRef = useRef(frameId);
  frameIdRef.current = frameId;
  // Strings, so board edits that leave them unchanged do not re-render the rift.
  const label = useValue("portal-rift-label", () => {
    const p = noteId ? portalOf(board.getShape(noteId as TLShapeId)) : peek ? { id: peek } : null;
    return p ? portalLabel(board, p) : "";
  }, [board, noteId, peek]);
  const color = useValue("portal-rift-color", () => (noteId ? portalColor(board, board.getShape(noteId as TLShapeId)) : peek ? B.violet : "#7c66ff"), [board, noteId, peek]);
  const tool = useValue("portal-rift-tool", () => inner?.getCurrentToolId() ?? "select", [inner]);
  const [focused, setFocused] = useState(false);
  const target = () => {
    if (peek) return board.getShapePageBounds(peek as TLShapeId) ?? null;
    const p = noteId ? livePortal(board, board.getShape(noteId as TLShapeId)) : null;
    return p ? portalBounds(board, p) : null;
  };
  // The page the destination is on (a peeked frame can be on another page).
  const targetPage = () => {
    if (peek) return board.getShape(peek as TLShapeId) ? board.getAncestorPageId(peek as TLShapeId) : undefined;
    const p = noteId ? livePortal(board, board.getShape(noteId as TLShapeId)) : null;
    if (p && "id" in p && board.getShape(p.id as TLShapeId)) return board.getAncestorPageId(p.id as TLShapeId);
    return board.getCurrentPageId();
  };

  const frame = (ed: Editor, animate: boolean) => {
    const b = target();
    if (!b) return;
    ed.zoomToBounds(new Box(b.x, b.y, b.w, b.h), { inset: 28, targetZoom: 1, ...(animate ? { animation: { duration: 220 } } : {}) });
  };
  // Recentre: measure first (a window that moved or resized has stale screen bounds), make
  // sure the destination's page is showing, then frame it.
  const recentre = () => {
    if (!inner) return;
    inner.updateViewportScreenBounds(inner.getContainer());
    const page = targetPage();
    if (page && page !== inner.getCurrentPageId() && inner.getPage(page)) inner.setCurrentPage(page);
    frame(inner, true);
  };
  // Open: catch the copy up, measure, frame the destination, then show (all before the
  // next paint). Close: pause the mirror and leave the editor idle.
  useLayoutEffect(() => {
    if (!inner) return;
    if (source) {
      mirror.resume();
      place();
      inner.updateViewportScreenBounds(inner.getContainer());
      const page = targetPage();
      if (page && page !== inner.getCurrentPageId() && inner.getPage(page)) inner.setCurrentPage(page);
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
  }, [inner, source, mirror]);

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
      if (e.key !== "Escape") return;
      // A widened conversation inside takes the first Esc (back to its normal width).
      if (wrap.current?.querySelector('[data-reading="1"]')) return;
      if (!focused) return;
      // Esc in a reply box with text in it leaves the box; the peek stays (the draft is kept).
      const field = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
      if (field && wrap.current?.contains(field) && (field.tagName === "TEXTAREA" || field.tagName === "INPUT") && field.value.trim()) {
        e.preventDefault();
        e.stopPropagation();
        field.blur();
        return;
      }
      if (inner.getEditingShapeId() || inner.getSelectedShapeIds().length || inner.getCurrentToolId() !== "select") return;
      if (win) {
        // A window pinned to the screen stays; Esc gives the keyboard back to the board.
        (document.activeElement as HTMLElement | null)?.blur?.();
        inner.blur({ blurContainer: false });
        board.focus({ focusContainer: false });
        setFocused(false);
        return;
      }
      onClose();
    };
    // Capture: decide from the state before tldraw's own Esc handling clears it.
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [inner, board, focused, onClose, open, win]);
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
    if (!rectRef.current) (window as unknown as { __portalEditor?: Editor }).__portalEditor = ed;
    // Tests reach a screen window's editor by its frame.
    else {
      const w = window as unknown as { __screenEditors?: Map<string, Editor> };
      (w.__screenEditors ??= new Map()).set(String(frameIdRef.current), ed);
    }
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
      const vb = board.getViewportScreenBounds();
      if (el && win && rect) {
        const r = fitRect(rect, vb);
        el.style.setProperty("--pane", `${paneW(r.w)}px`);
        el.style.transform = `translate(${r.x}px, ${r.y}px)`;
        el.style.width = `${r.w}px`;
        el.style.height = `${r.h}px`;
        clearTimeout(settle.current);
        settle.current = setTimeout(measure, 120);
        return;
      }
      if (el && peek) {
        // 48px clear at each side: the right sidebar's collapse tab sits on the canvas's right edge.
        const w = Math.min(PEEK_W + (hasSide && sideOpen ? PANE_W : hasSide ? FOLDED_W : 0), vb.w - 96);
        el.style.setProperty("--pane", `${paneW(w)}px`);
        const h = Math.min(PEEK_H, vb.h - 96);
        el.style.transform = `translate(${Math.round((vb.w - w) / 2)}px, ${Math.round(Math.max(16, (vb.h - h) / 2 - 12))}px)`;
        el.style.width = `${w}px`;
        el.style.height = `${h}px`;
        clearTimeout(settle.current);
        settle.current = setTimeout(measure, 120);
        return;
      }
      const b = noteId ? board.getShapePageBounds(noteId as TLShapeId) : null;
      if (!el || !b) return;
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
  }, [board, noteId, peek, hasSide, sideOpen, sideWide, measure, win, rect?.x, rect?.y, rect?.w, rect?.h]);
  // A window moves by its title chip and resizes by its corner: the element follows the
  // pointer directly, and the new rectangle is kept when the pointer lets go.
  const gesture = (kind: "move" | "size") => (e: React.PointerEvent<HTMLElement>) => {
    if (!win || !rect || e.button !== 0) return;
    if (kind === "move" && (e.target as HTMLElement).closest("button")) return;
    const el = wrap.current;
    if (!el) return;
    e.preventDefault();
    const vb = board.getViewportScreenBounds();
    const start = { px: e.clientX, py: e.clientY, ...fitRect(rect, vb) };
    let next = start as { x: number; y: number; w: number; h: number };
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.px;
      const dy = ev.clientY - start.py;
      next = fitRect(kind === "move" ? { x: start.x + dx, y: start.y + dy, w: start.w, h: start.h } : { x: start.x, y: start.y, w: start.w + dx, h: start.h + dy }, vb);
      el.style.transform = `translate(${next.x}px, ${next.y}px)`;
      el.style.width = `${next.w}px`;
      el.style.height = `${next.h}px`;
      el.style.setProperty("--pane", `${paneW(next.w)}px`);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      onRect?.({ x: next.x, y: next.y, w: next.w, h: next.h });
      if (inner) {
        inner.updateViewportScreenBounds(inner.getContainer());
        if (kind === "size") frame(inner, false);
      }
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  useLayoutEffect(place, [place]);
  // The conversation pane shown or hidden while open: the frame part changed size, so
  // re-measure and frame the destination again once the window has its new size.
  useEffect(() => {
    if (!inner || !source) return;
    const t = setTimeout(() => {
      inner.updateViewportScreenBounds(inner.getContainer());
      frame(inner, true);
    }, 140);
    return () => clearTimeout(t);
    // biome-ignore lint/correctness/useExhaustiveDependencies: on pane changes only.
  }, [hasSide, sideOpen, sideWide]);
  useQuickReactor("portal-rift-position", place, [place]);
  useEffect(() => () => clearTimeout(settle.current), []);
  return (
    <div
      ref={wrap}
      className={`bunny-portal-rift${open ? " open" : ""}${focused ? " focused" : ""}${peek ? " peek" : ""}${win ? " window" : ""}`}
      data-testid={win ? "screen-window" : open ? "portal-window" : "portal-window-hidden"}
      data-note={noteId ?? ""}
      data-peek={win ? "" : (peek ?? "")}
      data-window={win ? peek : undefined}
      aria-hidden={!open}
      style={{ "--portal": color, ...(z !== undefined ? { zIndex: z } : {}) } as React.CSSProperties}
      onPointerEnter={measure}
      onPointerDownCapture={() => {
        measure();
        onFront?.();
      }}
      onPointerDown={stop}
      onPointerUp={stop}
      onPointerMove={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
      onTouchStart={stop}
      onTouchEnd={stop}
    >
      {hasSide ? (
        <div className="bunny-peek-side" data-testid="peek-side" data-open={sideOpen || undefined}>
          {/* Folded: the strip is the handle. Open: the conversation's own › (in its header,
              like the right sidebar's collapse) folds it again. */}
          {sideOpen ? (
            side
          ) : (
            <button type="button" className="bunny-side-handle" data-testid="peek-side-toggle" aria-expanded={false} title="Show the conversation, to reply here" onClick={onSideToggle}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M15 6l-6 6 6 6" />
              </svg>
              <span>Chat</span>
            </button>
          )}
        </div>
      ) : null}
      <div className="bunny-portal-inside">
        <Tldraw licenseKey={TLDRAW_LICENSE_KEY} store={mirror.store} shapeUtils={shapeUtils} hideUi autoFocus={false} onMount={onMount} />
      </div>
      <div className="bunny-portal-chip" data-testid="portal-chip" onPointerDown={win ? gesture("move") : undefined} title={win ? "Drag to move" : undefined}>
        <PortalIcon size={14} />
        <span className="bunny-portal-title">{label}</span>
        {extra}
        <button type="button" className="primary" data-testid="portal-window-jump" title="Move the board there (Back returns here)" onClick={onJump}>
          Jump there
        </button>
        {menu ? null : win ? (
          <button type="button" className="icon" data-testid="portal-recenter" title="Recentre on the frame" aria-label="Recentre on the frame" onClick={recentre}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
            </svg>
          </button>
        ) : (
          <button type="button" data-testid="portal-recenter" title="Recentre on the destination" onClick={recentre}>
            Recentre
          </button>
        )}
        {menu ? (
          <button type="button" className="icon" data-testid="portal-more" aria-haspopup="menu" aria-expanded={menuOpen} title="More" onClick={() => setMenuOpen((o) => !o)}>
            ⋯
          </button>
        ) : null}
        {menu && menuOpen ? (
          // A click on an item does it and closes the menu.
          <div className="bunny-portal-menu" role="menu" data-testid="portal-menu" onClick={(e) => { if ((e.target as HTMLElement).closest("button")) setMenuOpen(false); }}>
            {menu}
            <button type="button" role="menuitem" data-testid="portal-recenter" onClick={recentre}>
              Recentre on the frame
            </button>
          </div>
        ) : null}
        <button type="button" className="icon" data-testid="portal-collapse" title={win ? "Close this window (unpin it from the screen)" : "Close the portal (Esc)"} onClick={onClose}>
          ×
        </button>
      </div>
      {win ? <div className="bunny-window-resize" data-testid="screen-window-resize" title="Drag to resize" onPointerDown={gesture("size")} /> : null}
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
