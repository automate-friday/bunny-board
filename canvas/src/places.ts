// Where this browser has been: the last board and frame per board, newest first, so the
// home-screen app reopens where the person left off and the phone shell can jump back to a
// frame on another board. Switching boards here does not reload the page: main.tsx remounts
// App for the new URL, so the bundle, the agent stream and the HTTP connection stay warm.

import { useSyncExternalStore } from "react";

export type Place = { board: string; frame: string | null; title?: string; at: number };

const KEY = "bunny-places";
const LAUNCHED = "bunny-launched";
const MAX = 8;
export const NAVIGATE_EVENT = "bunny:navigate";

let cached: { raw: string | null; list: Place[] } = { raw: null, list: [] };
const listeners = new Set<() => void>();

export function recentPlaces(): Place[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    raw = null;
  }
  if (raw === cached.raw) return cached.list;
  let list: Place[] = [];
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (Array.isArray(parsed)) list = parsed.filter((p): p is Place => !!p && typeof p.board === "string" && p.board.length > 0).slice(0, MAX);
  } catch {
    list = [];
  }
  cached = { raw, list };
  return list;
}

function save(list: Place[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* private mode: places are not remembered */
  }
  for (const fn of listeners) fn();
}

// One entry per board, holding the frame last open there (null: the board's home).
export function rememberPlace(board: string, frame: string | null, title?: string): void {
  const list = recentPlaces();
  const head = list[0];
  if (head && head.board === board && head.frame === frame && (title === undefined || head.title === title)) return;
  const prev = list.find((p) => p.board === board);
  const next: Place = { board, frame, title: frame ? (title ?? (prev?.frame === frame ? prev.title : undefined)) : undefined, at: Date.now() };
  save([next, ...list.filter((p) => p.board !== board)]);
}

export function forgetPlace(board: string): void {
  save(recentPlaces().filter((p) => p.board !== board));
}

export function useRecentPlaces(): Place[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      const storage = (e: StorageEvent) => e.key === KEY && cb();
      window.addEventListener("storage", storage);
      return () => {
        listeners.delete(cb);
        window.removeEventListener("storage", storage);
      };
    },
    recentPlaces,
  );
}

export function placeUrl(board: string, frame: string | null, search = window.location.search): string {
  const q = new URLSearchParams(search);
  q.set("board", board);
  if (frame) q.set("frame", frame);
  else q.delete("frame");
  q.delete("comment");
  return `${window.location.pathname}?${q}`;
}

// Open a board (and frame) without reloading the page; main.tsx remounts App for it.
export function openPlace(board: string, frame: string | null = null): void {
  const url = placeUrl(board, frame);
  if (url === window.location.pathname + window.location.search) return;
  window.history.pushState(null, "", url);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

// The open frame, kept in the address so an iOS reload after the app was evicted in the
// background (it reloads the current URL) comes back to it.
export function setFrameInUrl(frame: string | null): void {
  const url = placeUrl(new URLSearchParams(window.location.search).get("board") || "main", frame);
  if (url !== window.location.pathname + window.location.search) window.history.replaceState(window.history.state, "", url);
}

export function standalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches);
}

// Home-screen launch: iOS opens the URL saved when the icon was added (usually the main
// board). On the first page of a launch, a plain board URL (no frame or comment named) is
// replaced by the last place. Runs before App reads the URL.
export function restoreLastPlace(isStandalone = standalone()): Place | null {
  if (!isStandalone) return null;
  try {
    if (sessionStorage.getItem(LAUNCHED)) return null;
    sessionStorage.setItem(LAUNCHED, "1");
  } catch {
    return null;
  }
  const q = new URLSearchParams(window.location.search);
  if (q.get("frame") || q.get("comment") || window.location.pathname !== "/") return null;
  const last = recentPlaces()[0];
  if (!last) return null;
  const board = q.get("board") || "main";
  if (last.board === board && !last.frame) return null;
  window.history.replaceState(null, "", placeUrl(last.board, last.frame, window.location.search));
  return last;
}

// The key main.tsx mounts App under: a new board or frame in the URL is a fresh App.
export function placeKey(): string {
  const q = new URLSearchParams(window.location.search);
  return `${q.get("board") || "main"}|${q.get("frame") ?? ""}`;
}
