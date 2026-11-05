import { AssetRecordType, createShapeId, type Editor, type TLFrameShape, type VecLike } from "tldraw";
import { layoutLockedHere } from "./locks";
import { uploadFrameFile } from "./frameUploads";
import { uploadImage } from "./uploads";

// Capture destination before awaiting storage. Do not let selection/page changes
// redirect a file, and do not create a placeholder which retry could duplicate.
export function handleImageDrop(editor: Editor, boardId: string, point: VecLike, event: React.DragEvent, toast: (text: string) => void, openFrame: (id: string) => void): boolean {
  const files = Array.from(event.dataTransfer.files);
  if (!files.length) return false;
  const contains = (shape: TLFrameShape) => { const p = editor.getPointInShapeSpace(shape, point); return p.x >= 0 && p.y >= 0 && p.x <= shape.props.w && p.y <= shape.props.h; };
  const frame = editor.getCurrentPageShapesSorted().slice().reverse().find((shape): shape is TLFrameShape => shape.type === "frame" && contains(shape) && editor.getShapeAncestors(shape).every(ancestor => ancestor.type !== "frame" || contains(ancestor as TLFrameShape))) ?? null;
  const originalBinding = frame?.meta.paseo as {agentId?: string; host?: string} | undefined;
  const pageId = editor.getCurrentPageId();
  const images = files.filter(file => /^image\/(png|jpeg|gif|webp)$/.test(file.type));
  const contextFiles = files.filter(file => !images.includes(file));
  if (contextFiles.length) {
    const binding = frame?.meta.paseo as {agentId?: string; host?: string} | undefined;
    if (!frame || !binding?.agentId || binding.host) toast("Drop files or recordings inside a frame bound to a local agent. Remote delivery belongs to that host.");
    else {
      const agentId = binding.agentId;
      openFrame(frame.id);
      for (const file of contextFiles) {
        try {
          uploadFrameFile(boardId, frame.id, agentId, file, () => {
            if (editor.isDisposed || layoutLockedHere(editor)) return false;
            const target = editor.getShape<TLFrameShape>(frame.id);
            const current = target?.meta.paseo as {agentId?: string; host?: string} | undefined;
            return !!target && target.type === "frame" && editor.getAncestorPageId(target) === pageId && !editor.isShapeOrAncestorLocked(target) && current?.agentId === agentId && !current.host;
          });
        } catch (error) { toast((error as Error).message); }
      }
    }
  }
  if (!images.length) return true;
  if (frame && (frame.props.w < 60 || frame.props.h < 60)) { toast("Enlarge the destination frame before dropping an image."); return true; }
  if (layoutLockedHere(editor) || (frame && editor.isShapeOrAncestorLocked(frame))) { toast("Unlock the destination before dropping images."); return true; }
  const local = frame ? editor.getPointInShapeSpace(frame, point) : point;
  void (async () => {
    for (const file of images) {
      try {
        const uploaded = await uploadImage(boardId, file);
        if (editor.isDisposed) throw Error("Image stored, but the board was closed before placement.");
        const target = frame ? editor.getShape<TLFrameShape>(frame.id) : null;
        if ((frame && (!target || target.type !== "frame" || editor.getAncestorPageId(target) !== pageId || editor.isShapeOrAncestorLocked(target))) || layoutLockedHere(editor)) throw Error("Image stored, but destination changed or is locked. Drop again after restoring it.");
        if (editor.getCurrentPageId() !== pageId) throw Error("Image stored, but page changed. Return to the destination page and drop again.");
        if (target && (target.props.w < 60 || target.props.h < 60)) throw Error("Image stored, but destination is now too small. Enlarge it and drop again.");
        const bindingNow = target?.meta.paseo as {agentId?: string; host?: string} | undefined;
        if (originalBinding?.agentId && (bindingNow?.agentId !== originalBinding.agentId || bindingNow?.host !== originalBinding.host)) throw Error("Image stored, but original agent binding changed. Nothing placed or sent to a replacement agent.");
        const scale = target ? Math.min(1, Math.max(1, target.props.w - 40) / uploaded.w, Math.max(1, target.props.h - 40) / uploaded.h) : 1;
        const w = uploaded.w * scale, h = uploaded.h * scale;
        const x = target ? Math.max(20, Math.min(local.x, target.props.w - w - 20)) : local.x;
        const y = target ? Math.max(20, Math.min(local.y, target.props.h - h - 20)) : local.y;
        const assetId = AssetRecordType.createId();
        editor.run(() => {
          editor.createAssets([{id:assetId,typeName:"asset",type:"image",props:{name:file.name,src:uploaded.src,w:uploaded.w,h:uploaded.h,mimeType:file.type,isAnimated:file.type==="image/gif"},meta:{}}]);
          editor.createShape({id:createShapeId(),type:"image",parentId:target?.id ?? pageId,x,y,props:{assetId,w,h,altText:file.name},meta:{screenshotSource:{name:file.name,time:""}}});
        });
        if (target && originalBinding?.agentId && !originalBinding.host) {
          const agentId = originalBinding.agentId;
          openFrame(target.id);
          uploadFrameFile(boardId, target.id, agentId, file, () => {
            if (editor.isDisposed || layoutLockedHere(editor)) return false;
            const current = editor.getShape<TLFrameShape>(target.id);
            const binding = current?.meta.paseo as {agentId?: string; host?: string} | undefined;
            return !!current && editor.getAncestorPageId(current) === pageId && !editor.isShapeOrAncestorLocked(current) && binding?.agentId === agentId && !binding.host;
          });
          toast("Image placed. Agent context delivery has its own receipt in the sidebar.");
        } else toast(`Image stored in ${target?.props.name || "this page"}. ${originalBinding?.host ? "Remote image context must be sent on its owning host." : "Bind a local agent for a context receipt."}`);
      } catch (error) { toast((error as Error).message); }
    }
  })();
  return true;
}

// The phone's photo button (ChatComposer attach): each picture goes where a desktop drop on
// the frame sends it. An image is stored and placed in the frame below its content, then
// delivered to the frame's agent as context with its own receipt (uploadFrameFile). Other
// files (an iPhone may hand over HEIC) go to the agent only. Throws when nothing could be
// done, so the reply box keeps the photos and says why.
export async function sendPhotosToFrame(editor: Editor, boardId: string, frameId: string, agentId: string, files: File[]): Promise<void> {
  const frame = editor.getShape<TLFrameShape>(frameId as TLFrameShape["id"]);
  if (!frame || frame.type !== "frame") throw Error("This frame is gone; nothing was sent.");
  const binding = frame.meta.paseo as { agentId?: string; host?: string } | undefined;
  if (binding?.agentId !== agentId || binding.host) throw Error("Photos go to agents on this board's machine; this agent runs elsewhere.");
  const pageId = editor.getAncestorPageId(frame);
  const stillBound = () => {
    if (editor.isDisposed) return false;
    const current = editor.getShape<TLFrameShape>(frame.id);
    const now = current?.meta.paseo as { agentId?: string; host?: string } | undefined;
    return !!current && editor.getAncestorPageId(current) === pageId && now?.agentId === agentId && !now.host;
  };
  for (const file of files) {
    if (/^image\/(png|jpeg|gif|webp)$/.test(file.type)) {
      const uploaded = await uploadImage(boardId, file);
      const target = editor.getShape<TLFrameShape>(frame.id);
      if (!target || !stillBound()) throw Error("Photo stored, but the frame changed; nothing placed or sent.");
      // Below what is already in the frame, at most a third of its width.
      const kids = editor.getSortedChildIdsForParent(target.id).map((id) => editor.getShape(id)).filter((s): s is NonNullable<typeof s> => !!s);
      const bottom = kids.reduce((y, s) => { const b = editor.getShapeGeometry(s).bounds; return Math.max(y, s.y + b.h); }, 0);
      const scale = Math.min(1, Math.max(60, target.props.w / 3) / uploaded.w);
      const w = uploaded.w * scale, h = uploaded.h * scale;
      const x = 20, y = Math.max(20, Math.min(bottom + 20, target.props.h - h - 20));
      const assetId = AssetRecordType.createId();
      editor.run(() => {
        editor.createAssets([{ id: assetId, typeName: "asset", type: "image", props: { name: file.name, src: uploaded.src, w: uploaded.w, h: uploaded.h, mimeType: file.type, isAnimated: file.type === "image/gif" }, meta: {} }]);
        editor.createShape({ id: createShapeId(), type: "image", parentId: target.id, x, y, props: { assetId, w, h, altText: file.name }, meta: { screenshotSource: { name: file.name, time: "" } } });
      });
    }
    uploadFrameFile(boardId, frame.id, agentId, file, stillBound);
  }
}
