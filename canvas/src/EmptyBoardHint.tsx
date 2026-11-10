// First-run hint on a page with no frames: how to get an agent working, with starter
// prompts that answer "what is it for?". A starter draws a frame and opens its start form
// with the prompt filled in. The hint goes away as soon as the page has a frame.
import { perfCount } from "./perf";
import { useContext } from "react";
import { createShapeId, type Editor, useValue } from "tldraw";
import { B, softBtn, surface } from "./bunnyTheme";
import { pageFrames } from "./pageFrames";
import { MobileCtx } from "./mobile/mobileMode";
import { askStartSheet } from "./mobile/StartSheet";
import { QuickStarts } from "./QuickStarts";
import { setPendingPrompt, type Starter } from "./quickStartPrompts";

export function EmptyBoardHint({ editor }: { editor: Editor }) {
  const mobile = useContext(MobileCtx);
  const empty = useValue("empty-board", () => (perfCount("empty-board"), pageFrames(editor).get().length === 0), [editor]);
  const drawing = useValue("frame-tool", () => editor.getCurrentToolId() === "frame", [editor]);
  if (!empty) return null;
  const startWith = (s: Starter) => {
    const id = createShapeId();
    const c = editor.getViewportPageBounds().center;
    const w = 960;
    const h = 640;
    setPendingPrompt(id, s.prompt);
    editor.createShape({ id, type: "frame", x: c.x - w / 2, y: c.y - h / 2, props: { w, h, name: s.title.replace(/^Try: /, "") } });
    editor.select(id);
    if (mobile) askStartSheet(id);
  };
  return (
    <div
      data-testid="empty-board-hint"
      style={{ ...surface, position: "absolute", top: 64, left: "50%", transform: "translateX(-50%)", zIndex: 300, pointerEvents: "auto", padding: 16, width: 460, maxWidth: "calc(100vw - 32px)", boxSizing: "border-box", display: "flex", flexDirection: "column", gap: 14 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div>
        <strong style={{ display: "block", fontSize: 15, lineHeight: "20px" }}>What should an agent do?</strong>
        <span style={{ fontSize: 12, color: B.muted }}>Pick a starter: it draws a frame and fills in the prompt, which you can edit before it runs.</span>
      </div>
      <QuickStarts onPick={startWith} heading="Suggested" layout={mobile ? "row" : "grid"} />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, paddingTop: 2 }}>
        <span style={{ fontSize: 12, color: B.muted }}>Or draw your own frame (F) and choose <b style={{ fontWeight: 600 }}>Start conversation</b>.</span>
        <button type="button" data-testid="empty-board-draw-frame" style={{ ...softBtn, flex: "none" }} onClick={() => editor.setCurrentTool("frame")} disabled={drawing}>
          {drawing ? "Now drag on the board" : "Draw a frame"}
        </button>
      </div>
    </div>
  );
}
