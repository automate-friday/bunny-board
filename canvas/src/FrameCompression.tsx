import { useState } from 'react';
import { type Editor, useValue } from 'tldraw';
import { api } from './api';
import { newMessageId } from './frameChatDelivery';
import { boardLocks } from './locks';
import { surface, B } from './bunnyTheme';

export function FrameCompression({editor,boardId}:{editor:Editor;boardId:string}) {
  const frames=useValue('compression-chips',()=> {
    const locks=boardLocks(editor).get();
    if (locks.layout || locks.agentsPaused) return [];
    return editor.getCurrentPageShapes().flatMap(f=> {
      if (f.type!=='frame') return [];
      const p=f.meta.paseo as {agentId?:string;compressionOffer?:{w:number;h:number};compression?:{messageId:string;status:string}}|undefined;
      if (!p?.agentId || (!p.compressionOffer && p.compression?.status!=='pending')) return [];
      const bounds=editor.getShapePageBounds(f.id);
      if (!bounds?.collides(editor.getViewportPageBounds())) return [];
      const point=editor.pageToViewport({x:bounds.minX+12/editor.getZoomLevel(),y:bounds.minY+10/editor.getZoomLevel()});
      return [{id:f.id,w:f.props.w,h:f.props.h,...point,pending:p.compression?.status==='pending',messageId:p.compression?.messageId}];
    });
  },[editor]);
  const [busy,setBusy]=useState<string|null>(null);
  const [errors,setErrors]=useState<Record<string,string>>({});
  return <>{frames.map(f=><div key={f.id} data-testid="compression-chip" data-frame={f.id}
    style={{...surface,position:'absolute',left:f.x,top:f.y,zIndex:280,pointerEvents:'all',borderRadius:12,padding:'4px 8px',maxWidth:260,font:'12px system-ui',color:B.espresso}}
    onPointerDown={e=>e.stopPropagation()} onKeyDown={e=>e.stopPropagation()}>
    <button type="button" disabled={busy===f.id} style={{border:0,background:'transparent',color:'inherit',font:'inherit',cursor:'pointer'}}
      title={f.pending?'Request queued for the same agent. Click to retry delivery.':`Summarize into ${Math.round(f.w)} × ${Math.round(f.h)}. Originals stay restorable in Archive.`}
      onClick={async()=> {
        setBusy(f.id);setErrors(e=>({...e,[f.id]:''}));
        try { await api(`/api/ui/boards/${encodeURIComponent(boardId)}/frames/${encodeURIComponent(f.id)}/compress`,{method:'POST',body:JSON.stringify({messageId:f.pending?f.messageId:newMessageId(),w:f.w,h:f.h})}); }
        catch(e){setErrors(old=>({...old,[f.id]:(e as Error).message}));}
        finally {setBusy(null);}
      }}>{busy===f.id?'Requesting…':f.pending?'Summary requested · retry':'Compress to this size?'}</button>
    {errors[f.id]?<div role="alert" style={{color:'#b42318',padding:4}}>{errors[f.id]}</div>:null}
  </div>)}</>;
}
