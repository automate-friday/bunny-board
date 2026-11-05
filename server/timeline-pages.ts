import type {PaseoAgentTimelineHandle} from '@getpaseo/client';
import {projectItem,redactBoardTokens,simplifyItem} from './timeline';
import {withDaemonRead} from './daemon-health';
type Page=Awaited<ReturnType<PaseoAgentTimelineHandle['refetch']>>;
type Entry=Page['entries'][number];
function bad(message:string,status=400,code='INVALID_TIMELINE_CURSOR'){return Object.assign(new Error(message),{status,code});}
function encode(parts:unknown[]){return Buffer.from(JSON.stringify(parts)).toString('base64url');}
function decode(value:string,agent:string,count:number):unknown[]{
 if(!value||value.length>2048||!/^[A-Za-z0-9_-]+$/.test(value))throw bad('Invalid timeline cursor or row id');
 let x:unknown;try{x=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));}catch{throw bad('Invalid timeline cursor or row id');}
 if(!Array.isArray(x)||x.length!==count||x[0]!==agent||typeof x[1]!=='string'||!x[1]||x[1].length>256||!Number.isSafeInteger(x[2])||(x[2]as number)<0||(count===4&&(!Number.isSafeInteger(x[3])||(x[3]as number)<(x[2]as number))))throw bad('Timeline cursor does not match this agent or has invalid sequence');return x;
}
export function exactTimelineText(entry:Entry):string {
 const item=entry.item;
 const serial=(value:unknown)=>JSON.stringify(value,(_key,value:unknown)=>typeof value==='string'?redactBoardTokens(value):value,2);
 let text:unknown;
 switch(item.type){
  case 'user_message':case 'assistant_message':case 'reasoning':text=item.text;break;
  case 'tool_call':text=serial(item);break;
  case 'plugin':text=(item.data&&typeof item.data==='object'&&!Array.isArray(item.data)?item.data.text:undefined)??serial(item.data);break;
  case 'error':case 'notification':text=item.message;break;
  default:text=serial(item);
 }
 return redactBoardTokens(String(text??''));
}
export function timelineRows(page:Page,agent:string){
 return page.entries.flatMap(entry=>{const row=simplifyItem(entry);if(!row)return [];const exact=exactTimelineText(entry);const item=projectItem(entry,agent);return [{...row,id:encode([agent,page.epoch,entry.seqStart,entry.seqEnd]),truncated:row.primer?row.full!==exact:row.text!==exact,...(item?{item}:{})}];});
}
export async function timelinePage(ref:PaseoAgentTimelineHandle,agent:string,limitValue:string|null,before:string|null){
 const limit=limitValue===null?80:Number(limitValue);if(!Number.isInteger(limit)||limit<1||limit>200)throw bad('Timeline limit must be an integer from1 to200');
 const c=before?decode(before,agent,3):null;
 const page=await withDaemonRead(()=>ref.refetch({direction:c?'before':'tail',...(c?{cursor:{epoch:c[1]as string,seq:c[2]as number}}:{}),limit,projection:'projected'}));
 if(page.error)throw bad(page.error,503,'TIMELINE_UNAVAILABLE');
 return {agentId:agent,rows:timelineRows(page,agent),nextCursor:page.hasOlder&&page.startCursor?encode([agent,page.startCursor.epoch,page.startCursor.seq]):null,hasOlder:page.hasOlder,hasNewer:page.hasNewer,epoch:page.epoch,reset:page.reset,staleCursor:page.staleCursor,gap:page.gap,capabilities:{older:true,exact:true}};
}
// The exact row: resolved by seqStart, so a tool call whose seqEnd grew since the row
// was listed (running -> completed) still opens. Text is capped at 1 MB.
export const EXACT_ROW_CAP=1_000_000;
export async function timelineRow(ref:PaseoAgentTimelineHandle,agent:string,id:string){
 const c=decode(id,agent,4);const start=c[2]as number;
 const page=await withDaemonRead(()=>ref.refetch({direction:'after',cursor:{epoch:c[1]as string,seq:start-1},limit:1,projection:'projected'}));
 if(page.error)throw bad(page.error,503,'TIMELINE_UNAVAILABLE');
 if(page.epoch!==c[1]||page.staleCursor||page.gap||page.reset)throw bad('Timeline changed. Refresh history before opening this row.',409,'TIMELINE_ROW_CHANGED');
 const entry=page.entries.find(e=>e.seqStart===start&&e.seqEnd>=(c[3]as number));
 if(!entry){if(page.entries.length)throw bad('Timeline row changed. Refresh history.',409,'TIMELINE_ROW_CHANGED');throw bad('Timeline row not found',404,'TIMELINE_ROW_NOT_FOUND');}
 const row=simplifyItem(entry);if(!row)throw bad('Timeline row is not displayable',404,'TIMELINE_ROW_NOT_FOUND');
 // The item with generous bounds (64 KB per field) for the expanded view; text gets
 // the rest of the 1 MB budget.
 const item=projectItem(entry,agent,{head:64_000,tail:64_000,message:64_000});
 const cap=Math.max(0,EXACT_ROW_CAP-(item?JSON.stringify(item).length:0));
 const full=exactTimelineText(entry);const cut=full.length>cap;
 return {agentId:agent,id,kind:row.kind,at:row.at,text:cut?full.slice(0,cap):full,truncated:cut,redacted:true,seqEnd:entry.seqEnd,...(item?{item}:{})};
}
