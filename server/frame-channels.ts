// Explicit temporary conversations attached to an arrow. No transcript watcher
// forwards messages: one deliberate send produces at most one peer delivery.
import { timed } from "./perf";
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Rec, RecMap } from './records';
import type { RecordChange } from './room-host';
interface Channel {
  id:string; board:string; arrow:string; active:boolean;
  members:Array<{frame:string;agentId:string}>;
  bindings:string[];
  messages:Record<string,{messageId:string;from:string;text:string;operationId:string;status:'sending'|'accepted'|'unknown'}>;
}
export class FrameChannels {
  private channels:Record<string,Channel>;
  private file:string;
  constructor(dir:string, private records:(board:string)=>RecMap|null,private deliver:(board:string,frame:string,agentId:string,text:string)=>Promise<'accepted'|'unknown'>) {
    mkdirSync(dir,{recursive:true});this.file=path.join(dir,'channels.json');
    this.channels=existsSync(this.file)?JSON.parse(readFileSync(this.file,'utf8')):{};
    for(const c of Object.values(this.channels))for(const m of Object.values(c.messages))if(m.status==='sending')m.status='unknown';
    this.save();
  }
  private save(){timed('channels.save',()=>{writeFileSync(this.file+'.tmp',JSON.stringify(this.channels,null,2));renameSync(this.file+'.tmp',this.file);});}
  list(board:string){return Object.values(this.channels).filter(c=>c.board===board);}
  private ends(board:string,arrow:string){
    const records=this.records(board);if(records?.get(arrow)?.type!=='arrow')throw new Error('channel requires an existing arrow');
    const bindings=[...records.values()].filter(r=>r.typeName==='binding'&&r.fromId===arrow&&['start','end'].includes(r.props?.terminal));
    if(bindings.length!==2||bindings[0].props.terminal===bindings[1].props.terminal)throw new Error('arrow must bind two frame endpoints');
    return {records,bindings};
  }
  enroll(board:string,arrow:string,members:string[]){
    if(!Array.isArray(members)||members.length!==2||new Set(members).size!==2)throw new Error('explicitly choose two distinct member frames');
    const {records,bindings}=this.ends(board,arrow);
    const ends=bindings.map(b=>b.toId).sort();
    if([...members].sort().some((id,i)=>id!==ends[i]))throw new Error('members must exactly match arrow endpoints');
    const chosen=members.map(frame=>{const r=records.get(frame);if(r?.type!=='frame'||!r.meta?.paseo?.agentId)throw new Error('each member must be a bound frame');return {frame,agentId:String(r.meta.paseo.agentId)};});
    if(new Set(chosen.map(m=>m.agentId)).size!==2)throw new Error('channel members must be distinct conversations');
    const existing=Object.values(this.channels).find(c=>c.board===board&&c.arrow===arrow&&c.active);
    if(existing){if(this.valid(existing))return existing;existing.active=false;}
    const c:Channel={id:randomUUID(),board,arrow,active:true,members:chosen,bindings:bindings.map(b=>b.id),messages:{}};
    this.channels[c.id]=c;this.save();return c;
  }
  private valid(c:Channel){
    try {const {records,bindings}=this.ends(c.board,c.arrow);
      return bindings.every(b=>c.bindings.includes(b.id))&&c.members.every(m=>records.get(m.frame)?.meta?.paseo?.agentId===m.agentId)&&bindings.every(b=>c.members.some(m=>m.frame===b.toId));
    }catch{return false;}
  }
  revoke(board:string,id:string){const c=this.channels[id];if(!c||c.board!==board)throw new Error('unknown channel');c.active=false;this.save();return c;}
  changed(board:string,changes:RecordChange[]){
    let dirty=false;
    for(const c of Object.values(this.channels))if(c.board===board&&c.active){
      if(changes.some(d=>{
        if(d.id===c.arrow)return !d.after||d.after.type!=='arrow';
        if(c.bindings.includes(d.id))return !d.after||d.before?.toId!==d.after.toId||d.before?.fromId!==d.after.fromId||d.before?.props?.terminal!==d.after.props?.terminal;
        if(c.members.some(m=>m.frame===d.id))return !d.after||d.before?.meta?.paseo?.agentId!==d.after.meta?.paseo?.agentId;
        return false;
      })){c.active=false;dirty=true;}
    }if(dirty)this.save();
  }
  async send(board:string,frame:string,id:string,messageId:string,text:string){
    const c=this.channels[id];
    if(!c||c.board!==board||!c.active)throw new Error('channel membership is revoked or absent');
    if(!this.valid(c)){c.active=false;this.save();throw new Error('channel membership revoked after arrow or agent change');}
    if(!c.members.some(m=>m.frame===frame))throw new Error('sender is not a member of this channel');
    if(!/^[A-Za-z0-9_-]{1,100}$/.test(messageId)||typeof text!=='string'||!text.trim()||text.length>12000)throw new Error('messageId and nonempty text (max 12000 characters) required');
    const key=frame+'\0'+messageId;const previous=c.messages[key];
    if(previous){if(previous.text!==text)throw new Error('message ID already used with other text');return previous;}
    const target=c.members.find(m=>m.frame!==frame)!;
    const message:Channel['messages'][string]={messageId,from:frame,text,operationId:randomUUID(),status:'sending'};
    c.messages[key]=message;this.save();
    const prompt=`Arrow channel ${c.id}; message ${messageId}; from frame ${frame}. Explicit members: ${c.members.map(m=>m.frame).join(', ')}.\n${text}\nThis message terminates here. Do not forward it to another channel or echo it back. Reply in your conversation; send a channel message only for a fresh explicit request from the user.`;
    try{message.status=await this.deliver(board,target.frame,target.agentId,prompt);}catch{message.status='unknown';}
    this.save();return message;
  }
}
