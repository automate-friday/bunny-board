import { readSetting, legacyStorageKey } from "../../shared/bunny-storage";
// Per-viewer frame panel settings, kept in localStorage so they hold across frame
// selections and reloads:
// - where the panel lives: floating near the frame, or docked bottom-right as a pill or
//   expanded in place ("1" is the pill, the value the plain minimize flag always used);
// - pinned frames this browser kept before pins moved into the board (pins.ts reads them
//   once and moves them in).
import { useCallback, useEffect, useState } from "react";

export const PANEL_MINIMIZED_KEY = "bunny-frame-panel-minimized";
export const pinsKey = (boardId: string) => `bunny-pins:${boardId}`;
const EVENT = "bunny-frame-panel-dock";

export type PanelDock = "float" | "pill" | "open";
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const get = (storage: Store | undefined, key: string): string | null => {
  try {
    return readSetting(storage, key);
  } catch {
    return null; // storage blocked: defaults
  }
};
const put = (storage: Store | undefined, key: string, value: string | null) => {
  try {
    if (value === null) storage?.removeItem(key);
    else storage?.setItem(key, value);
    if (legacyStorageKey(key) !== key) storage?.removeItem(legacyStorageKey(key));
  } catch {
    /* storage blocked: the choice lasts until reload */
  }
};

export function readPanelDock(storage: Store | undefined): PanelDock {
  const v = get(storage, PANEL_MINIMIZED_KEY);
  return v === "1" ? "pill" : v === "open" ? "open" : "float";
}
export function writePanelDock(storage: Store | undefined, dock: PanelDock): void {
  put(storage, PANEL_MINIMIZED_KEY, dock === "pill" ? "1" : dock === "open" ? "open" : null);
}

export function readPins(storage: Store | undefined, boardId: string): string[] {
  try {
    const v = JSON.parse(get(storage, pinsKey(boardId)) ?? "[]");
    return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && x.startsWith("shape:")))] : [];
  } catch {
    return [];
  }
}
export function writePins(storage: Store | undefined, boardId: string, pins: string[]): void {
  put(storage, pinsKey(boardId), pins.length ? JSON.stringify(pins) : null);
}

const local = (): Store | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

// A localStorage-backed value every mounted panel (and other tabs) follows.
function useStored<T>(read: () => T, write: (v: T) => void, key: string): [T, (v: T) => void] {
  const [value, setState] = useState(read);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `read` changes with `key`.
  useEffect(() => {
    setState(read());
    const sync = () => setState(read());
    const onStorage = (e: StorageEvent) => {
      if (e.key === key || e.key === legacyStorageKey(key)) sync();
    };
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, [key]);
  const set = useCallback(
    (next: T) => {
      write(next);
      setState(next);
      window.dispatchEvent(new Event(EVENT));
    },
    // biome-ignore lint/correctness/useExhaustiveDependencies: `write` changes with `key`.
    [key],
  );
  return [value, set];
}

export const usePanelDock = () => useStored(() => readPanelDock(local()), (v) => writePanelDock(local(), v), PANEL_MINIMIZED_KEY);

// The floating panel sits near the top of the canvas, where a selected frame's title often is
// too (after a pin jump or a zoom to the frame). Covering the title broke renaming: the first
// click of a double-click selects the frame and brings the panel up, and the second lands on
// the panel ("Start conversation" on a frame without an agent). When the panel would overlap
// the selected frame's title, it moves down to just below the title. Screen pixels; `panel`
// is where the panel sits unshifted.
export type ScreenRect = { left: number; top: number; right: number; bottom: number };
export const HEADING_GAP = 8;
export function clearOfHeading(panel: ScreenRect, heading: ScreenRect | null, gap = HEADING_GAP): number {
  if (!heading) return 0;
  const overlaps = panel.left < heading.right + gap && panel.right > heading.left - gap && panel.top < heading.bottom + gap && panel.bottom > heading.top - gap;
  return overlaps ? Math.ceil(heading.bottom + gap - panel.top) : 0;
}
