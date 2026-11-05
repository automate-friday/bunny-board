// One tray entry: drag it onto the board (DRAG_MIME → handleComponentDrop → placeAt), or
// tap it to place the widget beside the selected frame (or in the middle of the view).

import type { Editor, TLShapeId } from "tldraw";
import { type AnyConfig, WIDGET_TYPE, type WidgetManifest, widgetProps } from "../../../../shared/widgets";
import { DRAG_MIME, type DragPayload, placeAt, placeBeside } from "../place";
import { endGhost, GRAB, startGhost } from "./Ghost";
import { WidgetIcon } from "./icons";

export function placeWidgetByTap(editor: Editor, m: WidgetManifest, config: AnyConfig = {}): TLShapeId {
  const props = { ...widgetProps(m.id, config) };
  const frame = editor.getSelectedShapes().find((s) => s.type === "frame");
  if (frame) return placeBeside(editor, frame.id, WIDGET_TYPE, props);
  const c = editor.getViewportPageBounds().center;
  return placeAt(editor, WIDGET_TYPE, props, { x: c.x - props.w / 2, y: c.y - props.h / 2 });
}

// A preset is a pre-filled config with its own tray label (the app widget's catalog).
export interface WidgetPreset {
  id: string;
  label: string;
  description: string;
  config: AnyConfig;
  title?: string;
  // Small tag after the label, e.g. the license.
  badge?: string;
  badgeTone?: "good" | "muted";
}

export function WidgetDragSource({ editor, manifest, preset, onPlaced, onDragging }: { editor: Editor; manifest: WidgetManifest; preset?: WidgetPreset; onPlaced?: () => void; onDragging?: () => void }) {
  // offset: where the cursor holds the card, so the drop lands where the ghost was.
  const config = preset?.config ?? {};
  const payload: DragPayload = { type: WIDGET_TYPE, props: { widgetId: manifest.id, config }, offset: GRAB };
  return (
    <button
      type="button"
      data-testid={preset ? `tray-preset-${manifest.id}-${preset.id}` : `tray-widget-${manifest.id}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
        e.dataTransfer.effectAllowed = "copy";
        startGhost(e, manifest, editor.getZoomLevel());
        onDragging?.();
      }}
      onDragEnd={() => {
        endGhost();
        onPlaced?.();
      }}
      onClick={() => {
        placeWidgetByTap(editor, manifest, config);
        onPlaced?.();
      }}
      title={preset?.title ?? "Drag onto the board, or tap to add it"}
      style={preset ? { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 1, minWidth: 0, textAlign: "left", padding: "5px 8px", border: "1px solid #e1e4ea", borderRadius: 8, background: "#fff", cursor: "grab", font: "11px system-ui" } : { display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", padding: "8px 10px", border: "1px solid #e1e4ea", borderRadius: 10, background: "#fff", cursor: "grab", font: "12px system-ui" }}
    >
      {preset ? (
        <>
          <span style={{ display: "flex", alignItems: "baseline", gap: 5, maxWidth: "100%" }}>
            <b style={{ fontSize: 12 }}>{preset.label}</b>
            {preset.badge ? (
              <span data-testid="tray-preset-badge" style={{ fontSize: 10, borderRadius: 4, padding: "0 4px", whiteSpace: "nowrap", ...(preset.badgeTone === "good" ? { color: "#1e7a3a", background: "#e6f4ea", border: "1px solid #b7dfc3" } : { color: "#667", border: "1px solid #e1e4ea" }) }}>
                {preset.badge}
              </span>
            ) : null}
          </span>
          <span style={{ color: "#778", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}>{preset.description}</span>
        </>
      ) : (
        <>
          <span style={{ color: "#333", display: "inline-flex" }}>
            <WidgetIcon name={manifest.icon} size={22} />
          </span>
          <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
            <b style={{ fontSize: 13 }}>{manifest.label}</b>
            <span style={{ color: "#667" }}>{manifest.description}</span>
          </span>
        </>
      )}
    </button>
  );
}
