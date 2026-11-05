import { perfCount } from "./perf";
import { useEffect } from "react";
import { type Editor, type TLFrameShape, type TLEventInfo, type TLShapeId, useEditor, useValue } from "tldraw";
import { layoutLockedHere } from "./locks";
import { pageFrames } from "./pageFrames";

type Review = { status: "done"; region: string; previousMode: string; at: string };
const reviewOf = (frame: TLFrameShape) => frame.meta.reviewState as Review | undefined;
const isZone = (frame: TLFrameShape) => (frame.meta.reviewZone as { kind?: string } | undefined)?.kind === "lgtm";
const paseoOf = (frame: TLFrameShape) => (frame.meta.paseo ?? {}) as Record<string, unknown>;
const NO_BADGES: { frame: TLFrameShape; point: { x: number; y: number } | null }[] = [];

export function ReviewTools({ frame }: { frame: TLFrameShape }) {
  const editor = useEditor();
  const locked = useValue("review-tools-lock", () => layoutLockedHere(editor) || editor.isShapeOrAncestorLocked(frame), [editor, frame]);
  const review = reviewOf(frame), paseo = paseoOf(frame);
  const toggleZone = () => { const live = editor.getShape<TLFrameShape>(frame.id); if (!live || locked) return; editor.updateShape({ id: live.id, type: "frame", meta: { ...live.meta, reviewZone: isZone(live) ? null : { kind: "lgtm" } } }); };
  const reopen = () => { const live = editor.getShape<TLFrameShape>(frame.id); if (!live || locked) return; const r = reviewOf(live); if (!r) return; editor.updateShape({ id: live.id, type: "frame", meta: { ...live.meta, reviewState: null, paseo: { ...paseoOf(live), mode: r.previousMode } } }); };
  return <>
    {!paseo.agentId && !review ? <button type="button" data-testid="review-zone-toggle" disabled={locked} onClick={toggleZone}>{isZone(frame) ? "Remove LGTM tag" : "Tag as LGTM area"}</button> : null}
    {isZone(frame) ? <span data-testid="review-zone-label">LGTM area · drop finished frames here</span> : null}
    {review ? <span data-testid="review-done">Done · {paseo.mode === "manual" ? "deltas paused (manual)" : `deltas ${paseo.mode ?? "live"} (changed)`} <button type="button" data-testid="review-reopen" disabled={locked} onClick={reopen}>Reopen · restore prior delta mode</button></span> : null}
  </>;
}

export function ReviewRegions({ editor }: { editor: Editor }) {
  const frames = useValue("review-regions", () => (perfCount("review-regions"), pageFrames(editor).get()), [editor]);
  // No zone or done frame (the usual case): the same empty list, and no camera dependency.
  const badges = useValue("review-badge-positions", () => { perfCount("review-badge-positions"); const marked = frames.filter(f => isZone(f) || reviewOf(f)); if (!marked.length) return NO_BADGES; editor.getCamera(); return marked.map(f => { const b = editor.getShapePageBounds(f); return { frame: f, point: b ? editor.pageToScreen({ x: b.x, y: b.y + 8 }) : null }; }); }, [editor, frames]);
  useEffect(() => {
    let gesturePage: string | null = null;
    const onEvent = (event: TLEventInfo) => {
      if (event.name === "cancel" || event.name === "interrupt" || event.type === "pinch" || (event.type === "keyboard" && event.name === "key_down" && event.code === "Escape")) { gesturePage = null; return; }
      if (event.type !== "pointer") return;
      if (event.name === "pointer_down") { gesturePage = editor.getCurrentPageId(); return; }
      if (event.name !== "pointer_up") return;
      const page = gesturePage; gesturePage = null;
      if (!page || page !== editor.getCurrentPageId() || !editor.isIn("select.translating")) return;
      const ids = editor.getSelectedShapes().filter(s => s.type === "frame").map(s => s.id);
      queueMicrotask(() => {
        if (editor.isDisposed || page !== editor.getCurrentPageId() || layoutLockedHere(editor)) return;
        const zones = editor.getCurrentPageShapes().filter((s): s is TLFrameShape => s.type === "frame" && isZone(s));
        for (const id of ids) {
          const f = editor.getShape<TLFrameShape>(id);
          if (!f || f.type !== "frame" || editor.getAncestorPageId(f) !== page || isZone(f) || reviewOf(f) || editor.isShapeOrAncestorLocked(f)) continue;
          const corners = editor.getShapePageTransform(f).applyToPoints([{x:0,y:0},{x:f.props.w,y:0},{x:f.props.w,y:f.props.h},{x:0,y:f.props.h}]);
          const zone = zones.find(z => z.id !== f.id && editor.getAncestorPageId(z) === page && !editor.hasAncestor(z, f.id) && !editor.isShapeOrAncestorLocked(z) && [z, ...editor.getShapeAncestors(z).filter((a): a is TLFrameShape => a.type === "frame")].every(clip => corners.every(point => { const p = editor.getPointInShapeSpace(clip, point); return p.x >= 0 && p.y >= 0 && p.x <= clip.props.w && p.y <= clip.props.h; })));
          if (!zone) continue;
          const paseo = paseoOf(f);
          editor.updateShape({ id: f.id, type: "frame", meta: { ...f.meta, reviewState: { status: "done", region: zone.id, previousMode: paseo.mode === "manual" || paseo.mode === "on-demand" ? paseo.mode : "live", at: new Date().toISOString() }, paseo: { ...paseo, mode: "manual" } } });
        }
      });
    };
    editor.on("before-event", onEvent);
    return () => { editor.off("before-event", onEvent); };

  }, [editor]);
  return <>{badges.map(({frame,point}) => point ? <div key={frame.id} data-testid={isZone(frame) ? "lgtm-area-badge" : "done-frame-badge"} style={{ position:"fixed",left:point.x+8,top:point.y,pointerEvents:"none",background:isZone(frame)?"#e8e9ff":"#e3f2df",border:"1px solid #789476",borderRadius:5,padding:"3px 6px",font:"12px system-ui",zIndex:220 }}>{isZone(frame) ? "LGTM area" : `Done · ${paseoOf(frame).mode === "manual" ? "deltas paused" : "delta mode changed"}`}</div> : null)}</>;
}
