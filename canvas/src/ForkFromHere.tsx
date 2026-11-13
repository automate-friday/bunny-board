// "Fork from here": the fork button in a response's footer and in the trailing row under your
// message (ResponseFooter.tsx), and the one confirmation it opens, anchored to the button. The
// confirmation quotes the message the fork cuts at and says what the new frame gets; Fork then
// asks the server (server/frame-fork.ts, body {rowId}) and the board toasts like the frame
// menu's "Fork to new frame". The phone thread offers the same from a message's long-press
// menu (mobile/ThreadTools.tsx).

import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import { B, primaryBtn, softBtn, surface, UI_FONT } from "./bunnyTheme";
import { type ForkFromResult, forkedNotice, messageTime } from "./forkPoint";
import { Glyph } from "./toolIcons";
import { BoardUiCtx } from "./ui";

export function forkFromRow(boardId: string, frameId: string, rowId: string): Promise<ForkFromResult> {
  return api<ForkFromResult>(`/api/ui/boards/${encodeURIComponent(boardId)}/frames/${encodeURIComponent(frameId)}/fork`, { method: "POST", body: JSON.stringify({ rowId }) });
}

export const FORK_CONFIRM_CSS = `
.bunny-fork-confirm button:focus-visible { outline: 2px solid ${B.violet}; outline-offset: 2px; }
.bunny-fork-confirm button:disabled { opacity: .6; cursor: default; }
`;

const WIDTH = 296;
// Room the confirmation needs (its height with an error line).
const ROOM = 230;
// Between the confirmation and the button.
const GAP = 8;
const oneLine: React.CSSProperties = { minWidth: 0, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" };

// `align`: the confirmation's left edge on the button's ("start", a response's footer) or its
// right edge ("end", the row under your message, which sits on the right).
export function ForkFromHere({ boardId, frameId, rowId, at, text, align = "start", className, size = 16 }: { boardId: string; frameId: string; rowId: string; at?: string; text: string; align?: "start" | "end"; className?: string; size?: number }) {
  const ui = useContext(BoardUiCtx);
  const link = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const go = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<React.CSSProperties | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const close = (refocus = false) => {
    setOpen(null);
    setErr(null);
    if (refocus) link.current?.focus();
  };
  const toggle = () => {
    if (open) return close();
    const r = link.current?.getBoundingClientRect();
    if (!r) return;
    const x = align === "start" ? { left: Math.max(8, Math.min(r.left, window.innerWidth - WIDTH - 8)) } : { right: Math.max(8, Math.min(window.innerWidth - r.right, window.innerWidth - WIDTH - 8)) };
    // Above the button when there is room, so the response stays in view; else under it.
    const y = r.top - GAP > ROOM ? { bottom: window.innerHeight - r.top + GAP } : { top: Math.max(8, Math.min(r.bottom + GAP, window.innerHeight - ROOM)) };
    setOpen({ ...x, ...y });
  };
  useLayoutEffect(() => {
    if (open) go.current?.focus();
  }, [open !== null]);
  // Esc, a press outside, or the thread scrolling away closes it.
  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => {
      const t = e.target as Node | null;
      if (t && (panel.current?.contains(t) || link.current?.contains(t))) return;
      close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close(true);
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("wheel", outside, true);
    window.addEventListener("resize", outside);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("wheel", outside, true);
      window.removeEventListener("resize", outside);
      window.removeEventListener("keydown", key, true);
    };
  }, [open !== null]);

  const fork = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      ui.toast(forkedNotice(await forkFromRow(boardId, frameId, rowId)));
      close();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const when = messageTime(at);
  const quote = text.replace(/\s+/g, " ").trim();
  return (
    <>
      <button ref={link} type="button" className={className} data-testid="fork-here" aria-haspopup="dialog" aria-expanded={!!open} aria-label="Fork from here" title="Fork from here" onPointerDown={(e) => e.stopPropagation()} onClick={toggle}>
        <Glyph name="fork" size={size} />
      </button>
      {open
        ? createPortal(
            <div ref={panel} className="bunny-fork-confirm" role="dialog" aria-label="Fork from here" data-testid="fork-here-confirm" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} style={{ ...surface, position: "fixed", ...open, width: WIDTH, maxWidth: "calc(100vw - 16px)", boxSizing: "border-box", padding: 12, display: "flex", flexDirection: "column", gap: 8, zIndex: 1100 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
                <span style={{ font: `600 13px ${UI_FONT}`, flex: "none" }}>Fork from here</span>
                {when ? (
                  <span data-testid="fork-here-time" title={at} style={{ ...oneLine, font: `11px ${UI_FONT}`, color: B.muted }}>
                    {when}
                  </span>
                ) : null}
              </div>
              {quote ? (
                <div data-testid="fork-here-quote" title={quote.slice(0, 600)} style={{ display: "flex", minWidth: 0, padding: "6px 8px", borderRadius: 8, background: B.lavenderSoft, font: `12px/1.45 ${UI_FONT}` }}>
                  <span style={oneLine}>{quote.slice(0, 200)}</span>
                </div>
              ) : null}
              <div style={{ font: `12px/1.45 ${UI_FONT}`, color: B.muted, overflowWrap: "break-word" }}>A new frame beside this one. Its agent starts from the conversation up to this message, and the frame is filled as this one was then. Files on disk are not rewound.</div>
              {err ? (
                <div role="alert" data-testid="fork-here-error" style={{ display: "flex", alignItems: "baseline", gap: 6, font: `12px/1.45 ${UI_FONT}`, color: B.muted }}>
                  <span aria-hidden style={{ flex: "none", width: 7, height: 7, borderRadius: 999, background: B.danger, transform: "translateY(-1px)" }} />
                  <span style={{ minWidth: 0, overflowWrap: "break-word" }}>Not forked: {err}</span>
                </div>
              ) : null}
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button type="button" style={softBtn} data-testid="fork-here-cancel" disabled={busy} onClick={() => close(true)}>
                  Cancel
                </button>
                <button ref={go} type="button" style={primaryBtn} data-testid="fork-here-go" disabled={busy} onClick={() => void fork()}>
                  {busy ? "Forking…" : "Fork"}
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
