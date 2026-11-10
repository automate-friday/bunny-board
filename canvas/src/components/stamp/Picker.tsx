// The stamp tool's toolbar button, its picker (the standard set) and the note field.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TldrawUiToolbarButton, type TLShapeId, useEditor, useValue } from "tldraw";
import { STAMP_HEX, STAMP_KIND_INFO, STAMP_KINDS, STAMP_NOTE_MAX } from "../../../../shared/components/stamp";
import { WidgetIcon } from "../widget/icons";
import { StampIcon } from "./icons";
import { noteFor, placeStamp, setStampNote, STAMP_TOOL, stampHint, stampKind } from "./tool";

export function StampToolButton() {
  const editor = useEditor();
  const active = useValue("stamp-tool-active", () => editor.getCurrentToolId() === STAMP_TOOL, [editor]);
  return (
    <>
      <TldrawUiToolbarButton type="tool" data-testid="stamp-tool-button" tooltip="Stamp" title="Stamp" isActive={active} onClick={() => editor.setCurrentTool(active ? "select" : STAMP_TOOL)}>
        <WidgetIcon name="stamp" />
      </TldrawUiToolbarButton>
      {active ? createPortal(<StampPicker />, document.body) : null}
      <NotePopover />
    </>
  );
}

function StampPicker() {
  const kind = useValue("stamp-kind", () => stampKind.get(), []);
  const hint = useValue("stamp-hint", () => stampHint.get(), []);
  return (
    <div
      data-testid="stamp-picker"
      onPointerDown={(e) => e.stopPropagation()}
      style={{ position: "fixed", left: "50%", bottom: 76, transform: "translateX(-50%)", zIndex: 400, maxWidth: "calc(100vw - 32px)", background: "light-dark(#f6f7f9, var(--bunny-surface))", border: "1px solid light-dark(#dde1e7, var(--bunny-line))", borderRadius: 14, boxShadow: "0 10px 30px rgba(20,30,60,.18)", padding: 8, display: "flex", flexDirection: "column", gap: 6, font: "12px system-ui" }}
    >
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
        {STAMP_KINDS.map((k) => {
          const info = STAMP_KIND_INFO[k];
          const ink = STAMP_HEX[info.color];
          const on = k === kind;
          return (
            <button
              key={k}
              type="button"
              data-testid={`stamp-kind-${k}`}
              aria-pressed={on}
              title={`${info.label}: ${info.hint}`}
              onClick={() => stampKind.set(k)}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 9px 4px 4px", border: `1.5px solid ${on ? ink : "light-dark(#dde1e7, var(--bunny-line))"}`, borderRadius: 16, background: on ? `${ink}14` : "light-dark(#fff, var(--bunny-surface))", cursor: "pointer", font: "12px system-ui", color: "light-dark(#223, var(--bunny-ink))" }}
            >
              <span style={{ width: 22, height: 22, borderRadius: 11, background: ink, color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                <StampIcon name={info.icon} size={13} strokeWidth={2.4} />
              </span>
              <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", lineHeight: 1.15 }}>
                <b style={{ fontWeight: 650 }}>{info.label}</b>
                <span style={{ color: "light-dark(#778, var(--bunny-muted))", fontSize: 10.5 }}>{info.hint}</span>
              </span>
            </button>
          );
        })}
      </div>
      {hint ? (
        <div data-testid="stamp-hint" style={{ color: "light-dark(#667, var(--bunny-muted))", textAlign: "center" }}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

// The optional one-line note: after a click (for the stamp just placed), on a held click
// (the stamp is placed with it on Enter), or on double-clicking a stamp.
function NotePopover() {
  const editor = useEditor();
  const target = useValue("stamp-note", () => noteFor.get(), []);
  const pos = useValue(
    "stamp-note-pos",
    () => {
      const t = noteFor.get();
      if (!t) return null;
      const b = t.mode === "placed" ? editor.getShapePageBounds(t.stampId) : null;
      const pt = b ? { x: b.minX, y: b.maxY + 6 } : t.mode === "pending" ? t.point : null;
      if (!pt) return null;
      const v = editor.pageToViewport(pt);
      const sb = editor.getViewportScreenBounds();
      return { x: sb.x + v.x, y: sb.y + v.y };
    },
    [editor],
  );
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const key = target ? (target.mode === "placed" ? target.stampId : `pending:${target.targetId}`) : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the target changes.
  useEffect(() => {
    if (!target) return;
    const s = target.mode === "placed" ? (editor.getShape(target.stampId) as { props?: { note?: string } } | undefined) : undefined;
    setText(s?.props?.note ?? "");
    setTimeout(() => input.current?.focus(), 0);
  }, [key]);
  if (!target || !pos) return null;
  const save = () => {
    if (target.mode === "placed") setStampNote(editor, target.stampId as TLShapeId, text);
    else placeStamp(editor, target.targetId, target.kind, { point: target.point, note: text });
    close();
  };
  // Hand the keyboard back to the canvas (Escape then leaves the stamp tool, as usual).
  const close = () => {
    noteFor.set(null);
    editor.focus();
  };
  return createPortal(
    <form
      data-testid="stamp-note-form"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") close();
      }}
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      style={{ position: "fixed", left: pos.x, top: pos.y, zIndex: 450, display: "flex", gap: 4, padding: 4, background: "light-dark(#fff, var(--bunny-surface))", border: "1px solid light-dark(#dde1e7, var(--bunny-line))", borderRadius: 10, boxShadow: "0 6px 20px rgba(20,30,60,.18)", font: "12px system-ui" }}
    >
      <input
        ref={input}
        data-testid="stamp-note-input"
        value={text}
        maxLength={STAMP_NOTE_MAX}
        placeholder={target.mode === "pending" ? `Note for ${STAMP_KIND_INFO[target.kind].label}, then Enter` : "Add a note (optional), Enter"}
        onChange={(e) => setText(e.target.value)}
        style={{ width: 230, border: "1px solid light-dark(#c9ced6, var(--bunny-line))", borderRadius: 6, padding: "4px 6px", font: "12px system-ui" }}
      />
      <button type="submit" data-testid="stamp-note-save" style={{ border: "1px solid light-dark(#2f80ed, hsl(214 35% 39%))", background: "#2f80ed", color: "#fff", borderRadius: 6, padding: "3px 10px", cursor: "pointer" }}>
        {target.mode === "pending" ? "Stamp" : "Save"}
      </button>
    </form>,
    document.body,
  );
}
