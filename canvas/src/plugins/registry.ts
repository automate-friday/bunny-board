// Canvas client for "My registry" (GET/POST /api/ui/plugins): one shared cache of the
// installed plugin ids, so the tray and the plugin pages agree without refetching per view.

import { useEffect, useSyncExternalStore } from "react";
import { api } from "../api";

let installed: string[] | null = null;
// Whether the board server offers developer plugins (BUNNY_DEV_PLUGINS=1; shared/plugins.ts).
let devPlugins = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const notify = () => {
  for (const fn of listeners) fn();
};

export function refreshInstalled(): Promise<void> {
  loading ??= api<{ installed: string[]; devPlugins?: boolean }>("/api/ui/plugins")
    .then((r) => {
      installed = r.installed;
      devPlugins = !!r.devPlugins;
      notify();
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

async function change(action: "install" | "uninstall", id: string): Promise<string[]> {
  const r = await api<{ installed: string[] }>(`/api/ui/plugins/${action}`, { method: "POST", body: JSON.stringify({ id }) });
  installed = r.installed;
  notify();
  return r.installed;
}

export const installPlugin = (id: string) => change("install", id);
export const uninstallPlugin = (id: string) => change("uninstall", id);

// Installed ids, or null until the first answer. Refetches on mount (another tab may have
// changed the registry).
export function useInstalled(): string[] | null {
  const value = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => installed,
  );
  useEffect(() => {
    void refreshInstalled().catch(() => {});
  }, []);
  return value;
}

// Whether developer plugins are offered (false until the registry answers).
export function useDevPlugins(): boolean {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => devPlugins,
  );
}

// Where "Back to board" goes: the board the person came from (?from=<board id>).
export function boardHref(): string {
  const from = new URLSearchParams(window.location.search).get("from");
  return from ? `/?board=${encodeURIComponent(from)}` : "/";
}

export function pluginsHref(id?: string): string {
  const from = new URLSearchParams(window.location.search).get("from") ?? new URLSearchParams(window.location.search).get("board");
  return `/plugins${id ? `/${encodeURIComponent(id)}` : ""}${from ? `?from=${encodeURIComponent(from)}` : ""}`;
}
