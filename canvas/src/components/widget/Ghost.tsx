// Drag ghost for the widget tray: while a widget is dragged, a translucent copy of the
// card at its real default size (times the current zoom) follows the cursor instead of
// the browser's drag image. On drop the shape is created in that exact spot (the drag
// payload carries the grab offset), so the ghost becomes the widget in place.
//
// Lifecycle: one drag at a time. startGhost adds window listeners for dragover, drop and
// dragend; endGhost removes them, cancels the pending frame and clears the state, so no
// listener or rAF outlives the drag (window.__widgetGhost.listeners() is 0 after it).

import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { WidgetManifest } from "../../../../shared/widgets";
import { WidgetGhostCard } from "./Skeleton";

// Where the cursor holds the card: inside the header, a little in from the left.
export const GRAB = { x: 24, y: 16 };

interface Drag {
  manifest: WidgetManifest;
  zoom: number;
  x: number;
  y: number;
  visible: boolean;
}

let drag: Drag | null = null;
let raf = 0;
let pending: { x: number; y: number } | null = null;
let safety: ReturnType<typeof setTimeout> | null = null;
const subscribers = new Set<() => void>();
let attached = 0;
const notify = () => {
  for (const fn of subscribers) fn();
};

// A transparent 1x1 image hides the browser's own drag image.
const blank = typeof Image !== "undefined" ? Object.assign(new Image(), { src: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" }) : null;

function onOver(e: DragEvent): void {
  if (!drag) return;
  pending = { x: e.clientX, y: e.clientY };
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    if (!drag || !pending) return;
    drag = { ...drag, x: pending.x, y: pending.y, visible: true };
    notify();
  });
}
function onEnd(): void {
  endGhost();
}

export function startGhost(e: React.DragEvent, manifest: WidgetManifest, zoom: number): void {
  endGhost();
  if (blank) e.dataTransfer.setDragImage(blank, 0, 0);
  drag = { manifest, zoom, x: e.clientX, y: e.clientY, visible: false };
  window.addEventListener("dragover", onOver, true);
  window.addEventListener("drop", onEnd, true);
  window.addEventListener("dragend", onEnd, true);
  attached = 3;
  // If the browser never sends dragend (source removed mid-drag), do not keep a ghost.
  safety = setTimeout(endGhost, 60_000);
  notify();
}

export function endGhost(): void {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  pending = null;
  if (safety) clearTimeout(safety);
  safety = null;
  if (attached) {
    window.removeEventListener("dragover", onOver, true);
    window.removeEventListener("drop", onEnd, true);
    window.removeEventListener("dragend", onEnd, true);
    attached = 0;
  }
  if (drag) {
    drag = null;
    notify();
  }
}

export function isDragging(): boolean {
  return !!drag;
}

function useDrag(): Drag | null {
  return useSyncExternalStore(
    (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    () => drag,
  );
}

export function WidgetGhostLayer() {
  const d = useDrag();
  if (!d || !d.visible) return null;
  return createPortal(
    <div
      data-testid="widget-ghost"
      data-widget={d.manifest.id}
      style={{ position: "fixed", left: d.x - GRAB.x * d.zoom, top: d.y - GRAB.y * d.zoom, zIndex: 500, pointerEvents: "none", opacity: 0.6, transform: `scale(${d.zoom})`, transformOrigin: "0 0" }}
    >
      <WidgetGhostCard manifest={d.manifest} />
    </div>,
    document.body,
  );
}

if (typeof window !== "undefined") (window as unknown as { __widgetGhost: unknown }).__widgetGhost = { listeners: () => attached, subscribers: () => subscribers.size, active: () => !!drag };
