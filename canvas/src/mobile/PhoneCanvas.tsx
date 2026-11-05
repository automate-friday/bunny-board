// Phone shell: tldraw's canvas is not mounted behind the tiles home (bench/phone.ts).
// Mounting it builds tldraw's culling index, which needs the page bounds of every shape on
// the page (~1,400 on the live board): one ~400 ms task at 4x CPU throttle, before the
// tiles could respond, and nothing of it is seen under the opaque tiles.
//
// Instead the bounds are computed a few shapes at a time while the page is idle (tldraw caches
// them), and the canvas mounts once that is done (in a React transition, so in slices), or at
// once when a frame or the board is opened. Once mounted it stays mounted.

import { startTransition, useEffect, useState } from "react";
import { DefaultCanvas, useEditor, useValue, type Editor, type TLCanvasComponentProps } from "tldraw";
import { phoneView } from "./visibility";

type Idle = (cb: (d: { timeRemaining(): number; didTimeout: boolean }) => void, o?: { timeout: number }) => number;
const idle: Idle = (globalThis as { requestIdleCallback?: Idle }).requestIdleCallback ?? ((cb) => setTimeout(() => cb({ timeRemaining: () => 8, didTimeout: false }), 50) as unknown as number);

// Page bounds for every shape, in idle slices of at most ~8 ms. Resolves when done.
export function warmShapeBounds(editor: Editor, sliceMs = 8): { done: Promise<void>; cancel(): void } {
  let cancelled = false;
  const done = new Promise<void>((resolve) => {
    const ids = [...editor.getCurrentPageShapeIds()];
    let i = 0;
    const step = (d: { timeRemaining(): number }) => {
      if (cancelled) return resolve();
      const until = performance.now() + Math.min(sliceMs, Math.max(2, d.timeRemaining()));
      while (i < ids.length && performance.now() < until) editor.getShapePageBounds(ids[i++]);
      if (i < ids.length) idle(step, { timeout: 1000 });
      else resolve();
    };
    idle(step, { timeout: 1000 });
  });
  return { done, cancel: () => void (cancelled = true) };
}

export function PhoneCanvas(props: TLCanvasComponentProps) {
  const editor = useEditor();
  const tiles = useValue("phone tiles", () => phoneView.get().mode === "tiles", []);
  const [warm, setWarm] = useState(false);
  const [mounted, setMounted] = useState(!tiles);
  useEffect(() => {
    if (mounted) return;
    // Opened a frame or the board: now. Warmed up under the tiles: as a transition, which
    // React renders in slices between other work instead of one ~300 ms task.
    if (!tiles) {
      setMounted(true);
      return;
    }
    if (warm) {
      startTransition(() => setMounted(true));
      return;
    }
    // Let the tiles and their first thumbnails settle before starting.
    let job: ReturnType<typeof warmShapeBounds> | null = null;
    const t = setTimeout(() => {
      job = warmShapeBounds(editor);
      void job.done.then(() => setWarm(true));
    }, 1500);
    return () => {
      clearTimeout(t);
      job?.cancel();
    };
  }, [editor, tiles, warm, mounted]);
  return mounted ? <DefaultCanvas {...props} /> : null;
}
