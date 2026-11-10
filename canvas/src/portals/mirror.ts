// The open portal's editor works on a local copy of the board's store, not on its own
// sync connection: no second websocket, no snapshot download, no server round trip. The
// copy is mirrored synchronously in both directions, in the stores' side effects (store
// listeners are batched to the next frame, which would let an older echo overwrite text
// typed in between):
//   board → portal: every document change on the board lands in the copy as a remote
//     change; while the portal is closed only the changed ids are noted and caught up
//     when it opens again.
//   portal → board: a person's change in the portal is put into the board's store as a
//     user change, so the board's sync client sends it to the server like any other edit
//     (and the board's own side effects, such as the layout lock, apply). If the board
//     refuses or alters it, the copy is corrected from the board. These pushes are
//     coalesced and sent off the input path (at most every PUSH_MS), so a keystroke in
//     the portal only costs the portal's editor; while a push is pending, the portal's
//     version of that record wins over a board change to it.
import { createTLStore, type Editor, isEqual, type TLRecord, type TLStore } from "tldraw";

type Id = TLRecord["id"];
const PUSH_MS = 80;

export class PortalMirror {
  readonly store: TLStore;
  private live = false;
  private dirty = new Set<Id>();
  private pushing: Map<Id, TLRecord | null> | null = null;
  private pending = new Set<Id>();
  private queued = false;
  private stops: Array<() => void> = [];
  private outgoing = new Map<Id, TLRecord | null>();
  private pushTimer: ReturnType<typeof setTimeout> | undefined;
  private onHide = () => this.push();
  /** The record being edited in the portal: board changes to it wait until the edit ends. */
  private editing: Id | null = null;
  private heldForEdit = new Set<Id>();

  constructor(private board: Editor) {
    const src = board.store;
    this.store = createTLStore({ schema: src.schema, assets: src.props.assets });
    const types = [...src.scopedTypes.document] as TLRecord["typeName"][];
    const docs = src.allRecords().filter((r) => src.scopedTypes.document.has(r.typeName));
    this.store.mergeRemoteChanges(() => this.store.put(docs));
    for (const t of types) {
      // portal → board (people's changes only; remote ones came from the board)
      this.stops.push(
        this.store.sideEffects.registerAfterCreateHandler(t, (r, source) => {
          if (source === "user") this.queuePush(r.id, r);
        }),
        this.store.sideEffects.registerAfterChangeHandler(t, (_prev, r, source) => {
          if (source === "user") this.queuePush(r.id, r);
        }),
        this.store.sideEffects.registerAfterDeleteHandler(t, (r, source) => {
          if (source === "user") this.queuePush(r.id, null);
        }),
        // board → portal
        src.sideEffects.registerAfterCreateHandler(t, (r) => this.fromBoard(r.id, r)),
        src.sideEffects.registerAfterChangeHandler(t, (_prev, r) => this.fromBoard(r.id, r)),
        src.sideEffects.registerAfterDeleteHandler(t, (r) => this.fromBoard(r.id, null)),
      );
    }
    window.addEventListener("pagehide", this.onHide);
  }

  /** Start mirroring into the copy (catching up on what changed while closed). */
  resume(): void {
    if (this.live) return;
    this.live = true;
    for (const id of this.dirty) this.pending.add(id);
    this.dirty.clear();
    this.flush();
  }

  /** Closed: send what is pending, stop applying board changes to the copy, only note
   *  which records changed. */
  pause(): void {
    this.push();
    this.live = false;
  }

  dispose(): void {
    this.push();
    window.removeEventListener("pagehide", this.onHide);
    for (const s of this.stops) s();
    this.stops = [];
  }

  /** The portal started or stopped editing a record. Ending an edit sends it at once and
   *  then applies any board change to it that waited (the board then holds the edit). */
  setEditing(id: Id | null): void {
    if (id === this.editing) return;
    const ended = this.editing;
    this.editing = id;
    if (!ended) return;
    this.push();
    if (this.heldForEdit.delete(ended)) {
      if (this.live) this.later(ended);
      else this.dirty.add(ended);
    }
  }

  private queuePush(id: Id, rec: TLRecord | null): void {
    this.outgoing.set(id, rec);
    if (this.pushTimer === undefined) this.pushTimer = setTimeout(() => this.push(), PUSH_MS);
  }

  /** Send the portal's pending changes to the board's store in one put. */
  push(): void {
    clearTimeout(this.pushTimer);
    this.pushTimer = undefined;
    if (!this.outgoing.size) return;
    const batch = this.outgoing;
    this.outgoing = new Map();
    const put: TLRecord[] = [];
    const remove: Id[] = [];
    for (const [id, rec] of batch) {
      if (rec) put.push(rec);
      else if (this.board.store.has(id)) remove.push(id);
    }
    this.pushing = batch;
    try {
      this.board.run(() => {
        if (put.length) this.board.store.put(put);
        if (remove.length) this.board.store.remove(remove);
      }, { history: "ignore" });
    } finally {
      this.pushing = null;
    }
    // The board kept something else (layout lock, a validation): correct the copy.
    for (const [id, rec] of batch) {
      const now = this.board.store.get(id) ?? null;
      if (rec ? now !== rec && !isEqual(now, rec) : now !== null) this.later(id);
    }
  }

  private fromBoard(id: Id, rec: TLRecord | null): void {
    // The board applying what the portal just pushed: already in the copy.
    if (this.pushing?.has(id)) {
      const mine = this.pushing.get(id) ?? null;
      if (rec === mine || (rec && mine && isEqual(rec, mine))) return;
    }
    // The portal has a newer version of this record on its way to the board.
    if (this.outgoing.has(id)) return;
    // Being typed into in the portal: never overwrite it mid-edit; caught up after.
    if (id === this.editing) {
      this.heldForEdit.add(id);
      return;
    }
    if (!this.live) {
      this.dirty.add(id);
      return;
    }
    this.later(id);
  }

  // Applied after the current change finishes (never inside another store's transaction),
  // still before the next input event or frame.
  private later(id: Id): void {
    this.pending.add(id);
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      this.flush();
    });
  }

  private flush(): void {
    if (!this.pending.size) return;
    const put: TLRecord[] = [];
    const remove: Id[] = [];
    for (const id of this.pending) {
      const b = this.board.store.get(id);
      const p = this.store.get(id);
      if (b && b !== p) put.push(b);
      else if (!b && p) remove.push(id);
    }
    this.pending.clear();
    if (!put.length && !remove.length) return;
    this.store.mergeRemoteChanges(() => {
      if (put.length) this.store.put(put);
      if (remove.length) this.store.remove(remove);
    });
  }
}
