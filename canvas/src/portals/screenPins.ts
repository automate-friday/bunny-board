// Frames pinned to the screen: the windows' state for this board on this device (the rules
// are in screenPinsModel.ts).
import { atom } from "tldraw";
import { readSetting } from "../../../shared/bunny-storage";
import { cleanScreenPins, type ScreenPin, screenPinsKey } from "./screenPinsModel";

export { addScreenPin, fitRect, newSpot, SCREEN_PIN_LIMIT, type ScreenPin } from "./screenPinsModel";

const local = (): Storage | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

export function readScreenPins(board: string): ScreenPin[] {
  try {
    return cleanScreenPins(JSON.parse(readSetting(local(), screenPinsKey(board)) ?? "[]"));
  } catch {
    return [];
  }
}

export const screenPins = atom<ScreenPin[]>("screen-pins", []);
let boardOfPins = "";
/** Load this board's windows (once per board). */
export function loadScreenPins(board: string): void {
  if (boardOfPins === board) return;
  boardOfPins = board;
  screenPins.set(readScreenPins(board));
}
/** Change the windows and remember them for this board on this device. */
export function setScreenPins(next: ScreenPin[]): void {
  const pins = cleanScreenPins(next);
  screenPins.set(pins);
  try {
    if (boardOfPins) local()?.setItem(screenPinsKey(boardOfPins), JSON.stringify(pins));
  } catch {
    /* they last until reload */
  }
}
export const updateScreenPin = (id: string, patch: Partial<ScreenPin>) => setScreenPins(screenPins.get().map((p) => (p.id === id ? { ...p, ...patch } : p)));
export const removeScreenPin = (id: string) => setScreenPins(screenPins.get().filter((p) => p.id !== id));
/** Bring a window to the front: the list's order is its stacking (and, at the limit, the
 *  first one is the least recently used, closed to make room). */
export function frontScreenPin(id: string): void {
  const pins = screenPins.get();
  if (pins[pins.length - 1]?.id === id) return;
  const pin = pins.find((p) => p.id === id);
  if (pin) setScreenPins([...pins.filter((p) => p.id !== id), pin]);
}
