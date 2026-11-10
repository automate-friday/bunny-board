import {Effect} from 'effect';
import { useEffect, useState } from 'react';
import { type Editor, useValue } from 'tldraw';
import { api } from './api';
import { B, UI_FONT } from './bunnyTheme';
import { switchToPin, type SwitchEditor } from './framePanelDock';
import { attentionItems, type AttentionRow } from './attentionItems';
import { useNow } from './TimelineItemView';
import { formatDuration } from './paseo/time';
import { attentionKey, reviewIsOld, readAttentionPreferences, saveAttentionPreferences, AttentionPreferencesLive } from './attentionInbox';

// Composition root for the browser preference store.
const preferencesLayer = AttentionPreferencesLive();
const readPreferences = (boardId: string) => Effect.runSync(readAttentionPreferences(boardId).pipe(Effect.provide(preferencesLayer)));
// One cached directory read, not one transcript subscription per frame. Hidden tabs do
// no background work; requests never overlap. Frame permission/error states work offline.
export function NeedsYou({ editor, boardId, open, onReturn }: { editor: Editor; boardId: string; open: (id: string) => void; onReturn?: () => void }) {
  const [preferences, setPreferences] = useState(() => readPreferences(boardId));
  const [showOlder, setShowOlder] = useState(false);
  const [returnView, setReturnView] = useState<{page: ReturnType<Editor['getCurrentPageId']>; camera: ReturnType<Editor['getCamera']>} | null>(null);
  useEffect(() => { Effect.runSync(saveAttentionPreferences(boardId, preferences).pipe(Effect.provide(preferencesLayer))); }, [boardId, preferences]);
  // Camera, pointer and presence updates must not rebuild the attention list.
  const frames = useValue('needs-you-frames', () => editor.store.query.records('shape').get().filter(r => r.type === 'frame'), [editor]);
  const hasLocal = frames.some(f => {
    const p = (f.meta as {paseo?:{agentId?:string;host?:string}}).paseo;
    return !!p?.agentId && !p.host;
  });
  const [directory, setDirectory] = useState<{rows:AttentionRow[]; stale:boolean; partial:boolean; error:boolean; loaded:boolean}>({rows:[],stale:false,partial:false,error:false,loaded:false});
  useEffect(() => {
    if (!hasLocal) { setDirectory({rows:[],stale:false,partial:false,error:false,loaded:true}); return; }
    const ctl = new AbortController();
    let busy = false, retry: ReturnType<typeof setTimeout> | undefined;
    const load = async (attempt = 0) => {
      if (busy || document.hidden || ctl.signal.aborted) return;
      busy = true;
      try {
        const q = new URLSearchParams({board:boardId,scope:'all',bound:'1',onBoard:'1',status:'attention,running',limit:'1000'});
        const data = await api<{rows:AttentionRow[];stale:boolean;truncated?:boolean;matched:number}>(`/api/ui/agents/list?${q}`, {signal:AbortSignal.any([ctl.signal,AbortSignal.timeout(12000)])});
        if (ctl.signal.aborted) return;
        setDirectory({rows:data.rows,stale:data.stale,partial:!!data.truncated || data.matched > data.rows.length,error:false,loaded:true});
        if (data.stale && attempt < 2) retry = setTimeout(() => void load(attempt + 1), 2000);
      } catch {
        if (!ctl.signal.aborted) setDirectory(old => ({...old,error:true}));
      } finally { busy = false; }
    };
    const refresh = () => { clearTimeout(retry); void load(); };
    refresh();
    const timer = setInterval(refresh,30000);
    document.addEventListener('visibilitychange',refresh);
    return () => {ctl.abort();clearInterval(timer);clearTimeout(retry);document.removeEventListener('visibilitychange',refresh);};
  },[boardId,hasLocal]);
  const allItems = attentionItems(frames,directory.rows);
  const now = useNow(allItems.some(i => !!i.since),1000);
  const available = allItems.filter(item => !preferences.dismissed.includes(attentionKey(item)));
  const older = available.filter(item => reviewIsOld(item, now));
  const items = available.filter(item => showOlder || !reviewIsOld(item, now));
  // Only say something when the list may be wrong; routine refreshes stay silent (data-sync says which).
  const notice = directory.error ? 'Some conversations may be missing' : directory.partial ? 'Some conversations may be missing' : '';
  const sync = directory.error ? 'error' : !directory.loaded ? 'loading' : directory.stale ? 'stale' : directory.partial ? 'partial' : 'ok';
  const toggle = () => setPreferences(p => ({...p, collapsed: !p.collapsed}));
  const control = {border:`1px solid ${B.line}`,borderRadius:8,background:'transparent',color:B.espresso,cursor:'pointer',minHeight:36,font:'inherit'} as const;
  const goBack = () => {
    if (!returnView) return;
    editor.setCurrentPage(returnView.page);
    editor.selectNone();
    // Restore directly: animating while the conversation closes changes the viewport
    // width mid-animation and tldraw would restore a different zoom.
    editor.setCamera(returnView.camera);
    onReturn?.();
    setReturnView(null);
  };
  return <aside aria-label="Needs you" data-testid="needs-you" data-state={preferences.collapsed ? 'collapsed' : 'open'} style={{boxSizing:'border-box',width:preferences.collapsed ? 48 : 'clamp(210px,18vw,260px)',flexShrink:0,minHeight:0,display:'flex',flexDirection:'column',borderRight:`1px solid ${B.line}`,background:B.cream,color:B.espresso,font:`13px/1.4 ${UI_FONT}`}}>
    <div style={{padding:6,display:'flex',alignItems:'center',gap:8,minHeight:48}}>
      <button type="button" data-testid="attention-toggle" aria-label={preferences.collapsed ? 'Show Needs you sidebar' : 'Hide Needs you sidebar'} aria-expanded={!preferences.collapsed} onClick={toggle} style={{...control,minWidth:36}} title={preferences.collapsed ? `Needs you (${items.length})` : 'Hide sidebar'}>{preferences.collapsed ? '☰' : '‹'}</button>
      {!preferences.collapsed ? <strong style={{flex:1}}>Needs you ({items.length})</strong> : null}
    </div>
    {returnView ? <button type="button" data-testid="attention-back" onClick={goBack} style={{...control,margin:6}} aria-label="Back to board" title="Back to board">{preferences.collapsed ? '↶' : '↶ Back to board'}</button> : null}
    {preferences.collapsed ? <span style={{textAlign:'center',fontSize:12}} aria-label={`${items.length} conversations need you`}>{items.length}</span> : <>
      <div data-testid="attention-status" role="status" data-sync={sync} title={notice || undefined} style={{height:32,boxSizing:'border-box',padding:'6px 12px',fontSize:11,color:B.muted,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',flexShrink:0}}>{notice}</div>
      <div style={{overflowY:'auto',overscrollBehavior:'contain',padding:'0 8px 8px',minHeight:0}}>
        {!items.length && directory.loaded && !directory.stale && !notice ? <p style={{padding:6,color:B.muted}}>You're caught up.</p> : null}
        {items.map(item => <div key={attentionKey(item)} style={{display:'flex',alignItems:'flex-start',borderBottom:`1px solid ${B.line}`}}>
          <button type="button" data-frame-id={item.frameId} onClick={() => {
            if (!returnView) setReturnView({page:editor.getCurrentPageId(),camera:{...editor.getCamera()}});
            switchToPin(editor as unknown as SwitchEditor,item.frameId,true,open);
          }} style={{display:'block',flex:1,minWidth:0,textAlign:'left',padding:'12px 4px',border:0,background:'transparent',color:B.espresso,font:'inherit',cursor:'pointer'}}>
            <span style={{display:'block',fontWeight:600,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{item.title}</span>
            <span style={{display:'block',fontSize:12,color:item.reason === 'Error' ? B.danger : B.muted}}>{item.reason}</span>
            {item.since ? <span style={{display:'block',fontSize:11,color:B.muted}}>Waiting {formatDuration(now-Date.parse(item.since))}</span> : null}
          </button>
          {item.reason === 'Ready to review' ? <button type="button" aria-label={`Dismiss ${item.title}`} title="Dismiss this review alert" onClick={() => setPreferences(p => ({...p,dismissed:[...p.dismissed,attentionKey(item)].slice(-500)}))} style={{...control,border:0,minWidth:32,marginTop:6}}>×</button> : null}
        </div>)}
        {preferences.dismissed.length ? <button type="button" onClick={() => setPreferences(p => ({...p,dismissed:[]}))} style={{...control,width:'100%',marginTop:8}}>Restore dismissed alerts</button> : null}
        {older.length ? <button type="button" data-testid="attention-older" onClick={() => setShowOlder(v => !v)} style={{...control,width:'100%',marginTop:8}}>{showOlder ? 'Hide' : 'Show'} {older.length} older review alerts</button> : null}
      </div>
    </>}
  </aside>;
}
