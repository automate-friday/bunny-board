// The pin rules (pins.ts has the hooks): a few hand-picked frames per board, kept in the
// board's tldraw document record so every device sees the same ones.
export const PIN_LIMIT = 8;
export const PINS_DOC = "document:document";

function cleanPins(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return [...new Set(v.filter((x): x is string => typeof x === "string" && x.startsWith("shape:")))].slice(0, PIN_LIMIT);
}

/** The board's pins, or null when the board has never stored any (so a device's old
 *  local pins may move in). */
export function boardPins(editor: { store: { get(id: never): unknown } }): string[] | null {
  return cleanPins((editor.store.get(PINS_DOC as never) as { meta?: { bunnyPins?: unknown } } | undefined)?.meta?.bunnyPins);
}

/** The document record with `pins` stored (cleaned and capped). */
export function withPins<T extends { meta?: object }>(doc: T, pins: readonly string[]): T {
  return { ...doc, meta: { ...doc.meta, bunnyPins: cleanPins(pins) ?? [] } };
}

/** The result of a pin change: the new pins, and the pin that made room (if any). */
export type PinChange = { pins: string[]; evicted: string | null };

/** The pin used least recently (by `lastUsed`, frame id → time), the earliest pinned on a
 *  tie or when nothing is known: the one a full set gives up for a new pin. */
export function leastUsedPin(pins: readonly string[], lastUsed: ReadonlyMap<string, number>): string | null {
  let pick: string | null = null;
  let at = Infinity;
  for (const p of pins) {
    const t = lastUsed.get(p) ?? -Infinity;
    if (t < at) {
      at = t;
      pick = p;
    }
  }
  return pick;
}

/** Pin or unpin `id`. Pinning when PIN_LIMIT are pinned unpins the least used pin to make
 *  room (it is never refused). */
export function togglePin(pins: readonly string[], id: string, lastUsed: ReadonlyMap<string, number> = new Map()): PinChange {
  if (pins.includes(id)) return { pins: pins.filter((p) => p !== id), evicted: null };
  return placePin(pins, id, null, lastUsed);
}

/** Pin `id` just before `before` (null: at the end), or move it there if already pinned.
 *  A new pin when PIN_LIMIT are pinned takes the place of the least used one (`evicted`). */
export function placePin(pins: readonly string[], id: string, before: string | null, lastUsed: ReadonlyMap<string, number> = new Map()): PinChange {
  if (before === id) return { pins: [...pins], evicted: null };
  let rest = pins.filter((p) => p !== id);
  let evicted: string | null = null;
  if (!pins.includes(id) && rest.length >= PIN_LIMIT) {
    evicted = leastUsedPin(rest.filter((p) => p !== before), lastUsed) ?? leastUsedPin(rest, lastUsed);
    rest = rest.filter((p) => p !== evicted);
  }
  const at = before ? rest.indexOf(before) : -1;
  if (at < 0) return { pins: [...rest, id], evicted };
  return { pins: [...rest.slice(0, at), id, ...rest.slice(at)], evicted };
}

/** Pins that still point at a frame (a deleted frame's pin is hidden, not forgotten). */
export const livePins = (pins: readonly string[], isFrame: (id: string) => boolean): string[] => pins.filter(isFrame);
