import { useId, useState } from "react";
import { createShapeId, useEditor, useValue, type TLImageShape, type TLFrameShape } from "tldraw";
import { layoutLockedHere } from "./locks";
import { B, UI_FONT, fieldLabel, surface } from "./bunnyTheme";
import { Action, UPLOAD_UI_CSS, hintText, nameText } from "./uploadUi";

export function ImageTools({ image }: { image: TLImageShape }) {
  const editor = useEditor();
  const live = useValue("source-image", () => editor.getShape<TLImageShape>(image.id), [editor,image.id]);
  const source = live?.meta.screenshotSource as { name?: string; time?: string; originalId?: string } | undefined;
  const [time, setTime] = useState(source?.time ?? "");
  const uid = useId();
  const locked = useValue("source-image-locked", () => layoutLockedHere(editor) || editor.isShapeOrAncestorLocked(image.id), [editor,image.id]);
  if (!live) return null;
  const originalId = source?.originalId ?? live.id;
  const save = () => {
    if (locked) return;
    const copies = editor.getCurrentPageShapes().filter(s => s.type === "image" && (s.id === originalId || (s.meta.screenshotSource as {originalId?:string})?.originalId === originalId));
    editor.updateShapes(copies.map(s => ({id:s.id,type:"image" as const,meta:{...s.meta,screenshotSource:{...(s.meta.screenshotSource as object ?? {}),name:source?.name ?? live.props.altText,time:time.trim(),originalId}},props:{altText:`${source?.name ?? live.props.altText}${time.trim()?` · ${time.trim()}`:""}`}})));
  };
  const crop = () => {
    if (locked) return;
    save();
    const id = createShapeId();
    const frame = editor.getShapeAncestors(live).slice().reverse().find(s => s.type === "frame") as TLFrameShape | undefined;
    if (frame && (frame.props.w < 60 || frame.props.h < 60)) return;
    const center = editor.getShapePageBounds(live)!.center;
    const point = frame ? editor.getPointInShapeSpace(frame, center) : center;
    const scale = frame ? Math.min(1,(frame.props.w-40)/(live.props.w/2),(frame.props.h-40)/(live.props.h/2)) : 1;
    const w = live.props.w / 2 * scale, h = live.props.h / 2 * scale;
    const x = frame ? Math.max(20,Math.min(point.x+24,frame.props.w-w-20)) : point.x+24;
    const y = frame ? Math.max(20,Math.min(point.y,frame.props.h-h-20)) : point.y;
    // An upright copy has predictable bounds even when the original is rotated.
    editor.createShape({id,type:"image",parentId:frame?.id ?? editor.getCurrentPageId(),x,y,rotation:0,props:{...live.props,w,h,crop:{topLeft:{x:.25,y:.25},bottomRight:{x:.75,y:.75}},altText:`Focus crop · ${source?.name ?? live.props.altText} · ${time.trim()}`},meta:{screenshotSource:{name:source?.name ?? live.props.altText,time:time.trim(),originalId,role:"focus-crop"}}});
    editor.select(id);editor.setCurrentTool("select.crop.idle");
  };
  const isCopy = !!source?.originalId && source.originalId !== live.id;
  const name = source?.name || live.props.altText || "Image";
  const cropHint = locked ? "Unlock the layout to make a crop." : live.props.crop ? "Already a crop. Drag its handles to change it." : "Adds a cropped copy beside it so you can zoom in on a detail. This image is unchanged.";
  return <div data-testid="image-source-tools" className="bunny-fp bfp-pop" aria-label="Screenshot details" onPointerDown={e=>e.stopPropagation()} onKeyDown={e=>e.stopPropagation()} style={{...surface,pointerEvents:"all",position:"absolute",top:100,left:12,zIndex:300,width:"min(340px, calc(100vw - 24px))",boxSizing:"border-box",padding:14,display:"flex",flexDirection:"column",gap:12}}>
    <style>{UPLOAD_UI_CSS}</style>
    <div style={{display:"flex",flexDirection:"column",gap:2}}>
      <span style={fieldLabel}>{isCopy ? "Focus crop" : "Screenshot"}</span>
      <div style={nameText} title={name}>{name}</div>
    </div>
    <label style={{display:"flex",flexDirection:"column",gap:5}}>
      <span style={{font:`600 12px ${UI_FONT}`}}>Source time</span>
      <input className="bup-input" aria-label="Screenshot source time" aria-describedby={`${uid}-time-hint`} placeholder="e.g. Take 12 · 07:42" maxLength={120} value={time} disabled={locked} onChange={e=>setTime(e.target.value)} />
      <span id={`${uid}-time-hint`} style={hintText}>Where the shot comes from, such as the take and timecode.</span>
    </label>
    <div style={{display:"flex",flexDirection:"column",gap:8,paddingTop:10,borderTop:`1px solid ${B.line}`}}>
      <Action id={`${uid}-save`} primary label="Save time" disabled={locked} onClick={save} hint={locked ? "Unlock the layout to edit." : isCopy ? "Saves it on this crop and the original screenshot." : "Saves it on this screenshot and any crops made from it."} />
      <Action id={`${uid}-crop`} testId="image-focus-copy" label="Make focus crop" disabled={locked || !!live.props.crop} onClick={crop} hint={cropHint} />
    </div>
  </div>;
}
