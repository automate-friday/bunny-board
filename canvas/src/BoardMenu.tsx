import {WorkerSettings} from './WorkerSettings';
import { ThemePicker } from "./theme";
import {useEffect, useRef, useState} from 'react';
import {type Editor, useValue} from 'tldraw';
import {api} from './api';
import {BoardControls, useNarrow} from './BoardControls';
import {BoardNameForm} from './BoardNameForm';
import {relTime} from './ImportPicker';
import {boardLocks, deviceLock} from './locks';
import {RefreshNotice} from './RefreshNotice';
import {useVisualViewport} from './visualViewport';
import { Emoji } from "./Emoji";
import { ArchiveMenuItem, usePendingArchive } from "./FrameArchive";

export function goToBoard(id: string): void {
  const q = new URLSearchParams(window.location.search);
  q.set('board', id);
  q.delete('frame');
  window.location.search = q.toString();
}

interface BoardRow {id:string;frames:number;boundFrames:number;lastActivityAt:string}

// The one top-right control: a "<board> ▾" pill whose icons show what is on (layout lock,
// paused agents, a clean-up proposal waiting, a newer canvas). Its menu holds every
// board-wide action in sections: Lock / Pause / Import, Archive, Boards (switch or start
// one, folded away: rarely used), Canvas version.
export function BoardMenu({editor,boardId,onImport,toast}:{editor:Editor;boardId:string;onImport:()=>void;toast:(text:string)=>void}) {
  const [open,setOpen]=useState(false),[versionStatus,setVersionStatus]=useState('');
  const [boardsOpen,setBoardsOpen]=useState(false),[boards,setBoards]=useState<BoardRow[]|null>(null),[naming,setNaming]=useState(false);
  const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
  const viewport=useVisualViewport();
  const narrow=useNarrow();
  const locks=useValue('board-menu-locks',()=>boardLocks(editor).get(),[editor]);
  const local=useValue('board-menu-device-lock',()=>deviceLock.get(),[]);
  const pending=usePendingArchive(editor);
  useEffect(()=>{if(!open)return;const outside=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node))setOpen(false);};const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.stopPropagation();setOpen(false);trigger.current?.focus();}};document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',key,true);return()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',key,true);};},[open]);
  // The board list loads only when "Boards" is unfolded.
  useEffect(()=>{if(!boardsOpen)return;api<{boards:BoardRow[]}>('/api/ui/boards').then(r=>setBoards(r.boards)).catch(()=>setBoards([]));},[boardsOpen]);
  const state=[locks.layout?'locked for everyone':local?'locked here':'',locks.agentsPaused?'agents paused':'',versionStatus].filter(Boolean).join(' · ');
  const section:React.CSSProperties={margin:'12px 0 6px',fontSize:11,fontWeight:600,letterSpacing:0.4,textTransform:'uppercase',color:'light-dark(#888, var(--bunny-muted))'};
  const others=(boards??[]).filter(b=>b.id!==boardId);
  return <div ref={root} style={{position:'relative'}}>
    <button ref={trigger} type="button" data-testid="board-menu-toggle" aria-expanded={open} aria-controls="board-menu-panel" onClick={()=>setOpen(v=>!v)} title={state||`Board “${boardId}”: controls, archive, other boards`}
      style={{display:'inline-flex',alignItems:'center',gap:5,padding:'5px 10px',minHeight:30,maxWidth:narrow?150:220,border:'1px solid light-dark(#ddd, var(--bunny-line))',borderRadius:999,font:'inherit',cursor:'pointer',color:'light-dark(#333, var(--bunny-ink))',boxShadow:'0 1px 4px #0001',background:locks.layout?'light-dark(#ffe3e0, hsl(6 45% 21%))':locks.agentsPaused?'light-dark(#fff0d9, hsl(36 45% 21%))':'light-dark(rgba(255,255,255,0.96), color-mix(in srgb, #20242c 96%, transparent))'}}>
      <span data-testid="board-menu-name" style={{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',fontWeight:500}}>{boardId}</span>
      {locks.layout||local?<Emoji name="lock" />:null}{locks.agentsPaused?<Emoji name="pause" />:null}{versionStatus?<span title={versionStatus}>!</span>:null}
      {pending?<span data-testid="board-menu-archive-dot" title={`${pending} frame${pending===1?'':'s'} waiting in a clean-up proposal`} style={{display:'inline-block',width:7,height:7,borderRadius:4,background:'#d9480f'}} />:null}
      <span style={{color:'light-dark(#888, var(--bunny-muted))'}}>▾</span>
    </button>
    <div id="board-menu-panel" data-testid="board-menu-panel" hidden={!open} style={{display:open?'block':'none',position:'absolute',right:0,top:'calc(100% + 8px)',width:'min(320px, calc(100vw - 24px))',maxHeight:Math.max(100,viewport.height-100),overflowY:'auto',padding:'10px 12px 12px',boxSizing:'border-box',border:'1px solid light-dark(#ddd, var(--bunny-line))',borderRadius:12,background:'light-dark(white, var(--bunny-surface))',boxShadow:'0 8px 28px #0003',zIndex:500}}>
      <div style={{display:'flex',alignItems:'baseline',gap:6}}><strong style={{fontSize:14,overflow:'hidden',textOverflow:'ellipsis'}}>{boardId}</strong><span style={{fontSize:12,color:'light-dark(#777, var(--bunny-muted))'}}>{state||'unlocked · agents active'}</span></div>
      <div style={{marginTop:10}}><BoardControls editor={editor} boardId={boardId} onImport={()=>{setOpen(false);onImport();}} toast={toast} big /></div>
      <div style={{marginTop:8}}><ArchiveMenuItem editor={editor} onOpen={()=>setOpen(false)} /></div>
      <ThemePicker />
      <WorkerSettings visible={open} />
      <div style={section}>Boards</div>
      <button type="button" data-testid="board-switcher" aria-expanded={boardsOpen} onClick={()=>setBoardsOpen(v=>!v)} style={{width:'100%',display:'flex',justifyContent:'space-between',padding:'7px 10px',border:'1px solid light-dark(#ddd, var(--bunny-line))',borderRadius:8,background:'light-dark(#fafafa, var(--bunny-surface))',font:'inherit',cursor:'pointer'}}>
        <span>Switch board…</span><span style={{color:'light-dark(#888, var(--bunny-muted))'}}>{boardsOpen?'▴':'▾'}</span>
      </button>
      {boardsOpen?<div data-testid="board-list" style={{marginTop:4,maxHeight:220,overflowY:'auto',border:'1px solid light-dark(#eee, var(--bunny-line))',borderRadius:8}}>
        {boards===null?<div style={{padding:8,color:'light-dark(#888, var(--bunny-muted))'}}>Loading…</div>:null}
        {others.map(b=><button key={b.id} type="button" data-testid="board-list-item" onClick={()=>goToBoard(b.id)} style={{width:'100%',display:'flex',gap:8,justifyContent:'space-between',padding:'6px 10px',border:0,borderBottom:'1px solid light-dark(#f3f3f3, var(--bunny-line))',background:'light-dark(white, var(--bunny-surface))',font:'inherit',cursor:'pointer',textAlign:'left'}}>
          <span style={{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{b.id}</span><span style={{color:'light-dark(#999, var(--bunny-muted))',fontSize:12,whiteSpace:'nowrap'}}>{b.frames} frames · {relTime(b.lastActivityAt)}</span>
        </button>)}
        {boards&&!others.length?<div style={{padding:8,color:'light-dark(#888, var(--bunny-muted))'}}>No other boards yet.</div>:null}
        <div style={{padding:'6px 10px'}}>{naming?<BoardNameForm narrow={narrow} onOpen={goToBoard} onClose={()=>setNaming(false)} />:<button type="button" data-testid="new-board" onClick={()=>setNaming(true)} style={{border:0,background:'none',color:'light-dark(#2f80ed, hsl(214 84% 74%))',padding:0,font:'inherit',cursor:'pointer'}}>+ New board…</button>}</div>
      </div>:null}
      <hr style={{border:0,borderTop:'1px solid light-dark(#eee, var(--bunny-line))',margin:'12px 0 10px'}} />
      <RefreshNotice embedded onStatus={setVersionStatus} />
    </div>
  </div>;
}
