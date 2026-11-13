// Phone thread sheet (Sidebar with `mobile`) tools:
// - long-press the agent's name in the header to rename it in place (Enter or Done saves,
//   Esc or tapping away cancels);
// - ⋯ → Edit agent settings: Name with the model, effort, access and mode controls;
// - + New in the top bar, and long-press a message → Start agent about this: the start sheet for a
//   new frame beside this one, prefilled like this agent (mobile/StartSheet.tsx askStartBeside);
// - long-press a message → Fork from here: a new frame and agent from the conversation up to
//   that message (ForkFromHere.tsx).
// A rename writes the frame's name; the board server carries it to the agent's Paseo title
// (server/frame-names.ts), as on desktop.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor, TLFrameShape, TLShapeId } from "tldraw";
import { api } from "../api";
import { publicBaseNow } from "../info";
import { cleanName } from "../../../shared/frame-names";
import { aboutMessage, sameAs } from "./placement";
import { askStartBeside, useVisibleViewport } from "./StartSheet";
import "./startSheet.css";
import "./threadWrap.css";
import { useModalHold } from "./modalHold";

export const LONG_PRESS_MS = 500;

// Press and hold without moving: `onLong` after LONG_PRESS_MS. A move over 10 px (a scroll or
// a drag) or an early release cancels it; the browser's own long-press menu is held back.
export function useLongPress(onLong: (at: { x: number; y: number }) => void, enabled = true) {
  const t = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number; id: number } | null>(null);
  const fired = useRef(false);
  const clear = () => {
    if (t.current) clearTimeout(t.current.timer);
    t.current = null;
  };
  useEffect(() => clear, []);
  if (!enabled) return {};
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button > 0) return;
      clear();
      fired.current = false;
      const at = { x: e.clientX, y: e.clientY };
      t.current = { x: e.clientX, y: e.clientY, id: e.pointerId, timer: setTimeout(() => { t.current = null; fired.current = true; navigator.vibrate?.(10); onLong(at); }, LONG_PRESS_MS) };
    },
    onPointerMove: (e: React.PointerEvent) => {
      const s = t.current;
      if (s && s.id === e.pointerId && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 10) clear();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
    // A long-press that ran must not also click what is under the finger.
    onClickCapture: (e: React.MouseEvent) => {
      if (fired.current) {
        e.preventDefault();
        e.stopPropagation();
        fired.current = false;
      }
    },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    style: { WebkitTouchCallout: "none" } as React.CSSProperties,
  };
}

export function renameFrame(editor: Editor, frameId: string, name: string): boolean {
  const f = editor.getShape(frameId as TLShapeId) as TLFrameShape | undefined;
  const next = cleanName(name);
  if (!f || !next || next === f.props.name) return false;
  editor.updateShape<TLFrameShape>({ id: f.id, type: "frame", props: { name: next } });
  return true;
}

// The header's name, edited in place.
export function TitleEdit({ initial, save, cancel }: { initial: string; save: (name: string) => void; cancel: () => void }) {
  const [name, setName] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const finish = (ok: boolean) => {
    if (done.current) return;
    done.current = true;
    if (ok && cleanName(name)) save(name);
    else cancel();
  };
  return (
    <span className="bm-title-edit" data-no-drag>
      <input
        ref={input}
        data-testid="thread-title-input"
        aria-label="Agent name"
        type="text"
        maxLength={80}
        enterKeyHint="done"
        autoComplete="off"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") { e.preventDefault(); finish(true); }
          else if (e.key === "Escape") finish(false);
        }}
        onBlur={() => finish(false)}
      />
      {/* Keeps the field focused when pressed (so blur does not cancel first). */}
      <button type="button" data-testid="thread-title-save" aria-label="Save name" onPointerDown={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()} onClick={() => finish(true)}>
        Done
      </button>
    </span>
  );
}

// ⋯ → Edit agent settings.
export function EditAgentSheet({ name: initial, controls, save, close }: { name: string; controls: React.ReactNode; save: (name: string) => void; close: () => void }) {
  useModalHold();
  const [name, setName] = useState(initial);
  const vp = useVisibleViewport();
  return createPortal(
    <div className="bm-start-layer" data-mobile-ui data-testid="edit-agent-layer" style={{ top: vp.top, height: vp.height, zIndex: 1005 }}>
      <div className="bm-start-scrim" onPointerDown={close} />
      <form className="bm-start-sheet" role="dialog" aria-modal="true" aria-label="Edit agent settings" data-testid="edit-agent-sheet" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") close(); }} onSubmit={(e) => { e.preventDefault(); (document.activeElement as HTMLElement | null)?.blur?.(); save(name); }}>
        <div className="bm-start-head">
          <span className="bm-grip-bar" aria-hidden="true" />
          <b>Agent settings</b>
        </div>
        <div className="bm-start-body">
          <label className="bm-start-field">
            <span className="bm-field-label">Name</span>
            <input data-testid="edit-agent-name" className="bm-start-input" type="text" maxLength={80} enterKeyHint="done" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          {controls ? (
            <div className="bm-start-field" data-testid="edit-agent-controls">
              <span className="bm-field-label">Model, effort, access and mode</span>
              {controls}
            </div>
          ) : null}
        </div>
        <div className="bm-start-foot">
          <button type="button" className="bm-start-cancel" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="bm-start-go" data-testid="edit-agent-save" disabled={!cleanName(name)}>
            Save
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

// A new agent beside this frame, like this one (same model and where it runs), optionally
// about one of its messages.
export async function startBeside(opts: { frameId: string; agentId?: string; binding: Record<string, unknown>; frameName: string; boardId: string; quote?: string }) {
  const agent = opts.agentId ? await api<{ provider?: string; model?: string }>(`/api/ui/agents/${encodeURIComponent(opts.agentId)}`).catch(() => null) : null;
  const like = sameAs(agent, opts.binding);
  const url = `${publicBaseNow()}/?board=${encodeURIComponent(opts.boardId)}&frame=${encodeURIComponent(opts.frameId)}`;
  askStartBeside(opts.frameId, { provider: like.provider, host: like.host, worker: like.worker, cloudProvider: like.cloudProvider, ...(opts.quote ? { prompt: aboutMessage(opts.quote, { name: opts.frameName, url }) } : {}) });
}

// Long-press on a message: what to do with it. `fork`: "Fork from here" (a new frame and
// agent from the conversation up to this message, ForkFromHere.tsx), where it can be forked.
export function MessageMenu({ at, text, startAbout, fork, close }: { at: { x: number; y: number }; text: string; startAbout: () => void; fork?: () => void; close: () => void }) {
  useModalHold();
  const [copied, setCopied] = useState(false);
  const top = Math.min(at.y + 8, window.innerHeight - (fork ? 188 : 140));
  return createPortal(
    <div className="bm-msg-layer" data-mobile-ui>
      <div className="bm-msg-scrim" onPointerDown={close} />
      <div className="bm-msg-menu" role="menu" data-testid="message-menu" style={{ top }}>
        <button type="button" role="menuitem" data-testid="message-start-agent" onClick={() => { close(); startAbout(); }}>
          + Start agent about this
        </button>
        {fork ? (
          <button type="button" role="menuitem" data-testid="message-fork-here" onClick={() => { close(); fork(); }}>
            Fork from here
          </button>
        ) : null}
        <button type="button" role="menuitem" data-testid="message-copy" onClick={() => { void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => undefined); setTimeout(close, 600); }}>
          {copied ? "Copied" : "Copy text"}
        </button>
      </div>
    </div>,
    document.body,
  );
}
