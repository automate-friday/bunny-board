import { useEffect, useState } from "react";

function visibleViewport() {
  const viewport = window.visualViewport;
  return { height: viewport?.height ?? window.innerHeight, width: viewport?.width ?? window.innerWidth, top: viewport?.offsetTop ?? 0, left: viewport?.offsetLeft ?? 0 };
}

// Safari chrome and the software keyboard can shrink/move the visible viewport
// without changing the layout viewport used by position:fixed.
export function useVisualViewport() {
  const [viewport, setViewport] = useState(visibleViewport);
  useEffect(() => {
    const update = () => setViewport(visibleViewport());
    const current = window.visualViewport;
    current?.addEventListener("resize", update);
    current?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    update();
    return () => { current?.removeEventListener("resize", update); current?.removeEventListener("scroll", update); window.removeEventListener("resize", update); };
  }, []);
  return viewport;
}
