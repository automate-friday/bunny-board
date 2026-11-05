// Phone: light stand-ins for heavy shapes in the board overview (bench/phone.ts --overview).
//
// On the iPhone the page was killed by the OS in the whole-board view at 0.1x on a board of
// ~1,500 shapes (the killed-page report, 2026-11-04). tldraw mounts every shape's component,
// on screen or not, so the overview held the full DOM of every note label, link preview,
// transcript card (rows, live agent stream), cloud-session card and widget (timers),
// and every HTML report opened inline (an iframe: a whole document each). At 0.1x none of it is
// legible.
//
// So on the phone, below LOW_ZOOM (tldraw's debounced "efficient" zoom, so not mid-pinch),
// and also whenever it is culled (off screen: tldraw hides it, but its DOM stays), a shape renders a
// placeholder instead: its outline in its colour and, for cards, a title readable at that zoom.
// No subscription, timer or iframe is mounted. Above FULL_ZOOM the real shape comes back
// (the gap between the two keeps a pinch near the line from flipping it). Exports (thumbnails)
// always render the real shape. Off the phone nothing changes.

import { createElement, type ReactElement, type ReactNode, useRef } from "react";
import { HTMLContainer, type TLShape, useEditor, useSvgExportContext, useValue } from "tldraw";
import { phonePlaceholder } from "./lodRule";
import { phoneGeometryOn } from "./phoneGeometry";

export { FULL_ZOOM, LOW_ZOOM } from "./lodRule";

// Whether this shape shows its placeholder now. `heavy`: also while it is culled.
export function usePhonePlaceholder(id: string, heavy: boolean): boolean {
  const editor = useEditor();
  const exporting = useSvgExportContext();
  const low = useRef(false);
  const on = phoneGeometryOn() && !exporting;
  return useValue(
    "phone-lod",
    () => {
      if (!on) return false;
      const next = phonePlaceholder(low.current, editor.getEfficientZoomLevel(), editor.getCulledShapes().has(id as TLShape["id"]), heavy);
      low.current = next.low;
      return next.placeholder;
    },
    [editor, id, on, heavy],
  );
}

// A card's stand-in: its box, a colour, and a title sized to stay readable when zoomed out.
export function CardPlaceholder({ w, h, title, tone = "#e7e2f7" }: { w: number; h: number; title: string; tone?: string }) {
  return (
    <HTMLContainer
      data-phone-placeholder=""
      style={{ width: w, height: h, borderRadius: 10, background: tone, border: "1px solid rgba(0,0,0,.12)", overflow: "hidden", display: "flex", alignItems: "flex-start", padding: 12, boxSizing: "border-box" }}
    >
      {/* Readable when zoomed out, but never bigger than the card holds; one line. */}
      <span style={{ font: `600 min(calc(12px / max(var(--tl-zoom, 1), 0.08)), ${Math.max(10, Math.min(w / 9, h / 2.5))}px) Inter, system-ui, sans-serif`, lineHeight: 1.15, color: "#2e1f16", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}>{title}</span>
    </HTMLContainer>
  );
}

// Wraps a shape's real component: the placeholder when usePhonePlaceholder says so.
function Lod({ id, heavy, placeholder, full }: { id: string; heavy: boolean; placeholder: () => ReactNode; full: () => ReactNode }) {
  return <>{usePhonePlaceholder(id, heavy) ? placeholder() : createElement(Full, { render: full })}</>;
}
function Full({ render }: { render: () => ReactNode }) {
  return <>{render()}</>;
}

// For a shape util's component(): `full` renders the real shape (in its own component, so
// its hooks mount and unmount with it).
export function phoneLod(shape: TLShape, heavy: boolean, placeholder: () => ReactNode, full: () => ReactNode): ReactElement {
  if (!phoneGeometryOn()) return <>{full()}</>;
  return <Lod key={shape.id} id={shape.id} heavy={heavy} placeholder={placeholder} full={full} />;
}

export const NOTE_FILL: Record<string, string> = { black: "#e8e8e8", grey: "#d9dde1", "light-violet": "#f2c9fa", violet: "#e0b3ea", blue: "#bccafa", "light-blue": "#b9dafb", yellow: "#fde9b6", orange: "#fbcfa7", green: "#b2e2cc", "light-green": "#c4ecc8", "light-red": "#fdd0d0", red: "#f6b8b8", white: "#ffffff" };

// A note or text block without its label: the note's square in its colour, a text block as
// a faint bar.
export function BlockPlaceholder({ w, h, fill, radius = 2 }: { w: number; h: number; fill: string; radius?: number }) {
  return <HTMLContainer data-phone-placeholder="" style={{ width: w, height: h, background: fill, borderRadius: radius }} />;
}

// Phone: tldraw's canvases (overlays, pattern fills) and exports size their backing stores by
// window.devicePixelRatio, 3 on recent iPhones; capped at 2 there (a full-screen overlay is
// 1170x2532x4 = 11.8 MB at 3x, 5.3 MB at 2x). Call before tldraw mounts.
export function capPhonePixelRatio(cap = 2): void {
  try {
    const own = Object.getOwnPropertyDescriptor(Window.prototype, "devicePixelRatio")?.get;
    const real = () => (own ? (own.call(window) as number) : 1);
    if (real() <= cap) return;
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: () => Math.min(cap, real()) });
  } catch {
    /* read-only in this browser: keep the real ratio */
  }
}
