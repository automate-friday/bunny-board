// Phone shell: an error inside the shell shows a small "Reload view" bar instead of a blank
// page, and remounts the shell on tap; errors are sent to the board server
// (POST /api/ui/debug/client-error, readable at GET /api/ui/debug/client-errors). While the
// shell is up, uncaught errors and rejections on the page are reported the same way.
// A page the OS killed (iOS ends a tab over its memory limit and reloads it) runs no code to
// report anything: useKilledPageReport notices it on the next load instead.

import { Component, type ReactNode, useEffect, useRef } from "react";

let sent = 0;
let windowStart = 0;
// At most 10 reports a minute; never throws.
export function reportClientError(where: string, error: unknown) {
  try {
    const now = Date.now();
    if (now - windowStart > 60_000) {
      windowStart = now;
      sent = 0;
    }
    if (++sent > 10) return;
    const e = error instanceof Error ? error : new Error(String((error as { message?: unknown })?.message ?? error));
    void fetch("/api/ui/debug/client-error", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ where, message: e.message, stack: e.stack ?? "", url: location.pathname + location.search }), keepalive: true, credentials: "same-origin" }).catch(() => {});
  } catch {
    /* reporting must never break the page */
  }
}

// Page-wide errors while the phone shell is mounted.
export function usePageErrorReports() {
  useEffect(() => {
    const onError = (e: ErrorEvent) => reportClientError("window", e.error ?? e.message);
    const onRejection = (e: PromiseRejectionEvent) => reportClientError("unhandledrejection", e.reason);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
}

// While the shell is up, a note of what it shows (mode, frame, zoom, images) is kept in
// sessionStorage and removed when the page unloads normally (pagehide). A load that finds the
// note still there follows a page that ended without unloading, most likely killed by the
// OS for memory: that is reported as "previous-page-killed" with the note.
const ALIVE = "bunny-phone-alive";
export function useKilledPageReport(state: () => Record<string, unknown>) {
  const read = useRef(state);
  read.current = state;
  useEffect(() => {
    let store: Storage | null = null;
    try {
      store = window.sessionStorage;
      const prev = store.getItem(ALIVE);
      if (prev) reportClientError("previous-page-killed", new Error(`the previous page ended without unloading (most likely killed by the OS for memory); last seen: ${prev}`));
    } catch {
      return;
    }
    const write = () => {
      try {
        store?.setItem(ALIVE, JSON.stringify({ at: new Date().toISOString(), ...read.current() }));
      } catch {}
    };
    const bye = () => {
      try {
        store?.removeItem(ALIVE);
      } catch {}
    };
    write();
    const t = setInterval(write, 3000);
    // Back from the bfcache: the note was removed on pagehide.
    const show = () => write();
    window.addEventListener("pagehide", bye);
    window.addEventListener("pageshow", show);
    return () => {
      clearInterval(t);
      window.removeEventListener("pagehide", bye);
      window.removeEventListener("pageshow", show);
      bye();
    };
  }, []);
}

export class ShellErrorBoundary extends Component<{ children: ReactNode; onReset?: () => void }, { failed: boolean; generation: number }> {
  state = { failed: false, generation: 0 };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    (window as unknown as { __bmCrashOnce?: boolean }).__bmCrashOnce = false; // soak-test hook (MobileShell)
    reportClientError("mobile-shell", error);
  }
  render() {
    if (this.state.failed)
      return (
        <div data-testid="mobile-shell-error" role="alert" style={{ position: "absolute", zIndex: 500, left: 10, right: 10, top: "calc(env(safe-area-inset-top) + 10px)", display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 14, background: "#2E1F16", color: "#FFF8EB", font: "14px Inter, system-ui, sans-serif", boxShadow: "0 8px 24px rgba(0,0,0,.25)" }}>
          <span style={{ flex: 1 }}>Something went wrong in the phone view.</span>
          <button
            type="button"
            data-testid="mobile-shell-reload"
            onClick={() => {
              this.props.onReset?.();
              this.setState((s) => ({ failed: false, generation: s.generation + 1 }));
            }}
            style={{ border: 0, borderRadius: 999, padding: "8px 14px", background: "#8875F6", color: "#fff", font: "600 14px Inter, system-ui, sans-serif" }}
          >
            Reload view
          </button>
        </div>
      );
    return <ShellGeneration key={this.state.generation}>{this.props.children}</ShellGeneration>;
  }
}

function ShellGeneration({ children }: { children: ReactNode }) {
  usePageErrorReports();
  return <>{children}</>;
}
