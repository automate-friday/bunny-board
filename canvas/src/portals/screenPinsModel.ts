// Frames pinned to the screen: small live windows onto a frame (the peek's window, Portals.tsx)
// that stay open while you move around the board, each with a pill in the bottom dock that
// shrinks it away or brings it back. Per device and board (localStorage): where they sit is
// about this screen. At most SCREEN_PIN_LIMIT; pinning another closes the oldest. `chat`:
// whether its conversation pane is unfolded (folded by default, so the window stays small).

export const SCREEN_PIN_LIMIT = 4;
export type ScreenPin = { id: string; x: number; y: number; w: number; h: number; min: boolean; chat: boolean; /** Conversation widened for reading. */ wide: boolean };

export const screenPinsKey = (board: string) => `bunny-screen-pins:${board}`;
const MIN_W = 260;
const MIN_H = 180;

/** Stored windows, cleaned: shape ids only, once each, sizes at least the minimum, the newest SCREEN_PIN_LIMIT. */
export function cleanScreenPins(v: unknown): ScreenPin[] {
  if (!Array.isArray(v)) return [];
  const num = (n: unknown, d: number) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n) : d);
  const out: ScreenPin[] = [];
  for (const p of v) {
    if (!p || typeof p !== "object" || typeof (p as ScreenPin).id !== "string" || !(p as ScreenPin).id.startsWith("shape:")) continue;
    if (out.some((o) => o.id === (p as ScreenPin).id)) continue;
    const q = p as Partial<ScreenPin>;
    out.push({ id: q.id as string, x: num(q.x, 80), y: num(q.y, 80), w: Math.max(MIN_W, num(q.w, 420)), h: Math.max(MIN_H, num(q.h, 300)), min: q.min === true, chat: q.chat === true, wide: q.wide === true });
  }
  return out.slice(-SCREEN_PIN_LIMIT);
}

/** Where a new window goes: the right side of the view, stacked down from the top. */
export function newSpot(existing: readonly ScreenPin[], view: { w: number; h: number }): Pick<ScreenPin, "x" | "y" | "w" | "h"> {
  const w = Math.min(440, Math.max(MIN_W, Math.round(view.w * 0.32)));
  const h = Math.min(320, Math.max(MIN_H, Math.round(view.h * 0.34)));
  const x = Math.max(8, view.w - w - 24);
  const step = 36;
  let y = 64;
  while (existing.some((p) => !p.min && Math.abs(p.x - x) < 24 && Math.abs(p.y - y) < 24) && y < view.h - h - 80) y += step;
  return { x, y, w, h };
}

/** Pin `id` to the screen (again: bring it up), closing the oldest when SCREEN_PIN_LIMIT are open.
 *  Returns the new list and the frame whose window was closed to make room, if any. */
export function addScreenPin(pins: readonly ScreenPin[], id: string, spot: Pick<ScreenPin, "x" | "y" | "w" | "h">): { pins: ScreenPin[]; dropped: string | null } {
  const had = pins.find((p) => p.id === id);
  if (had) return { pins: pins.map((p) => (p.id === id ? { ...p, min: false } : p)), dropped: null };
  const room = pins.length >= SCREEN_PIN_LIMIT ? pins.slice(1) : [...pins];
  return { pins: [...room, { id, ...spot, min: false, chat: false, wide: false }], dropped: pins.length >= SCREEN_PIN_LIMIT ? pins[0].id : null };
}

/** Keep a window's rectangle on screen and at least its minimum size. */
export function fitRect(r: Pick<ScreenPin, "x" | "y" | "w" | "h">, view: { w: number; h: number }): Pick<ScreenPin, "x" | "y" | "w" | "h"> {
  const w = Math.min(Math.max(MIN_W, Math.round(r.w)), Math.max(MIN_W, view.w - 16));
  const h = Math.min(Math.max(MIN_H, Math.round(r.h)), Math.max(MIN_H, view.h - 16));
  const x = Math.min(Math.max(8 - w + 120, Math.round(r.x)), view.w - 120);
  const y = Math.min(Math.max(8, Math.round(r.y)), view.h - 40);
  return { x, y, w, h };
}

