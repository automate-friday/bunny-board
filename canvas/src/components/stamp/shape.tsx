// Stamp shape. v2 stamps (kind set) are a pill: the kind's line icon and label, a response
// state badge (sent → seen → acting → done) and the optional note under it; they are
// parented to the shape they mark (canvas/src/components/stamp/tool.ts). v1 stamps (from
// the retired stamp-button widget, kind "") keep their rubber-stamp look. Props and
// migrations come from shared/ so the server schema matches exactly.

import { BaseBoxShapeUtil, HTMLContainer, type RecordProps, type TLShape } from "tldraw";
import { STAMP_HEX, STAMP_KIND_INFO, STAMP_STATE_TEXT, STAMP_TYPE, type StampKind, type StampProps, stampMigrations, stampShapeProps, stampSize, stampTime } from "../../../../shared/components/stamp";
import { StampIcon, STATE_ICON } from "./icons";
import { noteFor } from "./tool";

let styled = false;
function ensureStyle(): void {
  if (styled || typeof document === "undefined") return;
  styled = true;
  const el = document.createElement("style");
  el.textContent = "@keyframes bunny-stamp-pulse{0%,100%{opacity:1}50%{opacity:.35}}";
  document.head.appendChild(el);
}

export function StampPill({ kind, by, at, note, state }: Pick<StampProps, "by" | "at" | "note" | "state"> & { kind: StampKind }) {
  ensureStyle();
  const info = STAMP_KIND_INFO[kind];
  const ink = STAMP_HEX[info.color];
  const badge = state ? STATE_ICON[state] : null;
  const title = `${info.label} by ${by || "you"} · ${stampTime(at)}${state ? ` · ${STAMP_STATE_TEXT[state]}` : ""}${note ? ` · “${note}”` : ""}`;
  return (
    <div data-testid="stamp" data-kind={kind} data-state={state || "none"} title={title} style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2, font: "12px system-ui, sans-serif", userSelect: "none" }}>
      <div style={{ height: 28, boxSizing: "border-box", display: "flex", alignItems: "center", gap: 6, padding: "0 6px 0 3px", border: `1.5px solid ${ink}`, borderRadius: 14, background: "light-dark(#fff, var(--bunny-surface))", boxShadow: "0 2px 8px rgba(20,30,60,.16)", whiteSpace: "nowrap" }}>
        <span style={{ width: 21, height: 21, borderRadius: 11, background: ink, color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
          <StampIcon name={info.icon} size={13} strokeWidth={2.4} />
        </span>
        <span style={{ fontWeight: 650, color: "light-dark(#223, var(--bunny-ink))" }}>{info.label}</span>
        {badge ? (
          <span data-testid="stamp-state" data-state={state} title={STAMP_STATE_TEXT[state]} style={{ color: badge.color, display: "inline-flex", animation: state === "acting" ? "bunny-stamp-pulse 1.2s ease-in-out infinite" : undefined }}>
            <StampIcon name={badge.icon} size={14} strokeWidth={2.2} />
          </span>
        ) : null}
      </div>
      {note ? (
        <div data-testid="stamp-note" style={{ maxWidth: "100%", boxSizing: "border-box", padding: "1px 7px", borderRadius: 7, background: "light-dark(#fff, var(--bunny-surface))", border: "1px solid light-dark(#e1e4ea, var(--bunny-line))", color: "light-dark(#334, var(--bunny-ink))", fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{note}</div>
      ) : null}
    </div>
  );
}

declare module "tldraw" {
  interface TLGlobalShapePropsMap {
    stamp: StampProps;
  }
}

export type StampShape = TLShape<typeof STAMP_TYPE>;

export function StampMark({ label, color, by, at, scale = 1 }: Pick<StampProps, "label" | "color" | "by" | "at"> & { scale?: number }) {
  const ink = STAMP_HEX[color] ?? STAMP_HEX.red;
  // Ink on paper; a white stamp gets dark paper so it shows.
  const paper = color === "white" ? "#2a2a2a" : "#fffdf8";
  return (
    <div
      data-testid="stamp-mark"
      data-label={label}
      style={{
        width: "100%",
        height: "100%",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 2 * scale,
        border: `${3 * scale}px solid ${ink}`,
        borderRadius: 8 * scale,
        // A second, thin rule inside the first: the double frame of a rubber stamp.
        boxShadow: `inset 0 0 0 ${2.5 * scale}px ${paper}, inset 0 0 0 ${4 * scale}px ${ink}`,
        background: paper,
        color: ink,
        opacity: 0.9,
        fontFamily: "'Courier New', ui-monospace, monospace",
        userSelect: "none",
        pointerEvents: "none",
        overflow: "hidden",
      }}
    >
      <span style={{ fontSize: 24 * scale, lineHeight: 1.05, fontWeight: 800, letterSpacing: 2 * scale, textTransform: "uppercase", whiteSpace: "nowrap" }}>{label}</span>
      <span data-testid="stamp-who" style={{ fontSize: 10.5 * scale, lineHeight: 1.1, fontWeight: 700, letterSpacing: 0.4 * scale, whiteSpace: "nowrap", maxWidth: "92%", overflow: "hidden", textOverflow: "ellipsis" }}>
        {by || "you"} · {stampTime(at)}
      </span>
    </div>
  );
}

export class StampShapeUtil extends BaseBoxShapeUtil<StampShape> {
  static override type = STAMP_TYPE;
  static override props: RecordProps<StampShape> = stampShapeProps;
  static override migrations = stampMigrations;

  override getDefaultProps(): StampProps {
    return { label: "LGTM", color: "red", by: "you", at: 0, target: "", kind: "", note: "", state: "", ...stampSize("LGTM") };
  }

  override canEdit(): boolean {
    return false;
  }
  override canResize(): boolean {
    return false;
  }
  override hideResizeHandles(): boolean {
    return true;
  }
  override hideRotateHandle(): boolean {
    return true;
  }

  // Double-click a stamp to add or change its note.
  override onDoubleClick(shape: StampShape) {
    if (shape.props.kind) noteFor.set({ mode: "placed", stampId: shape.id });
  }

  override component(shape: StampShape) {
    const p = shape.props;
    if (p.kind)
      return (
        <HTMLContainer id={shape.id} style={{ width: p.w, height: p.h, overflow: "visible" }}>
          <StampPill kind={p.kind} by={p.by} at={p.at} note={p.note} state={p.state} />
        </HTMLContainer>
      );
    const scale = Math.min(p.w / stampSize(p.label).w, p.h / stampSize(p.label).h);
    return (
      <HTMLContainer id={shape.id} style={{ width: p.w, height: p.h }}>
        <StampMark label={p.label} color={p.color} by={p.by} at={p.at} scale={Math.max(0.3, scale)} />
      </HTMLContainer>
    );
  }

  override getIndicatorPath(shape: StampShape) {
    const path = new Path2D();
    path.roundRect(0, 0, shape.props.w, shape.props.kind ? 28 : shape.props.h, shape.props.kind ? 14 : 8);
    return path;
  }
}
