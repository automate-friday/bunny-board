// Tell Bunny → new agent: the screenshots go into the new frame before its agent starts, so
// the agent finds them in its frame (the same placement as a phone photo sent to a bound
// agent, fileDrop.ts sendPhotosToFrame, without the agent upload).

import { AssetRecordType, createShapeId, type Editor, type TLFrameShape } from "tldraw";
import { uploadImage } from "../uploads";

export async function placePhotos(editor: Editor, boardId: string, frameId: string, files: readonly File[]): Promise<number> {
  let placed = 0;
  for (const file of files) {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) continue;
    const uploaded = await uploadImage(boardId, file);
    const target = editor.getShape<TLFrameShape>(frameId as TLFrameShape["id"]);
    if (!target) throw Error("The new frame is gone; the photos were not placed.");
    const kids = editor.getSortedChildIdsForParent(target.id).map((id) => editor.getShape(id)).filter((s): s is NonNullable<typeof s> => !!s);
    const bottom = kids.reduce((y, s) => Math.max(y, s.y + editor.getShapeGeometry(s).bounds.h), 0);
    const scale = Math.min(1, Math.max(60, target.props.w / 3) / uploaded.w);
    const w = uploaded.w * scale, h = uploaded.h * scale;
    const assetId = AssetRecordType.createId();
    editor.run(() => {
      editor.createAssets([{ id: assetId, typeName: "asset", type: "image", props: { name: file.name, src: uploaded.src, w: uploaded.w, h: uploaded.h, mimeType: file.type, isAnimated: file.type === "image/gif" }, meta: {} }]);
      editor.createShape({ id: createShapeId(), type: "image", parentId: target.id, x: 20, y: Math.max(20, Math.min(bottom + 20, target.props.h - h - 20)), props: { assetId, w, h, altText: file.name } });
    });
    placed++;
  }
  return placed;
}
