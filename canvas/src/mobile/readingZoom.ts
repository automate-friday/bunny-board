// Phone shell: zoom far enough to read, wherever the shell shows the canvas (a frame with its
// thread open, collapsed or closed, and the board overview). The zoom range slides with the
// zoom (editModel.ts readingK): MOBILE_ZOOM_STEPS times a power of two. Every camera change and
// every camera-options change (the frame camera puts the board's steps back as it fits a
// frame) is checked, so the range is right for whichever state the shell is in. Mid-pinch too:
// tldraw re-reads the range on every touch move, so one pinch carries on past the old top.
// A jump (fit the frame, a double tap back, zoom to fit the board) would be clamped to the range
// in use before it could slide, so setCamera slides the range to the requested zoom first.

import { useEffect } from "react";
import { type Editor, react } from "tldraw";
import { jumpK, readingK } from "./editModel";
import { MOBILE_ZOOM_STEPS } from "./mobileMode";

const stepsFor = (k: number) => MOBILE_ZOOM_STEPS.map((s) => s * k);

export function useReadingZoom(editor: Editor, on: boolean) {
  useEffect(() => {
    if (!on) return;
    const slide = (z: number) => {
      const steps = editor.getCameraOptions().zoomSteps;
      const k = steps[0] / MOBILE_ZOOM_STEPS[0];
      const want = stepsFor(readingK(MOBILE_ZOOM_STEPS, z, editor.getBaseZoom(), k));
      if (steps.length !== want.length || steps.some((s, i) => s !== want[i])) editor.setCameraOptions({ zoomSteps: want });
    };
    // While a jump sets its range and then its camera, the clamp in between is not a zoom to follow.
    let jumping = false;
    let landing: ReturnType<typeof setTimeout> | undefined;
    const stop = react("phone-reading-zoom", () => {
      const z = editor.getZoomLevel();
      editor.getCameraOptions();
      if (!jumping) slide(z);
    });
    type SetCamera = Editor["setCamera"];
    const own = Object.prototype.hasOwnProperty.call(editor, "setCamera");
    const setCamera: SetCamera = editor.setCamera;
    editor.setCamera = ((point, opts) => {
      const z = (point as { z?: number }).z;
      if (!(typeof z === "number" && Number.isFinite(z) && z > 0) || jumping) return setCamera.call(editor, point, opts);
      jumping = true;
      try {
        // A jump below the board's range (the full-board fit of a very wide page) takes the
        // range down with it; otherwise the range slides as usual.
        const down = jumpK(MOBILE_ZOOM_STEPS, z, editor.getBaseZoom());
        if (down < 1) editor.setCameraOptions({ zoomSteps: stepsFor(down) });
        else slide(z);
        return setCamera.call(editor, point, opts);
      } finally {
        // An animated jump is one jump until it lands: the zooms on the way are not to follow.
        const ms = (opts as { animation?: { duration?: number } } | undefined)?.animation?.duration;
        const land = () => {
          jumping = false;
          slide(editor.getZoomLevel());
        };
        if (ms && ms > 0) {
          clearTimeout(landing);
          landing = setTimeout(land, ms + 60);
        } else land();
      }
    }) as SetCamera;
    return () => {
      clearTimeout(landing);
      stop();
      if (own) editor.setCamera = setCamera;
      else delete (editor as { setCamera?: SetCamera }).setCamera;
      editor.setCameraOptions({ zoomSteps: [...MOBILE_ZOOM_STEPS] });
    };
  }, [editor, on]);
}
