// Starter prompt cards under an opening message (quickStartPrompts.ts): a labelled group of
// equal cards, each an icon, a title and one line of detail, with "Show others" to rotate
// them. Cards about the frame's own content come first ("Here"). "Smarter with AI" (off by
// default) swaps in cards from an occasional model call; Show others goes back to local
// ones. A click fills the message; it never sends. `layout="compact"` is the phone's
// one-column list of up to three cards about this person's work (relevantStarters).
import { type CSSProperties, type ReactNode, useEffect, useMemo, useState } from "react";
import { B, UI_FONT } from "./bunnyTheme";
import type { Editor } from "tldraw";
import { pageContext } from "./pageContext";
import { aiCache, aiEnabled, fetchAiStarters, ghostIdeas, type PageContext, pageStarters, promptHistory, relevantStarters, setAiEnabled, suggestStarters, type Starter, type StarterKind, withAiStarters, withPageStarters } from "./quickStartPrompts";

const TINT: Record<StarterKind, { bg: string; fg: string }> = {
  plan: { bg: "light-dark(#FEF3C7, #4a3f1d)", fg: "light-dark(#A16207, #fcd34d)" },
  build: { bg: "light-dark(#DCFCE7, #1f3f2b)", fg: "light-dark(#15803D, #86efac)" },
  research: { bg: "light-dark(#DBEAFE, #1e3150)", fg: "light-dark(#1D4ED8, #93c5fd)" },
  review: { bg: "light-dark(#FFE4E6, #4a2329)", fg: "light-dark(#BE123C, #fda4af)" },
  write: { bg: B.peachSoft, fg: "light-dark(#C2410C, #fdba74)" },
  design: { bg: B.lavenderSoft, fg: B.violetDeep },
};

// Line icons in the board's emoji style (Emoji.tsx): 24-unit grid, currentColor strokes.
const ICON: Record<StarterKind, ReactNode> = {
  plan: <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M8 9h8M8 13h8M8 17h5" /></>,
  build: <path d="M14.5 5.5a4 4 0 0 0-5 5L4 16l4 4 5.5-5.5a4 4 0 0 0 5-5l-2.5 2.5-2.5-.5-.5-2.5z" />,
  research: <><circle cx="10.5" cy="10.5" r="5.5" /><path d="M15 15l5 5" /></>,
  review: <><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" /><path d="M9 12l2 2 4-4" /></>,
  write: <><path d="M5 19l1-4L16 5l3 3L9 18z" /><path d="M14 7l3 3" /></>,
  design: <><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="16" height="7" rx="1.5" /></>,
};
const RECENT_ICON = <><path d="M4 12a8 8 0 1 0 2.3-5.7" /><path d="M4 4v4h4" /><path d="M12 8v4l3 2" /></>;
const SPARK = <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />;

function Icon({ children, size = 14 }: { children: ReactNode; size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

const CSS = `
.bqs button.bqs-card{min-width:0;display:flex;gap:10px;align-items:center;text-align:left;border:1px solid ${B.line};background:light-dark(#fff,var(--bunny-surface));border-radius:12px;padding:9px 11px;box-sizing:border-box;cursor:pointer;color:${B.espresso};font:inherit;transition:border-color .12s,background .12s,box-shadow .12s}
.bqs button.bqs-card:hover:not(:disabled){border-color:${B.lavender};background:light-dark(#FBF9FF,var(--bunny-surface));box-shadow:0 1px 3px rgba(46,31,22,.06)}
.bqs button.bqs-card:focus-visible{outline:2px solid ${B.violet};outline-offset:1px}
.bqs button.bqs-more{border:0;background:none;padding:2px 4px;border-radius:6px;cursor:pointer;color:${B.violetDeep};font:500 12px ${UI_FONT};display:inline-flex;align-items:center;gap:4px}
.bqs button.bqs-more:hover:not(:disabled){background:${B.lavenderSoft}}
.bqs-switch{position:relative;width:22px;height:12px;border-radius:999px;background:${B.line};transition:background .12s;flex:none}
.bqs-switch>span{position:absolute;top:2px;left:2px;width:8px;height:8px;border-radius:50%;background:#fff;transition:left .12s}
.bqs-switch[data-on]{background:${B.violet}}.bqs-switch[data-on]>span{left:12px}
`;
const ellipsis: CSSProperties = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };

// The suggestion inputs a start form shares between its cards and its ghost typewriter:
// the person's history, the page around the frame, and (when on) the AI cards. The AI call
// waits until the form has sat idle (`idle`), so a quick start never triggers one.
export type QuickStartData = ReturnType<typeof useQuickStartData>;
export function useQuickStartData({ editor, frameId, idle = true }: { editor?: Editor; frameId?: string | null; idle?: boolean }) {
  const history = useMemo(() => promptHistory(), []);
  const context = useMemo<PageContext | null>(() => (editor && frameId ? pageContext(editor, frameId) : null), [editor, frameId]);
  const [ai, setAi] = useState(aiEnabled);
  const [aiCards, setAiCards] = useState<Starter[] | null>(() => (aiEnabled() ? aiCache()?.starters ?? null : null));
  const [aiBusy, setAiBusy] = useState(false);
  const learnable = history.length > 0 || !!context?.stickies.length || !!context?.frame;
  useEffect(() => {
    if (!ai || !idle || !learnable) return;
    let live = true;
    setAiBusy(true);
    fetchAiStarters(history, context).then((cards) => { if (live) { if (cards?.length) setAiCards(cards); setAiBusy(false); } });
    return () => { live = false; };
  }, [ai, idle, learnable, history, context]);
  const toggleAi = () => {
    setAiEnabled(!ai);
    setAi(!ai);
  };
  const ideas = useMemo(() => ghostIdeas(history, context, ai ? aiCards : null), [history, context, ai, aiCards]);
  return { history, context, ai, aiCards: ai ? aiCards : null, aiBusy, learnable, toggleAi, ideas };
}

export function QuickStarts({ onPick, layout = "grid", heading, data }: { onPick: (s: Starter) => void; layout?: "grid" | "compact"; heading?: string; data: QuickStartData }) {
  const { history, context, ai, aiCards, aiBusy, learnable, toggleAi } = data;
  const [page, setPage] = useState(0);
  const compact = layout === "compact";
  // Phone: a short list about this person's work only (relevantStarters), one card per row so
  // each title reads in full.
  const local = useMemo(() => (compact ? relevantStarters(history, context, 3, page) : withPageStarters(suggestStarters(history, 4, page), page === 0 ? pageStarters(context) : [])), [compact, history, context, page]);
  const showAi = page === 0 && !!aiCards?.length;
  const list = showAi && aiCards ? withAiStarters(local, aiCards, compact ? 3 : 4) : local;
  const title = heading ?? (showAi ? "For you · AI" : local.some((s) => s.badge === "page") ? "For this frame" : local.some((s) => s.badge === "recent") ? "For you" : "Suggested");
  return (
    <section className="bqs" data-testid="quick-starts" aria-label="Suggested prompts" style={{ display: "flex", flexDirection: "column", gap: compact ? 6 : 8, minWidth: 0, font: `13px/1.35 ${UI_FONT}` }}>
      <style>{CSS}</style>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, font: `600 11px ${UI_FONT}`, letterSpacing: ".04em", textTransform: "uppercase", color: B.muted, whiteSpace: "nowrap" }}>
          <Icon size={12}>{SPARK}</Icon>
          {title}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
        {learnable ? (
          <button type="button" className="bqs-more" data-testid="quick-starts-ai" aria-pressed={ai} onClick={() => { toggleAi(); setPage(0); }} title={ai ? "On: when you pause, at most once every 4 hours, your recent opening messages and this frame's stickies go to a small Claude model (Haiku) for tailored starters. Click to turn off." : "Off. Turn on for tailored starters: when you pause, at most once every 4 hours, your recent opening messages and this frame's stickies go to a small Claude model (Haiku)."} style={ai ? undefined : { color: B.muted }}>
            <span aria-hidden className="bqs-switch" data-on={ai || undefined}><span /></span>
            {aiBusy ? "Thinking…" : compact ? "AI" : "Smarter with AI"}
          </button>
        ) : null}
        <button type="button" className="bqs-more" data-testid="quick-starts-more" onClick={() => setPage((p) => p + 1)} aria-label="Show other suggestions">
          <Icon size={12}><path d="M20 12a8 8 0 1 1-2.3-5.7" /><path d="M20 4v4h-4" /></Icon>
          {compact ? null : "Show others"}
        </button>
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: compact ? "minmax(0, 1fr)" : "repeat(2, minmax(0, 1fr))", gap: compact ? 6 : 8 }}>
        {list.map((s) => {
          const tint = s.badge === "recent" || s.badge === "ai" ? { bg: B.lavenderSoft, fg: B.violetDeep } : TINT[s.kind];
          const icon = s.badge === "recent" ? RECENT_ICON : s.badge === "ai" ? SPARK : ICON[s.kind];
          const tag = s.badge === "recent" ? "Recent" : s.badge === "page" ? "Here" : null;
          return (
            <button key={s.prompt} type="button" className="bqs-card" data-testid="quick-start" data-kind={s.kind} data-badge={s.badge} title={s.prompt} onClick={() => onPick(s)} style={compact ? { padding: "7px 10px", gap: 10, minHeight: 48 } : undefined}>
              <span style={{ width: 26, height: 26, borderRadius: 8, flex: "none", display: "grid", placeItems: "center", background: tint.bg, color: tint.fg }}>
                <Icon size={14}>{icon}</Icon>
              </span>
              <span style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
                  <b style={{ ...ellipsis, fontWeight: 600, fontSize: compact ? 14 : 13 }}>{s.title}</b>
                  {tag && !compact ? <span style={{ flex: "none", font: `600 10px ${UI_FONT}`, color: B.violetDeep, background: B.lavenderSoft, borderRadius: 5, padding: "0 5px", lineHeight: "15px" }}>{tag}</span> : null}
                </span>
                <span style={{ ...ellipsis, fontSize: 12, color: B.muted }}>{s.detail}</span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

// Under the message box while a ghost idea shows: what Tab does, and a button for touch.
export function GhostUse({ onUse }: { onUse: () => void }) {
  return (
    <div className="bqs" data-testid="ghost-use" style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6, marginTop: -4, font: `12px ${UI_FONT}`, color: B.muted }}>
      <style>{CSS}</style>
      <span>Idea for this frame</span>
      <button type="button" className="bqs-more" data-testid="ghost-use-btn" onClick={onUse}>
        Use it <kbd style={{ font: `600 10px ${UI_FONT}`, border: `1px solid ${B.line}`, borderRadius: 4, padding: "0 4px", color: B.muted }}>Tab</kbd>
      </button>
    </div>
  );
}
