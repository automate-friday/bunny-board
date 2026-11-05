// Phone shell: which shapes tldraw renders under the shell (bench/phone.ts measured it).
// Rendering a live board's ~1,400 shapes behind the opaque tiles home cost ~5 s of main
// thread on load at 4x CPU throttle (note labels, transcript cards, culling), and tldraw
// renders even off-screen (culled) shapes. So, through tldraw's getShapeVisibility:
// - tiles: nothing is rendered (the tiles cover the canvas);
// - frame: only the open frame (and the frames it sits in, without their other content);
// - board, or no phone shell: everything, as on desktop.
// A frame whose thumbnail is being exported is shown for that export: tldraw's SVG export
// skips hidden shapes.

import { atom } from "@tldraw/state";

type Shape = { id: string; parentId: string };
// bare: frames shown without their contents (a thumbnail's frame body, LiveThumb.tsx).
export type PhoneView = { mode: "off" | "tiles" | "frame" | "board"; keep: ReadonlySet<string>; ancestors: ReadonlySet<string>; bare?: ReadonlySet<string> };

const OFF: PhoneView = { mode: "off", keep: new Set(), ancestors: new Set() };
export const phoneView = atom<PhoneView>("phone-view", OFF);
let shown: { mode: PhoneView["mode"]; frameId: string | null } = { mode: "off", frameId: null };
const exporting = new Map<string, number>();
const bare = new Set<string>();

// The frames to render (`targets`) and the shapes they sit in.
export function viewFor(mode: PhoneView["mode"], targets: readonly string[], parentOf: (id: string) => string | undefined): PhoneView {
  if (mode === "off" || mode === "board") return { mode, keep: new Set(), ancestors: new Set() };
  const keep = new Set(targets);
  const ancestors = new Set<string>();
  for (const t of targets) {
    for (let p = parentOf(t), guard = 0; p && p.startsWith("shape:") && guard < 50; p = parentOf(p), guard++) {
      ancestors.add(p);
      keep.add(p);
    }
  }
  return { mode, keep, ancestors };
}

export function shapeVisibility(view: PhoneView, shape: Shape): "hidden" | "visible" | "inherit" {
  if (view.mode === "off" || view.mode === "board") return "inherit";
  if (view.keep.has(shape.id)) return "visible";
  if (view.bare?.has(shape.parentId)) return "hidden";
  // Siblings on the page or inside a kept frame's ancestors are hidden; anything inside a
  // kept frame inherits (shown); anything deeper in a hidden shape inherits (hidden).
  if (!shape.parentId.startsWith("shape:") || view.ancestors.has(shape.parentId)) return "hidden";
  return "inherit";
}

// tldraw's getShapeVisibility (MOBILE_TLDRAW): reads the atom, so tldraw re-evaluates on changes.
export const phoneShapeVisibility = (shape: Shape): "hidden" | "visible" | "inherit" => shapeVisibility(phoneView.get(), shape);

let parentOf: (id: string) => string | undefined = () => undefined;
function publish() {
  const targets = [...(shown.frameId && shown.mode === "frame" ? [shown.frameId] : []), ...exporting.keys()];
  const view = viewFor(shown.mode, targets, parentOf);
  phoneView.set(bare.size && view.mode !== "off" && view.mode !== "board" ? { ...view, bare: new Set(bare) } : view);
}

// MobileShell: what is on screen.
export function setPhoneView(mode: PhoneView["mode"], frameId: string | null, parent: (id: string) => string | undefined) {
  parentOf = parent;
  shown = { mode, frameId };
  publish();
}

// The frame open on screen (its contents must not be hidden for an export).
export const isFrameOnScreen = (frameId: string) => shown.mode === "frame" && shown.frameId === frameId;

// LiveThumb: show one frame while its thumbnail is exported; `withoutContents`: the frame
// alone (its children hidden).
export async function withFrameShown<T>(frameId: string, run: () => Promise<T>, withoutContents = false): Promise<T> {
  exporting.set(frameId, (exporting.get(frameId) ?? 0) + 1);
  if (withoutContents) bare.add(frameId);
  if (exporting.get(frameId) === 1 || withoutContents) publish();
  try {
    return await run();
  } finally {
    if (withoutContents) {
      bare.delete(frameId);
      publish();
    }
    const n = (exporting.get(frameId) ?? 1) - 1;
    if (n > 0) exporting.set(frameId, n);
    else {
      exporting.delete(frameId);
      publish();
    }
  }
}
