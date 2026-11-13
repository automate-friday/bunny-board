import { readSetting } from "../../shared/bunny-storage";
// The desktop conversation sidebar's on-screen toggle (SidebarToggle in App.tsx). The sidebar
// remembers the last conversation it showed and whether it was open, per board and per
// viewer, including the reading width, so one click (or a reload) brings it back without finding the frame's panel.
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const sidebarKey = (boardId: string) => `bunny-sidebar:${boardId}`;
export type SidebarMemory = { frame: string | null; open: boolean; reading?: boolean; width?: number };

// The desktop sidebar's dragged width. It never gets narrower than SIDEBAR_MIN, and always
// leaves at least SIDEBAR_MIN of whiteboard visible (the minimum wins on a narrow window).
// No stored width means the default, min(420px, 45vw).
export const SIDEBAR_MIN = 320;
export const SIDEBAR_STEP = 24;
export const clampSidebarWidth = (width: number, viewportWidth: number): number =>
  Math.round(Math.max(SIDEBAR_MIN, Math.min(width, viewportWidth - SIDEBAR_MIN)));
export const defaultSidebarWidth = (viewportWidth: number): number => Math.round(Math.min(420, viewportWidth * 0.45));
const storedWidth = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= SIDEBAR_MIN && v <= 10000 ? Math.round(v) : undefined;
const widthField = (v: unknown) => { const w = storedWidth(v); return w === undefined ? {} : { width: w }; };

export function readSidebar(storage: Store | undefined, boardId: string): SidebarMemory {
  try {
    const v = JSON.parse(readSetting(storage, sidebarKey(boardId)) ?? "null");
    const frame = typeof v?.frame === "string" && v.frame.startsWith("shape:") ? v.frame : null;
    return { frame, open: !!frame && v?.open === true, ...(v?.reading === true ? { reading: true } : {}), ...widthField(v?.width) };
  } catch {
    return { frame: null, open: false };
  }
}

export function writeSidebar(storage: Store | undefined, boardId: string, memory: SidebarMemory): void {
  try {
    if (!memory.frame) storage?.removeItem(sidebarKey(boardId));
    else storage?.setItem(sidebarKey(boardId), JSON.stringify({ frame: memory.frame, open: memory.open, ...(memory.reading === true ? { reading: true } : {}), ...widthField(memory.width) }));
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
