// Sticky-note portals (shared/portal.ts). A note whose meta.portal points at a shape or a
// page area gets one portal button in the sticky's own colour. It opens the portal: a
// window under the sticky through which the target is live and editable (PortalRift.tsx:
// a second editor on the same board, so every click, move, edit and new shape lands on the
// real content). "Jump there" in the portal moves the camera to the target, and a "Back"
// pill returns to exactly where you were, through a stack of jumps. Hovering the button
// rings the destination. Only one rift is open at a time, and it is view state only: a DOM overlay,
// never a shape, so it is not saved, synced or counted as overlap.
// The same window also opens straight onto a frame, without a sticky: a peek (a frame tab
// clicked, FrameTabs.tsx), centred over a dimmed board; Esc or a click outside closes it.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { atom, Box, type Computed, computed, type Editor, isUninitialized, getColorValue, react, type TLEventInfo, type TLShape, type TLShapeId, type TLAnyShapeUtilConstructor, useValue } from "tldraw";
import { isAreaPortal, type PortalTarget, portalOf } from "../../../shared/portal";
import { pageFrames } from "../pageFrames";
import { PortalRift } from "./PortalRift";
import { PortalIcon } from "./icons";
import { PortalToolOverlay } from "./PortalTool";
import { addScreenPin, frontScreenPin, loadScreenPins, newSpot, removeScreenPin, SCREEN_PIN_LIMIT, type ScreenPin, screenPins, setScreenPins, updateScreenPin } from "./screenPins";
import "./portals.css";

type Cam = { x: number; y: number; z: number };
export const portalOpen = atom<string | null>("portal-open", null);
export const portalBack = atom<Array<{ cam: Cam; from: string; page?: string }>>("portal-back", []);
/** The frame being peeked at (a frame tab), or null. Only one of this and portalOpen is set. */
export const framePeek = atom<string | null>("frame-peek", null);
/** Peek at a frame (again: close it). */
export function togglePeek(id: string): void {
  portalOpen.set(null);
  framePeek.set(framePeek.get() === id ? null : id);
}
const portalFlash = atom<{ box: { x: number; y: number; w: number; h: number }; at: number; color: string } | null>("portal-flash", null);
const portalHover = atom<string | null>("portal-hover", null);

const ANIM = { animation: { duration: 420 } };
// The Back pill goes away when it is no longer the way back: when the person moves the
// camera themselves, after BACK_IDLE_MS with no input, or with its ×. Camera moves inside
// this window after a jump or Back are the portal's own animation, not the person's.
let selfMoveUntil = 0;
const selfMove = () => {
  selfMoveUntil = Date.now() + ANIM.animation.duration + 250;
};
export const BACK_IDLE_MS = 20_000;
export function clearBack(): void {
  if (portalBack.get().length) portalBack.set([]);
}

/** Page bounds of a portal's target, or null when the target shape is gone. */
export function portalBounds(editor: Editor, p: PortalTarget): Box | null {
  if (isAreaPortal(p)) return new Box(p.x, p.y, p.w, p.h);
  const s = editor.getShape(p.id as TLShapeId);
  return s ? (editor.getShapePageBounds(s.id) ?? null) : null;
}

/**
 * The sticky's portal if it can be followed: an area portal, or a shape portal whose
 * target is on the board. A portal to a deleted shape reads as none here (no button, no
 * opening, no jump), but meta.portal is kept, so undoing the delete brings it back.
 * Reactive: read inside useValue, it re-runs when the target appears or goes.
 */
export function livePortal(editor: Editor, note: TLShape | undefined): PortalTarget | null {
  const p = portalOf(note);
  if (!p) return null;
  if (isAreaPortal(p)) return p;
  return editor.getShape(p.id as TLShapeId) ? p : null;
}

function textOf(s: TLShape | undefined): string {
  if (!s) return "";
  const props = s.props as { name?: string; richText?: unknown; title?: string };
  if (s.type === "frame") return props.name || "frame";
  if (props.title) return props.title;
  const walk = (n: unknown): string => {
    if (!n || typeof n !== "object") return "";
    const o = n as { text?: string; content?: unknown[] };
    return (o.text ?? "") + (o.content ?? []).map(walk).join(" ");
  };
  return walk(props.richText).replace(/\s+/g, " ").trim();
}

// The current page's notes with a live portal. Notes come from tldraw's incremental
// store query and the list keeps its identity while the same notes qualify, so the
// camera-driven badge pass below walks the few portal notes, not every page shape.
const portalNotesByEditor = new WeakMap<Editor, Computed<TLShape[]>>();
const NO_NOTES: TLShape[] = [];
function portalNotes(editor: Editor): Computed<TLShape[]> {
  let c = portalNotesByEditor.get(editor);
  if (!c) {
    const notes = editor.store.query.ids("shape", () => ({ type: { eq: "note" } }));
    c = computed<TLShape[]>("portal-notes", (prev) => {
      const pageId = editor.getCurrentPageId();
      const next: TLShape[] = [];
      for (const id of notes.get()) {
        const s = editor.getShape(id as TLShapeId);
        if (s && livePortal(editor, s) && editor.getAncestorPageId(s) === pageId) next.push(s);
      }
      if (!next.length) return NO_NOTES;
      return !isUninitialized(prev) && prev.length === next.length && prev.every((s, i) => s === next[i]) ? prev : next;
    });
    portalNotesByEditor.set(editor, c);
  }
  return c;
}

const short = (t: string, n = 32) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/** "frame “Overflow”", "sticky “…” in “Overflow”", "area in “Overflow”". */
export function portalLabel(editor: Editor, p: PortalTarget): string {
  const frameAt = (b: Box) => {
    let hit: TLShape | undefined;
    for (const s of pageFrames(editor).get()) {
      const fb = editor.getShapePageBounds(s.id);
      if (fb?.containsPoint(b.center)) hit = s;
    }
    return hit;
  };
  if (isAreaPortal(p)) {
    const f = frameAt(new Box(p.x, p.y, p.w, p.h));
    return f ? `area in “${short(textOf(f), 24)}”` : "area";
  }
  const s = editor.getShape(p.id as TLShapeId);
  if (!s) return "missing target";
  if (s.type === "frame") return `frame “${short(textOf(s), 28)}”`;
  const b = editor.getShapePageBounds(s.id);
  const f = s.parentId && editor.getShape(s.parentId as TLShapeId)?.type === "frame" ? editor.getShape(s.parentId as TLShapeId) : b ? frameAt(b) : undefined;
  const kind = s.type === "note" ? "sticky" : s.type === "geo" ? "shape" : s.type;
  const t = textOf(s);
  return `${kind}${t ? ` “${short(t, 22)}”` : ""}${f ? ` in “${short(textOf(f), 20)}”` : ""}`;
}

/** The portal's colour: the source sticky's colour, as the board draws it. */
export function portalColor(editor: Editor, note: TLShape | undefined): string {
  const c = (note?.props as { color?: string } | undefined)?.color ?? "violet";
  try {
    return getColorValue(editor.getCurrentTheme().colors[editor.getColorMode()], c, "solid");
  } catch {
    return "#7c66ff";
  }
}

/** Jump the camera to the portal's target, remembering where we were. */
export function jumpThrough(editor: Editor, noteId: string): boolean {
  const note = editor.getShape(noteId as TLShapeId);
  const p = livePortal(editor, note);
  const b = p && portalBounds(editor, p);
  if (!p || !b) return false;
  // A shape's portal can lead to another page (a channel sticky's other frame often is on
  // one): go to that page first, and remember this one so Back returns here.
  const here = editor.getCurrentPageId();
  const target = isAreaPortal(p) ? undefined : editor.getShape(p.id as TLShapeId);
  const page = (target && editor.getAncestorPageId(target)) || here;
  const cam = editor.getCamera();
  portalBack.set([...portalBack.get(), { cam: { x: cam.x, y: cam.y, z: cam.z }, from: noteId, page: here }].slice(-20));
  portalOpen.set(null);
  portalHover.set(null);
  selfMove();
  const moved = page !== here;
  if (moved) editor.setCurrentPage(page);
  editor.zoomToBounds(b, { ...(moved ? {} : ANIM), inset: 80, targetZoom: 1 });
  portalFlash.set({ box: { x: b.x, y: b.y, w: b.w, h: b.h }, at: Date.now(), color: portalColor(editor, note) });
  return true;
}

/** Ring the portal's destination for a moment (after a person makes a portal). */
export function flashTarget(editor: Editor, noteId: string): void {
  const note = editor.getShape(noteId as TLShapeId);
  const p = livePortal(editor, note);
  const b = p && portalBounds(editor, p);
  if (b) portalFlash.set({ box: { x: b.x, y: b.y, w: b.w, h: b.h }, at: Date.now(), color: portalColor(editor, note) });
}

/** Pin a frame to the screen: a small window onto it that stays while you move around (and a
 *  pill in the bottom dock). Closes the peek; says which window closed to make room. */
export function pinToScreen(editor: Editor, frameId: string, toast: (text: string) => void): void {
  const vb = editor.getViewportScreenBounds();
  const { pins, dropped } = addScreenPin(screenPins.get(), frameId, newSpot(screenPins.get(), { w: vb.w, h: vb.h }));
  setScreenPins(pins);
  framePeek.set(null);
  if (dropped) toast(`Closed the window on “${textOf(editor.getShape(dropped as TLShapeId)).slice(0, 32)}” to make room (${SCREEN_PIN_LIMIT} at most)`);
}

/** Jump the board to a frame, on any page, remembering where we were (Back returns), and
 *  select it, so its conversation opens in the sidebar (one action to switch to it). */
export function jumpToFrame(editor: Editor, frameId: string): boolean {
  const shape = editor.getShape(frameId as TLShapeId);
  const page = shape ? editor.getAncestorPageId(shape) : undefined;
  if (!shape || !page) return false;
  const cam = editor.getCamera();
  portalBack.set([...portalBack.get(), { cam: { x: cam.x, y: cam.y, z: cam.z }, from: "", page: editor.getCurrentPageId() }].slice(-20));
  portalOpen.set(null);
  framePeek.set(null);
  selfMove();
  const moved = page !== editor.getCurrentPageId();
  if (moved) editor.setCurrentPage(page);
  editor.select(shape.id);
  const b = editor.getShapePageBounds(shape.id);
  if (!b) return false;
  editor.zoomToBounds(b, { ...(moved ? {} : ANIM), inset: 80, targetZoom: 1 });
  portalFlash.set({ box: { x: b.x, y: b.y, w: b.w, h: b.h }, at: Date.now(), color: "#8875F6" });
  return true;
}

export function jumpBack(editor: Editor): void {
  const stack = portalBack.get();
  const last = stack[stack.length - 1];
  if (!last) return;
  portalBack.set(stack.slice(0, -1));
  selfMove();
  if (last.page && last.page !== editor.getCurrentPageId() && editor.getPage(last.page as never)) {
    editor.setCurrentPage(last.page as never);
    editor.setCamera(last.cam);
    return;
  }
  editor.setCamera(last.cam, ANIM);
}

// --- icons -------------------------------------------------------------------------------
const Icon = ({ d, size = 14 }: { d: React.ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
);
export { PortalIcon } from "./icons";
const BackIcon = () => <Icon d={<path d="M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />} />;

// --- badges on stickies -------------------------------------------------------------------
type Badge = { id: string; x: number; y: number; ok: boolean; label: string; color: string };

// Recomputed on every camera move, so it returns a string: an unchanged list (a board edit
// elsewhere, typing in the rift) does not re-render anything.
function useBadges(editor: Editor): Badge[] {
  const json = useValue(
    "portal-badges",
    () => {
      const out: Badge[] = [];
      const notes = portalNotes(editor).get();
      if (!notes.length) return "[]";
      const vp = editor.getViewportPageBounds();
      const z = editor.getZoomLevel();
      for (const s of notes) {
        const p = livePortal(editor, s);
        if (!p) continue;
        const b = editor.getShapePageBounds(s.id);
        if (!b || !b.collides(vp) || b.w * z < 60) continue;
        const tr = editor.pageToViewport({ x: b.maxX, y: b.minY });
        out.push({ id: s.id, x: Math.round(tr.x), y: Math.round(tr.y), ok: !!portalBounds(editor, p), label: portalLabel(editor, p), color: portalColor(editor, s) });
        if (out.length >= 80) break;
      }
      return JSON.stringify(out);
    },
    [editor],
  );
  return useMemo(() => JSON.parse(json) as Badge[], [json]);
}

const stop = (e: React.PointerEvent | React.MouseEvent) => e.stopPropagation();
const tint = (color: string) => ({ "--portal": color }) as React.CSSProperties;

export type RiftProps = { shapeUtils: TLAnyShapeUtilConstructor[] };

// One button per portal sticky: it opens the portal (the common path). Jumping there is an
// action inside the open portal.
const PortalBadges = memo(function PortalBadges({ editor }: { editor: Editor }) {
  const badges = useBadges(editor);
  const open = useValue(portalOpen);
  return (
    <>
      {badges.map((b) => (
        <div
          key={b.id}
          className={`bunny-portal-badge${open === b.id ? " open" : ""}`}
          data-testid="portal-badge"
          data-note={b.id}
          style={{ left: b.x, top: b.y, ...tint(b.color) }}
          onPointerDown={stop}
          onPointerEnter={() => portalHover.set(b.id)}
          onPointerLeave={() => portalHover.set(null)}
        >
          <button
            type="button"
            className={`bunny-portal-open${b.ok ? "" : " missing"}${open === b.id ? " on" : ""}`}
            data-testid="portal-open"
            title={!b.ok ? "The target was deleted" : open === b.id ? "Close the portal" : `Open a portal onto ${b.label}`}
            disabled={!b.ok}
            onClick={() => {
              portalHover.set(null);
              framePeek.set(null);
              portalOpen.set(open === b.id ? null : b.id);
            }}
          >
            <PortalIcon />
          </button>
        </div>
      ))}
    </>
  );
});

export function Portals({ editor, toast, rift, peekExtra, peekSide, peekChatOpen = true, onPeekChat, peekChatWide = false, boardId, conversation }: { editor: Editor; toast(text: string): void; rift: RiftProps; peekExtra?: (frameId: string) => React.ReactNode; peekSide?: (frameId: string) => React.ReactNode; /** Whether the peek's conversation pane is unfolded, and its fold toggle. */ peekChatOpen?: boolean; onPeekChat?(): void; /** The peek's conversation widened for reading (3/4 of the window). */ peekChatWide?: boolean; /** Frames pinned to the screen (desktop): this board's windows. */ boardId?: string; /** A frame's conversation for a window's (folded) chat pane, with its wide state. */ conversation?: (frameId: string, wide: boolean, setWide: (wide: boolean) => void) => React.ReactNode }) {
  const open = useValue(portalOpen);
  const peek = useValue(framePeek);
  useEffect(() => {
    if (boardId) loadScreenPins(boardId);
  }, [boardId]);
  const windows = useValue(screenPins);
  const back = useValue(portalBack);
  const flash = useValue(portalFlash);
  const hover = useValue(portalHover);
  // The open rift's sticky, its portal or its target was deleted: close it.
  const openExists = useValue("portal-open-exists", () => (open ? !!livePortal(editor, editor.getShape(open as TLShapeId)) : true), [editor, open]);
  useEffect(() => {
    if (!openExists) portalOpen.set(null);
  }, [openExists]);
  const peekExists = useValue("frame-peek-exists", () => (peek ? editor.getShape(peek as TLShapeId)?.type === "frame" : true), [editor, peek]);
  // While peeking, the board's own style panel (for its selection) would sit over the
  // peek's conversation: hide it until the peek closes.
  const peeking = !!peek && peekExists && !open;
  useEffect(() => {
    const host = editor.getContainer();
    host.classList.toggle("bunny-peeking", peeking);
    return () => host.classList.remove("bunny-peeking");
  }, [editor, peeking]);
  useEffect(() => {
    if (!peekExists) framePeek.set(null);
  }, [peekExists]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Esc inside the rift first leaves its own editing/selection (PortalRift handles it).
      if (e.key === "Escape" && (portalOpen.get() || framePeek.get()) && !document.querySelector(".bunny-portal-rift.focused") && !document.querySelector('.bunny-portal-rift.peek:not(.window) [data-reading="1"]')) {
        portalOpen.set(null);
        framePeek.set(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const onJump = useCallback(() => {
    const peeked = framePeek.get();
    if (peeked) {
      if (!jumpToFrame(editor, peeked)) toast("This frame was deleted");
      return;
    }
    const id = portalOpen.get();
    if (id && !jumpThrough(editor, id)) toast("This portal's target was deleted");
  }, [editor, toast]);
  const onClose = useCallback(() => {
    portalOpen.set(null);
    framePeek.set(null);
  }, []);
  // While the Back pill shows: the person's own pan or zoom, or BACK_IDLE_MS without
  // input, dismisses it (it would otherwise linger after they have moved on).
  const hasBack = back.length > 0;
  useEffect(() => {
    if (!hasBack) return;
    let idle = setTimeout(clearBack, BACK_IDLE_MS);
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(clearBack, BACK_IDLE_MS);
    };
    const onInput = (info: TLEventInfo) => {
      if (info.type === "keyboard" || (info.type === "pointer" && info.name === "pointer_down")) touch();
    };
    editor.on("event", onInput);
    // Stepping back resets the clock too.
    const stopStack = react("portal-back-stack", () => {
      portalBack.get();
      touch();
    });
    let first = true;
    const stopCamera = react("portal-back-camera", () => {
      editor.getCamera();
      if (first) {
        first = false;
        return;
      }
      if (Date.now() > selfMoveUntil) clearBack();
    });
    return () => {
      clearTimeout(idle);
      editor.off("event", onInput);
      stopStack();
      stopCamera();
    };
  }, [editor, hasBack]);
  // The portal's editor is built once, ahead of time: when the board idles after a portal
  // sticky shows up (or at the latest on the first open), then kept mounted and reused.
  const [warm, setWarm] = useState(false);
  const anyPortal = useValue("portal-any", () => portalNotes(editor).get().length > 0, [editor]);
  useEffect(() => {
    if (warm) return;
    if (open || peek) return setWarm(true);
    if (!anyPortal) return;
    const ric = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) {
      const id = ric(() => setWarm(true), { timeout: 3000 });
      return () => (window as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback?.(id);
    }
    const t = setTimeout(() => setWarm(true), 1500);
    return () => clearTimeout(t);
  }, [warm, open, peek, anyPortal]);
  const lastFrom = back.length && back[back.length - 1].from ? editor.getShape(back[back.length - 1].from as TLShapeId) : undefined;
  const hoverNote = hover ? editor.getShape(hover as TLShapeId) : undefined;
  const hoverPortal = livePortal(editor, hoverNote);
  const hoverBox = hoverPortal ? portalBounds(editor, hoverPortal) : null;
  // Portal UI lives above the canvas's contained shapes, but below canvas-in-front
  // (Bunny panels) and tldraw's menus. Keep these sibling stacking contexts ordered
  // in portals.css so badges and windows cannot cover the start form.
  const layer = usePortalLayer(editor);
  if (!layer) return null;
  return createPortal(
    <>
      <PortalBadges editor={editor} />
      {/* A click on the board behind a peek closes it (capture: before the board's own pointer
          handling, which would otherwise take the click). Screen windows have no scrim. */}
      {peek && peekExists && !open ? (
        <div
          className="bunny-peek-scrim"
          data-testid="peek-scrim"
          onPointerDownCapture={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onClose();
          }}
        />
      ) : null}
      {/* Rendered in a fixed order (moving a live editor's DOM would disturb it); the list's
          order, most recently used last, sets which window is in front. A minimized window
          stays built (hidden, its copy of the board paused), so its pill brings it back at
          once instead of rebuilding an editor and a copy of the whole board. */}
      {boardId
        ? [...windows]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((w) => <ScreenWindow key={w.id} editor={editor} pin={w} z={260 + windows.indexOf(w)} rift={rift} toast={toast} conversation={conversation} />)
        : null}
      {warm ? <PortalRift board={editor} noteId={open && openExists ? open : null} frameId={!open && peek && peekExists ? peek : null} menu={!open && peek && peekExists ? peekExtra?.(peek) : null} side={!open && peek && peekExists ? peekSide?.(peek) : null} sideOpen={peekChatOpen} sideWide={peekChatWide} onSideToggle={onPeekChat} onJump={onJump} onClose={onClose} toast={toast} shapeUtils={rift.shapeUtils} /> : null}
      {back.length ? (
        <div className="bunny-portal-back" data-testid="portal-back-pill" style={tint(portalColor(editor, lastFrom))} onPointerDown={stop}>
          <button type="button" className="bunny-portal-back-go" data-testid="portal-back" onClick={() => jumpBack(editor)} title="Return to where you jumped from">
            <BackIcon /> Back{lastFrom ? ` to “${short(textOf(lastFrom), 24)}”` : ""}
            {back.length > 1 ? <span className="bunny-portal-depth">{back.length}</span> : null}
          </button>
          <button type="button" className="bunny-portal-back-x" data-testid="portal-back-close" onClick={clearBack} title="Dismiss" aria-label="Dismiss">
            ×
          </button>
        </div>
      ) : null}
      {hoverBox && hover !== open ? <PortalRing editor={editor} box={hoverBox} color={portalColor(editor, hoverNote)} testId="portal-hover-ring" /> : null}
      {flash ? <PortalFlash editor={editor} flash={flash} /> : null}
      <PortalToolOverlay editor={editor} />
    </>,
    layer,
  );
}

// A frame pinned to the screen: the peek's live window at its own place and size, with –
// (shrink to its pill) and Recentre in its title chip, and, for a frame with an agent, its
// conversation folded into a strip on the right (the owner's call, over the visual
// standards' "chat stays in the sidebar"). Hidden while its frame is gone (deleted or
// archived), so undo or restore brings it back.
function ScreenWindow({ editor, pin, z, rift, toast, conversation }: { editor: Editor; pin: ScreenPin; z: number; rift: RiftProps; toast(text: string): void; conversation?: (frameId: string, wide: boolean, setWide: (wide: boolean) => void) => React.ReactNode }) {
  const state = useValue(
    `screen-window:${pin.id}`,
    () => {
      const s = editor.getShape(pin.id as TLShapeId);
      if (s?.type !== "frame") return "gone";
      const p = (s.meta as { paseo?: { agentId?: string; request?: unknown } } | undefined)?.paseo;
      return p?.agentId || p?.request ? "bound" : "frame";
    },
    [editor, pin.id],
  );
  const gone = state === "gone";
  // Built the first time it is shown this visit (a window restored minimized costs nothing
  // until opened), then kept: minimizing only hides and pauses it.
  const [built, setBuilt] = useState(!pin.min);
  useEffect(() => {
    if (!pin.min) setBuilt(true);
  }, [pin.min]);
  const onSideToggle = useCallback(() => updateScreenPin(pin.id, { chat: !pin.chat }), [pin.id, pin.chat]);
  const onFront = useCallback(() => frontScreenPin(pin.id), [pin.id]);
  const setWide = useCallback((wide: boolean) => updateScreenPin(pin.id, { wide }), [pin.id]);
  const onJump = useCallback(() => {
    if (!jumpToFrame(editor, pin.id)) toast("This frame was deleted");
  }, [editor, pin.id, toast]);
  const onClose = useCallback(() => removeScreenPin(pin.id), [pin.id]);
  const onRect = useCallback((r: { x: number; y: number; w: number; h: number }) => updateScreenPin(pin.id, r), [pin.id]);
  if (gone || !built) return null;
  const extra = (
    <button type="button" data-testid="screen-window-min" title="Shrink to its pill (bottom of the board)" onClick={() => updateScreenPin(pin.id, { min: true })}>
      –
    </button>
  );
  return <PortalRift board={editor} noteId={null} frameId={pin.min ? null : pin.id} rect={pin} onRect={onRect} extra={extra} side={state === "bound" ? conversation?.(pin.id, pin.wide, setWide) : null} sideOpen={pin.chat} sideWide={pin.wide} onSideToggle={onSideToggle} z={z} onFront={onFront} onJump={onJump} onClose={onClose} toast={toast} shapeUtils={rift.shapeUtils} />;
}

/** A sibling layer above the contained canvas and below canvas-in-front / UI.
 *  The CSS layer order applies to every portal badge, peek and pinned window. */
function usePortalLayer(editor: Editor): HTMLElement | null {
  const [layer, setLayer] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const host = editor.getContainer();
    const el = document.createElement("div");
    el.className = "bunny-portal-layer";
    host.insertBefore(el, host.querySelector(":scope > .tlui-layout"));
    setLayer(el);
    return () => {
      el.remove();
      setLayer(null);
    };
  }, [editor]);
  return layer;
}

// A ring in the portal's colour round its destination (page box → screen).
function PortalRing({ editor, box, color, testId, flash }: { editor: Editor; box: { x: number; y: number; w: number; h: number }; color: string; testId: string; flash?: boolean }) {
  const r = useValue(
    "portal-ring-rect",
    () => {
      const a = editor.pageToViewport({ x: box.x, y: box.y });
      const z = editor.getZoomLevel();
      return { x: a.x, y: a.y, w: box.w * z, h: box.h * z };
    },
    [editor, box.x, box.y, box.w, box.h],
  );
  return (
    <div
      className={`bunny-portal-ring${flash ? " flash" : ""}`}
      data-testid={testId}
      style={{ left: r.x - 8, top: r.y - 8, width: r.w + 16, height: r.h + 16, ...tint(color) }}
    />
  );
}

// The ring after a jump, so the eye lands on the destination; it fades on its own.
function PortalFlash({ editor, flash }: { editor: Editor; flash: { box: { x: number; y: number; w: number; h: number }; at: number; color: string } }) {
  useEffect(() => {
    const t = setTimeout(() => portalFlash.set(null), 2000);
    return () => clearTimeout(t);
  }, [flash.at]);
  return <PortalRing key={flash.at} editor={editor} box={flash.box} color={flash.color} testId="portal-flash" flash />;
}
