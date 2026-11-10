import { AppIcon } from "../components/AppIcon";
// The phone composer's photos: a row of numbered thumbnails, sent in the row's order.
// Reorder by long-pressing a photo and dragging it along the row, or tap one and use
// ← Earlier / Later →; × removes one. The add-photo button is a line icon matching the
// thumb bar's (Hand, Search), 44 px.

import { useEffect, useRef, useState } from "react";
import { dropIndex, moveItem } from "./photoOrder";

const ids = new WeakMap<File, number>();
let nextId = 1;
const keyOf = (f: File) => {
  let id = ids.get(f);
  if (!id) ids.set(f, (id = nextId++));
  return id;
};

const LIFT_MS = 350;
type Press = { index: number; id: number; x: number; y: number; timer: ReturnType<typeof setTimeout> | null; lifted: boolean; moved: boolean };

export function PhotoTray({ photos, previews, setPhotos, disabled }: { photos: File[]; previews: string[]; setPhotos: (next: File[]) => void; disabled?: boolean }) {
  const [selected, setSelected] = useState<number | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const row = useRef<HTMLDivElement>(null);
  const press = useRef<Press | null>(null);
  const latest = useRef(photos);
  latest.current = photos;
  useEffect(() => {
    if (selected !== null && selected >= photos.length) setSelected(photos.length ? photos.length - 1 : null);
  }, [photos.length, selected]);
  // While a photo is lifted the row must not scroll under the finger: a non-passive
  // touchmove listener holds it (iOS and Chrome both honour preventDefault there).
  useEffect(() => {
    const el = row.current;
    if (!el) return;
    const hold = (e: TouchEvent) => {
      if (press.current?.lifted) e.preventDefault();
    };
    el.addEventListener("touchmove", hold, { passive: false });
    return () => el.removeEventListener("touchmove", hold);
  }, [photos.length > 0]);

  const move = (from: number, to: number) => {
    const next = moveItem(latest.current, from, to);
    setPhotos(next);
    return Math.max(0, Math.min(next.length - 1, to));
  };
  const centres = () => [...(row.current?.querySelectorAll<HTMLElement>("[data-photo-slot]") ?? [])].map((n) => { const r = n.getBoundingClientRect(); return r.left + r.width / 2; });
  const end = () => {
    const p = press.current;
    if (p?.timer) clearTimeout(p.timer);
    press.current = null;
    setDragging(null);
  };

  if (!photos.length) return null;
  return (
    <div data-testid="reply-photos" style={{ display: "flex", flexDirection: "column", gap: 4, paddingTop: 4 }}>
      <div ref={row} style={{ display: "flex", gap: 8, overflowX: "auto", padding: "8px 10px 6px 8px" }}>
        {photos.map((f, i) => (
          <span
            key={keyOf(f)}
            data-photo-slot={i}
            data-testid="reply-photo-thumb"
            data-name={f.name}
            data-selected={selected === i}
            data-dragging={dragging === i}
            style={{
              position: "relative",
              flex: "none",
              borderRadius: 10,
              touchAction: "pan-x",
              WebkitTouchCallout: "none",
              userSelect: "none",
              outline: selected === i ? "2px solid light-dark(#8875F6, hsl(249 35% 39%))" : "none",
              outlineOffset: 2,
              transform: dragging === i ? "scale(1.08)" : undefined,
              boxShadow: dragging === i ? "0 8px 20px rgba(46,31,22,.3)" : undefined,
              transition: "transform .12s",
              zIndex: dragging === i ? 2 : 1,
            } as React.CSSProperties}
          >
            {/* A real button, so a touch on the photo lands on it (Chromium and iOS move taps
                to the nearest clickable element, which would otherwise be the ×). */}
            <button
              type="button"
              data-testid="reply-photo-select"
              aria-label={`Photo ${i + 1} of ${photos.length}: ${f.name}. Long-press and drag to move, or tap for move buttons.`}
              onPointerDown={(e) => {
                if (disabled) return;
                const el = e.currentTarget;
                const id = e.pointerId;
                const p: Press = { index: i, id, x: e.clientX, y: e.clientY, timer: null, lifted: false, moved: false };
                // Mouse and pen lift at once; a finger after a still long-press (a quick swipe
                // still scrolls the row).
                const lift = () => {
                  p.lifted = true;
                  p.timer = null;
                  setDragging(p.index);
                  setSelected(p.index);
                  try { el.setPointerCapture(id); } catch { /* released already */ }
                  navigator.vibrate?.(10);
                };
                if (e.pointerType === "touch") p.timer = setTimeout(lift, LIFT_MS);
                press.current = p;
                if (e.pointerType !== "touch") lift();
              }}
              onPointerMove={(e) => {
                const p = press.current;
                if (!p || p.id !== e.pointerId) return;
                if (!p.lifted) {
                  if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 8) end();
                  return;
                }
                const to = dropIndex(centres(), p.index, e.clientX);
                if (to !== p.index) {
                  p.moved = true;
                  p.index = move(p.index, to);
                  setDragging(p.index);
                  setSelected(p.index);
                }
              }}
              onPointerUp={(e) => {
                const p = press.current;
                if (!p || p.id !== e.pointerId) return;
                end();
                // A tap (no drag) toggles the move buttons; a touch long-press leaves them up.
                if (!p.moved && !(p.lifted && e.pointerType === "touch")) setSelected((s) => (s === p.index && selected === p.index ? null : p.index));
              }}
              onPointerCancel={end}
              onContextMenu={(e) => e.preventDefault()}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft" && i > 0) setSelected(move(i, i - 1));
                else if (e.key === "ArrowRight" && i < photos.length - 1) setSelected(move(i, i + 1));
                else if (e.key === "Enter" || e.key === " ") setSelected((s) => (s === i ? null : i));
              }}
              style={{ display: "block", position: "relative", padding: 0, border: 0, background: "transparent", borderRadius: 10, cursor: "grab", touchAction: "pan-x", WebkitTouchCallout: "none" } as React.CSSProperties}
            >
              <img src={previews[i]} alt={f.name} draggable={false} style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 10, border: "1px solid light-dark(#e2e8f0, var(--bunny-line))", display: "block", pointerEvents: "none" }} />
              <span aria-hidden="true" data-testid="reply-photo-order" style={{ position: "absolute", left: 4, bottom: 4, minWidth: 18, height: 18, borderRadius: 9, background: "rgba(15,23,42,.75)", color: "#fff", font: "600 11px/18px system-ui", textAlign: "center", padding: "0 4px", boxSizing: "border-box" }}>
                {i + 1}
              </span>
            </button>
            <button
              type="button"
              data-testid="reply-photo-remove"
              aria-label={`Remove ${f.name}`}
              onClick={() => setPhotos(photos.filter((_, j) => j !== i))}
              // A 22 px dot on a 36 px hit area.
              style={{ position: "absolute", top: -12, right: -12, width: 36, height: 36, border: "none", background: "transparent", padding: 0, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
            >
              <span aria-hidden="true" style={{ width: 22, height: 22, borderRadius: 11, background: "#0f172a", color: "#fff", font: "13px/22px system-ui", textAlign: "center" }}>×</span>
            </button>
          </span>
        ))}
      </div>
      {selected !== null && selected < photos.length && photos.length > 1 ? (
        <div data-testid="reply-photo-move" style={{ display: "flex", gap: 8, alignItems: "center", minHeight: 44, font: "12px Inter, system-ui, sans-serif", color: "light-dark(#64748b, var(--bunny-muted))" }}>
          <button type="button" data-testid="reply-photo-left" aria-label={`Move photo ${selected + 1} earlier`} disabled={selected === 0} onClick={() => setSelected(move(selected, selected - 1))} style={moveBtn(selected === 0)}>
            ← Earlier
          </button>
          <span style={{ flex: 1, textAlign: "center" }}>Photo {selected + 1} of {photos.length} · sent in this order</span>
          <button type="button" data-testid="reply-photo-right" aria-label={`Move photo ${selected + 1} later`} disabled={selected === photos.length - 1} onClick={() => setSelected(move(selected, selected + 1))} style={moveBtn(selected === photos.length - 1)}>
            Later →
          </button>
        </div>
      ) : photos.length > 1 ? (
        // Same height as the move buttons, so tapping a photo never shifts the row under the finger.
        <div style={{ display: "flex", alignItems: "center", minHeight: 44, font: "11px Inter, system-ui, sans-serif", color: "light-dark(#64748b, var(--bunny-muted))" }}>Sent in this order · long-press and drag, or tap a photo, to move it</div>
      ) : null}
    </div>
  );
}

const moveBtn = (off: boolean): React.CSSProperties => ({ minHeight: 44, minWidth: 92, borderRadius: 12, border: "1px solid light-dark(#cbd5e1, hsl(213 35% 39%))", background: "light-dark(#fff, var(--bunny-surface))", color: off ? "light-dark(#94a3b8, var(--bunny-muted))" : "light-dark(#0f172a, hsl(222 50% 74%))", font: "600 13px Inter, system-ui, sans-serif", cursor: off ? "default" : "pointer" });

// Add a photo: a picture-frame line icon in the thumb bar's style.
export function PhotoIcon() {
  return <AppIcon name="image" size={24} />;
}
