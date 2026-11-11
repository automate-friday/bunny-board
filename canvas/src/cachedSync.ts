// useSync from @tldraw/sync 5.2.2 (useSync.mjs), with a saved copy of the board (boardCache.ts):
// - the socket starts connecting at once, while the saved copy is read;
// - with a copy, the store is filled from it and the board renders straight away; the sync
//   client then connects with the copy's server clock, so the server sends only what changed
//   since (or everything, replacing the copy, when it no longer has that history);
// - while connected, with nothing of ours waiting on the server, the board is saved back
//   (a few seconds after changes, and when the app goes to the background).
// Without a copy (or with ?boardcache=0) it behaves as useSync. Keep in step with useSync on
// tldraw upgrades.

import { atom, transact } from "@tldraw/state";
import * as sync from "@tldraw/sync";
import { TLRemoteSyncError, TLSyncClient, TLSyncErrorCloseEventReason, type RemoteTLStoreWithStatus, type TLPersistentClientSocket } from "@tldraw/sync";
import { useEffect, useState } from "react";
import {
  TAB_ID,
  UserRecordType,
  computed,
  createCachedUserResolve,
  createPresenceStateDerivation,
  createTLStore,
  createUserId,
  defaultUserPreferences,
  defaultUserStore,
  getDefaultUserPresence,
  getUserPreferences,
  registerColorsFromThemes,
  registerFontsFromThemes,
  resolveThemes,
  uniqueId,
  useTLSchemaFromUtils,
  useValue,
  type TLAnyShapeUtilConstructor,
  type TLAssetStore,
  type TLRecord,
  type TLStoreSnapshot,
} from "tldraw";
import { takeBoardCache, writeBoardCache, type CachedBoard } from "./boardCache";
import { markLaunch } from "./launchTiming";

const SAVE_AFTER_MS = 4000;

const mark = markLaunch;

// In @tldraw/sync-core's runtime exports (re-exported by @tldraw/sync), left out of its types.
const ClientWebSocketAdapter = (sync as unknown as { ClientWebSocketAdapter: new (uri: () => Promise<string>) => TLPersistentClientSocket & { connectionStatus: string; onStatusChange(cb: (ev: { status: string }) => void): () => void; close(): void } }).ClientWebSocketAdapter;
type Store = ReturnType<typeof createTLStore> & { ensureStoreIsUsable(): void };

// What the launch used, for launch timing (launchTiming.ts).
export const boardSource = atom<"cache" | "server" | null>("board-source", null);

type ClientInternals = {
  lastServerClock: number;
  isConnectedToRoom: boolean;
  pendingPushRequests: unknown[];
  incomingDiffBuffer: unknown[];
  speculativeChanges: { added: object; updated: object; removed: object };
};

// The store holds exactly the server's state at lastServerClock: connected, every change of
// ours acknowledged, every incoming diff applied.
function settled(c: ClientInternals): boolean {
  const s = c.speculativeChanges;
  return c.isConnectedToRoom && c.pendingPushRequests.length === 0 && c.incomingDiffBuffer.length === 0 && !Object.keys(s.added).length && !Object.keys(s.updated).length && !Object.keys(s.removed).length;
}

// App's options only (uri, assets, shapeUtils): no custom users, connect, presence or messages.
export function useCachedSync({ uri, assets, shapeUtils, boardId }: { uri: string; assets: TLAssetStore; shapeUtils: readonly TLAnyShapeUtilConstructor[]; boardId: string }): RemoteTLStoreWithStatus {
  const [state, setState] = useState<{ readyClient?: TLSyncClient<TLRecord>; error?: Error } | null>(null);
  const roomId = "default";
  const _users = undefined as undefined | { currentUser: typeof defaultUserStore.currentUser; resolve?: Parameters<typeof createCachedUserResolve>[0] };
  const onMount = undefined;
  const track = undefined as undefined | ((name: string, data: object) => void);
  const resolvedThemes = resolveThemes(undefined);
  registerColorsFromThemes(resolvedThemes);
  registerFontsFromThemes(resolvedThemes);
  const schema = useTLSchemaFromUtils({ shapeUtils });
  const getUserPresence = getDefaultUserPresence;
  const onCustomMessageReceived = undefined;

  useEffect(() => {
    const storeId = uniqueId();
    const users = _users
      ? { currentUser: _users.currentUser, resolve: _users.resolve ?? createCachedUserResolve((userId: string) => {
          const current = _users.currentUser.get();
          return current && current.id === createUserId(userId) ? current : null;
        }) }
      : { currentUser: defaultUserStore.currentUser, resolve: createCachedUserResolve((userId: string) => {
          const current = defaultUserStore.currentUser.get();
          if (current && current.id === createUserId(userId)) return current;
          const presences = store?.query.records("instance_presence").get() ?? [];
          const match = presences.find((p) => p.userId === createUserId(userId));
          return match ? UserRecordType.create({ id: createUserId(userId), name: match.userName, color: match.color }) : null;
        }) };
    const currentUser = computed("currentUser", () => {
      const user = users.currentUser.get();
      if (user) return user;
      const prefs = getUserPreferences();
      return UserRecordType.create({ id: createUserId(prefs.id), name: prefs.name ?? "", color: prefs.color ?? defaultUserPreferences.color });
    });
    // Connect first: the socket opens while the saved copy is read.
    const socket = new ClientWebSocketAdapter(async () => {
      const withParams = new URL(uri);
      withParams.searchParams.set("sessionId", TAB_ID);
      withParams.searchParams.set("storeId", storeId);
      return withParams.toString();
    });
    let didCancel = false;
    let store: Store | null = null;
    let saveNow = () => undefined as void;
    const disposers: (() => void)[] = [];
    const getConnectionStatus = () => (socket.connectionStatus === "error" ? "offline" : socket.connectionStatus);
    const collaborationStatusSignal = atom("collaboration status", getConnectionStatus());
    disposers.push(socket.onStatusChange(() => collaborationStatusSignal.set(getConnectionStatus())));
    const syncMode = atom<"readonly" | "readwrite">("sync mode", "readwrite");

    void takeBoardCache(boardId).then((cached) => {
      if (didCancel) return;
      mark("bunny:cache-read");
      store = createTLStore({ id: storeId, schema, assets, users, onMount, collaboration: { status: collaborationStatusSignal, mode: syncMode } } as Parameters<typeof createTLStore>[0]) as Store;
      let fromCache: CachedBoard | null = null;
      if (cached) {
        try {
          // Migrates a copy saved by an older canvas; a newer one (rollback) throws.
          store.loadStoreSnapshot({ store: cached.records, schema: cached.schema } as unknown as TLStoreSnapshot);
          store.ensureStoreIsUsable();
          fromCache = cached;
          mark("bunny:cache-loaded");
        } catch (e) {
          console.warn("board cache: saved copy not usable, loading from the server", e);
          store.clear();
        }
      }
      const presence = createPresenceStateDerivation(currentUser, { getUserPresence })(store);
      const otherSessions = store.query.ids("instance_presence");
      const presenceMode = computed("presenceMode", () => (otherSessions.get().size === 0 ? "solo" : "full"));
      const client = new TLSyncClient({
        store,
        socket,
        didCancel: () => didCancel,
        onLoad(c) {
          track?.("multiplayer.client", { name: "load", roomId });
          mark("bunny:server-first-message");
          if (!fromCache) {
            boardSource.set("server");
            setState({ readyClient: c });
          }
        },
        onSyncError(reason) {
          console.error("sync error", reason);
          track?.("multiplayer.client", { name: reason === TLSyncErrorCloseEventReason.NOT_FOUND ? "room-not-found" : `sync-error:${reason}`, roomId });
          setState({ error: new TLRemoteSyncError(reason) });
          socket.close();
        },
        onAfterConnect(_, { isReadonly }) {
          transact(() => {
            syncMode.set(isReadonly ? "readonly" : "readwrite");
            store!.ensureStoreIsUsable();
          });
        },
        onCustomMessageReceived,
        presence,
        presenceMode,
      } as ConstructorParameters<typeof TLSyncClient<TLRecord>>[0]);
      const internals = client as unknown as ClientInternals;
      if (fromCache) {
        // Ask the server for what changed since the copy, and draw the copy now.
        internals.lastServerClock = fromCache.clock;
        boardSource.set("cache");
        setState({ readyClient: client });
      }
      // Save the board back while it matches the server.
      let timer: ReturnType<typeof setTimeout> | null = null;
      const save = () => {
        timer = null;
        if (didCancel || !store || !settled(internals)) return;
        const snap = store.getStoreSnapshot("document");
        void writeBoardCache({ boardId, clock: internals.lastServerClock, schema: snap.schema, records: snap.store as Record<string, unknown>, savedAt: Date.now() });
      };
      const later = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(save, SAVE_AFTER_MS);
      };
      const unlisten = store.listen(later, { scope: "document" });
      // The first connection: save once it settles, so a board opened once has a copy.
      const unstatus = socket.onStatusChange((ev: { status: string }) => {
        if (ev.status === "online") later();
      });
      saveNow = save;
      const hidden = () => {
        if (document.visibilityState === "hidden") save();
      };
      document.addEventListener("visibilitychange", hidden);
      window.addEventListener("pagehide", save);
      disposers.push(() => {
        if (timer) clearTimeout(timer);
        unlisten();
        unstatus();
        document.removeEventListener("visibilitychange", hidden);
        window.removeEventListener("pagehide", save);
        client.close();
      });
    });

    return () => {
      // Leaving the board (a board switch): keep its latest state for coming back to it.
      saveNow();
      didCancel = true;
      for (const d of disposers) d();
      socket.close();
    };
  }, [assets, schema, uri, boardId]);

  return useValue(
    "remote synced store",
    () => {
      if (!state) return { status: "loading" } as const;
      if (state.error) return { status: "error", error: state.error } as const;
      if (!state.readyClient) return { status: "loading" } as const;
      const ready = state.readyClient as unknown as { socket: { connectionStatus: string }; store: Store };
      const connectionStatus = ready.socket.connectionStatus;
      return { status: "synced-remote", connectionStatus: connectionStatus === "error" ? "offline" : connectionStatus, store: ready.store } as RemoteTLStoreWithStatus;
    },
    [state],
  );
}
