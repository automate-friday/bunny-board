// Paseo-inspired prompt navigation, using the loaded human-message index.
import { useEffect, useRef, useState, type RefObject } from "react";
import { B, softBtn, surface, UI_FONT } from "./bunnyTheme";

type Prompt = { at: string; text: string };
const stamp = (at: string) => {
  const date = new Date(at);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : at;
};
// Keep the two landmarks while a small window follows the reader through long chats.
function windowIndices(length: number, active: number) {
  if (!length) return [];
  const start = Math.max(1, Math.min(length - 6, active - 2));
  return [...new Set([0, ...Array.from({ length: Math.min(5, Math.max(0, length - 2)) }, (_, i) => start + i), length - 1])].sort((a, b) => a - b);
}
export function ChatOutline({ listRef, prompts, mobile, onJump, onLatest, beginning, older, atStart }: {
  listRef: RefObject<HTMLDivElement | null>; prompts: Prompt[]; mobile: boolean;
  onJump: (at: string) => void; onLatest: () => void;
  beginning?: { busy: boolean; go: () => void; cancel: () => void };
  older?: { busy: boolean; error?: string | null; load: () => void };
  atStart: boolean;
}) {
  const [active, setActive] = useState<string | null>(null);
  const [up, setUp] = useState(false);
  const [open, setOpen] = useState(false);
  const [attention, setAttention] = useState<number | null>(null);
  const [previewY, setPreviewY] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLDivElement>(null);
  // Keep rail positions fixed while the reader points at them; loading more history must
  // not replace the prompt underneath the pointer.
  const [held, setHeld] = useState<string[] | null>(null);
  const activeIndex = Math.max(0, prompts.findIndex(p => p.at === active));
  const indices = held ? held.map(at => prompts.findIndex(p => p.at === at)).filter(i => i >= 0) : windowIndices(prompts.length, activeIndex);
  const attentionPrompt = attention === null ? null : prompts[indices[attention]];
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        setUp(el.scrollHeight - el.scrollTop - el.clientHeight > 40);
        const top = el.getBoundingClientRect().top;
        let current = prompts[0]?.at ?? null;
        for (const p of prompts) {
          const holder = el.querySelector<HTMLElement>(`[data-at="${CSS.escape(p.at)}"]`);
          const row = holder?.getClientRects().length ? holder : holder?.firstElementChild;
          if (row && row.getBoundingClientRect().top <= top + 24) current = p.at;
        }
        setActive(current);
      });
    };
    measure(); el.addEventListener('scroll', measure, { passive: true });
    const observer = new ResizeObserver(measure); observer.observe(el);
    const mutation = new MutationObserver(measure); mutation.observe(el, { childList: true, subtree: true, characterData: true });
    return () => { el.removeEventListener('scroll', measure); observer.disconnect(); mutation.disconnect(); cancelAnimationFrame(raf); };
  }, [listRef, prompts]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); root.current?.querySelector<HTMLButtonElement>('[data-testid="message-picker-toggle"]')?.focus(); } };
    document.addEventListener('pointerdown', close); root.current?.addEventListener('keydown', key);
    const el = picker.current; const selected = el?.querySelector<HTMLElement>('[aria-current="true"]');
    if (el && selected) el.scrollTop += selected.getBoundingClientRect().top - el.getBoundingClientRect().top - el.clientHeight / 2;
    return () => { document.removeEventListener('pointerdown', close); root.current?.removeEventListener('keydown', key); };
  }, [open]);
  const size = mobile ? 44 : 32;
  const target = { ...softBtn, display: 'grid', placeItems: 'center', width: size, height: size, padding: 0, color: B.muted } as const;
  const jump = (at: string) => { setOpen(false); setAttention(null); onJump(at); };
  const latest = () => { setOpen(false); setAttention(null); onLatest(); };
  const show = (button: HTMLButtonElement, slot: number) => {
    setAttention(slot);
    setPreviewY(Math.max(8, Math.min((root.current?.clientHeight ?? 0) - 90, button.getBoundingClientRect().top - (root.current?.getBoundingClientRect().top ?? 0))));
  };
  return <div ref={root} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 2 }}>
    <style>{`
      .bunny-outline-rail { opacity: .45; transition: opacity 140ms; }
      .bunny-outline-rail:hover, .bunny-outline-rail:focus-within { opacity: 1; }
      .bunny-outline-tick { font: 13px ${UI_FONT}; width: 32px; height: 32px; border: 0; background: transparent; cursor: pointer; display: flex; align-items: center; justify-content: flex-end; padding: 0 4px 0 0; border-radius: 8px; }
      .bunny-outline-tick span { border-radius: 999px; background: ${B.muted}; transition: width 140ms, height 140ms; pointer-events: none; }
      .bunny-outline-tick[aria-current=true] span { background: ${B.espresso}; }
      .bunny-outline-tick:focus-visible, .bunny-message-row:focus-visible { outline: 2px solid ${B.violet}; outline-offset: -2px; }
      .bunny-message-row:hover { background: ${B.hover}; }
      @media(prefers-reduced-motion: reduce) { .bunny-outline-tick span, .bunny-outline-rail { transition: none; } }
    `}</style>
    {!mobile && prompts.length > 1 ? <nav className="bunny-outline-rail" aria-label="Message navigation" data-testid="chat-outline" style={{ position: 'absolute', right: 0, top: '50%', transform: 'translateY(-50%)', maxHeight: '75%', overflowY: 'auto', pointerEvents: 'auto', scrollbarWidth: 'none' }}
      onPointerEnter={() => setHeld(indices.map(i => prompts[i].at))} onPointerLeave={() => { setHeld(null); setAttention(null); }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) { setHeld(null); setAttention(null); } }}>
      {indices.map((index, slot) => {
        const p = prompts[index];
        const distance = attention === null ? Infinity : Math.abs(slot - attention);
        const magnify = distance < 3 ? (1 + Math.cos(Math.PI * distance / 3)) / 2 : 0;
        const label = index === 0 ? (atStart ? 'Beginning' : 'Earliest loaded') : index === prompts.length - 1 ? 'Latest message' : `${index + 1} of ${prompts.length}`;
        return <button type="button" key={p.at} className="bunny-outline-tick" data-testid="chat-outline-tick" data-at={p.at} aria-label={`${label} · ${stamp(p.at)}: ${p.text}`} aria-current={active === p.at ? 'true' : undefined}
          onPointerEnter={e => show(e.currentTarget, slot)} onFocus={e => { setHeld(indices.map(i => prompts[i].at)); show(e.currentTarget, slot); }}
          onKeyDown={e => { const buttons = [...e.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>('button')]; const next = e.key === 'ArrowDown' ? slot + 1 : e.key === 'ArrowUp' ? slot - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : null; if(next !== null) { e.preventDefault(); buttons[Math.max(0, Math.min(next, buttons.length - 1))]?.focus(); } }}
          onClick={() => jump(p.at)}><span aria-hidden="true" style={{ width: (active === p.at ? 10 : 6) + magnify * 18, height: 2 + magnify * 2 }} /></button>;
      })}
    </nav> : null}
    {attentionPrompt && !open ? <div data-testid="chat-outline-preview" aria-hidden="true" style={{ ...surface, position: 'absolute', top: previewY, right: 36, maxWidth: 'calc(100% - 48px)', width: 260, padding: '8px 12px', color: B.espresso }}>
      <div style={{ color: B.muted, fontSize: 11, marginBottom: 4 }}>{indices[attention!] === 0 ? (atStart ? 'Beginning · ' : 'Earliest loaded · ') : indices[attention!] === prompts.length - 1 ? 'Latest message · ' : ''}{stamp(attentionPrompt.at)}</div>
      <div style={{ overflowWrap: 'break-word', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{attentionPrompt.text}</div>
    </div> : null}
    {prompts.length ? <button type="button" data-testid="message-picker-toggle" aria-label="Browse messages" title="Browse messages" aria-expanded={open} onClick={() => { setOpen(v => !v); setAttention(null); }} style={{ ...target, position: 'absolute', bottom: 12, right: 8, pointerEvents: 'auto' }}><svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"><path d="M4 4h9M4 8h9M4 12h9M1 4h1M1 8h1M1 12h1" /></svg></button> : null}
    {up ? <button type="button" data-testid="jump-to-latest" aria-label="Jump to latest" title="Jump to latest" onClick={latest} style={{ ...target, position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)', pointerEvents: 'auto' }}><svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 3v10M3 8l5 5 5-5" /></svg></button> : null}
    {open ? <section role="dialog" aria-label="Browse messages" data-testid="message-picker" style={{ ...surface, position: 'absolute', bottom: size + 20, left: 8, right: 8, maxHeight: '75%', display: 'flex', flexDirection: 'column', pointerEvents: 'auto', overflow: 'hidden' }}>
      <div style={{ padding: 8, borderBottom: `1px solid ${B.line}`, display: 'flex', alignItems: 'center', gap: 6 }}>
        <button type="button" style={{ ...softBtn, minHeight: size }} disabled={beginning?.busy} onClick={() => { if (beginning) beginning.go(); else if (prompts[0]) jump(prompts[0].at); }} title={beginning ? 'Go to beginning · loads earlier history' : atStart ? 'Go to beginning' : 'Go to earliest loaded message'}>{beginning?.busy ? 'Loading beginning…' : beginning || atStart ? 'Beginning' : 'Earliest loaded'}</button>
        <button type="button" style={{ ...softBtn, minHeight: size }} onClick={latest}>Latest</button>
        <button type="button" style={{ ...target, marginLeft: 'auto' }} aria-label="Close message picker" onClick={() => setOpen(false)}>×</button>
      </div>
      {older ? <div style={{ padding: '4px 8px', borderBottom: `1px solid ${B.line}` }}>
        <button type="button" data-testid="outline-load-earlier" style={{ ...softBtn, width: '100%', minHeight: size }} disabled={older.busy || beginning?.busy} onClick={older.load}>{older.busy ? 'Loading earlier messages…' : older.error ? 'Retry loading earlier messages' : 'Load earlier messages'}</button>
        {beginning?.busy ? <button type="button" style={{ ...softBtn, minHeight: size }} onClick={beginning.cancel}>Cancel loading beginning</button> : null}
        {older.error ? <div role="alert" style={{ fontSize: 11, color: B.muted }}>Earlier messages couldn’t load. Your place is saved.</div> : null}
      </div> : null}
      <div ref={picker} style={{ overflowY: 'auto', overscrollBehavior: 'contain', minHeight: 0, padding: 4 }}>
        {prompts.map((p, i) => <button key={p.at} type="button" className="bunny-message-row" data-testid="message-picker-item" aria-current={p.at === active ? 'true' : undefined} onClick={() => jump(p.at)} style={{ display: 'block', width: '100%', minHeight: mobile ? 56 : 44, padding: '6px 8px', border: 0, borderRadius: 8, textAlign: 'left', font: `13px ${UI_FONT}`, background: p.at === active ? B.hover : 'transparent', color: B.espresso, cursor: 'pointer' }}>
          <span style={{ display: 'block', fontSize: 11, color: B.muted, marginBottom: 4 }}>{i === 0 ? (atStart ? 'Beginning · ' : 'Earliest loaded · ') : i === prompts.length - 1 ? 'Latest message · ' : ''}<time dateTime={p.at}>{stamp(p.at)}</time></span>
          <span title={p.text} style={{ display: 'block', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.text}</span>
        </button>)}
      </div>
    </section> : null}
  </div>;
}
