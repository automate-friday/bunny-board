import { BoardMenu } from "./BoardMenu";
// Top-right of the canvas: one small "<board> ▾" pill. Everything board-wide (Lock, Pause,
// Import, Archive, switching boards, canvas version) lives in its menu (BoardMenu.tsx), so
// the corner stays light.

import { useContext } from "react";
import { useEditor } from "tldraw";
import { BoardUiCtx } from "./ui";

export function BoardHeader({ boardId, onImport }: { boardId: string; onImport: () => void }) {
  const editor = useEditor();
  const ui = useContext(BoardUiCtx);
  return (
    <div style={{ pointerEvents: "all", margin: 8, font: "13px system-ui, sans-serif" }} data-testid="board-header" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <BoardMenu editor={editor} boardId={boardId} onImport={onImport} toast={ui.toast} />
    </div>
  );
}
