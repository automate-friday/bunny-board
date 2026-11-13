// Explicit temporary conversations between two bound frames. A channel is anchored either to
// an arrow bound to both frames, or to a link: a pair of portal stickies, one in each
// frame, which also works when the frames are on different pages. No transcript watcher
// forwards messages: one deliberate send produces at most one peer delivery.
//
// Link channels are opened by a person (the board's connect-by-name) or by approving an
// agent's proposal (board_channel open). An agent never opens one itself.
import type {PromptReceipt} from './prompt-outbox';
import { timed } from "./perf";
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DOCUMENT_ID } from '../shared/locks';
import { childBoxes, freeGridSlot, GRID } from './layout';
import { ancestors, buildShape, isShape, nextIndex, NOTE_SIZE, type Rec, type RecMap } from './records';
import type { ChangeSource, RecordChange, WriteOps } from './room-host';
// An arrow channel is stored exactly as it always was: `arrow` and `bindings`, no `anchor`.
// A link channel has anchor 'link' and its two stickies; it keeps `arrow: ''` and
// `bindings: []` so code that only knows arrows (an older server or canvas reading the same
// file or list) sees a channel whose arrow does not exist instead of failing on a missing field.
export interface Channel {
  id:string; board:string; arrow:string; active:boolean;
  members:Array<{frame:string;agentId:string}>;
  bindings:string[];
  messages:Record<string,{messageId:string;from:string;text:string;operationId:string;status:PromptReceipt['status']}>;
  anchor?:'link';
  // One portal sticky per member frame: note.meta.portal = {id: the other frame},
  // note.meta.channel = {id: this channel}.
  stickies?:Array<{frame:string;note:string}>;
}
// What the canvas and agents are given: every channel says which kind of anchor it has.
export type ChannelView = Omit<Channel,'anchor'> & {anchor:'arrow'|'link'};
// An agent's request to be connected to another frame. Nothing opens until a person
// approves it on the board (the UI route); declined and expired ones are kept as a record.
export interface ChannelProposal {
  id:string; board:string; at:number;
  from:{frame:string;agentId:string;name:string};
  to:{frame:string;agentId:string;name:string};
  status:'pending'|'approved'|'declined'|'expired';
  decidedAt?:number; decidedBy?:string;
  // approved: the channel that connects the two frames.
  channelId?:string;
  // expired: why it can no longer be approved.
  why?:string;
}
// The loaded board a link channel writes its stickies to.
export interface ChannelRoom { records:RecMap; write(source:ChangeSource,fn:(ops:WriteOps)=>void):void; save():void; }
export interface ChannelBoards {
  room(board:string):ChannelRoom|null;
  // Runs a follow-up write after the change that caused it has been acknowledged to the tab
  // that pushed it (a server write landing before that is rebased away by the tab and pushed
  // again; see FrameWatcher.onChanges). Tests pass their own queue.
  defer?(fn:()=>void):void;
}
// note.meta[CHANNEL_META] = {id} marks a link channel's sticky.
export const CHANNEL_META='channel';
// Pending proposals for the canvas, in the tldraw document record's meta (like paseoArchive).
export const CHANNELS_KEY='paseoChannels';
export const PROPOSALS_PER_FRAME=3;
const DECIDED_KEPT=50;
const fail=(status:number,message:string)=>Object.assign(new Error(message),{status});
const channelNote=(r:Rec|null|undefined,id:string):r is Rec=>!!r&&r.type==='note'&&r.meta?.[CHANNEL_META]?.id===id;
const frameName=(r:Rec|undefined)=>String(r?.props?.name??'').trim();
const boundAgent=(r:Rec|undefined):string|null=>r?.type==='frame'&&r.meta?.paseo?.agentId?String(r.meta.paseo.agentId):null;
const samePair=(a:string,b:string,x:string,y:string)=>(a===x&&b===y)||(a===y&&b===x);
export class FrameChannels {
  private channels:Record<string,Channel>;
  private file:string;
  // Proposals live in their own file: channels.json stays a plain map of channels.
  private proposals:ChannelProposal[]=[];
  private proposalsFile:string;
  // announce: tells each member conversation its channel exists (the agent otherwise never
  // learns of an arrow drawn outside its frame). Optional so tests can count sends alone.
  constructor(dir:string, private records:(board:string)=>RecMap|null,private deliver:(board:string,frame:string,agentId:string,text:string,messageId:string,channelId:string)=>Promise<PromptReceipt['status']>,private announce?:(board:string,frame:string,agentId:string,text:string,messageId:string,channelId:string)=>Promise<unknown>,
    // boards: where link channels put their stickies and proposals their canvas summary.
    // Without it (arrow-only rigs) link channels and proposals are refused.
    private boards?:ChannelBoards) {
    mkdirSync(dir,{recursive:true});this.file=path.join(dir,'channels.json');
    this.channels=existsSync(this.file)?JSON.parse(readFileSync(this.file,'utf8')):{};
    for(const c of Object.values(this.channels))for(const m of Object.values(c.messages))if(m.status==='sending')m.status='unknown';
    this.save();
    this.proposalsFile=path.join(dir,'proposals.json');
    if(existsSync(this.proposalsFile)){
      try{const data=JSON.parse(readFileSync(this.proposalsFile,'utf8'));if(Array.isArray(data?.proposals))this.proposals=data.proposals;}
      // Keep the unreadable file; proposals are requests, so starting without them loses no channel.
      catch{renameSync(this.proposalsFile,`${this.proposalsFile}.corrupt-${Date.now()}`);}
    }
  }
  private save(){timed('channels.save',()=>{writeFileSync(this.file+'.tmp',JSON.stringify(this.channels,null,2));renameSync(this.file+'.tmp',this.file);});}
  private saveProposals(){
    const decided=this.proposals.filter(p=>p.status!=='pending');
    if(decided.length>DECIDED_KEPT){const keep=new Set(decided.slice(-DECIDED_KEPT));this.proposals=this.proposals.filter(p=>p.status==='pending'||keep.has(p));}
    writeFileSync(this.proposalsFile+'.tmp',JSON.stringify({proposals:this.proposals},null,2));renameSync(this.proposalsFile+'.tmp',this.proposalsFile);
  }
  private defer(fn:()=>void){
    const run=()=>{try{fn();}catch{/* the board closed or was archived meanwhile */}};
    if(this.boards?.defer)this.boards.defer(run);else setTimeout(run,30);
  }
  list(board:string){return Object.values(this.channels).filter(c=>c.board===board);}
  // The same list with every channel's anchor kind spelled out (the canvas renders from it).
  views(board:string):ChannelView[]{return this.list(board).map(c=>this.view(c));}
  view(c:Channel):ChannelView{return {...c,anchor:c.anchor??'arrow'};}
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
    this.channels[c.id]=c;this.save();this.announceOpened(c,records);return c;
  }
  // The opening notice for one new channel: who the peer is and how to use it. Delivery is
  // best effort; a member that misses it still finds the channel with board_channel list.
  private announceOpened(c:Channel,records:RecMap){
    if(!this.announce)return;
    for(const m of c.members){
      const peer=c.members.find(o=>o.frame!==m.frame)!;
      const name=String(records.get(peer.frame)?.props?.name??'').trim();
      void this.announce(c.board,m.frame,m.agentId,channelOpenedText(c.id,peer.frame,name,c.anchor??'arrow'),`channel-open-${c.id}-${m.agentId}`,c.id).catch(()=>{});
    }
  }
  private valid(c:Channel){
    if(c.anchor==='link'){
      const records=this.records(c.board);
      return !!records&&c.stickies?.length===2&&c.members.every(m=>boundAgent(records.get(m.frame))===m.agentId)&&c.stickies.every(s=>channelNote(records.get(s.note),c.id));
    }
    try {const {records,bindings}=this.ends(c.board,c.arrow);
      return bindings.every(b=>c.bindings.includes(b.id))&&c.members.every(m=>records.get(m.frame)?.meta?.paseo?.agentId===m.agentId)&&bindings.every(b=>c.members.some(m=>m.frame===b.toId));
    }catch{return false;}
  }
  revoke(board:string,id:string){const c=this.channels[id];if(!c||c.board!==board)throw new Error('unknown channel');c.active=false;this.save();this.dropStickies(c);return c;}
  changed(board:string,changes:RecordChange[]){
    let dirty=false;
    const closed:Channel[]=[];
    for(const c of Object.values(this.channels))if(c.board===board&&c.active){
      if(changes.some(d=>{
        if(c.anchor==='link'&&c.stickies?.some(s=>s.note===d.id))return !channelNote(d.after,c.id);
        if(d.id===c.arrow)return !d.after||d.after.type!=='arrow';
        if(c.bindings.includes(d.id))return !d.after||d.before?.toId!==d.after.toId||d.before?.fromId!==d.after.fromId||d.before?.props?.terminal!==d.after.props?.terminal;
        if(c.members.some(m=>m.frame===d.id))return !d.after||d.before?.meta?.paseo?.agentId!==d.after.meta?.paseo?.agentId;
        return false;
      })){c.active=false;dirty=true;if(c.anchor==='link')closed.push(c);}
    }if(dirty)this.save();
    // A closed link channel takes what is left of its pair of stickies off the board.
    for(const c of closed)this.defer(()=>this.dropStickies(c));
    // A sticky that carries a channel mark without being one of a live channel's pair: a
    // deleted sticky brought back by undo, a copy, a restored archive. Closing is final, so
    // it stays as an ordinary portal sticky and loses the mark.
    for(const d of changes){
      const id=d.after?.type==='note'?d.after.meta?.[CHANNEL_META]?.id:undefined;
      if(typeof id!=='string'||closed.some(c=>c.id===id)||this.liveSticky(board,d.id,id))continue;
      const note=d.id;this.defer(()=>this.unmark(board,note));
    }
    // A proposal whose frames have gone or been rebound can no longer be approved.
    let expired=false;
    for(const p of this.proposals)if(p.board===board&&p.status==='pending'){
      for(const end of [p.from,p.to]){
        const d=changes.find(x=>x.id===end.frame);
        if(d&&boundAgent(d.after??undefined)!==end.agentId){p.status='expired';p.decidedAt=Date.now();p.why=d.after?'a frame was bound to another conversation':'a frame was removed';expired=true;break;}
      }
    }
    if(expired){this.saveProposals();this.defer(()=>this.summarise(board));}
  }
  // --- link channels: a pair of portal stickies instead of an arrow -----------------------

  // The active, still valid channel (either kind) between two frames, if there is one.
  private between(board:string,a:string,b:string):Channel|null{
    for(const c of Object.values(this.channels)){
      if(c.board!==board||!c.active||c.members.length!==2||!samePair(c.members[0].frame,c.members[1].frame,a,b))continue;
      if(this.valid(c))return c;
      c.active=false;this.save();this.dropStickies(c);
    }
    return null;
  }

  // Two distinct bound frames with distinct conversations, as the arrow enrolment requires.
  private linkMembers(records:RecMap,members:string[]){
    if(!Array.isArray(members)||members.length!==2||new Set(members).size!==2)throw fail(400,'explicitly choose two distinct member frames');
    const chosen=members.map(frame=>{const agentId=boundAgent(records.get(frame));if(!agentId)throw fail(409,'each member must be a bound frame');return {frame,agentId};});
    if(chosen[0].agentId===chosen[1].agentId)throw fail(409,'channel members must be distinct conversations');
    return chosen;
  }

  // The sticky for one end: a portal to the other frame, in a free slot of this frame. A
  // frame with no free slot still gets it, at the top-left slot over what is there (the
  // channel matters more than the overlap, and a person can move the sticky).
  private linkNote(records:RecMap,channelId:string,frame:Rec,peer:Rec):Rec{
    const size={w:NOTE_SIZE,h:NOTE_SIZE};
    const box={w:Number(frame.props?.w)||0,h:Number(frame.props?.h)||0};
    const slot=freeGridSlot(childBoxes(records,frame.id),box,size)
      ??{x:Math.max(0,Math.min(GRID.x0,box.w-size.w)),y:Math.max(0,Math.min(GRID.y0,box.h-size.h))};
    return buildShape({type:'note',text:`⇄ ${frameName(peer)||'frame'}`,color:'light-green'},frame.id,nextIndex(records,frame.id),slot.x,slot.y,{portal:{id:peer.id},[CHANNEL_META]:{id:channelId}});
  }

  // Open a link channel between two bound frames (any pages) and announce it to both
  // agents. Only the board UI calls this: directly, or by approving a proposal.
  enrollLink(board:string,members:string[]):Channel{
    const room=this.boards?.room(board);
    if(!room)throw fail(404,'unknown board');
    const records=room.records;
    const chosen=this.linkMembers(records,members);
    const existing=this.between(board,members[0],members[1]);
    if(existing)throw fail(409,`these frames are already connected by channel ${existing.id}`);
    const id=randomUUID();
    const frames=chosen.map(m=>records.get(m.frame)!);
    const notes=frames.map((f,i)=>this.linkNote(records,id,f,frames[1-i]));
    const c:Channel={id,board,arrow:'',active:true,members:chosen,bindings:[],messages:{},anchor:'link',stickies:chosen.map((m,i)=>({frame:m.frame,note:notes[i].id}))};
    // Registered before the write: the change listener must find these stickies live.
    this.channels[id]=c;
    try{
      room.write({kind:'server',reason:'channel-link'},ops=>{for(const n of notes)ops.put(n);});
      if(!notes.every(n=>room.records.has(n.id)))throw fail(503,'the board could not be written; no channel was opened');
    }catch(e){delete this.channels[id];throw e;}
    // Both the channel and its stickies are on disk before either agent hears of it.
    this.save();room.save();
    this.settle(c);
    this.announceOpened(c,records);
    return c;
  }

  // Take a closed link channel's stickies (with anything attached to them) off the board.
  private dropStickies(c:Channel){
    if(c.anchor!=='link'||!c.stickies)return;
    const room=this.boards?.room(c.board);if(!room)return;
    const notes=c.stickies.map(s=>s.note).filter(id=>channelNote(room.records.get(id),c.id));
    if(!notes.length)return;
    const gone=new Set(notes);
    const inside:Rec[]=[];
    for(const r of room.records.values())if(isShape(r)&&ancestors(room.records,r).some(a=>gone.has(a)))inside.push(r);
    inside.sort((a,b)=>ancestors(room.records,b).length-ancestors(room.records,a).length);
    for(const r of inside)gone.add(r.id);
    room.write({kind:'server',reason:'channel-closed'},ops=>{
      for(const r of room.records.values())if(r.typeName==='binding'&&(gone.has(r.fromId)||gone.has(r.toId)))ops.remove(r.id);
      for(const r of inside)ops.remove(r.id);
      for(const id of notes)if(ops.get(id))ops.remove(id);
    });
  }

  private liveSticky(board:string,note:string,channelId:string){
    const c=this.channels[channelId];
    return !!c&&c.board===board&&c.active&&c.anchor==='link'&&!!c.stickies?.some(s=>s.note===note);
  }

  // Remove a stale channel mark from a sticky; its portal and text stay.
  private unmark(board:string,note:string){
    const room=this.boards?.room(board);if(!room)return;
    room.write({kind:'server',reason:'channel-orphan'},ops=>{
      const cur=ops.get(note);const id=cur?.type==='note'?cur.meta?.[CHANNEL_META]?.id:undefined;
      if(!cur||id===undefined||(typeof id==='string'&&this.liveSticky(board,note,id)))return;
      const {[CHANNEL_META]:_mark,...meta}=cur.meta;
      ops.put({...cur,meta});
    });
  }

  // --- proposals: an agent asks, a person approves on the board ---------------------------

  // The bound frame an agent means by a name or a shape: id. A name must match exactly one
  // bound frame (any page, case-insensitive), never the asker's own.
  resolve(board:string,asker:string,ref:string):{frame:string;agentId:string;name:string}{
    const records=this.records(board);
    if(!records)throw fail(404,'unknown board');
    const want=String(ref??'').trim();
    if(!want)throw fail(400,'frame is required: the name of a bound frame, or its shape: id');
    if(want.startsWith('shape:')){
      const r=records.get(want);
      if(want===asker)throw fail(400,`${want} is your own frame; name the frame you want to talk to`);
      if(r?.type!=='frame')throw fail(404,`${want} is not a frame on this board`);
      const agentId=boundAgent(r);
      if(!agentId)throw fail(409,`frame ${describe(r)} has no conversation bound to it; a channel connects two frames that each have an agent`);
      return {frame:r.id,agentId,name:frameName(r)};
    }
    const others:Rec[]=[];
    for(const r of records.values())if(r.id!==asker&&boundAgent(r))others.push(r);
    const key=fold(want);
    const exact=others.filter(r=>fold(frameName(r))===key);
    if(exact.length===1)return {frame:exact[0].id,agentId:boundAgent(exact[0])!,name:frameName(exact[0])};
    if(exact.length>1)throw fail(409,`${exact.length} bound frames are named "${want}": ${exact.map(r=>`${describe(r)} on page "${pageName(records,r)}"`).join(', ')}. Pass the shape: id of the one you mean.`);
    if(!others.length)throw fail(404,`no bound frame is named "${want}": yours is the only frame with a conversation on this board`);
    const own=fold(frameName(records.get(asker)))===key?' That is the name of your own frame.':'';
    throw fail(404,`no bound frame is named "${want}".${own} Closest: ${closest(want,others).map(describe).join(', ')}. Pass the exact name or the shape: id; board_read({scope:'board', query}) finds frames by name.`);
  }

  // board_channel open: file a request to be connected to another frame. Never opens a
  // channel. The same pair asked again (from either side) gets the pending proposal back.
  propose(board:string,asker:string,ref:string):{proposal:ChannelProposal;existing:boolean}{
    if(!this.boards?.room(board))throw fail(404,'unknown board');
    const records=this.records(board)!;
    const self=records.get(asker);const agentId=boundAgent(self);
    if(!agentId)throw fail(409,'your frame has no conversation bound to it');
    const to=this.resolve(board,asker,ref);
    if(to.agentId===agentId)throw fail(409,`frame ${to.name?`"${to.name}" (${to.frame})`:to.frame} belongs to your own conversation`);
    const live=this.between(board,asker,to.frame);
    if(live)throw fail(409,`your frame is already connected to ${to.name?`"${to.name}" (${to.frame})`:to.frame}: channel ${live.id}`);
    this.expireStale(board,records);
    const pending=this.proposals.filter(p=>p.board===board&&p.status==='pending');
    const same=pending.find(p=>samePair(p.from.frame,p.to.frame,asker,to.frame));
    if(same)return {proposal:same,existing:true};
    const mine=pending.filter(p=>p.from.frame===asker);
    if(mine.length>=PROPOSALS_PER_FRAME)throw fail(429,`you already have ${mine.length} channel proposals waiting for a decision (${mine.map(p=>p.to.name?`"${p.to.name}"`:p.to.frame).join(', ')}); no more until one is approved or declined on the board`);
    const proposal:ChannelProposal={id:randomUUID(),board,at:Date.now(),from:{frame:asker,agentId,name:frameName(self)},to,status:'pending'};
    this.proposals.push(proposal);this.saveProposals();this.summarise(board);
    return {proposal,existing:false};
  }

  // Every proposal on a board, newest first (the canvas lists the pending ones).
  proposalsOf(board:string):ChannelProposal[]{return this.proposals.filter(p=>p.board===board).sort((a,b)=>b.at-a.at);}
  // What one frame asked for, so its agent can see what became of a request: everything
  // still pending and its five latest decided ones.
  proposalsFrom(board:string,frame:string):ChannelProposal[]{
    const mine=this.proposalsOf(board).filter(p=>p.from.frame===frame);
    const decided=mine.filter(p=>p.status!=='pending').slice(0,5);
    return mine.filter(p=>p.status==='pending'||decided.includes(p));
  }

  // A person's decision. Approving opens the link channel (or adopts the channel that
  // connects the two frames by now) and announces it; declining opens nothing.
  decide(board:string,id:string,decision:'approve'|'decline',by:string):{proposal:ChannelProposal;channel:ChannelView|null}{
    const p=this.proposals.find(x=>x.id===id&&x.board===board);
    if(!p)throw fail(404,`no channel proposal ${id}`);
    if(p.status!=='pending')throw fail(409,`channel proposal ${id} was already ${p.status}`);
    const done=(status:ChannelProposal['status'],extra:Partial<ChannelProposal>={})=>{Object.assign(p,{status,decidedAt:Date.now(),decidedBy:by},extra);this.saveProposals();this.summarise(board);};
    if(decision==='decline'){done('declined');return {proposal:p,channel:null};}
    const records=this.records(board);
    const moved=[p.from,p.to].find(end=>boundAgent(records?.get(end.frame))!==end.agentId);
    if(moved){
      const why=`frame ${moved.name?`"${moved.name}" (${moved.frame})`:moved.frame} is no longer bound to the conversation it had when this was proposed`;
      done('expired',{why});throw fail(409,`${why}; nothing was opened`);
    }
    // enrollLink settles this proposal (and any other for the pair) as approved.
    const channel=this.between(board,p.from.frame,p.to.frame)??this.enrollLink(board,[p.from.frame,p.to.frame]);
    done('approved',{channelId:channel.id});
    return {proposal:p,channel:this.view(channel)};
  }

  // A new link channel answers every pending proposal for its pair.
  private settle(c:Channel){
    let hit=false;
    for(const p of this.proposals)if(p.board===c.board&&p.status==='pending'&&samePair(p.from.frame,p.to.frame,c.members[0].frame,c.members[1].frame)){p.status='approved';p.decidedAt=Date.now();p.channelId=c.id;hit=true;}
    if(hit){this.saveProposals();this.summarise(c.board);}
  }

  private expireStale(board:string,records:RecMap){
    let hit=false;
    for(const p of this.proposals)if(p.board===board&&p.status==='pending'&&[p.from,p.to].some(end=>boundAgent(records.get(end.frame))!==end.agentId)){p.status='expired';p.decidedAt=Date.now();p.why='a frame was removed or bound to another conversation';hit=true;}
    if(hit){this.saveProposals();this.summarise(board);}
  }

  // The pending proposals, in the document record for every tab to see.
  private summarise(board:string){
    const room=this.boards?.room(board);if(!room)return;
    const pending=this.proposals.filter(p=>p.board===board&&p.status==='pending').map(p=>({id:p.id,at:p.at,from:{frame:p.from.frame,name:p.from.name},to:{frame:p.to.frame,name:p.to.name}}));
    let wrote=false;
    room.write({kind:'server',reason:'channel-proposals'},ops=>{
      const doc=ops.get(DOCUMENT_ID)??{id:DOCUMENT_ID,typeName:'document',gridSize:10,name:'',meta:{}};
      const prev=doc.meta?.[CHANNELS_KEY];
      if(prev?JSON.stringify(prev.pending)===JSON.stringify(pending):!pending.length)return;
      ops.put({...doc,meta:{...doc.meta,[CHANNELS_KEY]:{pending,rev:Date.now()}}});wrote=true;
    });
    if(wrote)room.save();
  }

  deliveryCurrent(id:string,frame:string,agentId:string):boolean {
    const c=this.channels[id];return !!c&&c.active&&this.valid(c)&&c.members.some(m=>m.frame===frame&&m.agentId===agentId);
  }
  deliveryChanged(operationId:string,status:PromptReceipt['status']):void {
    for(const c of Object.values(this.channels))for(const message of Object.values(c.messages)){
      if(message.operationId===operationId&&message.status!==status){message.status=status;this.save();return;}
    }
  }

  async send(board:string,frame:string,id:string,messageId:string,text:string){
    const c=this.channels[id];
    if(!c||c.board!==board||!c.active)throw new Error('channel membership is revoked or absent');
    if(!this.valid(c)){c.active=false;this.save();this.dropStickies(c);throw new Error(c.anchor==='link'?'channel membership revoked after sticky or agent change':'channel membership revoked after arrow or agent change');}
    if(!c.members.some(m=>m.frame===frame))throw new Error('sender is not a member of this channel');
    if(!/^[A-Za-z0-9_-]{1,100}$/.test(messageId)||typeof text!=='string'||!text.trim()||text.length>12000)throw new Error('messageId and nonempty text (max 12000 characters) required');
    const key=frame+'\0'+messageId;const previous=c.messages[key];
    if(previous){if(previous.text!==text)throw new Error('message ID already used with other text');return previous;}
    const target=c.members.find(m=>m.frame!==frame)!;
    const message:Channel['messages'][string]={messageId,from:frame,text,operationId:randomUUID(),status:'sending'};
    c.messages[key]=message;this.save();
    const prompt=`Arrow channel ${c.id}; message ${messageId}; from frame ${frame}. Explicit members: ${c.members.map(m=>m.frame).join(', ')}.\n${text}\nThis message terminates here: do not relay it into another channel. Answer it over this channel yourself (no need to ask the user) when you have something that moves the work forward: an answer, a result, a question, a file or plan conflict. Skip acknowledgement-only or thank-you messages; when nothing is left to say, stop.`;
    try{const status=await this.deliver(board,target.frame,target.agentId,prompt,message.operationId,c.id);if(message.status==='sending')message.status=status;}catch{if(message.status==='sending')message.status='unknown';}
    this.save();return message;
  }
}

const fold=(s:string)=>s.trim().replace(/\s+/g,' ').toLowerCase();
const describe=(r:Rec)=>frameName(r)?`"${frameName(r)}" (${r.id})`:`(unnamed) (${r.id})`;
function pageName(records:RecMap,r:Rec):string{
  let p=records.get(r.parentId);let guard=0;
  while(p&&p.typeName!=='page'&&guard++<50)p=records.get(p.parentId);
  return p?.typeName==='page'?String(p.name??''):'?';
}
function editDistance(a:string,b:string):number{
  let row=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=1;i<=a.length;i++){
    const next=[i];
    for(let j=1;j<=b.length;j++)next.push(Math.min(next[j-1]+1,row[j]+1,row[j-1]+(a[i-1]===b[j-1]?0:1)));
    row=next;
  }
  return row[b.length];
}
// The frames whose names are nearest to what was asked for: a name containing it (or
// contained in it) first, then shared words, then spelling distance.
function closest(want:string,frames:Rec[],n=5):Rec[]{
  const q=fold(want).slice(0,80);const words=new Set(q.split(' '));
  const score=(r:Rec)=>{
    const s=fold(frameName(r)).slice(0,80);
    if(!s)return 3;
    if(s.includes(q)||q.includes(s))return Math.abs(s.length-q.length)/1000;
    const shared=s.split(' ').filter(w=>words.has(w)).length;
    return (shared?0.5:1)+editDistance(q,s)/Math.max(q.length,s.length);
  };
  return frames.map(r=>({r,s:score(r)})).sort((a,b)=>a.s-b.s||frameName(a.r).localeCompare(frameName(b.r))||(a.r.id<b.r.id?-1:1)).slice(0,n).map(x=>x.r);
}

// anchor: what connects the two frames on the board, an arrow or a link (a pair of portal stickies).
export function channelOpenedText(channelId:string,peerFrame:string,peerName:string,anchor:'arrow'|'link'='arrow'){
  return [
    `Channel opened: ${anchor==='link'?'a link':'an arrow'} on the board now connects your frame to frame ${peerName?`"${peerName}" (${peerFrame})`:peerFrame}. Channel id: ${channelId}.`,
    `List it with board_channel({action:'list'}); send one deliberate message with board_channel({action:'send', channelId:'${channelId}', messageId:'<stable id>', text}). Without board tools, POST the same JSON to your frame's /channel HTTP route.`,
    `The person connected these frames so the two agents coordinate; ${anchor==='link'?'the link':'the arrow'} is their approval, so do not ask them before sending. Start now with one short message: what you are working on, which files or areas you touch, and what you need from the other side. After that, message whenever it helps the work (answers, results, questions, conflicts); skip acknowledgement-only replies.`,
    'Limits: transcripts are never forwarded automatically, each send is one deliberate message with a stable messageId, and messages are not relayed into a third channel.',
  ].join('\n');
}
