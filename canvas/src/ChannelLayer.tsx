import { useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "tldraw";

/** Canvas channel annotations sit above shapes, below portals (240) and panels (250).
 * A sibling stacking context keeps even fixed badges and high-z offer chips behind
 * portal conversations; changing their individual z-indices inside canvas-in-front
 * cannot put them below a portal in a different stacking context.
 */
export function ChannelLayer({ editor, children }: { editor: Editor; children: ReactNode }) {
  const [layer, setLayer] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const host = editor.getContainer();
    const el = document.createElement("div");
    el.className = "bunny-channel-layer";
    Object.assign(el.style, { position: "absolute", inset: "0", zIndex: "230", pointerEvents: "none" });
    host.insertBefore(el, host.querySelector(":scope > .tlui-layout"));
    setLayer(el);
    return () => { el.remove(); };
  }, [editor]);
  return layer ? createPortal(children, layer) : null;
}
