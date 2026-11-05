import { BoundedWork } from "./bounded-work";
import {threadNotLoaded,daemonFailureReason} from "./daemon-health";
import { withDaemonRead } from "./daemon-health";
import { hostOperation } from "./daemon-health";
import {timelineRows} from "./timeline-pages";
// One live view per agent, shared by every browser tab and every card that shows it.
//
// For each agent somebody is watching, the hub holds exactly one Paseo timeline
// subscription. Timeline events only mark the view dirty; a debounced tail refetch
// rebuilds the rows, and a changed snapshot is pushed to every listener. Status comes
// from the agent lifecycle hooks (pushed in by core.ts) with a periodic refresh as a
// safety net. The same cache answers board_read, so an agent reading a frame that
// holds a sibling's card sees that sibling's latest messages.

import type { TranscriptRow, TranscriptSnapshot, TranscriptStatus, TranscriptUsage } from "../shared/components/transcript";
import { type AgentStatus, type PaseoBridge, statusOf } from "./paseo-bridge";
import type { RemoteAgents } from "./remote";

type Listener = (snap: TranscriptSnapshot) => void;

interface Entry {
  agentId: string;
  epoch:string|null;seq:number;
  retryTimer:ReturnType<typeof setTimeout>|null;
  snap: TranscriptSnapshot | null;
  sig: string;
  listeners: Set<Listener>;
  unsub: (() => void | Promise<void>) | null;
  subscribing: boolean;
  subscriptionReady: boolean;
  releaseTimer: ReturnType<typeof setTimeout> | null;
  timer: ReturnType<typeof setTimeout> | null;
  fetching: Promise<void> | null;
  dirty: boolean;
  lastFetch: number;
  lastRefresh: number;
  lastUsed: number;
  warmUntil: number;
  events: number;
  statusVersion: number;
  subscribes: number;
  fetches: number;
  broadcasts: number;
}

const ROWS = 60;
const DEBOUNCE_MS = 350;
const REFRESH_MS = 120_000;
const NOT_LOADED="Not loaded. Resume this conversation in Paseo, then retry.";
const POLL_MS = 20_000;
const IDLE_SUBSCRIBED_POLL_MS = 120_000;
const IDLE_GC_MS = 60_000;

export class TranscriptHub {
  private readonly entries = new Map<string, Entry>();
  private readonly sweep: ReturnType<typeof setInterval>;
  private stopped = false;
  private readonly readPool=new BoundedWork(8,512);
  private readonly reads=new Map<string,Promise<unknown>>();
  subscribeCalls = 0;
  unsubscribeCalls = 0;
  // Agents on other machines: rows come from af-network read polls, not a subscription.
  remote: RemoteAgents | null = null;
  // Called when an agent gets its first watcher (the subagent tracker checks it).
  onWatch: ((agentId: string) => void) | null = null;
  onUnwatch: ((agentId:string)=>void)|null=null;
  onTimeline: ((agentId:string,item:{type?:string;clientMessageId?:string;messageId?:string})=>void)|null=null;
  // Called when a published status changes (polls catch turns whose events were missed).
  onStatus: ((agentId: string, status: TranscriptStatus) => void) | null = null;
  // Running provider subagents per agent, attached to every snapshot published.
  private readonly subagents = new Map<string, number>();

  constructor(
    private readonly bridge: PaseoBridge,
    private readonly log: (m: string) => void,
  ) {
    this.sweep = setInterval(() => this.tick(), 5000);
    (this.sweep as unknown as { unref?: () => void }).unref?.();
  }

  private entry(agentId: string): Entry {
    let e = this.entries.get(agentId);
    if (!e) {
      if(this.entries.size>=256){
        const oldest=[...this.entries.values()].filter(x=>!x.listeners.size&&!x.fetching).sort((a,b)=>a.lastUsed-b.lastUsed)[0];
        if(oldest){if(oldest.timer)clearTimeout(oldest.timer);if(oldest.releaseTimer)clearTimeout(oldest.releaseTimer);this.release(oldest);this.entries.delete(oldest.agentId);}
      }
      e = { agentId, epoch:null,seq:-1,retryTimer:null,snap: null, sig: "", listeners: new Set(), unsub: null, subscribing: false, subscriptionReady: false, releaseTimer: null, timer: null, fetching: null, dirty: false, lastFetch: 0, lastRefresh: 0, lastUsed: Date.now(), warmUntil: 0, events: 0, statusVersion: 0, subscribes: 0, fetches: 0, broadcasts: 0 };
      this.entries.set(agentId, e);
    }
    return e;
  }

  // Start receiving snapshots for one agent. Returns the disposer.
  watch(agentId: string, fn: Listener): () => void {
    const e = this.entry(agentId);
    const first=!e.listeners.size;e.listeners.add(fn);
    if(first)this.onWatch?.(agentId);
    e.lastUsed = Date.now();
    if (e.releaseTimer) {
      clearTimeout(e.releaseTimer);
      e.releaseTimer = null;
    }
    if (!e.unsub) void this.subscribe(e);
    if (e.snap) fn(e.snap);
    if (!e.snap || !e.subscriptionReady && Date.now() - e.lastFetch > POLL_MS) this.schedule(e, 0);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      e.listeners.delete(fn);
      e.lastUsed = Date.now();
      // A page re-opens its stream when its set of cards changes; keep the Paseo
      // subscription for a few seconds so that does not churn it.
      if(e.listeners.size===0)this.onUnwatch?.(agentId);
      if(this.stopped)return;
      if (e.listeners.size === 0 && !e.releaseTimer)
        e.releaseTimer = setTimeout(() => {
          e.releaseTimer = null;
          if (e.listeners.size === 0) this.release(e);
        }, e.warmUntil>Date.now()?120000:5000);
    };
  }

  summary(agentId: string): TranscriptSnapshot | null {
    const e = this.entries.get(agentId);
    if (e) e.lastUsed = Date.now();
    return e?.snap ?? null;
  }

  // Hover warms for30s; a click or reply keeps the snapshot for10min. Reads
  // coalesce with the stream and cache delivery never waits for this refresh.
  prefetch(agentId:string,recent=false,retry=false):void {
    const e=this.entry(agentId);e.lastUsed=Date.now();
    if(retry)this.wake(e);
    e.warmUntil=Math.max(e.warmUntil,Date.now()+(recent?600000:30000));
    this.bridge.ensureConnected?.(recent);
    this.remote?.prefetch(agentId,recent,retry);
    this.readPool.prioritize(`${agentId}:metadata`);this.readPool.prioritize(`${agentId}:tail`);
    if(!e.snap || !e.subscriptionReady && Date.now()-e.lastFetch>2000 || retry)this.schedule(e,0);
  }
  private readOnce<T>(key:string,read:()=>Promise<T>):Promise<T> {
    const prior=this.reads.get(key);if(prior)return prior as Promise<T>;
    const work=this.readPool.run(key,read);this.reads.set(key,work);
    void work.finally(()=>{if(this.reads.get(key)===work)this.reads.delete(key);}).catch(()=>{});
    return work;
  }

  // Make sure the cache is fresh enough for an outline (board_read).
  // Bounded: board_read must not hang on a slow daemon; it falls back to the cache.
  async prime(agentIds: string[], maxAgeMs = 3000, timeoutMs = 1500): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([limit, this.primeAll(agentIds, maxAgeMs)]);
    clearTimeout(timer);
  }

  private async primeAll(agentIds: string[], maxAgeMs: number): Promise<void> {
    await Promise.all(
      [...new Set(agentIds)].map(async (id) => {
        const e = this.entry(id);
        e.lastUsed = Date.now();
        if(e.snap?.availability==='not-loaded')return;
        if (e.snap && (Date.now() - e.lastFetch < maxAgeMs || e.subscriptionReady && !e.snap.error) && !e.dirty) return;
        await this.fetch(e).catch(() => undefined);
      }),
    );
  }

  // A remote agent's poll came back (RemoteAgents, every 20 s while somebody watches).
  pushRemote(agentId: string, snap: TranscriptSnapshot): void {
    const e = this.entries.get(agentId);
    if (!e) return;
    e.lastFetch = Date.now();
    this.publish(e, snap);
  }

  // Lifecycle hooks (turn started/ended, permissions, archive) for any agent.
  setStatus(agentId: string, status: AgentStatus): void {
    const e = this.entries.get(agentId);
    if (!e?.snap) return;
    // A lifecycle hook is newer than any metadata read already in flight.
    e.statusVersion++;
    const resumed=e.snap.availability==='not-loaded'&&status==='running';
    if(resumed)this.wake(e);
    if(e.snap?.status===status&&!resumed)return;
    this.publish(e,{...e.snap!,status:status as TranscriptStatus,updatedAt:Date.now()});
    if(e.listeners.size)this.schedule(e,150);
  }

  isWatched(agentId: string): boolean {
    return (this.entries.get(agentId)?.listeners.size ?? 0) > 0;
  }

  setSubagents(agentId: string, running: number): void {
    if (running) this.subagents.set(agentId, running);
    else this.subagents.delete(agentId);
    const e = this.entries.get(agentId);
    if (e?.snap) this.publish(e, { ...e.snap, updatedAt: Date.now() });
  }

  // A cancel or prompt from the board: refetch soon, and refresh status.
  poke(agentId: string): void {
    const e = this.entries.get(agentId);
    if (!e) return;
    this.wake(e);e.lastRefresh = 0;
    this.schedule(e, 200);
  }

  connectionChanged(): void {
    for(const e of this.entries.values()) {
      if(this.remote?.isRemote(e.agentId))continue;
      const health=this.bridge.health();
      if(health.state!=='connected')this.release(e);
      this.publish(e,e.snap??{agentId:e.agentId,title:null,status:'idle',rows:[],updatedAt:Date.now()});
      if(health.state==='connected' && e.listeners.size){void this.subscribe(e);this.schedule(e,0);}
    }
  }

  stats() {
    return {
      entries: this.entries.size,
      paseoSubscriptions: [...this.entries.values()].filter((e) => e.unsub).length,
      subscribeCalls: this.subscribeCalls,
      unsubscribeCalls: this.unsubscribeCalls,
      agents: [...this.entries.values()].map((e) => ({
        agentId: e.agentId,
        listeners: e.listeners.size,
        subscribed: !!e.unsub,
        events: e.events,
        subscribes: e.subscribes,
        fetches: e.fetches,
        broadcasts: e.broadcasts,
        rows: e.snap?.rows.length ?? 0,
        status: e.snap?.status ?? null,
        warmUntil:e.warmUntil,
      })),
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.readPool.stop();
    clearInterval(this.sweep);
    const releases:Promise<void>[]=[];
    for (const e of this.entries.values()) {
      if(e.retryTimer)clearTimeout(e.retryTimer);
      if (e.timer) clearTimeout(e.timer);
      if (e.releaseTimer) clearTimeout(e.releaseTimer);
      e.timer = null;
      e.releaseTimer = null;
      releases.push(this.release(e));
    }
    await Promise.all(releases);
  }

  // --- internals -------------------------------------------------------------------

  private async subscribe(e: Entry): Promise<void> {
    if (e.unsub || e.subscribing || this.stopped || e.snap?.availability==='not-loaded') return;
    if (this.remote?.isRemote(e.agentId)) return;
    e.subscribing = true;
    const api = await Promise.resolve(this.bridge.readApi??this.bridge.ready).finally(() => {
      e.subscribing = false;
    });
    if (e.unsub || this.stopped || e.listeners.size === 0) return;
    // `mine` is this subscription's disposer. Failure paths only clear e.unsub while it
    // still points at `mine`, so a late failure cannot drop (and leak) a newer one.
    let mine: (() => void | Promise<void>) | null = null;
    const lost = (why: string) => {
      if (!mine || e.unsub !== mine || this.stopped) return;
      if(!threadNotLoaded(why))this.log(`transcript subscription ${e.agentId} lost: ${daemonFailureReason(Error(why))}`);
      e.unsub = null;
      e.subscriptionReady = false;
      this.unsubscribeCalls++;
      if(threadNotLoaded(why)){this.notLoaded(e);return;}
      // The SDK has already released it; resubscribe while somebody is watching.
      e.retryTimer=setTimeout(() => {
        e.retryTimer=null;
        if (e.listeners.size && !e.unsub) void this.subscribe(e);
      }, 2000);
    };
    try {
      const sub = api.agents.ref(e.agentId).timeline.subscribe((ev) => {
        e.events++;
        // biome-ignore lint/suspicious/noExplicitAny: event union.
        const t = (ev as any).event?.type;
        if (t === "error") {
          e.lastRefresh = 0;
          // biome-ignore lint/suspicious/noExplicitAny: event union.
          lost(String((ev as any).event?.error ?? "error event"));
        }
        if(!this.applyEvent(e,ev))this.schedule(e, DEBOUNCE_MS);
      });
      this.subscribeCalls++;
      e.subscribes++;
      mine = () => {
        this.unsubscribeCalls++;
        const owned=sub as typeof sub & {release?:()=>Promise<void>};
        return owned.release?owned.release():Promise.resolve(sub());
      };
      e.unsub = mine;
      e.subscriptionReady = false;
      // biome-ignore lint/suspicious/noExplicitAny: ready is on the returned function.
      Promise.resolve((sub as any).ready).then(() => {
        if (e.unsub === mine && !this.stopped) e.subscriptionReady = true;
      }, (err: Error) => lost(`subscribe failed: ${err.message}`));
    } catch (err) {
      if(threadNotLoaded(err))this.notLoaded(e);
      else if(!this.stopped)this.log(`transcript subscribe ${e.agentId} threw: ${daemonFailureReason(err)}`);
    }
  }

  private release(e: Entry): Promise<void> {
    e.subscriptionReady=false;
    const mine=e.unsub;e.unsub=null;
    if(!mine)return Promise.resolve();
    try{return Promise.resolve(mine()).catch(error=>{if(!this.stopped)this.log(`transcript release failed: ${daemonFailureReason(error)}`);});}
    catch{return Promise.resolve();}
  }

  private notLoaded(e:Entry):void {
    if(this.stopped)return;
    if(e.timer)clearTimeout(e.timer);e.timer=null;e.dirty=false;
    this.publish(e,{...(e.snap??{agentId:e.agentId,title:null,status:'idle',rows:[]}),availability:'not-loaded',error:NOT_LOADED,updatedAt:Date.now()});
  }
  private wake(e:Entry):void {
    if(e.snap?.availability==='not-loaded')this.publish(e,{...e.snap,availability:undefined,error:undefined,updatedAt:Date.now()});
    if(e.listeners.size&&!e.unsub)void this.subscribe(e);
  }
  // The SDK includes canonical epoch/sequence with timeline pushes. Rebuild only
  // the changed bounded/redacted row; a gap/replacement still triggers a tail.
  private applyEvent(e:Entry,message:unknown):boolean {
    const m=message as {epoch?:string;seq?:number;timestamp?:string;event?:{type?:string;item?:unknown;turnId?:string}};
    if(this.stopped)return true;
    if(m.event?.type==='thread_started'){this.wake(e);return false;}
    if(e.snap){
      if(m.event?.type==='turn_started'){this.setStatus(e.agentId,'running');return true;}
      if(m.event?.type==='turn_completed'){this.setStatus(e.agentId,'idle');return true;}
      if(m.event?.type==='permission_requested'){this.setStatus(e.agentId,'needs-permission');return true;}
      if(m.event?.type==='attention_required')return true;
    }
    if(m.event?.type!=='timeline')return false;
    if(m.event.item&&typeof m.event.item==='object')this.onTimeline?.(e.agentId,m.event.item);
    if(!e.snap||!e.epoch||m.epoch!==e.epoch||!Number.isSafeInteger(m.seq))return false;
    if(m.seq! <= e.seq)return true;
    if(m.seq!==e.seq+1)return false;
    const row=timelineRows({epoch:e.epoch,entries:[{seqStart:m.seq,seqEnd:m.seq,timestamp:m.timestamp??new Date().toISOString(),item:m.event.item,turnId:m.event.turnId}]} as Parameters<typeof timelineRows>[0],e.agentId)[0];
    e.seq=m.seq!;e.lastFetch=Date.now();
    if(!row)return true;
    const rows=[...e.snap.rows];const key=row.item?.key;
    const at=key?rows.findIndex(r=>r.item?.key===key):-1;
    if(at>=0)rows[at]={...row,id:rows[at].id};else rows.push(row);
    this.publish(e,{...e.snap,rows:rows.slice(-ROWS),error:undefined,availability:undefined,updatedAt:Date.now()});
    return true;
  }

  private schedule(e: Entry, delay: number): void {
    if (this.stopped || e.snap?.availability==='not-loaded') return;
    if (e.fetching) {
      e.dirty = true;
      return;
    }
    if (e.timer) return;
    e.timer = setTimeout(() => {
      e.timer = null;
      void this.fetch(e).catch(() => undefined);
    }, delay);
  }

  private fetch(e: Entry): Promise<void> {
    if(this.stopped||e.snap?.availability==='not-loaded')return Promise.resolve();
    if (e.fetching) {
      return e.fetching;
    }
    e.dirty = false;
    if (this.remote?.isRemote(e.agentId)) {
      // Serve the last poll; start one if it is older than the poll interval.
      const r = this.remote;
      e.fetching = (async () => {
        const host = r.isRemote(e.agentId)!;
        const snap = r.snapshot(e.agentId);
        if (!snap) void r.read(e.agentId);
        e.lastFetch = Date.now();
        this.publish(e, snap ?? { agentId: e.agentId, title: null, status: "idle", rows: [], updatedAt: Date.now(), remote: { host, polledAt: null } });
      })().finally(() => {
        e.fetching = null;
      });
      return e.fetching;
    }
    e.fetching = (async () => {
      const api = await withDaemonRead(()=>Promise.resolve(this.bridge.readApi??this.bridge.ready));
      const ref = api.agents.ref(e.agentId);
      e.fetches++;
      const generation=e.fetches,statusAtStart=e.statusVersion;
      let renderedSeq=e.seq;
      const valid=()=>!this.stopped&&this.entries.get(e.agentId)===e&&e.fetches===generation;
      let snap:TranscriptSnapshot=e.snap??{agentId:e.agentId,title:null,status:'idle',rows:[],updatedAt:Date.now()};
      let metadataError:string|undefined,tailError:string|undefined;
      const publish=()=>{if(valid())this.publish(e,{...snap,...(e.seq>renderedSeq&&e.snap?{rows:e.snap.rows}:{}),...(e.statusVersion>statusAtStart&&e.snap?{status:e.snap.status}:{}),...(e.snap?.availability==='not-loaded'?{availability:'not-loaded' as const,error:NOT_LOADED}:{error:tailError??metadataError}),updatedAt:Date.now()});};
      const every=snap.status==='running'||snap.status==='needs-permission'?15000:REFRESH_MS;
      const metadata=(!e.snap||Date.now()-e.lastRefresh>every)?(async()=>{
        const finish=hostOperation(this.log,'local','transcript-metadata');
        try {
          const read=this.readOnce(`${e.agentId}:metadata`,()=>ref.refresh()).then(result=>{
            if(!valid())return;
            metadataError=result?undefined:`agent ${e.agentId} not found`;
            snap={...snap,status:statusOf(result?.agent),title:result?.agent.title??snap.title};
            if(result?.agent)snap={...snap,...usageOf(result.agent)};
            e.lastRefresh=Date.now();publish();
          });
          await withDaemonRead(()=>read);if(!this.stopped)finish();
        }catch(error){metadataError=(error as Error).message;if(!this.stopped)finish(error);}
        e.lastRefresh=Date.now();if(!this.stopped)publish();
      })():Promise.resolve();
      const tail=(async()=>{
        const finish=hostOperation(this.log,'local','transcript-tail');
        try{
          const read=this.readOnce(`${e.agentId}:tail`,()=>ref.timeline.refetch({direction:'tail',limit:ROWS,projection:'projected'})).then(page=>{
            if(!valid())return;
            if(page.error)throw Error(page.error);
            if(typeof page.epoch==='string'){const seq=page.endCursor?.seq??page.entries.at(-1)?.seqEnd??-1;if(page.epoch===e.epoch&&seq<e.seq)return;e.epoch=page.epoch;e.seq=seq;}
            renderedSeq=e.seq;tailError=undefined;snap={...snap,rows:timelineRows(page,e.agentId)};
            const current=ref.current?.();if(current)snap={...snap,...usageOf(current)};
            e.lastFetch=Date.now();publish();
          });
          await withDaemonRead(()=>read);if(!this.stopped)finish();
        }catch(error){tailError=(error as Error).message;if(threadNotLoaded(error))this.notLoaded(e);if(!this.stopped)finish(error);}
        e.lastFetch=Date.now();if(!this.stopped)publish();
      })();
      await Promise.all([metadata,tail]);
      if(!e.unsub&&e.listeners.size)void this.subscribe(e);
    })().catch(error=>{
      if(!this.stopped)this.publish(e,{...(e.snap??{agentId:e.agentId,title:null,status:'idle',rows:[]}),updatedAt:Date.now(),error:(error as Error).message});
    }).finally(() => {
      e.fetching = null;
      if (e.dirty) this.schedule(e, e.snap?.error?2000:DEBOUNCE_MS);
    });
    return e.fetching;
  }

  private publish(e: Entry, input: TranscriptSnapshot): void {
    const running = this.subagents.get(e.agentId);
    const { subagents: _drop, ...rest } = input;
    const health = !input.remote ? this.bridge.health?.() : null;
    const connection:TranscriptSnapshot['connection'] = input.remote
      ? input.connection ?? {host:input.remote.host,state:input.error?'failed':input.remote.polledAt?'connected':'connecting',...(input.error?{reason:'remote-read-failed'}:{})}
      : health ? {host:health.host??'local',state:health.state==='connected'?'connected':health.state==='failed'?'failed':health.state==='connecting'?'connecting':'reconnecting',...(health.reason?{reason:health.reason}:{})} : input.connection;
    const snap: TranscriptSnapshot = {...rest,...(running?{subagents:running}:{}),...(connection?{connection}:{})};
    // Rows carry their items, so a tool call going running -> completed publishes.
    const sig = JSON.stringify([snap.connection ?? null,snap.remote ?? null,snap.title, snap.status, snap.error ?? "", snap.subagents ?? 0, snap.rows, snap.usage ?? null, snap.activeTurn ?? null]);
    const statusChanged = e.snap?.status !== snap.status;
    e.snap = snap;
    if (statusChanged) this.onStatus?.(e.agentId, snap.status);
    if (sig === e.sig) return;
    e.sig = sig;
    e.broadcasts++;
    for (const fn of e.listeners) {
      try {
        fn(snap);
      } catch (err) {
        this.log(`transcript listener failed: ${(err as Error).message}`);
      }
    }
  }

  private tick(): void {
    const now = Date.now();
    for (const e of this.entries.values()) {
      if(e.snap?.availability==='not-loaded'&&e.listeners.size)continue;
      if (e.listeners.size) {
        // Timeline subscriptions and lifecycle hooks refresh changed cards directly.
        // Keep a safety poll, but avoid two daemon reads every20s for idle cards.
        const subscribed=e.unsub&&e.subscriptionReady&&!e.snap?.error;
        const period=e.snap?.status==='archived'||e.snap?.status==='missing'?600000:subscribed?(e.snap?.status==='idle'?IDLE_SUBSCRIBED_POLL_MS:60000):POLL_MS;
        if (now - e.lastFetch > period) this.schedule(e, 0);
      } else if (now - e.lastUsed > IDLE_GC_MS && now>e.warmUntil && !e.fetching) {
        if (e.timer) clearTimeout(e.timer);
        if (e.releaseTimer) clearTimeout(e.releaseTimer);
        this.release(e);
        this.entries.delete(e.agentId);
      }
    }
  }
}

// Snapshot usage (agent lastUsage) and running turn (agent activeTurn).
// biome-ignore lint/suspicious/noExplicitAny: agent snapshot payload from the SDK.
export function usageOf(agent: any): { usage: TranscriptUsage | undefined; activeTurn: TranscriptSnapshot["activeTurn"] } {
  const u = agent?.lastUsage;
  let usage: TranscriptUsage | undefined;
  if (u && typeof u === "object") {
    usage = {};
    for (const k of ["inputTokens", "cachedInputTokens", "outputTokens", "totalCostUsd", "contextWindowMaxTokens", "contextWindowUsedTokens"] as const)
      if (typeof u[k] === "number" && Number.isFinite(u[k])) usage[k] = u[k];
  }
  const t = agent?.activeTurn;
  // Paseo's startedAt may be null; the contract wants a value, so null becomes "".
  const activeTurn = t && typeof t.turnId === "string" ? { turnId: t.turnId, startedAt: typeof t.startedAt === "string" || typeof t.startedAt === "number" ? t.startedAt : "" } : null;
  return { usage, activeTurn };
}
