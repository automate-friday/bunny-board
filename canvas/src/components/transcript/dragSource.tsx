// Sidebar handle for the transcript card: drag it onto the board (HTML5 drag and drop,
// handled by the canvas drop hook in registry.ts), or press "Pin to board" on touch
// devices, which places the card beside the frame.

import { type Editor, type TLShapeId, useValue } from "tldraw";
import { TRANSCRIPT_TYPE, transcriptDefaults } from "../../../../shared/components/transcript";
import { DRAG_MIME, type DragPayload, placeBeside } from "../place";

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

export function TranscriptDragSource({ editor, agentId, frameId }: { editor: Editor; agentId: string; frameId: string }) {
  const source = useValue("transcript-drag-owner", () => editor.getShape(frameId as TLShapeId), [editor, frameId]);
  const binding = (source?.meta as { paseo?: { agentId?: string } })?.paseo;
  const valid = binding?.agentId === agentId;
  const title = source?.type === "frame" ? String((source.props as { name?: string }).name || "Unnamed frame") : "Missing frame";
  const stillBound = () => (editor.getShape(frameId as TLShapeId)?.meta as { paseo?: { agentId?: string } })?.paseo?.agentId === agentId;
  const payload: DragPayload = { type: TRANSCRIPT_TYPE, props: { agentId } };
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <span
        data-testid="drag-transcript"
        draggable={valid}
        onDragStart={(e) => {
          if (!stillBound()) { e.preventDefault(); return; }
          e.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
          e.dataTransfer.effectAllowed = "copy";
        }}
        style={handle}
        title={`Transcript of ${title} · ${agentId}. Drop moves the card, not its conversation identity.`}
      >
        ⠿ Drag transcript to board
      </span>
      <span style={{ fontSize: 11, color: "#666", width: "100%", overflowWrap: "anywhere" }} data-testid="transcript-source">{title} · agent {agentId.slice(0, 8)}{valid ? "" : " · binding changed; select the frame again"}</span>
      <button
        type="button"
        data-testid="pin-transcript"
        disabled={!valid}
        onClick={() => { if (stillBound()) placeBeside(editor, frameId as TLShapeId, TRANSCRIPT_TYPE, transcriptDefaults(agentId) as never); }}
        style={{ ...handle, cursor: "pointer", borderStyle: "solid" }}
      >
        Pin to board
      </button>
    </div>
  );
}
