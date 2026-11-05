// Sticky-note portals: a note can point at another place on the same board, a shape
// (by id) or a page-space area. The link lives in the note's meta (`meta.portal`), so it
// travels with the note through sync, history and archive. The canvas draws a badge on the
// note to jump there (and back), and can expand the note into a live window onto the
// target. Expanded/collapsed is view state and is never stored.

export type PortalTarget = { id: string } | { x: number; y: number; w: number; h: number };

export const PORTAL_MAX_SIZE = 20_000;
const SHAPE_ID_RE = /^shape:[A-Za-z0-9_-]{1,64}$/;

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Validates a portal target given by an agent or a person. Throws a readable error. */
export function parsePortal(input: unknown): PortalTarget {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("portal must be {id} of a shape or a page-space area {x,y,w,h}");
  const o = input as Record<string, unknown>;
  if (o.id !== undefined) {
    if (typeof o.id !== "string" || !SHAPE_ID_RE.test(o.id)) throw new Error("portal.id must be a shape id like shape:abc123");
    if (o.x !== undefined || o.y !== undefined || o.w !== undefined || o.h !== undefined) throw new Error("portal takes either {id} or {x,y,w,h}, not both");
    return { id: o.id };
  }
  const { x, y, w, h } = o;
  if (!num(x) || !num(y) || !num(w) || !num(h)) throw new Error("portal area needs numbers x, y, w and h (page coordinates)");
  if (w <= 0 || h <= 0 || w > PORTAL_MAX_SIZE || h > PORTAL_MAX_SIZE) throw new Error(`portal area w and h must be between 1 and ${PORTAL_MAX_SIZE}`);
  if (Math.abs(x) > 1e6 || Math.abs(y) > 1e6) throw new Error("portal area is too far off the page");
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/** The portal stored on a shape's meta, or null (malformed values read as no portal). */
export function portalOf(shape: { type?: string; meta?: unknown } | null | undefined): PortalTarget | null {
  if (!shape || shape.type !== "note") return null;
  const raw = (shape.meta as { portal?: unknown } | undefined)?.portal;
  if (!raw) return null;
  try {
    return parsePortal(raw);
  } catch {
    return null;
  }
}

export const isAreaPortal = (p: PortalTarget): p is { x: number; y: number; w: number; h: number } => !("id" in p);
