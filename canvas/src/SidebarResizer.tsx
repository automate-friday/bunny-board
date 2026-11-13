import { useRef, useState } from "react";
import { B } from "./bunnyTheme";
import { clampSidebarWidth, defaultSidebarWidth, SIDEBAR_MIN, SIDEBAR_STEP } from "./sidebarMemory";

// The desktop sidebar's left edge: drag it to share the window between the whiteboard and
// the conversation. Double-click (or Enter) goes back to the default width; arrow keys
// nudge it (Shift for bigger steps). The width shows live while dragging and is committed
// once on release, so the board does not re-render on every pointer move.
export function SidebarResizer({ panel, width, onPreview, onCommit }: {
  panel: React.RefObject<HTMLElement | null>;
  width: number | null;
  onPreview: (width: number | null) => void;
  onCommit: (width: number | null) => void;
}) {
  const drag = useRef<{ x: number; w: number; id: number } | null>(null);
  const [active, setActive] = useState(false);
  const [hover, setHover] = useState(false);
  const vw = () => window.innerWidth;
  const current = () => panel.current?.getBoundingClientRect().width ?? width ?? defaultSidebarWidth(vw());
  const shown = Math.round(width ?? current());
  const end = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    setActive(false);
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    onCommit(clampSidebarWidth(d.w + (d.x - e.clientX), vw()));
  };
  return (
    <div
      data-testid="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the conversation panel"
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={Math.max(SIDEBAR_MIN, vw() - SIDEBAR_MIN)}
      aria-valuenow={shown}
      title="Drag to resize · double-click to reset"
      tabIndex={0}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, w: current(), id: e.pointerId };
        setActive(true);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d && d.id === e.pointerId) onPreview(clampSidebarWidth(d.w + (d.x - e.clientX), vw()));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => onCommit(null)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? SIDEBAR_STEP * 4 : SIDEBAR_STEP;
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          e.stopPropagation();
          onCommit(clampSidebarWidth(current() + (e.key === "ArrowLeft" ? step : -step), vw()));
        } else if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          onCommit(null);
        }
      }}
      style={{ position: "absolute", top: 0, bottom: 0, left: -5, width: 10, cursor: "col-resize", touchAction: "none", zIndex: 3, outline: "none", display: "flex", justifyContent: "center" }}
    >
      <span aria-hidden style={{ width: active ? 3 : 2, height: "100%", background: active || hover ? B.violet : "transparent", opacity: active ? 1 : 0.6, transition: "background 120ms ease-out" }} />
    </div>
  );
}
