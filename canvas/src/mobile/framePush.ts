// Phone shell: moving and resizing whole frames, and making room for them ("I have a board
// that could use some more space but it's hemmed in by other ones"). The pure parts, unit-tested
// in test/mobile-frame-push.test.ts; the gestures are in editGestures.ts, the chip in AddSheet.tsx.

import { FRAME_GAP } from "./placement";

export { FRAME_GAP };

export type FrameBox = { id: string; x: number; y: number; w: number; h: number };
type Box = { x: number; y: number; w: number; h: number };

// Two boxes closer than `gap` (0: overlapping; edges that only touch do not).
export const crowds = (a: Box, b: Box, gap = 0) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

// The neighbours the held frame overlaps now (their outline, and the "Push neighbours aside" chip).
export function overlappingFrames<T extends FrameBox>(held: Box & { id: string }, others: readonly T[]): T[] {
  return others.filter((o) => o.id !== held.id && crowds(held, o));
}

// "Push neighbours aside": the frames the held one overlaps move right or down, whichever is the
// smaller shift, just far enough to leave `gap` between them (the gap Start agent leaves between
// frames, placement.ts). A frame pushed onto another pushes that one in turn, and so on. The
// held frame never moves; frames that were already crowded but untouched stay where they are.
// Returns the shift (page units) of every frame that moves.
export function pushAside(held: FrameBox, others: readonly FrameBox[], gap = FRAME_GAP, limit = 5000): Map<string, { dx: number; dy: number }> {
  const at = new Map<string, FrameBox>();
  for (const o of others) if (o.id !== held.id) at.set(o.id, { ...o });
  const start = new Map([...at].map(([id, b]) => [id, { x: b.x, y: b.y }]));
  // Closer than the gap (half a unit of slack, so a frame pushed exactly to the gap is clear).
  const near = (a: Box, b: Box) => crowds(a, b, gap - 0.5);
  const queue: [FrameBox, string][] = overlappingFrames(held, [...at.values()]).map((o) => [held, o.id]);
  let steps = 0;
  while (queue.length && steps++ < limit) {
    const [by, id] = queue.shift() as [FrameBox, string];
    const o = at.get(id);
    if (!o || !near(by, o)) continue;
    const dx = Math.ceil(by.x + by.w + gap - o.x);
    const dy = Math.ceil(by.y + by.h + gap - o.y);
    if (dx <= dy) o.x += dx;
    else o.y += dy;
    // Pushed into the held frame from its left or top: the held frame pushes it on.
    if (near(held, o)) queue.push([held, o.id]);
    for (const q of at.values()) if (q.id !== o.id && near(o, q)) queue.push([o, q.id]);
  }
  const out = new Map<string, { dx: number; dy: number }>();
  for (const [id, b] of at) {
    const s = start.get(id) as { x: number; y: number };
    if (b.x !== s.x || b.y !== s.y) out.set(id, { dx: b.x - s.x, dy: b.y - s.y });
  }
  return out;
}
