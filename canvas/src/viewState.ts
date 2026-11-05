import { readSetting, legacyStorageKey } from "../../shared/bunny-storage";
// Per-viewer view state for board components (a transcript card's Full/Compact and
// Follow). It used to live in the shape's props, so switching a card to Full switched it
// for everyone and was saved in the board. Now each browser keeps its own choice in
// localStorage, keyed by board and shape id; the props hold the default (what an agent
// pinned, or what the card was created with).

import { useCallback, useSyncExternalStore } from "react";

const PREFIX = "bunny-view:";
const listeners = new Map<string, Set<() => void>>();
const cache = new Map<string, { raw: string | null; value: Record<string, unknown> | null }>();

function boardId(): string {
  return new URLSearchParams(window.location.search).get("board") || "main";
}

function read(key: string): Record<string, unknown> | null {
  let raw: string | null = null;
  try {
    raw = readSetting(localStorage, key);
  } catch {
    raw = null;
  }
  const hit = cache.get(key);
  if (hit && hit.raw === raw) return hit.value;
  let value: Record<string, unknown> | null = null;
  try {
    value = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    value = null;
  }
  cache.set(key, { raw, value });
  return value;
}

function notify(key: string): void {
  for (const fn of listeners.get(key) ?? []) fn();
}

window.addEventListener("storage", (e) => {
  if (e.key?.startsWith(PREFIX)) notify(e.key);
  else if (e.key?.startsWith(legacyStorageKey(PREFIX))) notify(e.key.replace(legacyStorageKey(PREFIX), PREFIX));
});

export function viewKey(shapeId: string): string {
  return `${PREFIX}${boardId()}:${shapeId}`;
}

// [state, update]: the stored view merged over `defaults`.
export function useViewState<T extends Record<string, unknown>>(shapeId: string, defaults: T): [T, (patch: Partial<T>) => void] {
  const key = viewKey(shapeId);
  const stored = useSyncExternalStore(
    (cb) => {
      let set = listeners.get(key);
      if (!set) listeners.set(key, (set = new Set()));
      set.add(cb);
      return () => set.delete(cb);
    },
    () => read(key),
  );
  const update = useCallback(
    (patch: Partial<T>) => {
      const next = { ...(read(key) ?? {}), ...patch };
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* private mode: the toggle just does not persist */
      }
      notify(key);
    },
    [key],
  );
  const merged = { ...defaults } as T;
  if (stored) for (const k of Object.keys(defaults)) if (k in stored && typeof stored[k] === typeof defaults[k]) (merged as Record<string, unknown>)[k] = stored[k];
  return [merged, update];
}
