// The bottom dock: a row along the bottom right, next to the organizer's Bunny launcher,
// holding the docked frame panel (or its pill). Pinned frames live in the frame tabs
// (FrameTabs.tsx).
import { useEffect, useRef, useState } from "react";
import { useNarrow } from "./BoardControls";
import { BUNNY_CONTROLS_CSS } from "./bunnyTheme";

// Right of the row clears the Bunny launcher (right 16, bottom 52, 58 wide); on phones the
// row sits above the launcher, clear of the tool bar. On mid widths tldraw stacks its undo /
// redo / delete row above the tool bar, so the row also rises to clear the measured tool bar.
export function DockRow({ children }: { children: React.ReactNode }) {
  const narrow = useNarrow();
  const row = useRef<HTMLDivElement>(null);
  const toolbarClear = useToolbarClearance(row);
  return (
    <div
      ref={row}
      className="bunny-fp"
      data-testid="bottom-dock"
      style={{ position: "absolute", right: narrow ? 16 : 86, bottom: Math.max(narrow ? 122 : 62, toolbarClear), left: 16, zIndex: 300, display: "flex", flexDirection: "row-reverse", alignItems: "flex-end", gap: 8, pointerEvents: "none" }}
    >
      <style>{BUNNY_CONTROLS_CSS}</style>
      {children}
    </div>
  );
}

// Distance from the bottom of the dock's container to just above tldraw's main tool bar
// (including its stacked extras row), 0 until the tool bar is on screen.
function useToolbarClearance(row: React.RefObject<HTMLDivElement | null>): number {
  const [clear, setClear] = useState(0);
  useEffect(() => {
    let observed: Element | null = null;
    const measure = () => {
      const container = row.current?.offsetParent;
      // The tool bar lives in tldraw's UI layer, a sibling of the canvas layer the dock is in.
      const bar = row.current?.closest(".tl-container")?.querySelector(".tlui-main-toolbar__inner");
      if (bar && bar !== observed) {
        if (observed) resize.unobserve(observed);
        resize.observe(bar);
        observed = bar;
      }
      const top = bar?.getBoundingClientRect().top;
      const next = container && top !== undefined && top > 0 ? Math.round(container.getBoundingClientRect().bottom - top + 8) : 0;
      setClear((c) => (c === next ? c : next));
    };
    const resize = new ResizeObserver(measure);
    // The tool bar mounts after the dock and swaps layout at tldraw's breakpoints.
    const poll = window.setInterval(measure, 1000);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      resize.disconnect();
      window.clearInterval(poll);
      window.removeEventListener("resize", measure);
    };
  }, [row]);
  return clear;
}
