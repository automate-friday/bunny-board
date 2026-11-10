import { AppIcon } from "./components/AppIcon";
import { type Editor, type TLShapeId, useValue } from "tldraw";
import { conversationFrameOf } from "./conversationFrame";
import { restoreTarget } from "./sidebarMemory";

// Always on screen on desktop, at the canvas's right edge (beside the sidebar when it is open,
// at the window edge when it is collapsed): one click collapses the conversation sidebar, one
// click brings back the last conversation it showed (sidebarMemory.ts).
export function SidebarToggle({ editor, open, last, onCollapse, onRestore }: { editor: Editor; open: boolean; last: string | null; onCollapse: () => void; onRestore: (frameId: string) => void }) {
  const target = useValue(
    "sidebar-toggle-target",
    () => {
      if (open) return null;
      const isFrame = (id: string) => editor.getShape(id as TLShapeId)?.type === "frame";
      const sel = editor.getOnlySelectedShape();
      const selected = sel ? conversationFrameOf(editor, sel)?.id ?? null : null;
      return restoreTarget(last, isFrame, selected, () => {
        // A conversation frame first; else any frame (its sidebar offers to start one).
        const frames = editor.getCurrentPageShapesSorted().filter((s) => s.type === "frame");
        // biome-ignore lint/suspicious/noExplicitAny: meta JSON.
        const bound = frames.find((s) => !!((s.meta as any)?.paseo?.agentId || (s.meta as any)?.paseo?.request));
        return (bound ?? frames[0])?.id ?? null;
      });
    },
    [editor, open, last],
  );
  const disabled = !open && !target;
  const label = open ? "Collapse sidebar" : disabled ? "No conversation to show: select a frame" : "Show sidebar";
  return (
    <button
      type="button"
      data-testid="sidebar-toggle"
      data-state={open ? "open" : "collapsed"}
      aria-label={label}
      aria-expanded={open}
      title={label}
      disabled={disabled}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => (open ? onCollapse() : target && onRestore(target))}
      style={{
        position: "absolute",
        right: 0,
        top: "50%",
        transform: "translateY(-50%)",
        zIndex: 400,
        width: 36,
        height: 64,
        padding: 0,
        border: "1px solid light-dark(#e2e8f0, var(--bunny-line))",
        borderRight: "none",
        borderRadius: "8px 0 0 8px",
        background: "light-dark(#fff, var(--bunny-surface))",
        boxShadow: "-2px 0 8px rgba(15,23,42,0.08)",
        color: disabled ? "light-dark(#cbd5e1, hsl(213 50% 74%))" : "light-dark(#475569, var(--bunny-muted))",
        font: "600 16px system-ui, sans-serif",
        cursor: disabled ? "default" : "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <AppIcon name={open ? "chevron-right" : "chevron-left"} />
    </button>
  );
}
