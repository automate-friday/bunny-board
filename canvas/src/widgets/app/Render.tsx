// App window body: the app in a sandboxed iframe with reload, open-in-new-tab and a
// fit-zoom toggle (renders the page at desktop width and scales it down to the widget).
// When the server says the app refuses framing (X-Frame-Options / CSP frame-ancestors), or
// the app is unreachable, it shows a status card (favicon, title, health, latency, Open)
// instead of a blank iframe. Health comes from the board server's probe; the iframe is
// loaded by the viewer's browser directly, never proxied.

import { useEffect, useRef, useState } from "react";
import { type AppConfig, type AppData, appHost, appTitle } from "../../../../shared/widgets/app";
import { WIDGET_STATUS_COLOR } from "../../components/widget/Render";
import { WidgetIcon } from "../../components/widget/icons";
import type { WidgetBodyProps } from "../registry";

// The width a desktop layout expects; fit-zoom renders the page this wide, scaled down.
const DESKTOP_W = 1280;

// No allow-top-navigation: the app cannot navigate the board away. allow-same-origin is
// dropped if the app shares the board's origin, or the sandbox would not hold.
function sandboxFor(url: string): string {
  const base = "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals";
  try {
    return new URL(url).origin === window.location.origin ? base : `${base} allow-same-origin`;
  } catch {
    return base;
  }
}

function useSize(ref: React.RefObject<HTMLElement | null>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

const ms = (n: number | null) => (n === null ? "" : n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`);

function healthText(d: AppData): string {
  if (d.health === "live") return `${ms(d.latencyMs)}${d.httpStatus ? ` · HTTP ${d.httpStatus}` : ""}`;
  return d.reason ?? d.health;
}

const btn: React.CSSProperties = { border: "1px solid light-dark(#dde1e7, var(--bunny-line))", background: "light-dark(#fff, var(--bunny-surface))", borderRadius: 6, padding: "2px 5px", cursor: "pointer", color: "light-dark(#445, var(--bunny-muted))", display: "inline-flex", alignItems: "center", gap: 4, font: "11px system-ui", textDecoration: "none" };

function Favicon({ url, size }: { url: string; size: number }) {
  const [ok, setOk] = useState(true);
  let src = "";
  try {
    src = `${new URL(url).origin}/favicon.ico`;
  } catch {
    /* no favicon */
  }
  if (!src || !ok)
    return (
      <span style={{ color: "light-dark(#556, var(--bunny-muted))", display: "inline-flex" }}>
        <WidgetIcon name="app" size={size} />
      </span>
    );
  return <img data-testid="app-favicon" src={src} alt="" width={size} height={size} referrerPolicy="no-referrer" onError={() => setOk(false)} style={{ borderRadius: 4, objectFit: "contain" }} />;
}

function StatusCard({ config, data, why }: { config: AppConfig; data: AppData; why: "blocked" | "unreachable" }) {
  const color = WIDGET_STATUS_COLOR[data.health];
  return (
    <div data-testid="app-status-card" data-why={why} style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, boxSizing: "border-box", background: "light-dark(#f8f9fb, var(--bunny-surface))" }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, maxWidth: 360, textAlign: "center" }}>
        <Favicon url={config.url} size={36} />
        <div style={{ fontSize: 17, fontWeight: 650, color: "light-dark(#223, var(--bunny-ink))" }}>{appTitle(config)}</div>
        <div style={{ color: "light-dark(#667, var(--bunny-muted))", wordBreak: "break-all" }}>{appHost(config.url)}</div>
        <div data-testid="app-card-health" style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "light-dark(#334, var(--bunny-ink))" }}>
          <span style={{ width: 9, height: 9, borderRadius: 5, background: color }} />
          <b>{data.health === "live" ? "Live" : data.health === "stale" ? "Degraded" : "Down"}</b>
          <span style={{ color: "light-dark(#667, var(--bunny-muted))" }}>{healthText(data)}</span>
        </div>
        <div data-testid="app-card-why" style={{ color: "light-dark(#778, var(--bunny-muted))", fontSize: 11, lineHeight: 1.4 }}>
          {why === "blocked" ? `This app does not allow being shown inside other pages (${data.frame.reason}).` : "The board server cannot reach this app, so the window would be blank."}
        </div>
        <a data-testid="app-open" href={config.url} target="_blank" rel="noopener noreferrer" style={{ ...btn, background: "#2f80ed", borderColor: "light-dark(#2f80ed, hsl(214 35% 39%))", color: "#fff", padding: "5px 14px", fontSize: 12 }}>
          <WidgetIcon name="external" size={14} /> Open {appTitle(config)}
        </a>
      </div>
    </div>
  );
}

export function AppBody({ config, state }: WidgetBodyProps) {
  const c = config as AppConfig;
  const d = state?.data as AppData | null;
  const [nonce, setNonce] = useState(0);
  const [fit, setFit] = useState(true);
  const viewport = useRef<HTMLDivElement>(null);
  const size = useSize(viewport);
  if (!d) return <div style={{ color: "light-dark(#778, var(--bunny-muted))", padding: 12 }}>{state?.status === "error" ? state.reason : "Checking the app…"}</div>;
  const blocked = d.frame.allowed === false;
  // Unreachable and never framed before: a blank iframe would say nothing.
  const down = d.health === "error";
  const scale = fit && size.w > 0 ? Math.min(1, size.w / DESKTOP_W) : 1;
  return (
    <div data-testid="app-body" data-health={d.health} data-framed={blocked || down ? "no" : "yes"} style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", borderBottom: "1px solid light-dark(#eef0f3, var(--bunny-line))", background: "light-dark(#fbfbfc, var(--bunny-surface))" }}>
        <Favicon url={c.url} size={14} />
        <span data-testid="app-url" title={c.url} style={{ flex: 1, minWidth: 0, color: "light-dark(#556, var(--bunny-muted))", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontFamily: "ui-monospace, monospace", fontSize: 11 }}>
          {c.url}
        </span>
        <span data-testid="app-latency" title={`checked ${new Date(d.checkedAt).toLocaleTimeString()} · ${d.method ?? ""} ${d.target}`} style={{ color: d.health === "live" ? "light-dark(#2a7a3f, hsl(136 50% 74%))" : d.health === "stale" ? "light-dark(#8a6400, hsl(43 88% 74%))" : "light-dark(#b3261e, hsl(3 71% 74%))", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
          {d.health === "live" ? ms(d.latencyMs) : d.health === "stale" ? (d.reason ?? "stale") : "down"}
        </span>
        {!blocked && !down ? (
          <>
            <button type="button" data-testid="app-fit" aria-pressed={fit} title={fit ? "Fit: desktop page scaled to the window (click for actual size)" : "Actual size (click to fit the desktop page)"} onClick={() => setFit((v) => !v)} style={{ ...btn, background: fit ? "light-dark(#e8f0fe, hsl(218 45% 21%))" : "light-dark(#fff, var(--bunny-surface))", borderColor: fit ? "light-dark(#9bbcf3, hsl(218 35% 39%))" : "light-dark(#dde1e7, var(--bunny-line))" }}>
              <WidgetIcon name="fit" size={14} />
              {fit ? `${Math.round(scale * 100)}%` : "100%"}
            </button>
            <button type="button" data-testid="app-reload" title="Reload" aria-label="Reload" onClick={() => setNonce((n) => n + 1)} style={btn}>
              <WidgetIcon name="refresh" size={14} />
            </button>
          </>
        ) : null}
        <a data-testid="app-open-tab" href={c.url} target="_blank" rel="noopener noreferrer" title="Open in a new tab" aria-label="Open in a new tab" style={btn}>
          <WidgetIcon name="external" size={14} />
        </a>
      </div>
      <div ref={viewport} style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden", background: "light-dark(#fff, var(--bunny-surface))" }}>
        {blocked ? (
          <StatusCard config={c} data={d} why="blocked" />
        ) : down ? (
          <StatusCard config={c} data={d} why="unreachable" />
        ) : (
          <iframe
            key={nonce}
            data-testid="app-iframe"
            title={appTitle(c)}
            src={c.url}
            sandbox={sandboxFor(c.url)}
            referrerPolicy="no-referrer"
            loading="lazy"
            allow="clipboard-write; fullscreen"
            style={{ position: "absolute", left: 0, top: 0, border: 0, width: size.w / scale || "100%", height: size.h / scale || "100%", transform: scale === 1 ? undefined : `scale(${scale})`, transformOrigin: "0 0" }}
          />
        )}
      </div>
    </div>
  );
}
