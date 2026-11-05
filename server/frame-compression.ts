import { toRichText } from '@tldraw/tlschema';
import { getIndexAbove } from '@tldraw/utils';
import { pageBox } from './layout';
import { absPos, baseShape, buildShape, isShape, nextIndex, shapeSize, type Rec } from './records';
import { subtree } from './frame-archive';
import type { BoardRoom, RecordChange } from './room-host';

const gestures = new WeakMap<BoardRoom, Map<string,{ids:string[];at:number}>>();

// Keep membership from before a shrink: tldraw can reparent overflowing children to
// the page in the same gesture. A later click must still preserve those originals.
export function compressionOffers(room: BoardRoom, changes: RecordChange[]): Array<(room:BoardRoom)=>void> {
  const fixups:Array<(room:BoardRoom)=>void> = [];
  const previous = new Map(room.records);
  for (const c of changes) { if (c.before) previous.set(c.id, c.before); else previous.delete(c.id); }
  for (const c of changes) {
    const f = c.after, before = c.before;
    if (f?.type !== 'frame' || !before || !before.meta?.paseo?.agentId) continue;
    if (f.props.w === before.props.w && f.props.h === before.props.h) continue;
    const old = before.meta.paseo.compressionOffer;
    const shrinking = f.props.w < before.props.w || f.props.h < before.props.h;
    let pending = gestures.get(room);
    if (!pending) { pending=new Map(); gestures.set(room,pending); }
    for (const [id,g] of pending) if (Date.now()-g.at>2000) pending.delete(id);
    const gesture=pending.get(f.id);
    const recent=gesture && Date.now()-gesture.at<2000 ? gesture.ids : [];
    const ids = new Set<string>([...recent, ...(old?.shapeIds ?? []), ...subtree(previous, f.id).map(s => s.id)]);
    pending.set(f.id,{ids:[...ids],at:Date.now()});
    const origin = absPos(room.records, f);
    const overflow = [...ids].some(id => {
      const r = room.records.get(id); if (!isShape(r)) return false;
      const b = pageBox(room.records, r, new Map());
      return b && (b.x < origin.x || b.y < origin.y || b.x + b.w > origin.x + f.props.w || b.y + b.h > origin.y + f.props.h);
    });
    const offer = (shrinking || old) && overflow ? { w: f.props.w, h: f.props.h, shapeIds: [...ids] } : null;
    fixups.push(room => room.write({kind:'server', reason:'compress-offer'}, ops => {
      const cur = ops.get(f.id); if (!cur || cur.props.w !== f.props.w || cur.props.h !== f.props.h || cur.meta?.paseo?.agentId !== before.meta?.paseo?.agentId) return;
      const p = {...cur.meta.paseo};
      if (offer) p.compressionOffer = offer; else delete p.compressionOffer;
      // A person's resize ends the previous size constraint.
      delete p.compression;
      ops.put({...cur, meta:{...cur.meta, paseo:p}});
    }));
  }
  return fixups;
}

export interface CompressionSummary {
  title: string;
  decisions: string[];
  results: string[];
  openItems: string[];
  artifacts: Array<{ title: string; url: string }>;
}

export function compressionPrompt(frame: Rec, messageId: string): string {
  const p = frame.meta.paseo;
  return `Compress this conversation into frame ${frame.id}, target ${p.compression.w} x ${p.compression.h} px (W x H). Request ${messageId}.
Write a concise summary of the conversation: a title, a few stickies covering decisions, results, and open items, plus links to key artifacts. Use your conversation history and the archived original content. Do not trim the transcript or change the conversation binding.
The originals are restorable in the board Archive, source frame ${frame.id}, entry ${p.compression.archiveId}.
Submit the summary with board_write({summary:{requestId:${JSON.stringify(messageId)},title:"...",decisions:["..."],results:["..."],openItems:["..."],artifacts:[{title:"...",url:"https://..."}]}}). The board lays it out to fit exactly; nothing may overlap or overflow. Do not resize the frame. Keep each item short. If your board_write tool schema lacks summary, POST this same JSON to your existing frame-scoped /write HTTP endpoint with your existing frame token. Read the Archive entry through the board UI API if needed; never invent missing decisions or results.`;
}

// A single atomic summary write avoids partial layouts. Notes are measured at their
// normal size, then uniformly scaled to fit the requested size with generous gutters.
// Reserve for the widest glyphs rather than average English text. UTF-16 length
// also counts both halves of emoji; explicit newlines each consume a full line.
function safeTextHeight(text:string, width:number, fontSize:number, lineHeight:number):number {
  const perLine=Math.max(1,Math.floor((width-40)/fontSize));
  return text.split('\n').reduce((n,line)=>n+Math.max(1,Math.ceil(line.length/perLine)),0)*lineHeight;
}

export function writeCompressionSummary(room: BoardRoom, frameId: string, raw: unknown): {ok:true; ids:string[]} {
  const frame = room.records.get(frameId)!;
  const compression = frame.meta?.paseo?.compression;
  if (!compression) throw Object.assign(Error('No compression request is active'), {status:409});
  const s = raw as CompressionSummary & {requestId:string};
  if (!s || s.requestId !== compression.messageId) throw Object.assign(Error('Summary requestId is stale'), {status:409});
  if (compression.status === 'complete') return {ok:true, ids:subtree(room.records, frameId).filter(r=>r.meta?.compressionRequest===s.requestId).map(r=>r.id)};
  const invalid = (message:string):never => {throw Object.assign(Error(message), {status:400});};
  if (typeof s.title !== 'string' || !s.title.trim() || s.title.length > 160) invalid('Summary needs a title of 1–160 characters');
  for (const key of ['decisions','results','openItems'] as const)
    if (!Array.isArray(s[key]) || s[key].length > 4 || s[key].some(t=>typeof t!=='string' || t.length>180)) invalid(`${key} needs at most four short strings (180 characters each)`);
  if (!Array.isArray(s.artifacts) || s.artifacts.length > 6 || s.artifacts.some(a=>!a || typeof a.title!=='string' || a.title.length>100 || typeof a.url!=='string' || a.url.length>2000 || !/^https?:\/\//i.test(a.url))) invalid('artifacts needs at most six {title,url} HTTP links');
  if (subtree(room.records, frameId).length) invalid('Frame changed while summarizing. Move new content out before submitting; nothing was overwritten.');
  const meta = {author:{kind:'agent', agentId:frame.meta.paseo.agentId}, compressionRequest:s.requestId};
  let index = nextIndex(room.records, frameId);
  const idx = () => { const out=index; index=getIndexAbove(index as never); return out; };
  const title = baseShape('text',frameId,idx(),20,20,{color:'black',size:'l',font:'sans',textAlign:'start',w:660,richText:toRichText(s.title),scale:1,autoSize:false},meta);
  const records:Rec[] = [title];
  const titleH = Math.max(90, shapeSize(title).h + 30, safeTextHeight(s.title,660,36,55)+30);
  const groups = [ ['Decisions',s.decisions,'yellow'], ['Results',s.results,'green'], ['Open items',s.openItems,'light-blue'] ] as const;
  let bottom = titleH;
  groups.forEach(([label,items,color],i)=> {
    const text = `${label}\n${items.length ? items.join('\n') : 'None recorded'}`;
    const note = buildShape({type:'note',text,color},frameId,idx(),20+i*240,titleH,meta);
    // Sans metrics are stable and conservative; extra space protects against browser growth.
    note.props.font='sans';
    note.props.growY = Math.max(note.props.growY, safeTextHeight(text,200,24,34)+40-200);
    records.push(note); bottom=Math.max(bottom,titleH+shapeSize(note).h+40);
  });
  for (const artifact of s.artifacts) {
    const link = baseShape('text',frameId,idx(),20,bottom,{color:'blue',size:'m',font:'sans',textAlign:'start',w:660,
      richText:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:artifact.title || artifact.url,marks:[{type:'link',attrs:{href:artifact.url,target:'_blank',rel:'noopener noreferrer'}}]}]}]},scale:1,autoSize:false},meta);
    records.push(link); bottom+=Math.max(65,shapeSize(link).h+20,safeTextHeight(artifact.title || artifact.url,660,24,36)+20);
  }
  const scale=Math.min(1, frame.props.w/720, frame.props.h/(bottom+30));
  for (const r of records) { r.x*=scale; r.y*=scale; r.props.scale=scale; }
  room.write({kind:'agent',agentId:frame.meta.paseo.agentId,frameId}, ops=> {
    for (const r of records) ops.put(r);
    ops.put({...frame,meta:{...frame.meta,paseo:{...frame.meta.paseo,compression:{...compression,status:'complete'}}}});
  });
  return {ok:true,ids:records.map(r=>r.id)};
}
