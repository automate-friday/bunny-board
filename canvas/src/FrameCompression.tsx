import { useState } from 'react';
import { type Editor, type TLFrameShape, useValue } from 'tldraw';
import { api } from './api';
import { newMessageId } from './frameChatDelivery';
import { boardLocks } from './locks';
import { surface, B } from './bunnyTheme';
import { pageFrames } from './pageFrames';

type Paseo={agentId?:string;compressionOffer?:{w:number;h:number};compression?:{messageId:string;status:string}};
const NO_OFFERS:TLFrameShape[]=[];
const NO_CHIPS:{id:string;w:number;h:number;x:number;y:number;pending:boolean;messageId?:string}[]=[];

export function FrameCompression({editor,boardId}:{editor:Editor;boardId:string}) {
  // Frames with an offer, from the shared frame list (no page scan); only when there are
  // any does the chip list read the camera, so pan/zoom costs nothing on a board without one.
  const offered=useValue('compression-offers',()=> {
    const locks=boardLocks(editor).get();
    if (locks.layout || locks.agentsPaused) return NO_OFFERS;
    const out=pageFrames(editor).get().filter(f=> {
      const p=f.meta.paseo as Paseo|undefined;
      return !!p?.agentId && (!!p.compressionOffer || p.compression?.status==='pending');
    });
    return out.length?out:NO_OFFERS;
  },[editor]);
  const frames=useValue('compression-chips',()=> {
    if (!offered.length) return NO_CHIPS;
    const vp=editor.getViewportPageBounds(), z=editor.getZoomLevel();
    return offered.flatMap(f=> {
      const p=f.meta.paseo as Paseo|undefined;
      const bounds=editor.getShapePageBounds(f.id);
      if (!bounds?.collides(vp)) return [];
      const point=editor.pageToViewport({x:bounds.minX+12/z,y:bounds.minY+10/z});
      return [{id:f.id,w:f.props.w,h:f.props.h,...point,pending:p?.compression?.status==='pending',messageId:p?.compression?.messageId}];
    });
  },[editor,offered]);
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
    {errors[f.id]?<div role="alert" style={{color:'light-dark(#b42318, hsl(4 76% 74%))',padding:4}}>{errors[f.id]}</div>:null}
  </div>)}</>;
}
