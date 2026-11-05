// How an active channel's badge shows (Channels.tsx), from the zoom and its arrow's size on
// screen. Full controls ("Channel · n receipts", "Remove channel") only on a desktop canvas at a
// working zoom and with room for them; otherwise a small ⇄ badge that fits inside the arrow's
// box on screen (so it scales with the canvas), or nothing when even that does not fit. The
// phone shell never shows the full controls: they covered the board overview.

export const FULL_BADGE_ZOOM = 0.5;
export const DOT_MAX = 22;
export const DOT_MIN = 10;

export function channelBadge(o: { mobile: boolean; zoom: number; w: number; h: number }): { mode: "full" } | { mode: "dot"; size: number } | { mode: "none" } {
  if (!o.mobile && o.zoom >= FULL_BADGE_ZOOM) return { mode: "full" };
  const room = Math.min(Math.max(o.w, o.h), DOT_MAX);
  return room >= DOT_MIN ? { mode: "dot", size: Math.round(room) } : { mode: "none" };
}
