// A copy of each recently opened board on this device (IndexedDB), so the phone can draw the
// board at once on launch or board switch instead of waiting for the connection and the whole
// board (~0.7 MB on a live-sized board) to arrive. cachedSync.ts writes it while connected and
// with nothing of ours waiting on the server, together with the server clock it matches; the
// next connection asks only for what changed since that clock.

import { standalone } from "./places";

export type CachedBoard = {
  boardId: string;
  clock: number;
  schema: unknown;
  records: Record<string, unknown>;
  savedAt: number;
};

const DB = "bunny-board-cache";
const STORE = "boards";
const MAX_BOARDS = 4;
const ORDER_KEY = "bunny-board-cache-order";
// A slow or broken IndexedDB never holds a launch up: past this the board loads as before.
const READ_TIMEOUT_MS = 800;

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "boardId" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("board cache blocked"));
    });
    dbPromise.catch(() => (dbPromise = null));
  }
  return dbPromise;
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

// Phones and the home-screen app (?boardcache=1 forces it on, ?boardcache=0 off). Desktop
// tabs connect as before. Fixed for the page's life: App picks its sync hook with it.
export function boardCacheEnabled(): boolean {
  try {
    if (typeof indexedDB === "undefined") return false;
    const param = new URLSearchParams(window.location.search).get("boardcache");
    if (param === "0" || param === "1") return param === "1";
    return standalone() || (typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches);
  } catch {
    return false;
  }
}

const reads = new Map<string, Promise<CachedBoard | null>>();

// The cached board, or null (none, unreadable, or slower than READ_TIMEOUT_MS). main.tsx starts
// the read for the URL's board before the app renders; App's sync hook picks the same promise up.
export function readBoardCache(boardId: string): Promise<CachedBoard | null> {
  if (!boardCacheEnabled()) return Promise.resolve(null);
  let p = reads.get(boardId);
  if (!p) {
    // index.html started this read before the app's code ran, for the board it expected.
    const early = (window as { __bunnyEarlyBoard?: { board: string; read: Promise<unknown> } }).__bunnyEarlyBoard;
    const raw = early?.board === boardId ? early.read : db().then((d) => request(d.transaction(STORE, "readonly").objectStore(STORE).get(boardId) as IDBRequest<unknown>));
    if (early?.board === boardId) delete (window as { __bunnyEarlyBoard?: unknown }).__bunnyEarlyBoard;
    const read = raw
      .then((v) => {
        const c = v as CachedBoard | null | undefined;
        return c && c.boardId === boardId && typeof c.clock === "number" && c.records && typeof c.records === "object" ? c : null;
      })
      .catch(() => null);
    p = Promise.race([read, new Promise<null>((r) => setTimeout(() => r(null), READ_TIMEOUT_MS))]);
    reads.set(boardId, p);
  }
  return p;
}

// Each board read is used once: the next mount of the same board reads what was saved since.
export function takeBoardCache(boardId: string): Promise<CachedBoard | null> {
  const p = readBoardCache(boardId);
  reads.delete(boardId);
  return p;
}

export async function writeBoardCache(entry: CachedBoard): Promise<void> {
  if (!boardCacheEnabled()) return;
  try {
    const d = await db();
    const tx = d.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    store.put(entry);
    // Keep the newest few boards (the order lives in localStorage: reading every cached board
    // back to sort them would cost more than the save).
    let order: string[] = [];
    try {
      order = JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]") as string[];
    } catch {
      order = [];
    }
    order = [entry.boardId, ...order.filter((b) => b !== entry.boardId)];
    for (const old of order.slice(MAX_BOARDS)) store.delete(old);
    try {
      localStorage.setItem(ORDER_KEY, JSON.stringify(order.slice(0, MAX_BOARDS)));
    } catch {
      /* private mode */
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    /* quota or private mode: the next launch loads from the server as before */
  }
}

export async function dropBoardCache(boardId: string): Promise<void> {
  try {
    const d = await db();
    d.transaction(STORE, "readwrite").objectStore(STORE).delete(boardId);
  } catch {
    /* nothing cached */
  }
}
