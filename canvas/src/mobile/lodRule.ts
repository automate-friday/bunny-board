// The phone's placeholder rule (mobile/lod.tsx), kept free of tldraw for the unit tests.
export const LOW_ZOOM = 0.3;
export const FULL_ZOOM = 0.4;

// `wasLow`: whether the zoom was "low" last time (below LOW_ZOOM, until it is back above
// FULL_ZOOM). Returns the new low state and whether to show the placeholder: when low, or for
// a heavy card (live stream, timers, iframe) while it is culled.
export function phonePlaceholder(wasLow: boolean, zoom: number, culled: boolean, heavy: boolean): { low: boolean; placeholder: boolean } {
  const low = wasLow ? zoom < FULL_ZOOM : zoom < LOW_ZOOM;
  return { low, placeholder: low || (heavy && culled) };
}
