// "You: <the last message you sent>" pinned under a thread's header (phone sheet and desktop
// Sidebar), so the conversation is easy to place without scrolling back. Tap: scroll to that
// message and highlight it. Long-press (phone): every message you sent in this thread, newest
// first (the newest in full); tap one to jump to it. Hover (desktop): the whole message.
// Nothing when the person has sent nothing. Rules in shared/last-message.ts and lastSent.ts.

import { useState } from "react";
import { useLongPress } from "./mobile/ThreadTools";

export type Mine = { text: string; at: string };

export function LastSentStrip({ text, full, mobile, onGo, mine = [], onJump }: { text: string; full: string; mobile: boolean; onGo: () => void; mine?: Mine[]; onJump?: (at: string) => void }) {
  const [open, setOpen] = useState(false);
  const press = useLongPress(() => setOpen(true), mobile) as { style?: React.CSSProperties };
  const list = mine.length > 1 && !!onJump;
  return (
    <div style={{ flexShrink: 0, position: "relative", borderBottom: "1px solid light-dark(#f1f5f9, var(--bunny-line))" }}>
      <button
        type="button"
        data-testid="last-sent"
        title={mobile ? undefined : full}
        {...press}
        onClick={() => {
          if (open) return setOpen(false);
          onGo();
        }}
        style={{ ...press.style, display: "flex", width: "100%", gap: 4, alignItems: "baseline", border: 0, background: "light-dark(#f8fafc, var(--bunny-surface))", padding: mobile ? "6px 14px" : "5px 14px", font: "inherit", fontSize: mobile ? 13 : 12, color: "light-dark(#475569, var(--bunny-muted))", textAlign: "left", cursor: "pointer" }}
      >
        <span style={{ flexShrink: 0, fontWeight: 600, color: "light-dark(#334155, hsl(215 50% 74%))" }}>You:</span>
        <span data-testid="last-sent-text" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{text}</span>
      </button>
      {open ? (
        <div data-testid="last-sent-full" role="dialog" aria-label="Your messages" onClick={() => setOpen(false)} style={{ position: "absolute", zIndex: 5, left: 10, right: 10, top: "100%", maxHeight: "min(420px, 60vh)", overflowY: "auto", background: "light-dark(#fff, var(--bunny-surface))", border: "1px solid light-dark(#e2e8f0, var(--bunny-line))", borderRadius: 12, boxShadow: "0 8px 24px rgba(15,23,42,.14)", padding: "6px", fontSize: 14, overflowWrap: "anywhere" }}>
          {/* The newest in full, unless the list's first line already shows all of it. */}
          {list && full.replace(/\s+/g, " ").trim() === mine[0].text ? null : <div style={{ padding: "4px 8px 6px", whiteSpace: "pre-wrap" }}>{full}</div>}
          {list ? (
            <div data-testid="last-sent-list" role="list">
              <div style={{ padding: "4px 8px", fontSize: 11, fontWeight: 600, color: "light-dark(#64748b, var(--bunny-muted))" }}>Your messages · tap to jump</div>
              {mine.map((m) => (
                <button key={m.at} type="button" role="listitem" data-testid="last-sent-item" data-at={m.at} onClick={(e) => { e.stopPropagation(); setOpen(false); onJump?.(m.at); }} style={{ display: "block", width: "100%", border: 0, background: "transparent", textAlign: "left", font: "inherit", fontSize: 14, color: "inherit", padding: "9px 8px", borderRadius: 8, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", cursor: "pointer" }}>
                  {m.text}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// Scrolls the timeline row sent at `at` into view and highlights it for ~1.5 s. False when
// it is not in the list (older than what is loaded).
export function scrollToRow(list: HTMLElement | null, at: string): boolean {
  const holder = list?.querySelector<HTMLElement>(`[data-at="${CSS.escape(at)}"]`);
  if (!holder) return false;
  // Holders may be display:contents; scroll and light up the first child with a box.
  const el = holder.getClientRects().length ? holder : ((holder.firstElementChild as HTMLElement | null) ?? holder);
  const box = el.getBoundingClientRect();
  const viewport = list!.getBoundingClientRect();
  // Scroll this conversation only. scrollIntoView also moves enclosing portal panes.
  list!.scrollTo({ top: list!.scrollTop + box.top - viewport.top - (list!.clientHeight - box.height) / 2, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  el.setAttribute("data-flash", "");
  el.animate?.([{ boxShadow: "0 0 0 3px rgba(250,204,21,.9)", background: "light-dark(rgba(254,243,199,.9), color-mix(in srgb, hsl(48 45% 21%) 90%, transparent))" }, { boxShadow: "0 0 0 3px rgba(250,204,21,0)", background: "light-dark(rgba(254,243,199,0), color-mix(in srgb, hsl(48 45% 21%) 0%, transparent))" }], { duration: 1500, easing: "ease-out" });
  setTimeout(() => el.removeAttribute("data-flash"), 1500);
  return true;
}
