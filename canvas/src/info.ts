// /api/ui/info, fetched once per page: the configured public base for links people
// share or open (the board may be opened on another host name than the one in links).

import { useEffect, useState } from "react";
import { api } from "./api";

export interface BoardInfo {
  publicBase: string;
  defaultProvider: string;
  humanName: string;
  // Start target default; absent means the configured runtime.
  cloudDefault?: boolean;
  runtimeHostname?: string;
  boardHostname?: string;
  // The machine the board's Paseo daemon reports (where local agents really run).
  agentMachine?: string | null;
  machine?: string;
  paseoServerId?: string | null;
  paseoServerIds?: Record<string, string>;
  providers: string[];
  capabilities?: { textBoundsMeasurementsSafe?: boolean; directoryCursorScan?: boolean; exactTimeline?: boolean; frameUploads?: boolean; frameUploadBindingGuard?: boolean; frameUploadRecoveryByUploadId?: boolean; reportBundles?: boolean };
}

// The last answer is kept in localStorage so a launch can render at once with it (main.tsx)
// while this page's own fetch refreshes it.
const CACHE_KEY = "bunny-info";
let pending: Promise<BoardInfo> | null = null;
let known: BoardInfo | null = readCached();

function readCached(): BoardInfo | null {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(CACHE_KEY);
    const v = raw ? (JSON.parse(raw) as BoardInfo) : null;
    return v && typeof v.publicBase === "string" ? v : null;
  } catch {
    return null;
  }
}

export function boardInfo(): Promise<BoardInfo> {
  if (!pending)
    pending = api<BoardInfo>("/api/ui/info")
      .then((i) => {
        known = i;
        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify(i));
        } catch {
          /* private mode */
        }
        return i;
      })
      .catch((e) => {
        pending = null;
        throw e;
      });
  return pending;
}

// The info fetched so far, or the last launch's (main.tsx waits briefly for it before the
// first render when there is none).
export function infoNow(): BoardInfo | null {
  return known;
}

export function publicBaseNow(): string {
  return known?.publicBase ?? window.location.origin;
}

export function usePublicBase(): string {
  const [base, setBase] = useState(publicBaseNow());
  useEffect(() => {
    boardInfo()
      .then((i) => setBase(i.publicBase))
      .catch(() => undefined);
  }, []);
  return base;
}

export function deepLink(base: string, board: string, frameId?: string | null): string {
  const q = new URLSearchParams({ board });
  if (frameId) q.set("frame", frameId);
  return `${base}/?${q}`;
}
