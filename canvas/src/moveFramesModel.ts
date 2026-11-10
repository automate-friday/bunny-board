// Where frames moved to another page land (moveFrames.ts); pure, for test/move-frames.test.ts.

export const PAGE_GAP = 80;

type Box = { x: number; y: number; w: number; h: number };

const overlaps = (a: Box, b: Box, gap = 0) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

// Where a group of boxes (`moved`, with its overall bounds `at`) goes among `others`: where it
// is when nothing is in the way, else to the right of everything, top-aligned with it.
export function placeAmong(at: Box, others: readonly Box[], gap = PAGE_GAP): { dx: number; dy: number } {
  if (!others.some((o) => overlaps(at, o, gap / 2))) return { dx: 0, dy: 0 };
  const right = Math.max(...others.map((o) => o.x + o.w));
  const top = Math.min(...others.map((o) => o.y));
  return { dx: right + gap - at.x, dy: top - at.y };
}
