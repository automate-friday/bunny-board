// The phone's placeholder rule (mobile/lod.tsx), kept free of tldraw for the unit tests.
// Most boards keep their real shapes (text included) until far out; only very large boards
// (the ~1,500-shape board the iPhone killed at 0.1x) swap to placeholders at the old 0.3x.
export const LOW_ZOOM = 0.12;
export const FULL_ZOOM = 0.16;
export const LARGE_BOARD_SHAPES = 600;
export const LARGE_LOW_ZOOM = 0.3;
export const LARGE_FULL_ZOOM = 0.4;

// The low/full pair for a page holding `shapes` shapes.
export function zoomLines(shapes: number): { low: number; full: number } {
  return shapes > LARGE_BOARD_SHAPES ? { low: LARGE_LOW_ZOOM, full: LARGE_FULL_ZOOM } : { low: LOW_ZOOM, full: FULL_ZOOM };
}

// `wasLow`: whether the zoom was "low" last time (below the low line, until it is back above
// the full line). Returns the new low state and whether to show the placeholder: when low, or for
// a heavy card (live stream, timers, iframe) while it is culled. `shapes`: the page's shape count.
export function phonePlaceholder(wasLow: boolean, zoom: number, culled: boolean, heavy: boolean, shapes = 0): { low: boolean; placeholder: boolean } {
  const lines = zoomLines(shapes);
  const low = wasLow ? zoom < lines.full : zoom < lines.low;
  return { low, placeholder: low || (heavy && culled) };
}
