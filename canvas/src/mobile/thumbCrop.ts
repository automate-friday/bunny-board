// The part of a frame a phone tile shows (LiveThumb), kept free of tldraw for the unit tests.
export type Box = { x: number; y: number; w: number; h: number };
// The part of a frame a w x h tile shows: its contents (not the empty frame around them) with a
// little margin, widened or deepened to the tile's shape and kept inside the frame where it fits.
export function cropBox(frame: Box, content: Box | null, w: number, h: number): Box {
  const pad = 16;
  let x0 = frame.x, y0 = frame.y, x1 = frame.x + frame.w, y1 = frame.y + frame.h;
  if (content?.w && content.h) {
    x0 = Math.max(x0, content.x - pad);
    y0 = Math.max(y0, content.y - pad);
    x1 = Math.min(x1, content.x + content.w + pad);
    y1 = Math.min(y1, content.y + content.h + pad);
    if (x1 - x0 < 1 || y1 - y0 < 1) [x0, y0, x1, y1] = [frame.x, frame.y, frame.x + frame.w, frame.y + frame.h];
  }
  const aspect = w / h;
  let cw = x1 - x0, ch = y1 - y0;
  // Wide content: deepen downwards (reading order); tall content: widen around the middle.
  let cx = x0, cy = y0;
  if (cw / ch < aspect) {
    const nw = ch * aspect;
    cx = x0 - (nw - cw) / 2;
    cw = nw;
  } else ch = cw / aspect;
  // Never past the frame (nothing there but page): shrink to fit, keeping the tile's shape,
  // from the content's top-left (where reading starts).
  const shrink = Math.min(1, frame.w / cw, frame.h / ch);
  if (shrink < 1) {
    cx = Math.max(cx, x0);
    cw *= shrink;
    ch *= shrink;
  }
  const fit = (at: number, size: number, lo: number, len: number) => (size >= len ? lo + (len - size) / 2 : Math.min(Math.max(at, lo), lo + len - size));
  return { x: fit(cx, cw, frame.x, frame.w), y: fit(cy, ch, frame.y, frame.h), w: cw, h: ch };
}
