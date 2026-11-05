// Landscape = an immersive whiteboard (from an iPhone: "make landscape like a video player which full
// screens the whiteboard for me to zoom around and we switch to hidden button to open
// interfaces"). In the phone shell, turned landscape on a frame or the board view:
// - the shell's chrome is hidden: top bar, quick-switch strip, bottom bar, the thread, search
//   and start sheets, Bunny's launcher, the editing chips. Hidden with CSS, never unmounted, so
//   turning back to portrait finds everything as it was: the open frame, the thread open or
//   collapsed, an unsent draft, the camera;
// - the canvas is a map: one-finger pan, pinch zoom, double-tap zoom; nothing is picked up or
//   edited, and canvas taps that would change the shell (open a frame, collapse the thread) do
//   nothing (`immersiveNow`);
// - a small semi-transparent corner button shows the chrome as an overlay; it hides again after
//   REVEAL_MS or on a second tap;
// - the point in the middle of what is visible stays there across the rotation (portrait: the
//   band above the thread sheet or bar; landscape: the whole screen).
// The tiles home (a list, not a whiteboard) stays as it is in landscape.

import { useEffect, useRef, useState } from "react";
import { type Editor, react } from "tldraw";
import "./immersive.css";

export const REVEAL_MS = 4000;

let immersive = false;
let revealed = false;
// Landscape whiteboard (chrome may be shown as an overlay): no editing, no canvas-tap navigation.
export const immersiveNow = () => immersive;

const landscapeNow = () => typeof window !== "undefined" && window.innerWidth > window.innerHeight;

// The middle of what is visible of the canvas (client px): the whole screen in the immersive
// landscape; otherwise between the top bar (and quick-switch strip) and whatever covers the
// bottom (the thread sheet at any stop, or the bar).
export function visibleMiddle(): { x: number; y: number } {
  const root = document.documentElement;
  if (root.classList.contains("bm-immersive") && !root.classList.contains("bm-revealed")) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  const top = Math.max(document.querySelector(".bm-top")?.getBoundingClientRect().bottom ?? 0, document.querySelector(".bm-switch")?.getBoundingClientRect().bottom ?? 0);
  const covers = [document.querySelector(".bm-dock"), document.querySelector('[data-testid="sidebar"][data-sheet="1"]')].flatMap((e) => (e && e.getBoundingClientRect().height ? [e.getBoundingClientRect().top] : []));
  const bottom = covers.length ? Math.min(...covers) : window.innerHeight;
  return { x: window.innerWidth / 2, y: (top + bottom) / 2 };
}

export function useLandscape(): boolean {
  const [on, setOn] = useState(landscapeNow);
  useEffect(() => {
    const update = () => setOn(landscapeNow());
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);
  return on;
}

export function Immersive({ editor, active }: { editor: Editor; active: boolean }) {
  const landscape = useLandscape();
  const on = active && landscape;
  const [shown, setShown] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    immersive = on;
    const root = document.documentElement;
    root.classList.toggle("bm-immersive", on);
    if (!on) setShown(false);
    return () => {
      immersive = false;
      root.classList.remove("bm-immersive");
    };
  }, [on]);
  useEffect(() => {
    revealed = on && shown;
    document.documentElement.classList.toggle("bm-revealed", revealed);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (revealed) hideTimer.current = setTimeout(() => setShown(false), REVEAL_MS);
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [on, shown]);

  // Landscape is a viewer: the hand tool while it lasts, the tool from before when it ends.
  useEffect(() => {
    if (!on) return;
    const before = editor.getCurrentToolId();
    if (before !== "hand") editor.setCurrentTool("hand");
    return () => {
      if (before !== "hand" && editor.getCurrentToolId() === "hand") editor.setCurrentTool(before);
    };
  }, [editor, on]);

  // The middle of what is visible stays put across a rotation: remember the page point under it
  // and put it back under the middle of what is visible after. (In portrait that is the band
  // between the top bar and the thread sheet or bar; in landscape, the whole screen.)
  useEffect(() => {
    if (!active) return;
    const pagePoint = () => editor.screenToPage(visibleMiddle());
    let centre = pagePoint();
    let size = `${window.innerWidth}x${window.innerHeight}`;
    let settling = false;
    const refresh = () => {
      if (!settling && `${window.innerWidth}x${window.innerHeight}` === size) centre = pagePoint();
    };
    const stop = react("phone-rotation-centre", () => {
      editor.getCamera();
      refresh();
    });
    // The visible band also moves without the camera (the thread sheet settling, a draft
    // growing the reply box): look again a few times a second.
    const poll = setInterval(refresh, 250);
    const onResize = () => {
      const next = `${window.innerWidth}x${window.innerHeight}`;
      if (next === size) return;
      const was = centre;
      size = next;
      settling = true;
      // Again after a moment: tldraw takes the new viewport size on the next frame, and the
      // shell's chrome hides or shows.
      const put = () => {
        const m = visibleMiddle();
        const v = editor.getViewportScreenBounds();
        const z = editor.getZoomLevel();
        editor.setCamera({ x: (m.x - v.x) / z - was.x, y: (m.y - v.y) / z - was.y, z }, { immediate: true });
      };
      requestAnimationFrame(() => {
        put();
        setTimeout(() => {
          put();
          settling = false;
          centre = pagePoint();
        }, 150);
      });
    };
    window.addEventListener("resize", onResize);
    return () => {
      stop();
      clearInterval(poll);
      window.removeEventListener("resize", onResize);
    };
  }, [editor, active]);

  if (!on) return null;
  return (
    <button
      type="button"
      className="bm-immersive-reveal"
      data-testid="mobile-immersive-reveal"
      aria-pressed={shown}
      aria-label={shown ? "Hide the controls" : "Show the controls"}
      onClick={() => setShown((s) => !s)}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {shown ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
      </svg>
    </button>
  );
}
