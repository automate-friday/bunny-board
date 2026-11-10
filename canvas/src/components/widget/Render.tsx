// Generic frame around every plugin widget: icon, label and config summary, a status dot
// (grey pulsing connecting, green live, amber stale, red error) with "last synced Ns ago",
// a gear that opens the config form, and the widget's own body (canvas/src/widgets).

import { useEffect, useState } from "react";
import { useEditor, useValue } from "tldraw";
import { DEV_PLUGIN_NOTE, isDevPlugin } from "../../../../shared/plugins";
import { type AnyConfig, isConfigured, type WidgetState, type WidgetStatus, widgetConfig, widgetKey, widgetLink, widgetManifest } from "../../../../shared/widgets";
import { widgetBodies } from "../../widgets/registry";
import { useWidgetState } from "../../widgets/store";
import { WidgetConfigForm } from "./ConfigForm";
import { WidgetIcon } from "./icons";
import { WidgetSkeleton } from "./Skeleton";
import type { WidgetShape } from "./shape";

export const WIDGET_STATUS_COLOR: Record<WidgetStatus, string> = { connecting: "#9aa0a6", live: "#2fa84f", stale: "#e0a100", error: "#d93025" };
const STATUS_TEXT: Record<WidgetStatus, string> = { connecting: "Connecting", live: "Live", stale: "Stale", error: "Error" };

let styled = false;
function ensureStyle(): void {
  if (styled || typeof document === "undefined") return;
  styled = true;
  const el = document.createElement("style");
  el.textContent = "@keyframes bunny-widget-pulse{0%,100%{opacity:1}50%{opacity:.3}}";
  document.head.appendChild(el);
}

function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function ago(at: number | null, now: number): string {
  if (!at) return "never synced";
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
}

export function StatusDot({ state }: { state: WidgetState | null }) {
  ensureStyle();
  const now = useNow(1000);
  const status = state?.status ?? "connecting";
  const synced = `last synced ${ago(state?.syncedAt ?? null, now)}`;
  const title = `${STATUS_TEXT[status]}${state?.reason ? ` · ${state.reason}` : ""} · ${synced}`;
  return (
    <span data-testid="widget-status" data-status={status} title={title} style={{ display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0, minWidth: 0, maxWidth: "55%" }}>
      <span style={{ width: 10, height: 10, borderRadius: 5, flexShrink: 0, background: WIDGET_STATUS_COLOR[status], boxShadow: `0 0 0 2px ${WIDGET_STATUS_COLOR[status]}33`, animation: status === "connecting" ? "bunny-widget-pulse 1.2s ease-in-out infinite" : undefined }} />
      <span data-testid="widget-status-text" style={{ fontSize: 11, color: status === "error" ? "light-dark(#b3261e, hsl(3 71% 74%))" : status === "stale" ? "light-dark(#8a6400, hsl(43 88% 74%))" : "light-dark(#667, var(--bunny-muted))", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {status === "error" || status === "stale" ? (state?.reason ?? STATUS_TEXT[status]) : status === "live" ? ago(state?.syncedAt ?? null, now) : "connecting…"}
      </span>
    </span>
  );
}

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

export function WidgetRender({ shape }: { shape: WidgetShape }) {
  const editor = useEditor();
  const { widgetId } = shape.props;
  const m = widgetManifest(widgetId);
  const readOnly = useValue("widget-readonly", () => editor.getIsReadonly() || editor.isShapeOrAncestorLocked(shape), [editor, shape]);
  let config: AnyConfig = shape.props.config;
  let configError: string | null = null;
  try {
    config = widgetConfig(widgetId, shape.props.config);
  } catch (e) {
    configError = (e as Error).message;
  }
  const configured = !configError && isConfigured(widgetId, config);
  const [editing, setEditing] = useState(false);
  const key = configured ? widgetKey(widgetId, config) : null;
  const live = useWidgetState(key);
  const state: WidgetState | null = configError ? { status: "error", data: null, reason: `invalid_config: ${configError}`, syncedAt: null, updatedAt: 0 } : live;
  const Body = widgetBodies[widgetId];
  const save = (next: AnyConfig) => {
    editor.updateShape<WidgetShape>({ id: shape.id, type: "widget", props: { config: next } });
    setEditing(false);
  };
  const setConfig = (patch: AnyConfig) => {
    if (readOnly) return;
    const merged: AnyConfig = { ...config, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v === "" || v === undefined || v === null) delete merged[k];
    try {
      save(widgetConfig(widgetId, merged));
    } catch {
      /* a body only offers valid choices */
    }
  };
  return (
    <section
      data-testid="widget-card"
      data-widget={widgetId}
      data-status={state?.status ?? (configured ? "connecting" : "unconfigured")}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("input,button,select,textarea,a,[data-scroll]")) e.stopPropagation();
      }}
      onKeyDown={stop}
      style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", boxSizing: "border-box", background: "light-dark(#fff, var(--bunny-surface))", border: `1.5px solid ${state ? `${WIDGET_STATUS_COLOR[state.status]}aa` : "light-dark(#c9ced6, var(--bunny-line))"}`, borderRadius: 12, boxShadow: "0 3px 14px rgba(20,30,60,.10)", overflow: "hidden", pointerEvents: "all", font: "12px system-ui, sans-serif", color: "light-dark(#223, var(--bunny-ink))" }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderBottom: "1px solid light-dark(#eef0f3, var(--bunny-line))", background: "light-dark(#f8f9fb, var(--bunny-surface))", minHeight: 20 }}>
        <span style={{ color: "light-dark(#3b4252, var(--bunny-muted))", display: "inline-flex" }}>
          <WidgetIcon name={m?.icon ?? "widgets"} size={16} />
        </span>
        <span style={{ fontWeight: 650, fontSize: 13, whiteSpace: "nowrap" }}>{m?.label ?? widgetId}</span>
        {/* Hidden from the store, tray and agents (shared/plugins.ts); existing ones still run. */}
        {isDevPlugin(widgetId) ? (
          <span data-testid="widget-dev-note" title={DEV_PLUGIN_NOTE} style={{ flexShrink: 0, fontSize: 10, fontWeight: 600, color: "light-dark(#7a5b00, hsl(45 88% 74%))", background: "light-dark(#fff4cc, hsl(47 45% 21%))", border: "1px solid light-dark(#f0dc94, hsl(47 35% 39%))", borderRadius: 6, padding: "1px 5px", whiteSpace: "nowrap" }}>
            developer plugin
          </span>
        ) : null}
        <span data-testid="widget-summary" style={{ color: "light-dark(#667, var(--bunny-muted))", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {m && configured ? m.summary(config, state) : ""}
        </span>
        {/* The widget's link out (manifest headerLink), e.g. "Open in Postiz": a new tab, never in place. */}
        {(() => {
          const link = m && configured ? widgetLink({ widgetId, config }, state) : null;
          return link ? (
            <a data-testid="widget-link" href={link.href} target="_blank" rel="noopener noreferrer" title={link.title ?? link.label} style={{ flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 3, color: "light-dark(#1d5fbf, hsl(216 74% 74%))", fontWeight: 600, fontSize: 11, textDecoration: "none", whiteSpace: "nowrap" }}>
              {link.label}
              <WidgetIcon name="external" size={13} />
            </a>
          ) : null;
        })()}
        {/* An invalid config is an error too: red dot with the reason, over the form to fix it. */}
        {configured || configError ? <StatusDot state={state} /> : null}
        {m && configured && !readOnly ? (
          <button type="button" data-testid="widget-configure" title="Configure" aria-label="Configure" onClick={() => setEditing((v) => !v)} style={{ border: "none", background: "transparent", cursor: "pointer", padding: 0, color: "light-dark(#556, var(--bunny-muted))", display: "inline-flex" }}>
            <WidgetIcon name="settings" size={16} />
          </button>
        ) : null}
      </header>
      <div data-scroll onWheel={stop} style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {!m ? (
          <div style={{ padding: 12 }}>Widget “{widgetId}” is not installed on this board server.</div>
        ) : !configured || editing ? (
          <WidgetConfigForm manifest={m} config={configError ? m.defaults() : config} readOnly={readOnly} onSave={save} onCancel={configured ? () => setEditing(false) : undefined} />
        ) : !state?.data && state?.status !== "error" && state?.status !== "stale" ? (
          // Mounted at once, before the server answers: skeleton and a grey dot.
          <WidgetSkeleton rows={Math.max(1, Math.min(6, Math.floor((shape.props.h - 40) / 44)))} />
        ) : Body ? (
          <Body config={config} state={state} widgetKey={key!} readOnly={readOnly} shapeId={shape.id} setConfig={setConfig} />
        ) : (
          <pre style={{ margin: 0, padding: 10, fontSize: 11 }}>{JSON.stringify(state?.data, null, 2)}</pre>
        )}
      </div>
    </section>
  );
}
