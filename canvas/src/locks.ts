import { readSetting, legacyStorageKey } from "../../shared/bunny-storage";
// Board locks on the canvas: read from the document (meta.paseoLocks, written by the
// server), changed through POST /api/ui/boards/:id/locks, and enforced here before a
// change ever leaves the tab (the server puts back anything that slips through).
//
// "Lock layout" blocks moving, resizing, rotating and deleting what is already on the
// board, by touch or mouse. Drawing new shapes still works: a shape this tab creates may
// be shaped by its tool until the pointer lifts, then it is locked like everything else.
// Touch devices start with a lock of their own ("this device"), one tap to undo.

import { atom, type Computed, computed, type Editor, type TLEventInfo, type TLRecord, type TLShape } from "tldraw";
import { type BoardLocks, DOCUMENT_ID, layoutChange, NO_LOCKS, readLocks } from "../../shared/locks";
import { api } from "./api";

export const isTouchDevice = (): boolean =>
  typeof window !== "undefined" && (window.matchMedia?.("(pointer: coarse)").matches || (navigator.maxTouchPoints > 0 && !window.matchMedia?.("(pointer: fine)").matches));

const unlockKey = (boardId: string) => `bunny-touch-unlocked:${boardId}`;

// This device's own lock (touch default). sessionStorage: a new visit locks again.
export const deviceLock = atom("paseo-device-lock", false);

export function initDeviceLock(boardId: string): void {
  let unlocked = false;
  try {
    unlocked = readSetting(sessionStorage, unlockKey(boardId)) === "1";
  } catch {
    /* private mode */
  }
  deviceLock.set(isTouchDevice() && !unlocked);
}

export function setDeviceLock(boardId: string, on: boolean): void {
  deviceLock.set(on);
  try {
    if (on) sessionStorage.removeItem(unlockKey(boardId));
    else sessionStorage.setItem(unlockKey(boardId), "1");
    sessionStorage.removeItem(legacyStorageKey(unlockKey(boardId)));
  } catch {
    /* private mode */
  }
}

const docLocks = new WeakMap<Editor, Computed<BoardLocks>>();

export function boardLocks(editor: Editor): Computed<BoardLocks> {
  let c = docLocks.get(editor);
  if (!c) {
    c = computed("bunny-locks", () => {
      const doc = editor.store.get(DOCUMENT_ID as TLRecord["id"]);
      return doc ? readLocks((doc as { meta?: unknown }).meta) : NO_LOCKS;
    });
    docLocks.set(editor, c);
  }
  return c;
}

export function layoutLockedHere(editor: Editor): boolean {
  return boardLocks(editor).get().layout || deviceLock.get();
}

export interface LocksResponse {
  locks: BoardLocks;
  queued: { deltas: number; frames: number; intros: number };
  flushed?: number;
  discarded?: number;
}

export function postLocks(boardId: string, patch: { layout?: boolean; agentsPaused?: boolean; discard?: boolean }): Promise<LocksResponse> {
  return api<LocksResponse>(`/api/ui/boards/${encodeURIComponent(boardId)}/locks`, { method: "POST", body: JSON.stringify({ ...patch, by: window.__board?.userName }) });
}

export function getLocks(boardId: string): Promise<LocksResponse> {
  return api<LocksResponse>(`/api/ui/boards/${encodeURIComponent(boardId)}/locks`);
}

// Install the guard on an editor. Returns the disposer.
export function installLayoutGuard(editor: Editor, onBlocked: (what: string) => void): () => void {
  // Shapes this tab created while locked, until the pointer that made them lifts.
  const fresh = new Set<string>();
  let lastNotice = 0;
  const notice = (what: string) => {
    if (Date.now() - lastNotice < 4000) return;
    lastNotice = Date.now();
    onBlocked(what);
  };
  const stopCreate = editor.sideEffects.registerAfterCreateHandler("shape", (shape, source) => {
    if (source === "user" && layoutLockedHere(editor)) fresh.add(shape.id);
  });
  const stopChange = editor.sideEffects.registerBeforeChangeHandler("shape", (prev: TLShape, next: TLShape, source) => {
    if (source !== "user" || !layoutLockedHere(editor) || fresh.has(next.id)) return next;
    // Text being typed may re-measure its own box; that is content, not layout.
    if (editor.isIn("select.editing_shape") && editor.getEditingShapeId() === next.id) return next;
    if (!layoutChange(prev as never, next as never).length) return next;
    notice("Layout is locked: nothing moves until you unlock it");
    return prev;
  });
  const stopDelete = editor.sideEffects.registerBeforeDeleteHandler("shape", (shape, source) => {
    if (source !== "user" || !layoutLockedHere(editor) || fresh.has(shape.id)) return;
    notice("Layout is locked: unlock it to delete");
    return false;
  });
  // A new pointer interaction (seen before the editor handles it) ends any earlier
  // creation; so does the end of the one that created the shape.
  const onBefore = (info: TLEventInfo) => {
    if (info.type === "pointer" && info.name === "pointer_down") fresh.clear();
  };
  const onEvent = (info: TLEventInfo) => {
    if (info.type === "pointer" && info.name === "pointer_up" && fresh.size) setTimeout(() => !editor.inputs.getIsPointing() && fresh.clear(), 50);
  };
  editor.on("before-event", onBefore);
  editor.on("event", onEvent);
  return () => {
    stopCreate();
    stopChange();
    stopDelete();
    editor.off("before-event", onBefore);
    editor.off("event", onEvent);
  };
}
