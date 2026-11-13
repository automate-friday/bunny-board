// The row of actions under a completed response, and the one under your message, after
// Paseo 0.11.4's AssistantTurnFooter and UserMessage trailing row (responseLayout.ts has the
// rules for where they go).
//
//   response:  [Copy] [Fork from here]  10:03  Raw text      always shown, muted
//   your message:            [Copy] [Fork from here]          on hover or keyboard focus
//
// Icon-only buttons, no counters. Each is a 32x32px target on desktop (44px on touch layouts)
// around a 16px glyph, with a tooltip and an accessible name, a focus ring, and a colour change
// on hover and focus. Unlike Paseo's 22px targets, as docs/VISUAL-STANDARDS.md asks. The row
// under your message keeps its height while hidden, so nothing moves when it appears; on the
// phone it is not drawn (the message's long-press menu has Copy and Fork from here).

import { useEffect, useRef, useState } from "react";
import { B, UI_FONT } from "./bunnyTheme";
import { FORK_CONFIRM_CSS, ForkFromHere } from "./ForkFromHere";
import { footerTime } from "./responseLayout";
import { Glyph } from "./toolIcons";

export const RESPONSE_FOOTER_CSS = `
.bunny-turn-footer, .bunny-user-actions { display: flex; align-items: center; min-width: 0; height: 32px; flex: none; }
.bunny-turn-footer { gap: 0; margin: -4px 0 0 -8px; }
.bunny-user-actions { justify-content: flex-end; margin: 2px -8px 0 0; transition: opacity .15s; }
.bunny-turn-btn { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; flex: none; width: 32px; height: 32px; padding: 0; border: 0; border-radius: 999px; background: none; color: ${B.muted}; cursor: pointer; transition: color .15s, background .15s; }
.bunny-turn-btn:hover, .bunny-turn-btn:focus-visible, .bunny-turn-btn[aria-expanded="true"] { color: ${B.espresso}; background: ${B.lavenderSoft}; }
.bunny-turn-btn:focus-visible { outline: 2px solid ${B.violet}; outline-offset: -2px; }
.bunny-turn-meta { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; padding: 0 4px; font: 11px ${UI_FONT}; color: ${B.muted}; }
.bunny-turn-raw { flex: none; height: 32px; padding: 0 6px; border: 0; border-radius: 999px; background: none; color: ${B.muted}; cursor: pointer; font: 11px ${UI_FONT}; text-decoration: underline; text-underline-offset: 2px; }
.bunny-turn-raw:hover, .bunny-turn-raw:focus-visible, .bunny-turn-raw[aria-pressed="true"] { color: ${B.espresso}; }
.bunny-turn-raw:focus-visible { outline: 2px solid ${B.violet}; outline-offset: -2px; }
.bunny-turn-footer[data-touch="1"] { height: 44px; margin: -8px 0 0 -14px; }
.bunny-turn-footer[data-touch="1"] .bunny-turn-btn, .bunny-turn-footer[data-touch="1"] .bunny-turn-raw { width: 44px; height: 44px; }
.bunny-turn-footer[data-touch="1"] .bunny-turn-raw { width: auto; padding: 0 10px; }
.bunny-user-actions[data-hidden="1"] { opacity: 0; pointer-events: none; }
.bunny-unit:hover > .bunny-user-actions, .bunny-user-actions:focus-within, .bunny-user-actions:has([aria-expanded="true"]) { opacity: 1; pointer-events: auto; }
@media (hover: none) { .bunny-user-actions[data-hidden="1"] { opacity: 1; pointer-events: auto; } }
@media (pointer: coarse) {
  .bunny-turn-footer { height: 44px; margin: -8px 0 0 -14px; }
  .bunny-user-actions { height: 44px; margin-right: -14px; }
  .bunny-turn-btn { width: 44px; height: 44px; }
  .bunny-turn-raw { height: 44px; padding: 0 10px; }
}
@media (prefers-reduced-motion: reduce) { .bunny-user-actions, .bunny-turn-btn { transition: none; } }
${FORK_CONFIRM_CSS}`;

// The board is also served over plain http on the tailnet, where navigator.clipboard is missing.
export function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(() => true, () => fallbackCopy(text));
  return Promise.resolve(fallbackCopy(text));
}
function fallbackCopy(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  const focus = document.activeElement as HTMLElement | null;
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  focus?.focus?.();
  return ok;
}

export function CopyButton({ text, label, testId }: { text: string; label: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const name = copied ? "Copied" : label;
  return (
    <button
      type="button"
      className="bunny-turn-btn"
      data-testid={testId}
      aria-label={name}
      title={name}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => {
        void copyToClipboard(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      <Glyph name={copied ? "check" : "copy"} size={16} />
    </button>
  );
}

interface ForkTarget {
  boardId: string;
  frameId: string;
  rowId: string;
  at?: string;
  text: string;
}

export function ResponseFooter({ copyText, fork, at, raw, touch }: { copyText: string; fork?: ForkTarget; at?: string; raw?: { on: boolean; toggle: () => void }; touch: boolean }) {
  const when = footerTime(at);
  return (
    <div className="bunny-turn-footer" data-testid="response-footer" data-touch={touch ? "1" : undefined} role="group" aria-label="Response actions">
      {copyText ? <CopyButton text={copyText} label="Copy response" testId="response-copy" /> : null}
      {fork ? <ForkFromHere {...fork} className="bunny-turn-btn" align="start" /> : null}
      {when ? (
        <time className="bunny-turn-meta" data-testid="response-time" dateTime={at} title={at ? new Date(at).toLocaleString() : undefined}>
          {when}
        </time>
      ) : null}
      {raw ? (
        <button type="button" className="bunny-turn-raw" data-testid="response-raw" aria-pressed={raw.on} title={raw.on ? "Show the reply formatted" : "Show the reply's raw Markdown"} onPointerDown={(e) => e.stopPropagation()} onClick={raw.toggle}>
          {raw.on ? "Formatted" : "Raw text"}
        </button>
      ) : null}
    </div>
  );
}

// Under your message: hidden until the message is pointed at or a button has keyboard focus.
export function UserMessageActions({ text, fork }: { text: string; fork?: ForkTarget }) {
  if (!text && !fork) return null;
  return (
    <div className="bunny-user-actions" data-testid="user-message-actions" data-hidden="1" role="group" aria-label="Message actions">
      {text ? <CopyButton text={text} label="Copy message" testId="user-message-copy" /> : null}
      {fork ? <ForkFromHere {...fork} className="bunny-turn-btn" align="end" /> : null}
    </div>
  );
}
