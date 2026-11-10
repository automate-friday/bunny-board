import { readSetting } from "../../shared/bunny-storage";
// The desktop conversation sidebar's on-screen toggle (SidebarToggle in App.tsx). The sidebar
// remembers the last conversation it showed and whether it was open, per board and per
// viewer, including the reading width, so one click (or a reload) brings it back without finding the frame's panel.
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const sidebarKey = (boardId: string) => `bunny-sidebar:${boardId}`;
export type SidebarMemory = { frame: string | null; open: boolean; reading?: boolean };

export function readSidebar(storage: Store | undefined, boardId: string): SidebarMemory {
  try {
    const v = JSON.parse(readSetting(storage, sidebarKey(boardId)) ?? "null");
    const frame = typeof v?.frame === "string" && v.frame.startsWith("shape:") ? v.frame : null;
    return { frame, open: !!frame && v?.open === true, ...(v?.reading === true ? { reading: true } : {}) };
  } catch {
    return { frame: null, open: false };
  }
}

export function writeSidebar(storage: Store | undefined, boardId: string, memory: SidebarMemory): void {
  try {
    if (!memory.frame) storage?.removeItem(sidebarKey(boardId));
    else storage?.setItem(sidebarKey(boardId), JSON.stringify({ frame: memory.frame, open: memory.open, ...(memory.reading === true ? { reading: true } : {}) }));
  } catch {
    /* storage blocked: the toggle still works until reload */
  }
}

// The conversation the toggle restores: the last one shown if its frame is still on the
// board, else the conversation of the current selection, else the first frame on the page
// (a conversation frame before a plain one).
export function restoreTarget(last: string | null, isFrame: (id: string) => boolean, selected: string | null, firstBound: () => string | null): string | null {
  if (last && isFrame(last)) return last;
  if (selected && isFrame(selected)) return selected;
  return firstBound();
}
