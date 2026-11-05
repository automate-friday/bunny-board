import { createContext } from "react";
import type { PickerTarget } from "./ImportPicker";

// Board-level UI the frame toolbar, header and context menu reach: the import picker
// (with the last context-menu point) and a toast.
export const BoardUiCtx = createContext<{
  openConversation(frameId: string): void;
  openPicker(t: PickerTarget): void;
  contextPoint(): { x: number; y: number } | null;
  setContextPoint(p: { x: number; y: number }): void;
  // An action shows as a button in the toast (Archive's Undo).
  toast(text: string, action?: { label: string; run(): void }): void;
}>({
  openConversation() {},
  openPicker() {},
  contextPoint: () => null,
  setContextPoint() {},
  toast() {},
});
