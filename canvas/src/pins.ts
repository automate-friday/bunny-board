// Pinned frames: a few saved jump spots per board, kept in the board itself (the tldraw
// document record's meta) so every device that opens the board sees the same pins and a
// pin made on the desktop is there on the phone. Until there are accounts, everyone on a
// board shares its pins. At most PIN_LIMIT: pins are hand-picked; recency covers the rest
// (frameTabsModel.ts). The rules are in pinsModel.ts.
import { useCallback, useEffect } from "react";
import { type Editor, useValue } from "tldraw";
import { readPins, writePins } from "./framePanelDock";
import { boardPins, PIN_LIMIT, PINS_DOC, placePin, togglePin, withPins } from "./pinsModel";

export { PIN_LIMIT } from "./pinsModel";

export function writeBoardPins(editor: Editor, pins: readonly string[]): void {
  editor.run(
    () => {
      const doc = editor.store.get(PINS_DOC as never) as { meta?: object } | undefined;
      if (doc) editor.store.put([withPins(doc, pins) as never]);
    },
    { history: "ignore" },
  );
}

const local = (): Storage | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

/** The board's pins, live; a toggle, and a place (pin or move before another pin, null for
 *  the end), both returning false when the pins are full. Pins this browser kept locally
 *  before pins moved into the board move in once. */
export function usePins(editor: Editor, boardId: string): [string[], (id: string) => boolean, (id: string, before: string | null) => boolean] {
  const stored = useValue("board-pins", () => boardPins(editor), [editor]);
  const synced = useValue("board-doc-loaded", () => !!editor.store.get(PINS_DOC as never), [editor]);
  useEffect(() => {
    if (stored !== null || !synced) return;
    const old = readPins(local(), boardId);
    if (!old.length) return;
    writeBoardPins(editor, old.slice(0, PIN_LIMIT));
    writePins(local(), boardId, []);
  }, [editor, boardId, stored, synced]);
  const toggle = useCallback(
    (id: string) => {
      const next = togglePin(boardPins(editor) ?? [], id);
      if (next.full) return false;
      writeBoardPins(editor, next.pins);
      return true;
    },
    [editor],
  );
  const place = useCallback(
    (id: string, before: string | null) => {
      const next = placePin(boardPins(editor) ?? [], id, before);
      if (next.full) return false;
      writeBoardPins(editor, next.pins);
      return true;
    },
    [editor],
  );
  return [stored ?? [], toggle, place];
}
