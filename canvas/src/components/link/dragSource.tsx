// Sidebar handle for a board link card: drag it onto this board or onto another board's
// tab (the drop makes a link card there), or copy the frame's deep link; pasting a board
// deep link onto any board also makes a link card (App.tsx url handler).

import { useState } from "react";
import { LINK_TYPE } from "../../../../shared/components/link";
import { deepLink, usePublicBase } from "../../info";
import { DRAG_MIME, type DragPayload } from "../place";

const handle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 8px",
  border: "1px dashed #8aa9d6",
  borderRadius: 6,
  background: "#f3f7fd",
  color: "#2a5aa0",
  cursor: "grab",
  userSelect: "none",
  fontSize: 12,
};

export function LinkDragSource({ boardId, frameId, title }: { boardId: string; frameId: string; title: string }) {
  const base = usePublicBase();
  const url = deepLink(base, boardId, frameId);
  const [copied, setCopied] = useState(false);
  const payload: DragPayload = { type: LINK_TYPE, props: { board: boardId, frameId, title } };
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <span
        data-testid="drag-link"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
          e.dataTransfer.setData("text/uri-list", url);
          e.dataTransfer.setData("text/plain", url);
          e.dataTransfer.effectAllowed = "copy";
        }}
        style={handle}
        title="Drag onto this board or another board's tab to make a link card to this frame"
      >
        ⠿ Drag link to this frame
      </span>
      <button
        type="button"
        data-testid="copy-frame-link"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(url)
            .then(() => setCopied(true))
            .catch(() => undefined);
          setTimeout(() => setCopied(false), 2000);
        }}
        style={{ ...handle, cursor: "pointer", borderStyle: "solid" }}
        title={url}
      >
        {copied ? "Copied" : "Copy link"}
      </button>
    </div>
  );
}
