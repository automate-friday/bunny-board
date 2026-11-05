// Widget tray: a toolbar button that opens a panel of installed widgets (shared/widgets).
// Each entry is a drag source; a tap places it instead (touch screens).

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { TldrawUiToolbarButton, useEditor } from "tldraw";
import { WIDGETS } from "../../../../shared/widgets";
import { pluginsHref, refreshInstalled, useDevPlugins, useInstalled } from "../../plugins/registry";
import { trayContents } from "../../plugins/tray";
import { WidgetDragSource } from "./dragSource";
import { WidgetGhostLayer } from "./Ghost";
import { WidgetIcon } from "./icons";

export function WidgetTrayButton() {
  const editor = useEditor();
  const [open, setOpen] = useState(false);
  // While a widget is dragged the tray steps aside (it is not removed: the drag source
  // must stay in the DOM for dragend to fire).
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!open) return;
    // The registry may have changed on the plugins page (or in another tab).
    void refreshInstalled().catch(() => {});
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  const placed = () => {
    setDragging(false);
    setOpen(false);
  };
  const appManifest = WIDGETS.find((m) => m.id === "app");
  const installed = useInstalled();
  const devPlugins = useDevPlugins();
  const { widgets, apps } = trayContents(installed, devPlugins);
  return (
    <>
      <TldrawUiToolbarButton type="tool" data-testid="widget-tray-button" tooltip="Widgets" title="Widgets" isActive={open} onClick={() => setOpen((v) => !v)}>
        <WidgetIcon name="widgets" />
      </TldrawUiToolbarButton>
      <WidgetGhostLayer />
      {open
        ? createPortal(
            <div
              data-testid="widget-tray"
              onPointerDown={(e) => e.stopPropagation()}
              style={{ opacity: dragging ? 0 : 1, pointerEvents: dragging ? "none" : undefined, transition: "opacity 120ms", position: "fixed", left: "50%", bottom: 76, transform: "translateX(-50%)", zIndex: 400, width: "min(340px, calc(100vw - 32px))", maxHeight: "calc(100vh - 120px)", overflowY: "auto", background: "#f6f7f9", border: "1px solid #dde1e7", borderRadius: 14, boxShadow: "0 10px 30px rgba(20,30,60,.18)", padding: 10, display: "flex", flexDirection: "column", gap: 8, font: "12px system-ui" }}
            >
              <div style={{ display: "flex", alignItems: "center" }}>
                <b style={{ flex: 1, fontSize: 13 }}>Widgets</b>
                <button type="button" aria-label="Close widgets" onClick={() => setOpen(false)} style={{ border: "none", background: "transparent", cursor: "pointer", color: "#556", display: "inline-flex", padding: 2 }}>
                  <WidgetIcon name="close" size={16} />
                </button>
              </div>
              <div style={{ color: "#667" }}>Drag one onto the board, then set it up. Agents can add them too (board_widget).</div>
              {installed === null ? <div style={{ color: "#889" }}>Loading your plugins…</div> : null}
              {installed !== null && !widgets.length && !apps.length ? <div data-testid="tray-empty" style={{ color: "#667" }}>Nothing installed yet.</div> : null}
              {widgets.map((m) => (
                <WidgetDragSource key={m.id} editor={editor} manifest={m} onDragging={() => setTimeout(() => setDragging(true), 0)} onPlaced={placed} />
              ))}
              {appManifest && apps.length ? (
                <div data-testid="tray-app-catalog" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ color: "#556", fontWeight: 600 }}>Apps <span style={{ fontWeight: 400, color: "#889" }}>· ready-made app windows</span></div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
                    {apps.map((p) => (
                      <WidgetDragSource key={p.id} editor={editor} manifest={appManifest} preset={p} onDragging={() => setTimeout(() => setDragging(true), 0)} onPlaced={placed} />
                    ))}
                  </div>
                </div>
              ) : null}
              <a
                href={pluginsHref()}
                data-testid="tray-browse-plugins"
                style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "8px 10px", border: "1px dashed #c9ced6", borderRadius: 10, color: "#2d3442", textDecoration: "none", fontWeight: 600, fontSize: 12.5, background: "#fff" }}
              >
                <WidgetIcon name="widgets" size={16} /> Browse plugins
              </a>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
