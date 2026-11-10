import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type Editor, type TLShapeId, useValue } from 'tldraw';
import { indexFrames, jumpToFrame, lastInteracted, readAgentSends, readRecents, recencyKey, rememberFrame, searchFrames, timeAgo } from './jumpPaletteModel';

function storage(): Storage | undefined {
  try { return window.localStorage; } catch { return; }
}

// Thumbnails are rendered one at a time, only for rows scrolled into view, and kept for a
// minute so reopening the palette is instant without showing a stale board for long.
const THUMB_W = 96, THUMB_H = 64, THUMB_TTL = 60_000;
const thumbs = new Map<string, { url: string; at: number }>();
let queue: Promise<unknown> = Promise.resolve();
function renderThumb(editor: Editor, id: string): Promise<string | null> {
  const dark = editor.user.getIsDarkMode();
  const key = `${id}:${dark ? "dark" : "light"}`;
  const cached = thumbs.get(key);
  if (cached && Date.now() - cached.at < THUMB_TTL) return Promise.resolve(cached.url);
  const next = queue.then(async () => {
    const bounds = editor.getShapePageBounds(id as TLShapeId);
    if (!bounds?.w || !bounds.h) return null;
    const scale = Math.min(1, THUMB_W / bounds.w, THUMB_H / bounds.h);
    const { blob } = await editor.toImage([id as TLShapeId], { format: 'png', scale, pixelRatio: 2, background: true, padding: 0 });
    if (editor.user.getIsDarkMode() !== dark) return null;
    const url = URL.createObjectURL(blob);
    const old = thumbs.get(key);
    thumbs.set(key, { url, at: Date.now() });
    if (old) setTimeout(() => URL.revokeObjectURL(old.url), 5000);
    return url;
  }).catch(() => null);
  queue = next;
  return next;
}

export function FrameThumb({ editor, id }: { editor: Editor; id: string }) {
  const dark = useValue('jump-thumbnail-theme', () => editor.user.getIsDarkMode(), [editor]);
  const [image, setImage] = useState<{url:string;dark:boolean}|null>(()=>{const hit=thumbs.get(`${id}:${dark ? 'dark' : 'light'}`);return hit?{url:hit.url,dark}:null;});
  const url = image?.dark === dark ? image.url : null;
  const [failed, setFailed] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    let live = true;
    setFailed(false);
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      void renderThumb(editor, id).then(next => { if (live) { if (next) setImage({url:next,dark}); else setFailed(true); } });
    });
    observer.observe(element);
    return () => { live = false; observer.disconnect(); };
  }, [editor, id, dark]);
  return <span ref={box} className="bunny-jump-thumb" data-thumb={url ? 'ready' : failed ? 'failed' : 'pending'} aria-hidden="true">
    {url ? <img src={url} alt="" /> : null}
  </span>;
}

const TONE: Record<string, string> = { working: 'working', starting: 'working', idle: 'idle', 'needs permission': 'attention', error: 'error' };

export function JumpPalette({ editor, boardId, userId, onFindConversations }: { editor: Editor; boardId: string; userId: string; onFindConversations?: () => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [jumps, setJumps] = useState<Map<string, number>>(new Map());
  const [sends, setSends] = useState<Map<string, number>>(new Map());
  const [now, setNow] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const key = recencyKey(boardId, userId);
  // No store scan or subscription while the palette is closed.
  const frames = useValue('jump-palette-frames', () => open ?
    indexFrames(editor.store.allRecords(), window.location.origin) : [], [editor, open]);
  const touched = useMemo(() => lastInteracted(frames, jumps, sends), [frames, jumps, sends]);
  const results = useMemo(() => searchFrames(frames, query, touched), [frames, query, touched]);
  const selected = Math.min(active, results.length - 1);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat || event.altKey ||
        !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!open) {
        previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setJumps(readRecents(storage(), key));
        setSends(readAgentSends(storage()));
        setNow(Date.now());
        setQuery(''); setActive(0);
      }
      setOpen(!open);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, key]);

  useEffect(() => {
    if (!open || !dialog.current) return;
    const element = dialog.current;
    element.showModal();
    input.current?.focus();
    return () => {
      element.close();
      if (previousFocus.current?.isConnected) previousFocus.current.focus();
      else editor.focus();
    };
  }, [open, editor]);

  useEffect(() => {
    if (open) dialog.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, selected]);

  const jump = (id: string) => {
    if (!jumpToFrame(editor, id)) return;
    setJumps(rememberFrame(storage(), key, id));
    setOpen(false);
  };

  if (!open) return null;
  return createPortal(<>
    <style>{`
      .bunny-jump { width:min(620px,calc(100vw - 32px)); max-height:80dvh; box-sizing:border-box; padding:0; border:1px solid var(--bunny-line,light-dark(#ddcfc2, hsl(29 35% 39%))); border-radius:14px; background:var(--bunny-cream,light-dark(#fff8eb, var(--bunny-surface))); color:var(--bunny-ink,light-dark(#2e1f16, var(--bunny-ink))); box-shadow:0 18px 70px #0003; font:14px Inter,system-ui,sans-serif; }
      .bunny-jump::backdrop { background:light-dark(#17121b55, color-mix(in srgb, #2b303b 33%, transparent)); }
      .bunny-jump header { display:flex; align-items:center; justify-content:space-between; padding:16px 20px 8px; }
      .bunny-jump h2 { margin:0; font-size:18px; }
      .bunny-jump button { cursor:pointer; font:inherit; color:inherit; }
      .bunny-jump-close { border:0; background:transparent; font-size:24px!important; }
      .bunny-jump-search { margin:8px 20px 12px; }
      .bunny-jump input { box-sizing:border-box; width:100%; padding:12px; border:1px solid var(--bunny-line,light-dark(#ddcfc2, hsl(29 35% 39%))); border-radius:8px; color:inherit; background:light-dark(#fff, var(--bunny-surface)); font:inherit; }
      .bunny-jump :focus-visible { outline:2px solid var(--bunny-violet,light-dark(#8875f6, hsl(249 35% 39%))); outline-offset:2px; }
      .bunny-jump ul { list-style:none; margin:0; padding:0 8px 8px; max-height: min(390px,45dvh); overflow-y:auto; }
      .bunny-jump li { display:flex; align-items:center; gap:8px; border-radius:8px; padding-right:12px; }
      .bunny-jump li[data-active=true] { background:var(--bunny-lavender,light-dark(#e6dcfa, hsl(260 45% 21%))); }
      .bunny-jump-target { display:flex; align-items:center; gap:12px; flex:1; min-width:0; padding:12px; text-align:left; border:0; background:transparent; }
      .bunny-jump-thumb { width:${THUMB_W}px; height:${THUMB_H}px; flex-shrink:0; display:flex; align-items:center; justify-content:center; overflow:hidden; border:1px solid var(--bunny-line,light-dark(#ddcfc2, hsl(29 35% 39%))); border-radius:6px; background:light-dark(#fff, var(--bunny-surface)); }
      .bunny-jump-thumb[data-thumb=pending] { background:linear-gradient(90deg,light-dark(#fff, var(--bunny-surface)) 0%,light-dark(#f3ece2, var(--bunny-raised)) 50%,light-dark(#fff, var(--bunny-surface)) 100%); background-size:200% 100%; animation:bunny-jump-shimmer 1.2s linear infinite; }
      .bunny-jump-thumb[data-thumb=failed] { border-style:dashed; opacity:.55; }
      .bunny-jump-thumb img { max-width:100%; max-height:100%; display:block; }
      @keyframes bunny-jump-shimmer { to { background-position:-200% 0; } }
      .bunny-jump-meta { display:flex; align-items:center; gap:8px; }
      .bunny-jump-status { padding:1px 8px; border-radius:999px; font-size:11px; font-weight:600; background:light-dark(#efe8de, var(--bunny-raised)); color:var(--bunny-muted,light-dark(#65584f, var(--bunny-muted))); }
      .bunny-jump-status[data-tone=working] { background:light-dark(#dbeafe, hsl(214 45% 21%)); color:light-dark(#1d4ed8, hsl(224 76% 74%)); }
      .bunny-jump-status[data-tone=idle] { background:light-dark(#dcfce7, hsl(141 45% 21%)); color:light-dark(#15803d, hsl(142 72% 74%)); }
      .bunny-jump-status[data-tone=attention] { background:light-dark(#fde7c7, hsl(36 45% 21%)); color:light-dark(#9c4b00, hsl(29 88% 74%)); }
      .bunny-jump-status[data-tone=error] { background:light-dark(#fde2e2, hsl(0 45% 21%)); color:light-dark(#b00020, hsl(349 88% 74%)); }
      .bunny-jump-label { min-width:0; display:flex; flex-direction:column; gap:4px; }
      .bunny-jump-label strong,.bunny-jump-label small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .bunny-jump-label small { color:var(--bunny-muted,light-dark(#65584f, var(--bunny-muted))); }
      .bunny-jump a { color:var(--bunny-ink,light-dark(#2e1f16, var(--bunny-ink))); font-size:12px; white-space:nowrap; }
      .bunny-jump footer { padding:12px 20px; border-top:1px solid var(--bunny-line,light-dark(#ddcfc2, hsl(29 35% 39%))); color:var(--bunny-muted,light-dark(#65584f, var(--bunny-muted))); font-size:12px; }
      .bunny-jump-conversations { display:block; margin-top:10px; padding:6px 0; border:0; background:transparent; text-decoration:underline; }
      .bunny-jump-empty { margin:24px 20px; }
    `}</style>
    <dialog ref={dialog} className="bunny-jump" aria-labelledby={titleId}
      onCancel={event => { event.preventDefault(); setOpen(false); }}
      onClick={event => { if (event.target === dialog.current) {
        const rect = dialog.current.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) setOpen(false);
      } }}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          setOpen(false);
        }
      }}>
      <header><h2 id={titleId}>Jump to a frame</h2><button type="button" className="bunny-jump-close" aria-label="Close frame search" onClick={() => setOpen(false)}>×</button></header>
      <div className="bunny-jump-search">
        <input ref={input} type="search" aria-label="Search frames" placeholder="Search frame or agent name…" value={query}
          onChange={event => { setQuery(event.target.value); setActive(0); }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Enter') { event.preventDefault(); if (results[selected]) jump(results[selected].id); }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              if (results.length) setActive((selected + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length);
            }
          }} />
      </div>
      {results.length ? <ul aria-label="Matching frames">{results.map((frame, i) => <li key={frame.id} data-frame-id={frame.id} data-active={i === selected} onPointerMove={() => setActive(i)}>
        <button type="button" className="bunny-jump-target" onClick={() => jump(frame.id)} aria-label={`Jump to ${frame.name}`}>
          <FrameThumb editor={editor} id={frame.id} />
          <span className="bunny-jump-label"><strong>{frame.name}</strong><small>{frame.pageName}{frame.agentTitle ? ` · ${frame.agentTitle}` : ''}</small>
            <span className="bunny-jump-meta">
              <span className="bunny-jump-status" data-frame-status={frame.status} data-tone={TONE[frame.status] ?? 'quiet'}>{frame.agentId ? `Agent: ${frame.status}` : 'No agent'}</span>
              <small data-last-interacted={touched.get(frame.id) ?? ''}>Last interacted with: {timeAgo(touched.get(frame.id), now)}</small>
            </span></span>
        </button>
        {frame.reportUrl ? <a href={frame.reportUrl} target="_blank" rel="noopener noreferrer" onClick={() => setOpen(false)} aria-label={`Open report for ${frame.name}`}>Open report ↗</a> : null}
      </li>)}</ul> : <p className="bunny-jump-empty">No frames match “{query}”.</p>}
      <footer><span role="status" aria-live="polite">{results.length} {results.length === 1 ? 'frame' : 'frames'}{results[selected] ? ` · ${results[selected].name}` : ''}</span> · ↑↓ choose · Enter jump · Esc close
        {onFindConversations ? <button type="button" className="bunny-jump-conversations" onClick={() => { setOpen(false); onFindConversations(); }}>Find other conversations…</button> : null}
      </footer>
    </dialog>
  </>, document.body);
}
