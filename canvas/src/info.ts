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
  machine?: string;
  paseoServerId?: string | null;
  paseoServerIds?: Record<string, string>;
  providers: string[];
  capabilities?: { textBoundsMeasurementsSafe?: boolean; directoryCursorScan?: boolean; exactTimeline?: boolean; frameUploads?: boolean; frameUploadBindingGuard?: boolean; frameUploadRecoveryByUploadId?: boolean; reportBundles?: boolean };
}

let pending: Promise<BoardInfo> | null = null;
let known: BoardInfo | null = null;

export function boardInfo(): Promise<BoardInfo> {
  if (!pending)
    pending = api<BoardInfo>("/api/ui/info")
      .then((i) => (known = i))
      .catch((e) => {
        pending = null;
        throw e;
      });
  return pending;
}

// The info fetched so far (main.tsx waits briefly for it before the first render).
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
