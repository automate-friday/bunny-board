// Next-step suggestions inside the empty opening-message box (quickStartPrompts.ts). While
// the box is empty, up to three cards sit in it under the placeholder line: one icon for the
// kind of step (the likely next request, something to check, a new idea), the action, and a
// line saying what prompted it. A click fills the message; it never sends. Typing in the
// box (or naming the agent) removes them; an empty box brings them back. Every card comes
// from the suggestion model (server/quick-starts-ai.ts); there are no fixed or replayed
// cards. Two small controls share the placeholder line: more suggestions, and a switch that
// turns them off (then nothing is sent). The empty-board hint, which has no message box,
// shows the same cards as a plain list (QuickStartList).
import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { B, UI_FONT } from "./bunnyTheme";
import type { Editor } from "tldraw";
import { pageContext } from "./pageContext";
import { aiEnabled, askAllowed, cachedIdeas, contextKey, fetchIdeas, lastError, noteShown, notePicked, type PageContext, pageOf, promptHistory, setAiEnabled, type Starter, type StarterSlot } from "./quickStartPrompts";

const TINT: Record<StarterSlot, { bg: string; fg: string; label: string }> = {
  next: { bg: "light-dark(#DCFCE7, #1f3f2b)", fg: "light-dark(#15803D, #86efac)", label: "Next step" },
  check: { bg: "light-dark(#FFE4E6, #4a2329)", fg: "light-dark(#BE123C, #fda4af)", label: "Worth checking" },
  idea: { bg: B.lavenderSoft, fg: B.violetDeep, label: "New idea" },
};

// Line icons in the board's emoji style (Emoji.tsx): 24-unit grid, currentColor strokes.
const SPARK = <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />;
const ICON: Record<StarterSlot, ReactNode> = {
  next: <><path d="M5 12h13" /><path d="M13 6l6 6-6 6" /></>,
  check: <><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" /><path d="M9 12l2 2 4-4" /></>,
  idea: SPARK,
};
const AGAIN = <><path d="M20 12a8 8 0 1 1-2.3-5.7" /><path d="M20 4v4h-4" /></>;

function Icon({ children, size = 14 }: { children: ReactNode; size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

const CSS = `
.bqs button.bqs-card{min-width:0;width:100%;display:flex;gap:9px;align-items:center;text-align:left;border:1px solid ${B.line};background:light-dark(#fff,var(--bunny-surface));border-radius:9px;padding:4px 9px;box-sizing:border-box;cursor:pointer;color:${B.espresso};font:inherit;transition:border-color .12s,background .12s}
.bqs button.bqs-card:hover:not(:disabled){border-color:${B.lavender};background:light-dark(#FBF9FF,var(--bunny-surface))}
.bqs button.bqs-card:focus-visible{outline:2px solid ${B.violet};outline-offset:1px}
.bqs button.bqs-ctl{border:0;background:none;padding:0;border-radius:999px;cursor:pointer;color:${B.violetDeep};display:inline-grid;place-items:center}
.bqs button.bqs-ctl:hover:not(:disabled){background:${B.lavenderSoft}}
.bqs button.bqs-ctl:focus-visible{outline:2px solid ${B.violet};outline-offset:1px}
.bqs button.bqs-ctl[aria-pressed=false]{color:${B.muted}}
.bqs button.bqs-ctl:disabled{opacity:.5;cursor:default}
.bqs-wait{border:1px solid ${B.line};border-radius:9px;box-sizing:border-box;background:light-dark(#fff,var(--bunny-surface));opacity:.55;animation:bqs-wait 1.4s ease-in-out infinite}
@keyframes bqs-wait{50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){.bqs-wait{animation:none}}
`;
const ellipsis: CSSProperties = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };

// What a start form's suggestions run on: the cards for this frame (from the cache at once,
// then from the model), paging for "more", and the switch. `active` is whether the form is
// open: nothing is read or asked before that. `count` is how many cards show at a time.
const ASK_DELAY_MS = 400;
export type QuickStartData = ReturnType<typeof useQuickStartData>;
export function useQuickStartData({ editor, frameId, active = true, count = 3 }: { editor?: Editor; frameId?: string | null; active?: boolean; count?: number }) {
  const history = useMemo(() => promptHistory(), [active]);
  const context = useMemo<PageContext | null>(() => (active && editor ? pageContext(editor, frameId ?? null) : null), [active, editor, frameId]);
  const key = useMemo(() => contextKey(history, context), [history, context]);
  const [ai, setAi] = useState(aiEnabled);
  const on = ai && active;
  // Everything below belongs to one frame context (`key`): a new context starts over from
  // its cached cards. `attempt` is bumped by "more" after a call that gave nothing.
  const fresh = useMemo(() => ({ key, more: null as Starter[] | null, page: 0, failed: false, error: "", attempt: 0 }), [key]);
  const [held, setHeld] = useState(fresh);
  const view = held.key === key ? held : fresh;
  const patch = useCallback((p: Partial<typeof fresh>) => setHeld((v) => ({ ...(v.key === key ? v : fresh), ...p })), [key, fresh]);
  const cached = useMemo(() => (on ? cachedIdeas(key) : []), [on, key]);
  const ideas = view.more ?? cached;
  const [busy, setBusy] = useState(false);
  const { cards, needMore } = useMemo(() => pageOf(ideas, count, view.page, !view.failed), [ideas, count, view.page, view.failed]);
  useEffect(() => {
    if (!on || !needMore) return;
    // A call for this context gave nothing a moment ago: wait for "more" or the hold-off.
    if (!view.attempt && !askAllowed(key)) return patch({ failed: true, error: lastError(key) });
    let live = true;
    setBusy(true);
    // A form that is opened and closed again straight away never asks.
    const t = setTimeout(() => {
      void fetchIdeas(key, history, context, { frameId: frameId ?? null }).then((r) => {
        if (!live) return;
        patch("ideas" in r ? { more: r.ideas, error: "" } : { failed: true, error: r.error });
        setBusy(false);
      });
    }, ASK_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(t);
      setBusy(false);
    };
  }, [on, needMore, key, history, context, frameId, view.attempt, patch]);
  const toggleAi = useCallback(() => {
    setAi((was) => {
      setAiEnabled(!was);
      return !was;
    });
  }, []);
  // The next cards; after a call that gave nothing, one more try.
  const more = useCallback(() => patch(view.failed && !cards.length ? { failed: false, attempt: view.attempt + 1 } : { page: view.page + 1 }), [patch, view.failed, view.page, view.attempt, cards.length]);
  // Why there are no cards, when a call gave none.
  const note = on && view.failed && !cards.length && !busy ? view.error : "";
  return { ai, cards: on ? cards : [], busy: on && busy, note, count, toggleAi, more };
}

function Card({ s, compact, onPick }: { s: Starter; compact: boolean; onPick: (s: Starter) => void }) {
  const slot: StarterSlot = s.slot && s.slot in TINT ? s.slot : "next";
  const tint = TINT[slot];
  return (
    <button type="button" className="bqs-card" data-testid="quick-start" data-slot={slot} title={`${tint.label}: ${s.prompt}`} onClick={() => { notePicked(s.title); onPick(s); }} style={{ height: compact ? ROW.compact : ROW.list }}>
      <span style={{ width: 22, height: 22, borderRadius: 8, flex: "none", display: "grid", placeItems: "center", background: tint.bg, color: tint.fg }}>
        <Icon size={13}>{ICON[slot]}</Icon>
      </span>
      <span style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
        <b style={{ ...ellipsis, fontWeight: 600, fontSize: compact ? 14 : 13 }}>{s.title}</b>
        {s.detail ? <span style={{ ...ellipsis, fontSize: 12, color: B.muted }}>{s.detail}</span> : null}
      </span>
    </button>
  );
}

function Controls({ data, compact }: { data: QuickStartData; compact: boolean }) {
  const { ai, cards, busy, toggleAi, more } = data;
  const size = compact ? 40 : 32;
  return (
    <>
      {ai ? (
        <button type="button" className="bqs-ctl" data-testid="quick-starts-more" onClick={more} disabled={busy} aria-label="Other suggestions" title={cards.length ? "Other suggestions" : "Suggest again"} style={{ width: size, height: size }}>
          <Icon size={compact ? 16 : 13}>{AGAIN}</Icon>
        </button>
      ) : null}
      <button type="button" className="bqs-ctl" data-testid="quick-starts-ai" aria-pressed={ai} aria-label="Suggestions" onClick={toggleAi} title={ai ? "Suggestions are on: your recent opening messages, this frame and the frames near it (names, stickies, what their agents reported) and the workspace's recent commits go to a small Claude model, which suggests what to ask next. Click to turn off." : "Suggestions are off: nothing is sent. Click to have a small Claude model read your recent requests, the frames near this one and the workspace, and suggest what to ask next."} style={{ width: size, height: size }}>
        <Icon size={compact ? 16 : 13}>{SPARK}</Icon>
      </button>
    </>
  );
}

// Card and placeholder-line heights (desktop list, phone compact).
const ROW = { list: 44, compact: 48 };
const TOP = { list: 36, compact: 44 };
const GAP = 4;

// Wraps a start form's message box and lays the suggestions inside it. `show`: the box is
// empty and nothing else has been typed. `children` renders the box itself with the height
// the cards need; once grown it stays that tall, so typing does not make the form jump.
// `insetRight` keeps the controls clear of something else in the box's top-right corner.
export function SuggestField({ data, show, onPick, layout = "list", insetRight = 0, className, children }: { data: QuickStartData; show: boolean; onPick: (s: Starter) => void; layout?: "list" | "compact"; insetRight?: number; className?: string; children: (minHeight: number | undefined) => ReactNode }) {
  const { ai, cards, busy, count } = data;
  const compact = layout === "compact";
  const waiting = show && ai && busy && cards.length < count;
  const rows = show && ai ? (waiting ? count : cards.length) : 0;
  const need = rows ? TOP[layout] + rows * ROW[layout] + (rows - 1) * GAP + 8 : 0;
  const [tall, setTall] = useState(0);
  useEffect(() => { if (need > tall) setTall(need); }, [need, tall]);
  const titles = show ? cards.map((s) => s.title).join("\n") : "";
  useEffect(() => { if (titles) noteShown(titles.split("\n")); }, [titles]);
  return (
    <div className={`bqs${className ? ` ${className}` : ""}`} data-testid="suggest-field" style={{ position: "relative", font: `13px/1.35 ${UI_FONT}` }}>
      <style>{CSS}</style>
      {children(Math.max(tall, need) || undefined)}
      {show ? (
        <>
          <span style={{ position: "absolute", top: 2, right: 6 + insetRight, display: "inline-flex", alignItems: "center", gap: 2 }}>
            <Controls data={data} compact={compact} />
          </span>
          {!rows && data.note ? (
            <span data-testid="quick-starts-note" role="status" title={data.note} style={{ ...ellipsis, position: "absolute", left: 12, right: 12, top: TOP[layout] + 2, fontSize: 12, color: B.muted, pointerEvents: "none" }}>
              {data.note}
            </span>
          ) : null}
          {rows ? (
            <div data-testid="quick-starts" aria-label="Suggested next steps" aria-busy={waiting || undefined} style={{ position: "absolute", left: 8, right: 8, top: TOP[layout], display: "flex", flexDirection: "column", gap: GAP, pointerEvents: "none" }}>
              {cards.map((s) => <span key={s.prompt} style={{ display: "flex", pointerEvents: "auto" }}><Card s={s} compact={compact} onPick={onPick} /></span>)}
              {waiting ? Array.from({ length: count - cards.length }, (_, i) => <div key={i} className="bqs-wait" data-testid="quick-start-wait" style={{ height: ROW[layout] }} />) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

// The same cards as a plain list, for the empty-board hint (which has no message box).
export function QuickStartList({ data, onPick, layout = "list" }: { data: QuickStartData; onPick: (s: Starter) => void; layout?: "list" | "compact" }) {
  const { ai, cards, busy, count } = data;
  const compact = layout === "compact";
  const waiting = ai && busy && cards.length < count;
  const titles = cards.map((s) => s.title).join("\n");
  useEffect(() => { if (titles) noteShown(titles.split("\n")); }, [titles]);
  return (
    <section className="bqs" data-testid="quick-starts" aria-label="Suggested next steps" aria-busy={waiting || undefined} style={{ display: "flex", flexDirection: "column", gap: GAP, minWidth: 0, font: `13px/1.35 ${UI_FONT}` }}>
      <style>{CSS}</style>
      {cards.map((s) => <Card key={s.prompt} s={s} compact={compact} onPick={onPick} />)}
      {waiting ? Array.from({ length: count - cards.length }, (_, i) => <div key={i} className="bqs-wait" data-testid="quick-start-wait" style={{ height: ROW[layout] }} />) : null}
      {data.note ? <span data-testid="quick-starts-note" role="status" title={data.note} style={{ ...ellipsis, fontSize: 12, color: B.muted }}>{data.note}</span> : null}
      <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "flex-end", gap: 2 }}>
        <Controls data={data} compact={compact} />
      </span>
    </section>
  );
}
