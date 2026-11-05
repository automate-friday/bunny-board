// The bottom dock: a row along the bottom right, next to the organizer's Bunny launcher,
// holding the docked frame panel (or its pill) for an unpinned frame, and the pinned frames. Pinned frames are
// "saved" jump locations: one pill each (status dot + name), always shown whatever is
// selected. A click jumps to the frame (select + open its conversation; the camera moves only
// with "Jump to frame when switching"); × or right-click unpins.
import { useEffect, useRef, useState } from "react";
import { type Editor, type TLFrameShape, type TLShapeId, useEditor, useValue } from "tldraw";
import { displayStatus, statusLabel, subagentCount, useAgentView } from "./agents";
import { useNarrow } from "./BoardControls";
import { B, BUNNY_CONTROLS_CSS, surface, UI_FONT } from "./bunnyTheme";
import { Dot } from "./Dot";
import { FramePanel } from "./FramePanel";
import { livePins, removePin, type SwitchEditor, switchToPin, usePinJump, usePins } from "./framePanelDock";


// Right of the row clears the Bunny launcher (right 16, bottom 52, 58 wide); on phones the
// row sits above the launcher, clear of the tool bar.
export function DockRow({ children }: { children: React.ReactNode }) {
  const narrow = useNarrow();
  return (
    <div
      className="bunny-fp"
      data-testid="bottom-dock"
      style={{ position: "absolute", right: narrow ? 16 : 86, bottom: narrow ? 122 : 62, left: 16, zIndex: 300, display: "flex", flexDirection: "row-reverse", alignItems: "flex-end", gap: 8, pointerEvents: "none" }}
    >
      <style>{BUNNY_CONTROLS_CSS}</style>
      {children}
    </div>
  );
}

// Status of a pinned frame's conversation.
function useFrameStatus(editor: Editor, id: string): { key: string; text: string } {
  // biome-ignore lint/suspicious/noExplicitAny: meta JSON.
  const paseo = useValue(`pin-meta:${id}`, () => ((editor.getShape(id as TLShapeId)?.meta as any)?.paseo ?? {}) as Record<string, any>, [editor, id]);
  const view = useAgentView(paseo.agentId);
  if (!paseo.agentId) return paseo.request ? { key: "requested", text: "starting…" } : { key: "unbound", text: "no conversation yet" };
  const status = displayStatus(view, paseo.boundAt, paseo.status, paseo.subagents, paseo.cloudSessions, paseo.host);
  return { key: status, text: statusLabel(status, subagentCount(view, paseo.subagents)) };
}

function PinPill({ editor, id, name, active, focus, onJump, onUnpin }: { editor: Editor; id: string; name: string; active: boolean; focus: boolean; onJump: () => void; onUnpin: () => void }) {
  const status = useFrameStatus(editor, id);
  const button = useRef<HTMLButtonElement>(null);
  // Back on the pill after its panel collapses (Esc or –), so the keyboard keeps its place.
  useEffect(() => {
    if (focus) button.current?.focus();
  }, [focus]);
  return (
    <span
      data-testid="pin-chip"
      data-frame-id={id}
      data-active={active || undefined}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onUnpin();
      }}
      style={{ ...surface, pointerEvents: "all", display: "inline-flex", alignItems: "center", borderRadius: 999, maxWidth: 220, background: active ? B.lavenderSoft : B.cream, border: `1px solid ${active ? B.violet : B.line}` }}
    >
      <button ref={button} type="button" className="bfp-chip" aria-label={`${name}, ${status.text}${active ? ", selected" : ""}. Jump to this frame`} title={`${name} · ${status.text}. Jump to this frame (right-click to unpin)`} onClick={onJump} style={{ display: "inline-flex", alignItems: "center", gap: 7, minWidth: 0, border: 0, background: "transparent", padding: "6px 4px 6px 10px", font: `600 13px ${UI_FONT}`, color: B.espresso, cursor: "pointer", borderRadius: 999 }}>
        <Dot status={status.key} text={status.text} />
        <span data-pin-name style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
      </button>
      <button type="button" className="bfp-chip" data-testid="pin-unpin" aria-label={`Unpin ${name}`} title="Unpin" onClick={onUnpin} style={{ border: 0, background: "transparent", padding: "6px 10px 6px 2px", color: B.muted, cursor: "pointer", font: `500 14px ${UI_FONT}`, borderRadius: 999 }}>
        ×
      </button>
    </span>
  );
}

// Pinned frames of this board, in pin order. A pin whose frame is gone (deleted, archived,
// or not synced yet) is hidden rather than forgotten, so restoring or undoing brings it back.
// The selected pinned frame (`expanded`) shows its frame panel in place of its pill: never a
// second panel or pill for the same frame.
export function PinDock({ boardId, current, expanded, onExpand, onCollapse, openFrame }: { boardId: string; current: string | null; expanded: string | null; onExpand: (id: string) => void; onCollapse: () => void; openFrame: (id: string) => void }) {
  const editor = useEditor();
  const [pins, setPins] = usePins(boardId);
  const [jump] = usePinJump();
  const [refocus, setRefocus] = useState<string | null>(null);
  const frames = useValue(
    "pinned-frames",
    () => livePins(pins, (id) => editor.getShape(id as TLShapeId)?.type === "frame").map((id) => editor.getShape(id as TLShapeId) as TLFrameShape),
    [editor, pins],
  );
  if (!frames.length) return null;
  // Pins wrap in reading order; extra rows stack upward from the dock line (the dock is
  // anchored at the bottom), so they never cover the tool bar or the Bunny launcher.
  return (
    <div data-testid="pin-dock" style={{ flex: "1 1 0", minWidth: 0, display: "flex", flexWrap: "wrap", justifyContent: "flex-end", alignItems: "flex-end", gap: 8, pointerEvents: "none" }}>
      {frames.map((f) =>
        f.id === expanded ? (
          <FramePanel
            key={f.id}
            frame={f}
            boardId={boardId}
            pinned
            onOpen={() => openFrame(f.id)}
            onCollapse={() => {
              setRefocus(f.id);
              onCollapse();
            }}
          />
        ) : (
          <PinPill
            key={f.id}
            editor={editor}
            id={f.id}
            name={f.props.name || "Frame"}
            active={f.id === current}
            focus={refocus === f.id}
            onJump={() => (f.id === current ? onExpand(f.id) : switchToPin(editor as unknown as SwitchEditor, f.id, jump, openFrame))}
            onUnpin={() => setPins(removePin(pins, f.id))}
          />
        ),
      )}
    </div>
  );
}
