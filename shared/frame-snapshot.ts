// Frame snapshots (board_snapshot): the message the server sends to connected canvases
// asking one of them to draw a frame, and the sizes both sides agree on. The server cannot
// draw a board itself (no browser, no fonts), so a person's open canvas does it and posts
// the PNG back (server/frame-snapshots.ts, canvas/src/frameSnapshot.tsx).

export const SNAPSHOT_MESSAGE = "bunny:frame-snapshot";
// Long edge of the picture in pixels: larger is downscaled by vision models anyway.
export const SNAPSHOT_MAX_EDGE = 1568;
// A frame's PNG at that size is normally well under 1 MB; base64 of this fits a 5 MB image limit.
export const MAX_SNAPSHOT_BYTES = 3 * 1024 * 1024;

// A part of the frame, in frame-relative coordinates (as board_read prints them).
export interface SnapshotArea { x: number; y: number; w: number; h: number }
export interface SnapshotRequest { type: typeof SNAPSHOT_MESSAGE; requestId: string; frameId: string; area: SnapshotArea | null; maxEdge: number }

export function isSnapshotRequest(data: unknown): data is SnapshotRequest {
  const d = data as Partial<SnapshotRequest> | null;
  return !!d && typeof d === "object" && d.type === SNAPSHOT_MESSAGE && typeof d.requestId === "string" && typeof d.frameId === "string" && typeof d.maxEdge === "number";
}

// The export scale for a w x h region drawn at `pixelRatio` device pixels per unit, so the
// picture's long edge is at most maxEdge. Never above 1: small frames are not enlarged.
export function snapshotScale(w: number, h: number, maxEdge = SNAPSHOT_MAX_EDGE, pixelRatio = 2): number {
  const long = Math.max(w, h, 1);
  return Math.min(1, maxEdge / (long * pixelRatio));
}

// The requested area clamped to the frame; null (the whole frame) when it is absent, and an
// error string when it is malformed or lies outside the frame.
export function clampArea(area: unknown, frameW: number, frameH: number): SnapshotArea | null | string {
  if (area === undefined || area === null) return null;
  const a = area as Partial<SnapshotArea>;
  if (typeof a !== "object" || ![a.x, a.y, a.w, a.h].every((n) => typeof n === "number" && Number.isFinite(n))) return "area needs numbers {x, y, w, h} (frame-relative, as board_read prints them)";
  const x = Math.max(0, a.x as number), y = Math.max(0, a.y as number);
  const w = Math.min(frameW, (a.x as number) + (a.w as number)) - x, h = Math.min(frameH, (a.y as number) + (a.h as number)) - y;
  if (w < 20 || h < 20) return `area lies outside your frame (${Math.round(frameW)}x${Math.round(frameH)}) or is under 20 px`;
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}
