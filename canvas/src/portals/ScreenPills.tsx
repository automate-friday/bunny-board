// The bottom dock's pills for frames pinned to the screen (screenPins.ts): one per window,
// with the frame's status dot and name. Clicking a pill shrinks its window away or brings it
// back; × closes the window.
import { type Editor, type TLShapeId, useValue } from "tldraw";
import { B, DOT, surface, UI_FONT } from "../bunnyTheme";
import { removeScreenPin, type ScreenPin, screenPins, updateScreenPin } from "./screenPins";

function Pill({ editor, pin }: { editor: Editor; pin: ScreenPin }) {
  const info = useValue(
    `screen-pill:${pin.id}`,
    () => {
      const s = editor.getShape(pin.id as TLShapeId);
      if (s?.type !== "frame") return null;
      const p = (s.meta as { paseo?: { agentId?: string; status?: string } } | undefined)?.paseo;
      return { name: (s.props as { name?: string }).name || "Frame", status: p?.agentId ? (p.status ?? "idle") : "unbound" };
    },
    [editor, pin.id],
  );
  if (!info) return null;
  return (
    <span
      data-testid="screen-pill"
      data-frame-id={pin.id}
      data-min={pin.min || undefined}
      onPointerDown={(e) => e.stopPropagation()}
      style={{ ...surface, pointerEvents: "all", display: "inline-flex", alignItems: "center", borderRadius: 999, maxWidth: 240, background: pin.min ? B.cream : B.lavenderSoft, border: `1px solid ${pin.min ? B.line : B.violet}` }}
    >
      <button
        type="button"
        data-testid="screen-pill-toggle"
        aria-pressed={!pin.min}
        title={`${info.name} · ${pin.min ? "Show its window" : "Shrink its window to this pill"}`}
        onClick={() => updateScreenPin(pin.id, { min: !pin.min })}
        style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0, minHeight: 36, border: 0, background: "transparent", padding: "0 8px 0 12px", font: `600 13px ${UI_FONT}`, color: B.espresso, cursor: "pointer", borderRadius: 999 }}
      >
        <span aria-hidden style={{ width: 9, height: 9, borderRadius: 5, flex: "none", background: DOT[info.status] ?? DOT.unbound }} />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{info.name}</span>
      </button>
      <button type="button" data-testid="screen-pill-close" aria-label={`Close the window on ${info.name}`} title="Close the window" onClick={() => removeScreenPin(pin.id)} className="bunny-pill-x" style={{ flex: "none", width: 32, height: 32, margin: "2px 2px 2px 0", display: "grid", placeItems: "center", border: `1px solid ${B.line}`, background: "transparent", padding: 0, color: B.muted, cursor: "pointer", font: `500 14px ${UI_FONT}`, borderRadius: 999 }}>
        ×
      </button>
    </span>
  );
}

export function ScreenPills({ editor }: { editor: Editor }) {
  const pins = useValue(screenPins);
  if (!pins.length) return null;
  return (
    <div data-testid="screen-pills" style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", alignItems: "flex-end", gap: 8, pointerEvents: "none" }}>
      {pins.map((p) => (
        <Pill key={p.id} editor={editor} pin={p} />
      ))}
    </div>
  );
}
