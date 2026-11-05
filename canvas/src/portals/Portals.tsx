// Sticky-note portals (shared/portal.ts). A note whose meta.portal points at a shape or a
// page area gets one portal button in the sticky's own colour. It opens the portal: a
// window under the sticky through which the target is live and editable (PortalRift.tsx:
// a second editor on the same board, so every click, move, edit and new shape lands on the
// real content). "Jump there" in the portal moves the camera to the target, and a "Back"
// pill returns to exactly where you were, through a stack of jumps. Hovering the button
// rings the destination. Only one rift is open at a time, and it is view state only: a DOM overlay,
// never a shape, so it is not saved, synced or counted as overlap.
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { atom, Box, type Editor, getColorValue, type TLShape, type TLShapeId, type TLAnyShapeUtilConstructor, useValue } from "tldraw";
import { isAreaPortal, type PortalTarget, portalOf } from "../../../shared/portal";
import { PortalRift } from "./PortalRift";
import "./portals.css";

type Cam = { x: number; y: number; z: number };
export const portalOpen = atom<string | null>("portal-open", null);
export const portalBack = atom<Array<{ cam: Cam; from: string }>>("portal-back", []);
const portalFlash = atom<{ box: { x: number; y: number; w: number; h: number }; at: number; color: string } | null>("portal-flash", null);
const portalHover = atom<string | null>("portal-hover", null);

const ANIM = { animation: { duration: 420 } };

/** Page bounds of a portal's target, or null when the target shape is gone. */
export function portalBounds(editor: Editor, p: PortalTarget): Box | null {
  if (isAreaPortal(p)) return new Box(p.x, p.y, p.w, p.h);
  const s = editor.getShape(p.id as TLShapeId);
  return s ? (editor.getShapePageBounds(s.id) ?? null) : null;
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

const short = (t: string, n = 32) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/** "frame “Overflow”", "sticky “…” in “Overflow”", "area in “Overflow”". */
export function portalLabel(editor: Editor, p: PortalTarget): string {
  const frameAt = (b: Box) => {
    let hit: TLShape | undefined;
    for (const s of editor.getCurrentPageShapes()) {
      if (s.type !== "frame") continue;
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
  const p = portalOf(note);
  const b = p && portalBounds(editor, p);
  if (!b) return false;
  const cam = editor.getCamera();
  portalBack.set([...portalBack.get(), { cam: { x: cam.x, y: cam.y, z: cam.z }, from: noteId }].slice(-20));
  portalOpen.set(null);
  portalHover.set(null);
  editor.zoomToBounds(b, { ...ANIM, inset: 80, targetZoom: 1 });
  portalFlash.set({ box: { x: b.x, y: b.y, w: b.w, h: b.h }, at: Date.now(), color: portalColor(editor, note) });
  return true;
}

export function jumpBack(editor: Editor): void {
  const stack = portalBack.get();
  const last = stack[stack.length - 1];
  if (!last) return;
  portalBack.set(stack.slice(0, -1));
  editor.setCamera(last.cam, ANIM);
}

// --- icons -------------------------------------------------------------------------------
const Icon = ({ d, size = 14 }: { d: React.ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
);
/** A portal swirl: three arms spiralling into a bright core. */
export const PortalIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true" className="bunny-portal-swirl">
    <path d="M12 12c0-2.4 1.9-4 4.2-3.6 2.8.5 4 3.6 2.8 6.4-1.6 3.6-6.2 4.9-9.8 3.2" />
    <path d="M12 12c2.1 1.2 2.6 3.6 1.1 5.4-1.8 2.2-5.1 2.1-7.3-.1-2.8-2.8-2.3-7.5.9-10" />
    <path d="M12 12c-2.1-1.2-2.4-3.7-.6-5.3 2.1-1.9 5.4-1.4 7.2 1.1" opacity="0.7" />
    <circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none" />
  </svg>
);
const BackIcon = () => <Icon d={<path d="M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />} />;

// --- badges on stickies -------------------------------------------------------------------
type Badge = { id: string; x: number; y: number; ok: boolean; label: string; color: string };

// Recomputed on every camera move, so it returns a string: an unchanged list (a board edit
// elsewhere, typing in the rift) does not re-render anything.
function useBadges(editor: Editor): Badge[] {
  const json = useValue(
    "portal-badges",
    () => {
      const vp = editor.getViewportPageBounds();
      const z = editor.getZoomLevel();
      const out: Badge[] = [];
      for (const s of editor.getCurrentPageShapes()) {
        const p = portalOf(s);
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

export function Portals({ editor, toast, rift }: { editor: Editor; toast(text: string): void; rift: RiftProps }) {
  const open = useValue(portalOpen);
  const back = useValue(portalBack);
  const flash = useValue(portalFlash);
  const hover = useValue(portalHover);
  // The open rift's sticky was deleted or lost its portal: close it.
  const openExists = useValue("portal-open-exists", () => (open ? !!portalOf(editor.getShape(open as TLShapeId)) : true), [editor, open]);
  useEffect(() => {
    if (!openExists) portalOpen.set(null);
  }, [openExists]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Esc inside the rift first leaves its own editing/selection (PortalRift handles it).
      if (e.key === "Escape" && portalOpen.get() && !document.querySelector(".bunny-portal-rift.focused")) portalOpen.set(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const onJump = useCallback(() => {
    const id = portalOpen.get();
    if (id && !jumpThrough(editor, id)) toast("This portal's target was deleted");
  }, [editor, toast]);
  const onClose = useCallback(() => portalOpen.set(null), []);
  // The portal's editor is built once, ahead of time: when the board idles after a portal
  // sticky shows up (or at the latest on the first open), then kept mounted and reused.
  const [warm, setWarm] = useState(false);
  const anyPortal = useValue("portal-any", () => editor.getCurrentPageShapes().some((s) => !!portalOf(s)), [editor]);
  useEffect(() => {
    if (warm) return;
    if (open) return setWarm(true);
    if (!anyPortal) return;
    const ric = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) {
      const id = ric(() => setWarm(true), { timeout: 3000 });
      return () => (window as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback?.(id);
    }
    const t = setTimeout(() => setWarm(true), 1500);
    return () => clearTimeout(t);
  }, [warm, open, anyPortal]);
  const lastFrom = back.length ? editor.getShape(back[back.length - 1].from as TLShapeId) : undefined;
  const hoverNote = hover ? editor.getShape(hover as TLShapeId) : undefined;
  const hoverPortal = portalOf(hoverNote);
  const hoverBox = hoverPortal ? portalBounds(editor, hoverPortal) : null;
  return (
    <>
      <PortalBadges editor={editor} />
      {warm ? <PortalRift board={editor} noteId={open && openExists ? open : null} onJump={onJump} onClose={onClose} toast={toast} shapeUtils={rift.shapeUtils} /> : null}
      {back.length ? (
        <button
          type="button"
          className="bunny-portal-back"
          data-testid="portal-back"
          style={tint(portalColor(editor, lastFrom))}
          onPointerDown={stop}
          onClick={() => jumpBack(editor)}
          title="Return to where you jumped from"
        >
          <BackIcon /> Back{lastFrom ? ` to “${short(textOf(lastFrom), 24)}”` : ""}
          {back.length > 1 ? <span className="bunny-portal-depth">{back.length}</span> : null}
        </button>
      ) : null}
      {hoverBox && hover !== open ? <PortalRing editor={editor} box={hoverBox} color={portalColor(editor, hoverNote)} testId="portal-hover-ring" /> : null}
      {flash ? <PortalFlash editor={editor} flash={flash} /> : null}
    </>
  );
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
