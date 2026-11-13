import {agentBusy} from './paseo-bridge';
import {createHash, randomUUID} from 'node:crypto';
import {mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {BoundedWork} from './bounded-work';
import {hostMetrics} from './host-metrics';
import {daemonFailureReason, hostOperation, transientDaemonError, withDaemonRead} from './daemon-health';

export interface PromptIntent {
  messageId: string;
  agentId: string;
  host: string | null;
  boardId: string;
  frameId: string;
  text: string;
  kind?: 'prompt'|'delta'|'stamp'|'channel';
  channelId?: string;
  // Must reach a busy agent now, cancelling its running turn (a "stop" stamp): sent with
  // activeTurnBehavior 'interrupt' and never held for the turn to end.
  urgent?: boolean;
  // The reply the same reply box sent just before this one. Two POSTs can reach the board
  // in either order; this one waits until that one has arrived and gone out (see
  // DELIVERY.prevWaitMs), so replies keep the order they were typed in.
  prev?: string;
}
// queued → sending → accepted (the daemon answered) → delivered (the agent's timeline
// shows the prompt). failed is final and only follows a timeline check that found
// nothing. unknown is a pre-confirmation receipt; loading one re-verifies it. accepted
// with final set is as far as the board can know: a remote host's acknowledgement
// (reason host-ack), or an old acceptance the timeline cannot place (unverified).
// A queued receipt's reason says what it waits for: waiting-host (Paseo unreachable),
// waiting-turn (busy agent whose provider cannot steer), or a retry after an error.
// waiting-start: the agent's start (often a remote start) has not finished yet.
export interface PromptReceipt extends PromptIntent {
  status: 'queued' | 'sending' | 'accepted' | 'delivered' | 'failed' | 'unknown';
  attempts: number;
  createdAt: number;
  retryAt: number;
  reason?: string;
  // Message ids sent on the wire, oldest first; the first is messageId. A resend after a
  // verified miss gets a fresh one, because the daemon answers a reused id whose earlier
  // send died with agent_request_outcome_unknown forever.
  wireIds?: string[];
  sentAt?: number;
  ackAt?: number;
  deliveredAt?: number;
  checks?: number;
  // How the message goes to a busy agent (shared/send-capabilities MidTurn), as decided by
  // the last pre-send check; the reply box shows what that can and cannot promise.
  mode?: string;
  // Nothing more will be checked: an unknown receipt with no timeline to read (remote
  // host), left for a person to resolve, or an old accepted one the timeline cannot place.
  final?: boolean;
}
// What the agent's timeline says about a receipt's wire ids. running: the agent has a
// turn in flight, so a missing prompt may still land.
export type Landing = {landed: boolean; running: boolean} | 'unsupported';

// How a message meets a busy agent: an urgent one (a stop stamp) interrupts the turn, and
// the board never holds it for the turn to end (server/core.ts); everything else steers.
export const turnBehavior=(r:Pick<PromptIntent,'urgent'>):'interrupt'|'steer'=>r.urgent?'interrupt':'steer';

export const DELIVERY = {
  maxSends: 5,
  // Wait this long after a failed send before trusting a timeline miss: the daemon's own
  // run-start deadline is 60 s, and a send can land after its request failed.
  settleMs: 75_000,
  // Accepted sends are re-read at 1, 2, 4… s; this many misses on an idle agent mean
  // the daemon accepted something that never reached the timeline.
  acceptedMisses: 6,
  // After this, nothing is resent: an old prompt arriving late is worse than a visible failure.
  windowMs: 15 * 60_000,
  // While a send waits for its acknowledgement, the timeline is read this often.
  watchMs: 3000,
  // How long a reply waits for the earlier reply it names (prev) to reach the board. After
  // that it is failed as earlier-missing, never sent (sending it would put it ahead of the
  // earlier one, which may still arrive): the reply box puts its text back.
  prevWaitMs: 30_000,
};
const fail=(message:string,status:number)=>Object.assign(Error(message),{status});
const key=(agent:string,id:string)=>createHash('sha256').update(JSON.stringify([agent,id])).digest('hex');
const backoff=(n:number)=>Math.min(30_000,1000*2**Math.min(n,5));
// Re-read after an await that may have moved the receipt on.
const statusOf=(r:PromptReceipt):PromptReceipt['status']=>r.status;
export const wireIdsOf=(r:PromptReceipt)=>r.wireIds?.length?r.wireIds:[r.messageId];

// The board owns intent; the daemon owns deduplication per wire id; the agent timeline
// says what arrived. A prompt is resent only after its earlier wire ids are verified
// absent from an agent with no turn in flight, so a retry never duplicates a turn.
export class PromptOutbox {
  private readonly records=new Map<string,PromptReceipt>();
  private stopped=false;
  // Nothing is sent or judged before start(): the board calls it once frame bindings are
  // restored. A drain before that (a host health callback during startup) would find no
  // binding and fail every queued receipt as binding-revoked.
  private started=false;
  private readonly abort=new AbortController();
  private timer:ReturnType<typeof setInterval>|null=null;
  private readonly jobs=new Map<string,Promise<void>>();
  private readonly pools=new Map<string,BoundedWork>();
  private readonly awaiting=new Map<string,(result:'landed'|'stopped')=>void>();
  onChange:((receipt:PromptReceipt)=>void)|null=null;
  // Checked before each send: a reason to hold it (e.g. 'waiting-turn': the agent is busy
  // and its provider cannot take a message mid-turn without cancelling the turn), or null.
  // Held sends keep their place; later sends to that agent wait behind them.
  hold:((r:PromptReceipt,signal:AbortSignal)=>Promise<{wait:string|null;mode?:string;inputReply?:boolean}>)|null=null;
  // The agent's start is still pending (server/core.ts): "agent not found" then means
  // "not created yet", so the send waits (waiting-start) instead of failing as missing.
  startPending:((r:PromptIntent)=>boolean)|null=null;
  // Set by the board (server/core.ts): drains wait for start(). Unit rigs drain directly.
  requireStart=false;
  reconcile(){for(const r of this.records.values())this.onChange?.({...r});}
  constructor(
    private readonly dir:string,
    private readonly current:(r:PromptIntent)=>boolean,
    private readonly available:(r:PromptIntent)=>boolean,
    private readonly deliver:(r:PromptIntent,wireId:string)=>Promise<void>,
    private readonly log:(message:string)=>void,
    private readonly landing:(r:PromptReceipt,signal?:AbortSignal)=>Promise<Landing>=async()=>'unsupported',
    private readonly now:()=>number=Date.now,
  ) {
    mkdirSync(dir,{recursive:true,mode:0o700});
    for(const file of readdirSync(dir).filter(f=>/^[a-f0-9]{64}\.json$/.test(f))) {
      const r=JSON.parse(readFileSync(path.join(dir,file),'utf8')) as PromptReceipt;
      if(key(r.agentId,r.messageId)+'.json'!==file)throw Error('Invalid prompt receipt identity');
      // Daemon receipts make resending an interrupted request under its wire id safe.
      if(r.status==='sending'){r.status='queued';r.retryAt=0;}
      if(r.status==='unknown')r.retryAt=0;
      this.records.set(key(r.agentId,r.messageId),r);
    }
  }
  private save(r:PromptReceipt) {
    const file=path.join(this.dir,key(r.agentId,r.messageId)+'.json');
    const tmp=file+'.'+randomUUID()+'.tmp';
    writeFileSync(tmp,JSON.stringify(r),{mode:0o600});renameSync(tmp,file);
    this.onChange?.({...r});
  }
  submit(input:PromptIntent):PromptReceipt {
    if(this.stopped)throw fail('Prompt queue stopped; retry with the same messageId after recovery',503);
    if(!/^[A-Za-z0-9_-]{8,100}$/.test(input.messageId))throw fail('messageId needs 8–100 letters, digits, hyphens or underscores',400);
    if(input.prev!==undefined&&(!/^[A-Za-z0-9_-]{8,100}$/.test(input.prev)||input.prev===input.messageId))throw fail('prev must be another messageId',400);
    const max=input.kind==='delta'?64000:24000;
    if(!input.text.trim()||input.text.length>max)throw fail(`Prompt must contain 1–${max} characters`,400);
    const id=key(input.agentId,input.messageId),prior=this.records.get(id);
    if(prior){
      if(['text','host','boardId','frameId','kind','channelId'].some(k=>prior[k as keyof PromptIntent]!==input[k as keyof PromptIntent]))throw fail('messageId was already used for different content or binding',409);
      return {...prior};
    }
    if(this.records.size>=5000)throw fail('Prompt receipt ledger is full; preserve receipts before accepting more work',503);
    const r:PromptReceipt={...input,status:'queued',attempts:0,createdAt:this.now(),retryAt:0,wireIds:[input.messageId]};
    this.save(r);this.records.set(id,r);return {...r};
  }
  // Chat replies on this board that have not gone out yet (the reconnect banner counts them).
  pendingOn(boardId:string):number {
    let n=0;for(const r of this.records.values())if(r.boardId===boardId&&(r.kind??'prompt')==='prompt'&&(r.status==='queued'||r.status==='sending'))n++;return n;
  }
  // The person took a queued reply back (to correct it, or drop it) before it went out.
  // Only a send that never reached the wire can be withdrawn: once a send has been tried,
  // the daemon may hold it, so it is left to deliver (409). A withdrawn receipt ends as
  // failed/withdrawn; later replies that named it as prev no longer wait for it.
  withdraw(agentId:string,messageId:string):PromptReceipt {
    const r=this.records.get(key(agentId,messageId));if(!r)throw fail('Prompt receipt not found',404);
    if(r.status==='failed'&&r.reason==='withdrawn')return {...r};
    if(r.status!=='queued'||r.attempts>0||(r.kind??'prompt')!=='prompt')throw fail(r.status==='delivered'?'Already delivered to the agent':'Already on its way to the agent; it can no longer be taken back',409);
    r.status='failed';r.reason='withdrawn';r.retryAt=0;this.save(r);
    this.log(`prompt-delivery ${JSON.stringify({agent:r.agentId.slice(0,8),kind:'prompt',attempts:0,withdrawn:true})}`);
    return {...r};
  }
  get(agentId:string,messageId:string):PromptReceipt {
    const r=this.records.get(key(agentId,messageId));if(!r)throw fail('Prompt receipt not found',404);return {...r};
  }
  start(){if(this.timer||this.stopped)return;this.started=true;this.timer=setInterval(()=>void this.drain(),1000);this.timer.unref();void this.drain();}
  stop(){
    this.stopped=true;this.abort.abort();if(this.timer)clearInterval(this.timer);this.timer=null;
    for(const pool of this.pools.values())pool.stop();
    for(const done of [...this.awaiting.values()])done('stopped');
  }
  // Only board-owned canonical user_message pushes call this; projected text is not proof.
  noteLanded(agentId:string,wireId:string):void {
    if(this.stopped)return;
    for(const r of this.records.values())if(r.agentId===agentId&&r.attempts>0&&wireIdsOf(r).includes(wireId)){
      this.delivered(r);this.awaiting.get(key(r.agentId,r.messageId))?.('landed');
    }
  }
  drain(force=false):Promise<void> {
    if(this.stopped)return Promise.resolve();
    if(this.requireStart&&!this.started)return Promise.resolve();
    const groups=new Map<string,PromptReceipt[]>();
    for(const r of this.records.values())if(r.status==='queued'||((r.status==='accepted'||r.status==='unknown')&&!r.final)) {
      const id=JSON.stringify([r.host??'local',r.agentId]);const rows=groups.get(id)??[];rows.push(r);groups.set(id,rows);
    }
    for(const [id,rows] of groups){
      if(this.jobs.has(id))continue;
      rows.sort((a,b)=>a.createdAt-b.createdAt);
      const host=rows[0].host??'local';let pool=this.pools.get(host);
      if(!pool){pool=new BoundedWork(4,5000);this.pools.set(host,pool);}
      const job=pool.run(id,()=>this.drainHost(rows,force)).catch(error=>{
        if(!this.stopped)this.log(`prompt-queue ${JSON.stringify({host,reason:daemonFailureReason(error)})}`);
      }).finally(()=>{this.jobs.delete(id);});
      this.jobs.set(id,job);
    }
    // Admit newly queued agents even while an earlier drain still awaits a slow send.
    return Promise.all([...this.jobs.values()]).then(()=>{});
  }
  private async drainHost(rows:PromptReceipt[],force:boolean) {
    const blocked=new Set<string>();
    const channelOnly=new Set<string>();
    const block=(id:string,channel=false)=>{
      if(!blocked.has(id)&&channel)channelOnly.add(id);
      if(!channel)channelOnly.delete(id);
      blocked.add(id);
    };
    for(const r of rows){
      if(this.stopped)return;
      if(r.status==='delivered'||r.status==='failed'||r.status==='sending')continue;
      if(r.status==='accepted'||r.status==='unknown'){
        // Until an uncertain send is settled, later prompts to that agent wait (ordering).
        if(r.status==='unknown')block(r.agentId);
        if(r.retryAt<=this.now())await this.verify(r);
        if(statusOf(r)==='queued')block(r.agentId);
        continue;
      }
      if(!this.current(r)){
        r.status=r.attempts?'unknown':'failed';r.reason='binding-revoked';
        if(r.status==='unknown')r.retryAt=this.now();
        this.save(r);block(r.agentId);continue;
      }
      // Behind an earlier message to the same agent that has not gone yet: say so.
      // An urgent message (a stop stamp) goes ahead of earlier ones held for the turn to end.
      let decision:{wait:string|null;mode?:string;inputReply?:boolean}|undefined;
      if(blocked.has(r.agentId)&&!r.urgent){
        // An answer needed to finish the current turn must pass background messages
        // waiting for that turn. Never pass uncertain sends or earlier user replies.
        if(channelOnly.has(r.agentId)&&(r.kind??'prompt')==='prompt'&&this.hold){
          try{decision=await this.hold(r,this.abort.signal);}catch{ /* keep queued */ }
        }
        if(!decision?.inputReply){if(!r.attempts)this.waiting(r,'waiting-earlier');if(r.kind!=='channel')channelOnly.delete(r.agentId);continue;}
      }
      // Sent after another reply that has not arrived yet, or arrived but not gone out:
      // wait for it. Not blocking the agent, so that earlier reply can go first.
      if(r.prev&&!r.attempts){
        const prior=this.records.get(key(r.agentId,r.prev));
        if(!prior&&this.now()-r.createdAt>=DELIVERY.prevWaitMs){
          // Never overtake a predecessor that has not arrived: this one ends, unsent.
          r.status='failed';r.reason='earlier-missing';this.save(r);
          this.log(`prompt-delivery ${JSON.stringify({agent:r.agentId.slice(0,8),kind:r.kind??'prompt',attempts:0,failed:'earlier-missing'})}`);
          continue;
        }
        if(!prior||prior.status==='queued'||prior.status==='sending'||(prior.status==='unknown'&&!prior.final)){this.waiting(r,'waiting-earlier');continue;}
      }
      if(!this.available(r)){this.waiting(r,'waiting-host');block(r.agentId);continue;}
      if(!force&&r.retryAt>this.now()){block(r.agentId);continue;}
      // A lost acknowledgement often hides a prompt that arrived (and may have started the
      // very turn a hold would wait for): ask before holding or resending.
      if(r.attempts>0&&await this.landedNow(r)){if(this.stopped)return;this.delivered(r);continue;}
      if(this.stopped||statusOf(r)==='delivered')continue;
      if(this.hold){
        // A failed check is uncertainty, and uncertain means hold.
        try{decision??=await this.hold(r,this.abort.signal);}catch{decision={wait:r.host?'waiting-status':'waiting-host'};}
        if(this.stopped)return;
        if(decision.mode&&decision.mode!==r.mode){r.mode=decision.mode;if(!decision.wait)this.saveQuiet(r);}
        if(decision.wait){if(statusOf(r)!=='queued')continue;this.waiting(r,decision.wait);r.retryAt=this.now()+2000;block(r.agentId,r.kind==='channel'&&r.attempts===0&&(decision.wait==='waiting-turn'||decision.wait==='waiting-status'));continue;}
      }
      // Withdrawn while the hold check ran: never send it.
      if(statusOf(r)!=='queued')continue;
      // Membership/binding may have changed while admission awaited a host read.
      if(!this.current(r)){
        r.status=r.attempts?'unknown':'failed';r.reason='binding-revoked';
        if(r.attempts)r.retryAt=this.now();this.save(r);block(r.agentId);continue;
      }
      await this.send(r);
      // Preserve per-agent ordering while a send is retrying or uncertain.
      if(statusOf(r)!=='accepted'&&statusOf(r)!=='delivered')block(r.agentId);
    }
  }
  // A queued send that cannot go yet says why (shown in the reply box and frame), persisted
  // only when the reason changes.
  private waiting(r:PromptReceipt,reason:string){if(r.reason!==reason){r.reason=reason;this.save(r);}}
  private async send(r:PromptReceipt) {
    const wire=wireIdsOf(r).at(-1)!;
    if(this.stopped||statusOf(r)==='delivered'||statusOf(r)==='failed')return;
    if(!r.attempts)hostMetrics(this.log).record(r.host??'local','prompt-queue-wait',this.now()-r.createdAt);
    if(r.reason==='waiting-turn'||r.reason==='waiting-host'||r.reason==='waiting-earlier'||r.reason==='waiting-status'||r.reason==='waiting-start')delete r.reason;
    r.status='sending';r.attempts++;r.sentAt=this.now();this.save(r);
    const finish=hostOperation(this.log,r.host??'local','queued-prompt');
    try {
      const started=this.now();
      const sent=Promise.resolve().then(()=>this.deliver(r,wire)).then(()=>{
        if(!this.stopped){r.ackAt=this.now();if(r.status==='delivered')this.saveQuiet(r);hostMetrics(this.log).record(r.host??'local','prompt-ack',this.now()-started);}
      },error=>{if(!this.stopped)hostMetrics(this.log).record(r.host??'local','prompt-ack',this.now()-started,daemonFailureReason(error));throw error;});
      const outcome=await this.ackOrLanding(r,sent);if(this.stopped)return;
      finish();
      if(outcome==='landed'||statusOf(r)==='delivered')return this.delivered(r);
      r.status='accepted';r.ackAt=this.now();r.checks=0;r.retryAt=this.now();delete r.reason;
    }catch(error){
      if(this.stopped)return;finish(error);
      if(statusOf(r)==='delivered')return;
      const message=String((error as Error)?.message??error);
      r.reason=daemonFailureReason(error);
      // agent_request_key_conflict: the daemon already holds a different request under this
      // wire id (an earlier board version sent it with other options), so it may have landed.
      if(/agent_request_outcome_unknown|agent_request_key_conflict|unconfirmed|Trace already exists/i.test(message)||(transientDaemonError(error)&&r.attempts>=DELIVERY.maxSends)){
        // The daemon will never settle this wire id (its earlier send died midway), or
        // retries ran out: it may still have landed, so the timeline decides.
        r.status='unknown';if(/agent_request_outcome_unknown/.test(message))r.reason='outcome-unknown';r.retryAt=this.now()+backoff(r.attempts);
      }else if(r.reason==='missing'&&r.attempts<=1&&this.startPending?.(r)){
        // Not created on the host yet: nothing was delivered, so it waits for the start.
        r.status='queued';r.attempts=0;r.reason='waiting-start';r.retryAt=this.now()+backoff(0);
      }else if(transientDaemonError(error)){
        // Lost acknowledgement, timeout or reconnect: the daemon deduplicates a resend
        // under the same wire id, and joins one still in flight.
        r.status='queued';r.retryAt=this.now()+backoff(r.attempts-1);
      }else r.status='failed';
    }
    this.save(r);
    if(statusOf(r)==='accepted')await this.verify(r);
  }
  // Read the timeline for an accepted or uncertain receipt: delivered when it landed,
  // otherwise check again, resend under a fresh wire id once a miss is certain, or fail.
  private async verify(r:PromptReceipt) {
    let seen:Landing;
    try{seen=await this.readLanding(r);}
    catch(error){if(this.stopped||statusOf(r)==='delivered')return;r.retryAt=this.now()+backoff(r.checks??0);r.reason=`verify-${daemonFailureReason(error)}`;this.saveQuiet(r);return;}
    if(this.stopped||statusOf(r)==='delivered')return;
    if(seen==='unsupported'){
      // Remote hosts have no exact timeline: their acknowledgement is all the board can know.
      // It stays accepted (final), never shown as delivered.
      if(r.status==='accepted'){r.final=true;r.reason='host-ack';this.save(r);this.log(`prompt-delivery ${JSON.stringify({agent:r.agentId.slice(0,8),kind:r.kind??'prompt',attempts:r.attempts,acknowledged:'host-ack'})}`);}
      // Without a timeline the uncertain receipt stays for a person to resolve; never resent.
      else{r.final=true;this.save(r);}
      return;
    }
    if(seen.landed)return this.delivered(r);
    r.checks=(r.checks??0)+1;
    const age=this.now()-r.createdAt,sinceSend=this.now()-(r.sentAt??r.createdAt);
    const miss=r.status==='accepted'?!seen.running&&r.checks>=DELIVERY.acceptedMisses:!seen.running&&sinceSend>=DELIVERY.settleMs;
    if(!miss){r.retryAt=this.now()+(r.status==='accepted'?backoff(r.checks-1):Math.min(backoff(r.checks),Math.max(1000,DELIVERY.settleMs-sinceSend)));this.saveQuiet(r);return;}
    if(r.status==='accepted'&&age>DELIVERY.windowMs){
      // An old daemon-accepted receipt (from before timeline checks, or a very long
      // conversation) is not proof of loss: it stays accepted, unverified, never resent.
      r.final=true;r.reason='unverified';this.save(r);return;
    }
    if(r.attempts>=DELIVERY.maxSends||age>DELIVERY.windowMs){
      r.status='failed';r.reason=r.attempts>=DELIVERY.maxSends?'retries-exhausted':'expired';this.save(r);
      this.log(`prompt-delivery ${JSON.stringify({agent:r.agentId.slice(0,8),kind:r.kind??'prompt',attempts:r.attempts,failed:r.reason})}`);
      return;
    }
    if(!this.current(r)){r.status='failed';r.reason='binding-revoked';this.save(r);return;}
    // Verified absent with nothing in flight: resend under a fresh wire id.
    r.wireIds=[...wireIdsOf(r),`${r.messageId}-r${r.attempts}`];
    r.status='queued';r.retryAt=0;r.reason='resend-after-miss';this.save(r);
  }
  private delivered(r:PromptReceipt,reason?:string) {
    if(r.status==='delivered')return;
    r.status='delivered';r.deliveredAt=this.now();if(reason)r.reason=reason;else delete r.reason;r.retryAt=0;this.save(r);
    hostMetrics(this.log).record(r.host??'local','prompt-delivery-total',this.now()-r.createdAt);
    if(r.ackAt!==undefined&&r.ackAt<=this.now())hostMetrics(this.log).record(r.host??'local','prompt-post-ack',this.now()-r.ackAt);
    this.log(`prompt-delivery ${JSON.stringify({agent:r.agentId.slice(0,8),kind:r.kind??'prompt',attempts:r.attempts,ms:this.now()-r.createdAt})}`);
  }
  private readLanding(r:PromptReceipt):Promise<Landing> {
    const signal=this.abort.signal;
    if(signal.aborted)return Promise.reject(Error('Prompt queue stopped'));
    return new Promise((resolve,reject)=>{
      const stop=()=>reject(Error('Prompt queue stopped'));
      signal.addEventListener('abort',stop,{once:true});
      Promise.resolve().then(()=>{if(signal.aborted)throw Error('Prompt queue stopped');return this.landing(r,signal);}).then(resolve,reject).finally(()=>signal.removeEventListener('abort',stop));
    });
  }
  private async landedNow(r:PromptReceipt):Promise<boolean> {
    try{const seen=await this.readLanding(r);return seen!=='unsupported'&&seen.landed;}catch{return false;}
  }
  // The daemon's answer, or the timeline showing the prompt first, whichever comes first:
  // a busy daemon can deliver a prompt and still time out its acknowledgement (60 s).
  private ackOrLanding(r:PromptReceipt,sent:Promise<void>):Promise<'ack'|'landed'|'stopped'> {
    sent.catch(()=>{});
    if(r.status==='delivered')return Promise.resolve('landed');
    return new Promise((resolve,reject)=>{
      let done=false,checking=false;const id=key(r.agentId,r.messageId);
      const end=()=>{done=true;clearInterval(timer);this.awaiting.delete(id);};
      const timer=setInterval(()=>{
        if(done||checking||this.stopped)return;checking=true;
        void this.landedNow(r).then(landed=>{checking=false;if(landed&&!done){end();resolve('landed');}});
      },DELIVERY.watchMs);
      this.awaiting.set(id,result=>{if(!done){end();resolve(result);}});
      sent.then(()=>{if(!done){end();resolve('ack');}},error=>{if(!done){end();reject(error);}});
    });
  }
  // A recheck that changes nothing a reader shows is persisted without an onChange.
  private saveQuiet(r:PromptReceipt){const listener=this.onChange;this.onChange=null;try{this.save(r);}finally{this.onChange=listener;}}
}

// The daemon-side reads behind Landing: user_message rows carry the clientMessageId the
// prompt was sent with. Pages back to just before the receipt was created.
type TimelineEntry={timestamp?:string;item:{type:string;clientMessageId?:string;messageId?:string}};
type TimelinePage={entries:TimelineEntry[];hasOlder:boolean;startCursor:{epoch:string;seq:number}|null;error:string|null};
export interface LandingReader {
  aux:{isConnected:boolean;fetchAgentTimeline(agentId:string,options:object):Promise<unknown>;fetchAgent(agentId:string):Promise<{agent:{status?:string;activeTurn?:unknown}}|null>}|null;
}
export async function promptLanding(bridge:LandingReader,r:PromptReceipt,read=withDaemonRead,signal?:AbortSignal):Promise<Landing>{
  if(signal?.aborted)throw Error('Prompt queue stopped');
  const aux=bridge.aux;if(!aux?.isConnected)throw Error('Paseo disconnected');
  const ids=new Set(wireIdsOf(r));
  let cursor:TimelinePage['startCursor']=null;
  for(let page=0;page<10;page++){
    if(signal?.aborted)throw Error('Prompt queue stopped');
    const tl=await read(()=>aux.fetchAgentTimeline(r.agentId,{direction:cursor?'before':'tail',...(cursor?{cursor}:{}),limit:100,projection:'canonical'}) as Promise<TimelinePage>);
    if(signal?.aborted)throw Error('Prompt queue stopped');
    if(tl.error)throw Error(tl.error);
    if(tl.entries.some(e=>e.item.type==='user_message'&&(ids.has(e.item.clientMessageId??'')||ids.has(e.item.messageId??''))))return {landed:true,running:false};
    const oldest=Date.parse(tl.entries[0]?.timestamp??'');
    if(!tl.hasOlder||!tl.startCursor||oldest<r.createdAt-60_000)break;
    cursor=tl.startCursor;
  }
  if(signal?.aborted)throw Error('Prompt queue stopped');
  const agent=(await read(()=>aux.fetchAgent(r.agentId)))?.agent;
  return {landed:false,running:agentBusy(agent)};
}
