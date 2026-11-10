// The Portal tool (bottom toolbar, next to Arrow): lets a person make a portal without an
// agent or the arrow trick.
//   With a sticky selected: pick the tool, then click a shape (a portal to it) or drag a
//     box (a portal to that page area).
//   With no sticky selected: the first click on a sticky picks it as the source; anything
//     else shows "Select a sticky first".
//   Esc (or picking another tool) cancels. The right-click Make/Remove portal stay.
// The tool's state (source, hint, the box being dragged) is in portalTool, drawn by
// <PortalToolOverlay> in the portal layer (Portals.tsx).
import { atom, type Editor, StateNode, type TLShape, type TLShapeId, useValue } from "tldraw";
import type { PortalTarget } from "../../../shared/portal";
import { PortalIcon } from "./icons";
import { setPortal } from "./PortalMenu";
import { flashTarget, portalColor } from "./Portals";

export const PORTAL_TOOL = "portal";

type Area = { x: number; y: number; w: number; h: number };
export const portalTool = atom<{ source: TLShapeId | null; hint: string; area: Area | null } | null>("portal-tool", null);

const HINT_PICK = "Select a sticky first: click the sticky that should open the portal.";
const HINT_TARGET = "Click a shape, or drag a box around an area, to link this sticky to it. Esc cancels.";

function onlyNote(editor: Editor): TLShape | null {
  const s = editor.getOnlySelectedShape();
  return s?.type === "note" ? s : null;
}

export class PortalTool extends StateNode {
  static override id = PORTAL_TOOL;
  private start: { x: number; y: number } | null = null;

  override onEnter() {
    this.editor.setCursor({ type: "cross", rotation: 0 });
    const note = onlyNote(this.editor);
    portalTool.set({ source: note?.id ?? null, hint: note ? HINT_TARGET : HINT_PICK, area: null });
  }
  override onExit() {
    this.start = null;
    portalTool.set(null);
  }
  override onPointerDown() {
    const p = this.editor.inputs.getCurrentPagePoint();
    this.start = { x: p.x, y: p.y };
  }
  override onPointerMove() {
    const st = portalTool.get();
    if (!this.start || !st?.source || !this.editor.inputs.getIsPointing()) return;
    const p = this.editor.inputs.getCurrentPagePoint();
    const s = this.start;
    if (!st.area && Math.hypot(p.x - s.x, p.y - s.y) * this.editor.getZoomLevel() < 6) return;
    portalTool.set({ ...st, area: { x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) } });
  }
  override onPointerUp() {
    const s = this.start;
    this.start = null;
    const st = portalTool.get();
    if (!s || !st) return;
    if (st.area) {
      const a = st.area;
      portalTool.set({ ...st, area: null });
      if (st.source && a.w * this.editor.getZoomLevel() > 8 && a.h * this.editor.getZoomLevel() > 8) this.finish(st.source, { x: Math.round(a.x), y: Math.round(a.y), w: Math.round(a.w), h: Math.round(a.h) });
      return;
    }
    const hit = this.editor.getShapeAtPoint(s, { hitInside: true, hitFrameInside: true, margin: 4 / this.editor.getZoomLevel() });
    if (!st.source) {
      if (hit?.type === "note") {
        this.editor.select(hit.id);
        portalTool.set({ source: hit.id, hint: HINT_TARGET, area: null });
      } else portalTool.set({ ...st, hint: HINT_PICK });
      return;
    }
    if (!hit || hit.id === st.source) {
      portalTool.set({ ...st, hint: HINT_TARGET });
      return;
    }
    this.finish(st.source, { id: hit.id });
  }
  override onCancel() {
    this.editor.setCurrentTool("select");
  }
  override onInterrupt() {
    this.start = null;
    const st = portalTool.get();
    if (st) portalTool.set({ ...st, area: null });
  }

  private finish(source: TLShapeId, target: PortalTarget) {
    const editor = this.editor;
    editor.run(() => setPortal(editor, source, target));
    editor.setCurrentTool("select");
    editor.select(source);
    flashTarget(editor, source);
  }
}

export const PortalToolIcon = () => <PortalIcon size={18} />;

// The hint and the box being dragged.
export function PortalToolOverlay({ editor }: { editor: Editor }) {
  const st = useValue(portalTool);
  const color = useValue("portal-tool-color", () => {
    const id = portalTool.get()?.source;
    return portalColor(editor, id ? editor.getShape(id) : undefined);
  }, [editor]);
  const rect = useValue(
    "portal-tool-area",
    () => {
      const a = portalTool.get()?.area;
      if (!a) return null;
      const p = editor.pageToViewport({ x: a.x, y: a.y });
      const z = editor.getZoomLevel();
      return { x: p.x, y: p.y, w: a.w * z, h: a.h * z };
    },
    [editor],
  );
  if (!st) return null;
  const style = { "--portal": color } as React.CSSProperties;
  return (
    <>
      <div className={`bunny-portal-tool-hint${st.source ? " ready" : ""}`} data-testid="portal-tool-hint" style={style}>
        <PortalIcon size={16} />
        <span>{st.hint}</span>
      </div>
      {rect ? <div className="bunny-portal-tool-area" data-testid="portal-tool-area" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, ...style }} /> : null}
    </>
  );
}
