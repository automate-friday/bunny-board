// First-run hint on a page with no frames: how to get an agent working. It goes away as
// soon as the page has a frame.
import { perfCount } from "./perf";
import { type Editor, useValue } from "tldraw";
import { B, primaryBtn, surface } from "./bunnyTheme";
import { pageFrames } from "./pageFrames";

export function EmptyBoardHint({ editor }: { editor: Editor }) {
  const empty = useValue("empty-board", () => (perfCount("empty-board"), pageFrames(editor).get().length === 0), [editor]);
  const drawing = useValue("frame-tool", () => editor.getCurrentToolId() === "frame", [editor]);
  if (!empty) return null;
  return (
    <div
      data-testid="empty-board-hint"
      style={{ ...surface, position: "absolute", top: 64, left: "50%", transform: "translateX(-50%)", zIndex: 300, pointerEvents: "auto", padding: "12px 16px", maxWidth: "min(440px, calc(100vw - 32px))", display: "flex", flexDirection: "column", gap: 8 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <strong style={{ fontSize: 14 }}>Put an agent to work</strong>
      <ol style={{ margin: 0, paddingLeft: 18, color: B.espresso }}>
        <li>Draw a frame (F) around an idea, or an empty one.</li>
        <li>Select the frame and choose <b>Start conversation</b>.</li>
        <li>Say what you want. The agent replies in the sidebar and writes stickies in the frame.</li>
      </ol>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button type="button" data-testid="empty-board-draw-frame" style={primaryBtn} onClick={() => editor.setCurrentTool("frame")} disabled={drawing}>
          {drawing ? "Now drag on the board" : "Draw a frame"}
        </button>
      </div>
    </div>
  );
}
