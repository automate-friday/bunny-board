// The pin rules (pins.ts has the hooks): a few hand-picked frames per board, kept in the
// board's tldraw document record so every device sees the same ones.
export const PIN_LIMIT = 4;
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

export type PinToggle = { pins: string[]; full: boolean };
/** Pin or unpin `id`. Pinning when PIN_LIMIT are pinned changes nothing (`full`). */
export function togglePin(pins: readonly string[], id: string): PinToggle {
  if (pins.includes(id)) return { pins: pins.filter((p) => p !== id), full: false };
  if (pins.length >= PIN_LIMIT) return { pins: [...pins], full: true };
  return { pins: [...pins, id], full: false };
}

/** Pin `id` just before `before` (null: at the end), or move it there if already pinned.
 *  Pinning a new frame when PIN_LIMIT are pinned changes nothing (`full`). */
export function placePin(pins: readonly string[], id: string, before: string | null): PinToggle {
  if (before === id) return { pins: [...pins], full: false };
  if (!pins.includes(id) && pins.length >= PIN_LIMIT) return { pins: [...pins], full: true };
  const rest = pins.filter((p) => p !== id);
  const at = before ? rest.indexOf(before) : -1;
  if (at < 0) return { pins: [...rest, id], full: false };
  return { pins: [...rest.slice(0, at), id, ...rest.slice(at)], full: false };
}

/** Pins that still point at a frame (a deleted frame's pin is hidden, not forgotten). */
export const livePins = (pins: readonly string[], isFrame: (id: string) => boolean): string[] => pins.filter(isFrame);
