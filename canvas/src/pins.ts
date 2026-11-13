// Pinned frames: a few saved jump spots per board, kept in the board itself (the tldraw
// document record's meta) so every device that opens the board sees the same pins and a
// pin made on the desktop is there on the phone. Until there are accounts, everyone on a
// board shares its pins. At most PIN_LIMIT: pins are hand-picked; recency covers the rest
// (frameTabsModel.ts). Pinning never fails: with PIN_LIMIT pinned, a new pin takes the place
// of the one you used least recently, and a toast says so (with Undo). The rules are in
// pinsModel.ts.
import { useCallback, useContext, useEffect } from "react";
import { type Editor, type TLShapeId, useValue } from "tldraw";
import { readPins, writePins } from "./framePanelDock";
import { readAgentSends, readRecents, recencyKey } from "./jumpPaletteModel";
import { boardPins, type PinChange, PIN_LIMIT, PINS_DOC, placePin, togglePin, withPins } from "./pinsModel";
import { BoardUiCtx } from "./ui";

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

// When this viewer last used each pinned frame (looked at it, jumped to it, or messaged its
// agent): which pin makes room for a new one.
function pinUse(editor: Editor, boardId: string, pins: readonly string[]): Map<string, number> {
  const storage = local();
  const viewer = (window as { __board?: { userId?: string } }).__board?.userId ?? "";
  const viewed = readRecents(storage, recencyKey(boardId, viewer));
  const sent = readAgentSends(storage);
  const used = new Map<string, number>();
  for (const id of pins) {
    const agent = (editor.getShape(id as TLShapeId)?.meta as { paseo?: { agentId?: string } } | undefined)?.paseo?.agentId;
    used.set(id, Math.max(viewed.get(id) ?? -Infinity, agent ? (sent.get(agent) ?? -Infinity) : -Infinity));
  }
  return used;
}

const nameOf = (editor: Editor, id: string) => {
  const n = (editor.getShape(id as TLShapeId)?.props as { name?: string } | undefined)?.name || "Frame";
  return n.length > 32 ? `${n.slice(0, 31)}…` : n;
};

/** The board's pins, live; a toggle, and a place (pin or move before another pin, null for
 *  the end). Pins this browser kept locally before pins moved into the board move in once. */
export function usePins(editor: Editor, boardId: string): [string[], (id: string) => void, (id: string, before: string | null) => void] {
  const ui = useContext(BoardUiCtx);
  const stored = useValue("board-pins", () => boardPins(editor), [editor]);
  const synced = useValue("board-doc-loaded", () => !!editor.store.get(PINS_DOC as never), [editor]);
  useEffect(() => {
    if (stored !== null || !synced) return;
    const old = readPins(local(), boardId);
    if (!old.length) return;
    writeBoardPins(editor, old.slice(0, PIN_LIMIT));
    writePins(local(), boardId, []);
  }, [editor, boardId, stored, synced]);
  // Write the change; when a pin made room, say which, with Undo (back to the pins before).
  const apply = useCallback(
    (id: string, change: (pins: string[], used: Map<string, number>) => PinChange) => {
      const before = boardPins(editor) ?? [];
      const next = change(before, pinUse(editor, boardId, before));
      writeBoardPins(editor, next.pins);
      if (next.evicted) {
        ui.toast(`Pinned “${nameOf(editor, id)}”, unpinned “${nameOf(editor, next.evicted)}” (${PIN_LIMIT} max)`, { label: "Undo", run: () => writeBoardPins(editor, before) });
      }
    },
    [editor, boardId, ui],
  );
  const toggle = useCallback((id: string) => apply(id, (pins, used) => togglePin(pins, id, used)), [apply]);
  const place = useCallback((id: string, before: string | null) => apply(id, (pins, used) => placePin(pins, id, before, used)), [apply]);
  return [stored ?? [], toggle, place];
}
