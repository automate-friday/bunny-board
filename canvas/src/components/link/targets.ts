// Live status of link targets, shared by every link card on the page: one request per
// target every 15 s while at least one card shows it.

import { useEffect, useSyncExternalStore } from "react";
import type { LinkTarget } from "../../../../shared/components/link";
import { api } from "../../api";

interface View {
  target: LinkTarget | null;
  error: string | null;
}

interface Entry {
  view: View;
  at: number;
  holders: number;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
}

const entries = new Map<string, Entry>();

function ensure(k: string): Entry {
  let e = entries.get(k);
  if (!e) entries.set(k, (e = { view: { target: null, error: null }, at: 0, holders: 0, listeners: new Set(), timer: null }));
  return e;
}

async function load(k: string, board: string, frameId: string): Promise<void> {
  const e = ensure(k);
  try {
    const target = await api<LinkTarget>(`/api/ui/boards/${encodeURIComponent(board)}/summary${frameId ? `?frame=${encodeURIComponent(frameId)}` : ""}`);
    e.view = { target, error: null };
  } catch (err) {
    e.view = { target: e.view.target, error: (err as Error).message };
  }
  e.at = Date.now();
  for (const fn of e.listeners) fn();
}

export function useLinkTarget(board: string, frameId: string): View {
  const k = `${board}\n${frameId}`;
  useEffect(() => {
    const e = ensure(k);
    e.holders++;
    if (!e.timer) {
      if (Date.now() - e.at > 3000) void load(k, board, frameId);
      e.timer = setInterval(() => void load(k, board, frameId), 15000);
    }
    return () => {
      e.holders--;
      if (e.holders <= 0 && e.timer) {
        clearInterval(e.timer);
        e.timer = null;
      }
    };
  }, [k, board, frameId]);
  return useSyncExternalStore(
    (cb) => {
      const e = ensure(k);
      e.listeners.add(cb);
      return () => e.listeners.delete(cb);
    },
    () => ensure(k).view,
  );
}
