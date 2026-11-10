// Placeholder parts shared by the drag ghost and a freshly mounted widget, so the ghost
// turns into the real widget without a visual jump: same header, same skeleton body.

import type { WidgetManifest } from "../../../../shared/widgets";
import { WidgetIcon } from "./icons";

let styled = false;
function ensureStyle(): void {
  if (styled || typeof document === "undefined") return;
  styled = true;
  const el = document.createElement("style");
  el.textContent = "@keyframes bunny-widget-shimmer{0%{background-position:-160px 0}100%{background-position:160px 0}}";
  document.head.appendChild(el);
}

const bar = (w: string): React.CSSProperties => ({
  height: 9,
  width: w,
  borderRadius: 5,
  background: "linear-gradient(90deg,light-dark(#eceef2, var(--bunny-raised)) 0px,light-dark(#f6f7f9, var(--bunny-surface)) 40px,light-dark(#eceef2, var(--bunny-raised)) 80px)",
  backgroundSize: "320px 100%",
  animation: "bunny-widget-shimmer 1.2s linear infinite",
});

// The body of a widget that has no data yet.
export function WidgetSkeleton({ rows = 3 }: { rows?: number }) {
  ensureStyle();
  const widths = ["72%", "54%", "86%", "40%", "64%", "78%"];
  return (
    <div data-testid="widget-skeleton" style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ ...bar("22px"), height: 22, borderRadius: 6, flexShrink: 0 }} />
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 5 }}>
            <div style={bar("30%")} />
            <div style={bar(widths[i % widths.length])} />
          </div>
        </div>
      ))}
    </div>
  );
}

// The whole card as the ghost shows it: real header (icon, label), grey dot, skeleton.
export function WidgetGhostCard({ manifest }: { manifest: WidgetManifest }) {
  return (
    <section style={{ width: manifest.size.w, height: manifest.size.h, display: "flex", flexDirection: "column", boxSizing: "border-box", background: "light-dark(#fff, var(--bunny-surface))", border: "1.5px dashed light-dark(#9aa0a6, var(--bunny-line))", borderRadius: 12, boxShadow: "0 10px 30px rgba(20,30,60,.18)", overflow: "hidden", font: "12px system-ui, sans-serif", color: "light-dark(#223, var(--bunny-ink))" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderBottom: "1px solid light-dark(#eef0f3, var(--bunny-line))", background: "light-dark(#f8f9fb, var(--bunny-surface))", minHeight: 20 }}>
        <span style={{ color: "light-dark(#3b4252, var(--bunny-muted))", display: "inline-flex" }}>
          <WidgetIcon name={manifest.icon} size={16} />
        </span>
        <span style={{ fontWeight: 650, fontSize: 13 }}>{manifest.label}</span>
        <span style={{ flex: 1 }} />
        <span style={{ width: 10, height: 10, borderRadius: 5, background: "light-dark(#9aa0a6, var(--bunny-raised))" }} />
      </header>
      <WidgetSkeleton rows={Math.max(1, Math.min(6, Math.floor((manifest.size.h - 40) / 44)))} />
    </section>
  );
}
