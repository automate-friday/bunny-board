// Keep the sync client at its collaborative rate when this tab is the only session.
//
// tldraw's sync client runs in "solo mode" while the store holds no instance_presence
// record: it then sends and applies sync messages once a second instead of 30 times
// (TLSyncClient SOLO_MODE_FPS; useSync derives presenceMode from
// store.query.ids("instance_presence") and has no option to override it). Agents write
// through the server, which has no presence, so on a board someone has to themselves every
// agent edit reached his screen up to a second late.
//
// So the canvas keeps one local placeholder presence record in the store. It is never
// sent: the sync client pushes only document-scoped changes from the store, and its own
// presence from the presence derivation, not from presence records. It never shows: its
// name is empty (comment @-mentions drop empty names) and its page is no real page, so
// cursors, brushes, selection hints and follow UI (all "on the current page") skip it.
// The sync client wipes every presence record on reconnect; a before-delete veto keeps
// this one through the wipe, so the rate never drops to solo, even for a moment.
import { createUserId, type Editor, InstancePresenceRecordType, PageRecordType, type TLEventInfo, type TLInstancePresence } from "tldraw";

export const SYNC_RATE_PRESENCE_ID = InstancePresenceRecordType.createId("bunny-sync-rate");

export function syncRatePresence(): TLInstancePresence {
  return InstancePresenceRecordType.create({
    id: SYNC_RATE_PRESENCE_ID,
    userId: createUserId("bunny-sync-rate"),
    userName: "",
    currentPageId: PageRecordType.createId("bunny-sync-rate"),
  });
}

// The collaborative rate costs CPU: remote changes are applied up to 30 times a second
// instead of once. That is worth it while the person watches agents work, not while they pan,
// zoom or drag (those frames are what they feel). So the placeholder is held only while
// the page is idle: any wheel, pinch or pointer press/drag drops it (back to tldraw's 1 fps
// batching, as before), and it returns IDLE_MS after the last such input.
export const SYNC_RATE_IDLE_MS = 400;

/** Holds the placeholder while the editor is idle; returns a disposer that removes it. */
export function keepCollaborativeSyncRate(editor: Editor, idleMs = SYNC_RATE_IDLE_MS): () => void {
  const store = editor.store;
  let disposing = false;
  let wanted = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ensure = () => {
    if (wanted && !disposing && !store.has(SYNC_RATE_PRESENCE_ID)) store.mergeRemoteChanges(() => store.put([syncRatePresence()]));
  };
  const drop = () => {
    wanted = false;
    if (store.has(SYNC_RATE_PRESENCE_ID)) store.mergeRemoteChanges(() => store.remove([SYNC_RATE_PRESENCE_ID]));
  };
  const stopVeto = store.sideEffects.registerBeforeDeleteHandler("instance_presence", (record) =>
    disposing || !wanted || record.id !== SYNC_RATE_PRESENCE_ID ? undefined : false,
  );
  // Fallback for removals that skip side effects (applyDiff with runCallbacks: false).
  const stopListen = store.listen(ensure, { scope: "presence" });
  const onEvent = (info: TLEventInfo) => {
    const interacting = info.type === "wheel" || info.type === "pinch" || (info.type === "pointer" && (info.name === "pointer_down" || editor.inputs.getIsPointing()));
    if (!interacting) return;
    if (wanted) drop();
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (editor.inputs.getIsPointing()) return void (timer = setTimeout(() => onEvent({ type: "pointer", name: "pointer_move" } as TLEventInfo), idleMs));
      wanted = true;
      ensure();
    }, idleMs);
  };
  editor.on("event", onEvent);
  ensure();
  return () => {
    disposing = true;
    clearTimeout(timer);
    editor.off("event", onEvent);
    stopVeto();
    stopListen();
    if (store.has(SYNC_RATE_PRESENCE_ID)) store.mergeRemoteChanges(() => store.remove([SYNC_RATE_PRESENCE_ID]));
  };
}
