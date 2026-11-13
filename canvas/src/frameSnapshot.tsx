// The canvas side of board_snapshot (server/frame-snapshots.ts): the server asks every open
// canvas for a picture of a frame, for the frame's agent; this draws it and posts the PNG.
//
// The frame is drawn in a hidden off-screen editor from a copy of its records (TldrawImage,
// as History's overlay and the Archive preview do), not exported from the board the person
// is using: tldraw only exports shapes on the current page, the phone shell hides most
// shapes, and an export from the live editor copies styles on the main thread while the
// person works. So a snapshot works whichever page or phone view the person is on.

import { createRoot } from "react-dom/client";
import { Box, type Editor, type TLAnyShapeUtilConstructor, type TLShapeId, TldrawImage } from "tldraw";
import { isSnapshotRequest, MAX_SNAPSHOT_BYTES, type SnapshotRequest, snapshotScale } from "../../shared/frame-snapshot";
import { TLDRAW_LICENSE_KEY } from "./tldraw-license";

type Rec = { id: string; typeName: string; [key: string]: unknown };
type Responder = (request: SnapshotRequest) => void;
let responder: Responder | null = null;

// The sync client's custom-message handler (App.tsx, cachedSync.ts). Other messages are not ours.
export function onBoardMessage(data: unknown): void {
  if (isSnapshotRequest(data)) responder?.(data);
}

const PAGE = "page:snapshot";
// Room above the frame for its title, as the person sees it.
const TITLE = 36;
const RENDER_TIMEOUT_MS = 8000;

// The frame, everything in it, the assets its images use and the bindings between its
// shapes, as a store snapshot with the frame alone on one page at the origin.
export function frameSnapshotRecords(editor: Editor, frameId: string): { store: Record<string, Rec>; w: number; h: number } | null {
  const frame = editor.getShape(frameId as TLShapeId);
  if (!frame || frame.type !== "frame") return null;
  const store: Record<string, Rec> = {
    "document:document": { id: "document:document", typeName: "document", gridSize: 10, name: "", meta: {} },
    [PAGE]: { id: PAGE, typeName: "page", name: "Snapshot", index: "a1", meta: {} },
  };
  const ids = editor.getShapeAndDescendantIds([frame.id]);
  for (const id of ids) {
    const shape = editor.getShape(id);
    if (!shape) continue;
    store[id] = shape as unknown as Rec;
    const assetId = (shape.props as { assetId?: string | null }).assetId;
    const asset = assetId ? (editor.store.get(assetId as never) as unknown as Rec | undefined) : undefined;
    if (asset) store[asset.id] = asset;
  }
  for (const r of editor.store.allRecords()) {
    if (r.typeName !== "binding") continue;
    const b = r as unknown as { id: string; fromId: TLShapeId; toId: TLShapeId };
    if (ids.has(b.fromId) && ids.has(b.toId)) store[b.id] = r as unknown as Rec;
  }
  store[frame.id] = { ...(frame as unknown as Rec), parentId: PAGE, x: 0, y: 0, rotation: 0 };
  const props = frame.props as { w: number; h: number };
  return { store, w: props.w, h: props.h };
}

// Draw the frame (or one area of it) to a PNG whose long edge is at most request.maxEdge.
export async function renderFrameSnapshot(editor: Editor, shapeUtils: readonly TLAnyShapeUtilConstructor[], request: SnapshotRequest, maxEdge = request.maxEdge): Promise<Blob | null> {
  const copy = frameSnapshotRecords(editor, request.frameId);
  if (!copy) return null;
  const a = request.area;
  const bounds = a ? new Box(a.x, a.y, a.w, a.h) : new Box(-8, -TITLE, copy.w + 16, copy.h + TITLE + 8);
  const scale = snapshotScale(bounds.w, bounds.h, maxEdge);
  const holder = document.createElement("div");
  holder.setAttribute("data-testid", "frame-snapshot-render");
  holder.style.cssText = `position:fixed;left:-100000px;top:0;width:${Math.ceil(bounds.w * scale)}px;height:${Math.ceil(bounds.h * scale)}px;overflow:hidden;pointer-events:none;opacity:0`;
  document.body.appendChild(holder);
  const root = createRoot(holder);
  try {
    const snapshot = { store: copy.store, schema: editor.store.schema.serialize() };
    root.render(<TldrawImage licenseKey={TLDRAW_LICENSE_KEY} snapshot={snapshot as never} shapeUtils={shapeUtils} pageId={PAGE as never} darkMode={editor.user.getIsDarkMode()} bounds={bounds} scale={scale} padding={0} format="png" background />);
    // TldrawImage shows an <img> with a blob URL once its export is done.
    const src = await new Promise<string | null>((resolve) => {
      const found = () => holder.querySelector("img")?.getAttribute("src") ?? null;
      const seen = new MutationObserver(() => {
        const url = found();
        if (url) finish(url);
      });
      const timer = setTimeout(() => finish(null), RENDER_TIMEOUT_MS);
      const finish = (url: string | null) => {
        clearTimeout(timer);
        seen.disconnect();
        resolve(url);
      };
      seen.observe(holder, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
      const now = found();
      if (now) finish(now);
    });
    if (!src) return null;
    return await (await fetch(src)).blob();
  } finally {
    root.unmount();
    holder.remove();
  }
}

// Answer the server's snapshot requests for this board while this canvas is open. One at a
// time; a tab in the background waits a moment so a visible one answers first (the server
// takes the first picture and refuses the rest).
export function installSnapshotResponder(editor: Editor, boardId: string, shapeUtils: readonly TLAnyShapeUtilConstructor[]): () => void {
  let queue: Promise<unknown> = Promise.resolve();
  const answer = async (request: SnapshotRequest) => {
    if (document.visibilityState === "hidden") await new Promise((r) => setTimeout(r, 1500));
    if (editor.isDisposed) return;
    let blob = await renderFrameSnapshot(editor, shapeUtils, request);
    // A dense frame can exceed the upload limit: once more at half the size.
    if (blob && blob.size > MAX_SNAPSHOT_BYTES) blob = await renderFrameSnapshot(editor, shapeUtils, request, request.maxEdge / 2);
    if (!blob || blob.size > MAX_SNAPSHOT_BYTES) return;
    const url = `/api/ui/boards/${encodeURIComponent(boardId)}/frames/${encodeURIComponent(request.frameId)}/snapshot?request=${encodeURIComponent(request.requestId)}&dark=${editor.user.getIsDarkMode() ? 1 : 0}`;
    // 409 = another canvas answered first, or the agent stopped waiting: nothing to do.
    await fetch(url, { method: "POST", headers: { "content-type": "image/png" }, body: blob });
  };
  const mine: Responder = (request) => {
    queue = queue.then(() => answer(request)).catch(() => undefined);
  };
  responder = mine;
  return () => {
    if (responder === mine) responder = null;
  };
}
