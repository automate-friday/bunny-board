import { useVisualViewport } from "./visualViewport";
import { useEffect, useRef, useState } from "react";
import { COMPONENTS_VERSION } from "../../shared/components/transcript";
declare const __CANVAS_BUILD_ID__: string;
export function RefreshNotice({ embedded = false, onStatus }: { embedded?: boolean; onStatus?: (status: string) => void } = {}) {
  const viewport = useVisualViewport();
  const mobile = viewport.width <= 600;
  const [serverId, setServerId] = useState<string | null>(null), [error, setError] = useState<string | null>(null), [checking, setChecking] = useState(false), [open, setOpen] = useState(false), [checkedAt, setCheckedAt] = useState<number | null>(null);
  const runCheck = useRef<() => void>(() => {});
  useEffect(() => {
    const ctl = new AbortController(); let busy = false;
    const check = async () => {
      if (busy || ctl.signal.aborted) return; busy = true; setChecking(true);
      try {
        const res = await fetch(`/?canvas-version-check=${Date.now()}`, { cache: "no-store", signal: AbortSignal.any([ctl.signal, AbortSignal.timeout(8000)]) });
        if (!res.ok) throw Error(`HTTP ${res.status}`);
        const doc = new DOMParser().parseFromString(await res.text(), "text/html");
        const id = doc.querySelector('meta[name="canvas-build"]')?.getAttribute("content");
        if (!id) throw Error("The server did not supply a canvas version.");
        if (!ctl.signal.aborted) { setServerId(id); setError(null); setCheckedAt(Date.now()); }
      } catch (e) { if (!ctl.signal.aborted) setError((e as Error).message); }
      finally { busy = false; if (!ctl.signal.aborted) setChecking(false); }
    };
    runCheck.current = () => void check(); void check();
    const timer = setInterval(() => void check(), 60000); window.addEventListener("focus", check);
    return () => { ctl.abort(); clearInterval(timer); window.removeEventListener("focus", check); runCheck.current = () => {}; };
  }, []);
  const panelReserve = Math.min(170, Math.max(0, viewport.height - 120));
  const newer = !!serverId && serverId !== __CANVAS_BUILD_ID__;
  useEffect(() => { onStatus?.(newer ? "canvas update available" : error ? "version check failed" : ""); }, [newer, error, onStatus]);
  return <>
    <div onPointerDown={e => e.stopPropagation()} onPointerUp={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} style={{ position: embedded ? "relative" : "fixed", ...(!embedded && mobile ? { top: viewport.top + viewport.height - (open ? panelReserve : 54), right: 8, transform: "translateY(-100%)", maxHeight: open ? Math.max(0, viewport.height - panelReserve - 8) : undefined, display: "flex", flexDirection: "column" } : embedded ? {} : { bottom: 54, left: 8 }), zIndex: mobile ? 350 : 1000, padding: 6, maxWidth: !embedded && mobile ? "calc(100vw - 16px)" : 440, boxSizing: "border-box", background: "#fff", border: "1px solid #ccc", borderRadius: 6, font: "11px system-ui", pointerEvents: "all" }}>
      <button type="button" data-testid="canvas-version-toggle" style={{ flexShrink: 0 }} onClick={() => setOpen(v => !v)} aria-expanded={open}>{mobile && !embedded ? "Version" : "Canvas version"}{newer ? mobile ? " · update" : " · update available" : error ? mobile ? " · error" : " · check failed" : ""}</button>
      {open ? <div data-testid="canvas-version-details" style={{ overflowWrap: "anywhere", minHeight: 0, overflowY: "auto" }}>
        <div>Loaded: {__CANVAS_BUILD_ID__} · component schema {COMPONENTS_VERSION}</div><div>Server: {serverId ?? "not checked"}</div>
        {checkedAt ? <div>Last successful check: {new Date(checkedAt).toLocaleTimeString()}</div> : null}
        {error ? <div role="alert">Version check failed: {error}. Loaded canvas retained.</div> : null}
        <button type="button" data-testid="canvas-version-check" disabled={checking} onClick={() => runCheck.current()}>{checking ? "Checking…" : "Check for updates"}</button>
        <div>Refresh only after saving drafts and board sync completes.</div><button type="button" onClick={() => window.location.reload()}>Refresh canvas</button>
      </div> : null}
    </div>
    {newer && !mobile && !embedded ? <div role="status" data-testid="refresh-notice" style={{ position: "fixed", top: 60, left: 8, right: 8, zIndex: 10000, padding: 10, background: "#fff4d6", border: "1px solid #a66a00", borderRadius: 8, font: "13px system-ui", pointerEvents: "all" }}>A newer canvas is available ({serverId}). Finish typing and wait for board sync before refreshing. <button type="button" onClick={() => window.location.reload()}>Refresh canvas</button></div> : null}
  </>;
}
