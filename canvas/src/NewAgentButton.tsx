// Desktop "+ New agent" in the top-left bar, beside the page menu: an empty frame next to the
// frame you are in (the selected one, else the open conversation's), selected and in view, its
// panel open on the start form (FramePanel's startRequested). The phone has "+ New" in its top
// bar (mobile/MobileShell.tsx).

import { createShapeId, DefaultMenuPanel, type Editor, type TLShapeId, useEditor } from "tldraw";
import { startRequested } from "./FramePanel";
import { newFrameSpot } from "./mobile/mobileMode";
import { besideFrame } from "./mobile/placement";

// The frame whose conversation the sidebar shows (set by Sidebar while it is open).
let conversationFrame: string | null = null;
export function setConversationFrame(id: string | null) {
  conversationFrame = id;
}

function anchorFrame(editor: Editor): string | null {
  const sel = editor.getOnlySelectedShape();
  if (sel) {
    const frame = sel.type === "frame" ? sel : editor.findShapeAncestor(sel, (s) => s.type === "frame");
    if (frame) return frame.id;
  }
  return conversationFrame && editor.getShape(conversationFrame as TLShapeId) ? conversationFrame : null;
}

export function newAgentFrame(editor: Editor): string {
  const anchor = anchorFrame(editor);
  const page = (anchor && editor.getAncestorPageId(anchor as TLShapeId)) || editor.getCurrentPageId();
  const others = [...editor.getPageShapeIds(page)].flatMap((id) => (editor.getShape(id)?.type === "frame" ? (editor.getShapePageBounds(id) ?? []) : []));
  const b = anchor ? editor.getShapePageBounds(anchor as TLShapeId) : undefined;
  const at = b ? besideFrame(b, others) : newFrameSpot(others);
  const id = createShapeId();
  if (page !== editor.getCurrentPageId()) editor.setCurrentPage(page);
  editor.createShape({ id, type: "frame", parentId: page, x: at.x, y: at.y, props: { w: 960, h: 640, name: "New agent" } });
  startRequested.add(id);
  editor.select(id);
  editor.zoomToBounds({ x: at.x, y: at.y, w: 960, h: 640 }, { animation: { duration: 300 }, inset: 80 });
  return id;
}

const btn: React.CSSProperties = { pointerEvents: "auto", border: "1px solid light-dark(#c4b5fd, hsl(249 35% 39%))", background: "light-dark(#EFE8FE, hsl(259 45% 21%))", color: "light-dark(#5b47d6, hsl(248 73% 80%))", font: "600 13px Inter, system-ui, sans-serif", borderRadius: 999, padding: "6px 12px", margin: "6px 0 0 6px", cursor: "pointer", whiteSpace: "nowrap", height: 32 };

export function MenuPanelWithNewAgent() {
  const editor = useEditor();
  return (
    <div style={{ display: "flex", alignItems: "flex-start" }}>
      <DefaultMenuPanel />
      <button type="button" data-testid="new-agent" title="Start a new agent beside the frame you are in" style={btn} onPointerDown={(e) => e.stopPropagation()} onClick={() => newAgentFrame(editor)}>
        + New agent
      </button>
    </div>
  );
}
