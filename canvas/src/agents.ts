// Live agent views for the whole page: one refcounted entry per agent id, shared by
// every transcript card and the sidebar, fed by ONE EventSource for the set of agents
// on screen (/api/ui/events?agents=a,b,c). Browsers cap HTTP/1.1 at ~6 connections per
// origin, so a stream per card would hang the page at six cards.

import { perfCount } from "./perf";
import { checkingRemoteSnapshot, staleRemoteStatus } from "../../shared/remote-status";
import { startingView } from "../../shared/start-pending";
import { useEffect, useState, useSyncExternalStore } from "react";
import { type Computed, computed, type Editor, isUninitialized } from "tldraw";
import type { TranscriptSnapshot } from "../../shared/components/transcript";

export type AgentView = TranscriptSnapshot & { paseoUrl?: string | null; denied?: boolean };

type Notify = () => void;

class AgentStore {
  private readonly recent=new Map<string,number>();
  private readonly warm=new Map<string,{timer:ReturnType<typeof setTimeout>;fetched:number;pending:boolean;recentSent:boolean}>();
  private persistTimer:ReturnType<typeof setTimeout>|null=null;
  constructor(){
    if(typeof document!=='undefined')document.addEventListener('visibilitychange',()=>this.schedule(0));
    try{
      const saved=JSON.parse(sessionStorage.getItem('board-transcript-cache')??'[]') as Array<{at:number;view:AgentView}>;
      for(const {at,view} of saved.slice(0,24))if(Date.now()-at<600000 && typeof view?.agentId==='string' && Array.isArray(view.rows)){
        this.views.set(view.agentId,{...checkingRemoteSnapshot(view),connection:{host:view.connection?.host??view.remote?.host??'board',state:'connecting'}});
        this.recent.set(view.agentId,at);this.released.set(view.agentId,at);
      }
    }catch{}
  }
  prefetch(agentId:string,recent=false,retry=false):void {
    if(!agentId)return;
    if(recent)this.recent.set(agentId,Date.now());
    let warm=this.warm.get(agentId);
    if(!warm){
      if(this.warm.size>=64){const oldest=this.warm.entries().next().value;if(oldest){clearTimeout(oldest[1].timer);this.warm.delete(oldest[0]);}}
      warm={timer:setTimeout(()=>{},0),fetched:0,pending:false,recentSent:false};
      this.warm.set(agentId,warm);
    }
    clearTimeout(warm.timer);
    warm.timer=setTimeout(()=>{this.warm.delete(agentId);},recent?120000:30000);
    this.schedule(0);
    if(!retry&&(warm.pending || Date.now()-warm.fetched<2000)&&(!recent||warm.recentSent))return;
    if(recent)warm.recentSent=true;
    warm.pending=true;warm.fetched=Date.now();
    void fetch(`/api/ui/agents/${encodeURIComponent(agentId)}/snapshot?recent=${recent?'1':'0'}${retry?'&retry=1':''}`,{signal:AbortSignal.timeout(8000)})
      .then(async response=>{
        if(!response.ok)return;const {snap}=await response.json() as {snap:AgentView|null};
        if(snap && snap.agentId===agentId && (this.views.get(agentId)?.updatedAt??0)<=snap.updatedAt){this.views.set(agentId,snap);this.notify(agentId);this.persist();}
      }).catch(()=>{}).finally(()=>{warm!.pending=false;});
  }
  private persist():void {
    if(this.persistTimer)return;
    this.persistTimer=setTimeout(()=>{
      this.persistTimer=null;let bytes=0;const saved=[];
      for(const [id,at] of [...this.recent].sort((a,b)=>b[1]-a[1]).slice(0,24)){
        const view=this.views.get(id);if(!view||Date.now()-at>600000)continue;
        const entry={at,view};const size=JSON.stringify(entry).length;if(size>200000||bytes+size>2000000)continue;
        bytes+=size;saved.push(entry);
      }
      try{sessionStorage.setItem('board-transcript-cache',JSON.stringify(saved));}catch{}
    },1000);
  }
  private readonly refs = new Map<string, number>();
  private readonly views = new Map<string, AgentView>();
  private readonly listeners = new Map<string, Set<Notify>>();
  private es: EventSource | null = null;
  private openKey = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  // One pending retry for denied ids; a snapshot for an id clears its count.
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly deniedCount = new Map<string, number>();
  // Proof counters (window.__agentStore.stats).
  readonly stats = { opens: 0, closes: 0, messages: 0, errors: 0, perAgent: {} as Record<string, number> };

  retain(agentId: string): () => void {
    if (!agentId) return () => undefined;
    const n = this.refs.get(agentId) ?? 0;
    this.refs.set(agentId, n + 1);
    if (n === 0) this.schedule(80);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const left = (this.refs.get(agentId) ?? 1) - 1;
      if (left > 0) this.refs.set(agentId, left);
      else {
        this.refs.delete(agentId);
        this.released.set(agentId, Date.now());
        this.schedule(400);
        this.schedulePrune();
      }
    };
  }

  // Views nobody has held for PRUNE_MS are dropped (boards with many cards, or a long
  // session switching frames, used to keep every snapshot ever received).
  private readonly released = new Map<string, number>();
  private pruneTimer: ReturnType<typeof setTimeout> | null = null;

  private schedulePrune(): void {
    if (this.pruneTimer) return;
    this.pruneTimer = setTimeout(() => {
      this.pruneTimer = null;
      this.prune();
      if (this.released.size) this.schedulePrune();
    }, PRUNE_MS);
  }

  prune(now = Date.now()): number {
    let n = 0;
    for (const [id, at] of this.released) {
      if (this.refs.has(id)) {
        this.released.delete(id);
        continue;
      }
      if (now - at < (this.recent.has(id)?600000:PRUNE_MS)) continue;
      this.recent.delete(id);
      this.released.delete(id);
      this.views.delete(id);
      this.deniedCount.delete(id);
      delete this.stats.perAgent[id];
      n++;
    }
    return n;
  }

  // Number of cached views (proof: pruning works).
  get size(): number {
    return this.views.size;
  }

  subscribe(agentId: string, fn: Notify): () => void {
    let set = this.listeners.get(agentId);
    if (!set) {
      set = new Set();
      this.listeners.set(agentId, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (!set.size) this.listeners.delete(agentId);
    };
  }

  get(agentId: string): AgentView | undefined {
    return this.views.get(agentId);
  }

  // Ids with a live stream, and how many cards/sidebars hold each.
  holders(): Record<string, number> {
    return Object.fromEntries(this.refs);
  }

  get connected(): boolean {
    return !!this.es && this.es.readyState !== EventSource.CLOSED;
  }

  get streamKey(): string {
    return this.openKey;
  }

  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.open();
    }, delay);
  }

  // The frame's start is still pending (shared/start-pending.ts): a denied or "not found"
  // agent is not created yet, so keep asking instead of giving up after a few tries.
  retryStarting(agentId: string): void {
    const view = this.views.get(agentId);
    if (!view || (!view.denied && view.status !== "missing")) return;
    this.deniedCount.delete(agentId);
    if (!this.retryTimer) this.open(true);
  }

  private open(force = false): void {
    const ids = (typeof document!=='undefined'&&document.hidden?[]:[...this.refs.keys()]).sort((a,b)=>(this.recent.get(b)??0)-(this.recent.get(a)??0)||a.localeCompare(b)).slice(0,64).sort();
    const key = ids.join(",");
    if (!force && key === this.openKey && this.connected) return;
    if (this.es) {
      this.es.close();
      this.stats.closes++;
      this.es = null;
    }
    this.openKey = key;
    if (!ids.length) return;
    const es = new EventSource(`/api/ui/events?agents=${encodeURIComponent(key)}`);
    this.es = es;
    this.stats.opens++;
    es.onmessage = (ev) => {
      let msg: { type: string; snap?: AgentView; agentId?: string; error?: string };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.stats.messages++;
      if (msg.type === "snapshot" && msg.snap) {
        const id = msg.snap.agentId;
        this.deniedCount.delete(id);
        this.stats.perAgent[id] = (this.stats.perAgent[id] ?? 0) + 1;
        // Another Mac's agent: the server's paseo:// link names this Mac's daemon.
        this.views.set(id, msg.snap.remote ? { ...msg.snap, paseoUrl: null } : msg.snap);
        this.notify(id);
        this.persist();
      } else if (msg.type === "denied" && msg.agentId) {
        const id = msg.agentId;
        this.views.set(id, { agentId: id, title: null, status: "missing", rows: [], error: msg.error, updatedAt: Date.now(), denied: true });
        this.notify(id);
        // A card just dropped may reach the server a moment after its stream opens, and
        // a frame's agent is unknown until the server resumes it. Retry a few times, with
        // one timer for the whole stream, then give up.
        const n = (this.deniedCount.get(id) ?? 0) + 1;
        this.deniedCount.set(id, n);
        if (n <= 8 && !this.retryTimer)
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.open(true);
          }, Math.min(15000, 1500 * n));
      }
    };
    es.onerror = () => {
      this.stats.errors++;
      for(const id of this.refs.keys()) {
        const view=this.views.get(id);
        if(view){this.views.set(id,{...checkingRemoteSnapshot(view),connection:{host:view.connection?.host??view.remote?.host??'board',state:'reconnecting',reason:'board-stream-disconnected'}});this.notify(id);}
      }
      // EventSource retries network errors itself, but gives up for good on a non-200
      // reply (for example while the plugin restarts). Re-open it ourselves then.
      if (es.readyState === EventSource.CLOSED && this.es === es) setTimeout(() => this.es === es && this.open(true), 3000);
    };
  }

  private notify(agentId: string): void {
    for (const fn of this.listeners.get(agentId) ?? []) fn();
  }
}

const PRUNE_MS = 60_000;

export const agentStore = new AgentStore();

declare global {
  interface Window {
    __agentStore?: AgentStore;
  }
}
window.__agentStore = agentStore;

// Hold a live view of one agent while the calling component is mounted.
export function useAgentView(agentId: string | undefined,active=true): AgentView | null {
  const [,tick]=useState(0);
  useEffect(() => (agentId&&active ? agentStore.retain(agentId) : undefined), [agentId,active]);
  const view=useSyncExternalStore(
    (cb) => (agentId&&active ? agentStore.subscribe(agentId, cb) : () => undefined),
    () => (agentId ? (agentStore.get(agentId) ?? null) : null),
  );
  const polledAt=view?.remote?.polledAt;
  // The visible age advances between remote reads, including a stale snapshot.
  useEffect(()=>{
    if(!active||!polledAt)return;
    const timer=setInterval(()=>tick(n=>n+1),1000);
    return ()=>clearInterval(timer);
  },[active,polledAt]);
  return view;
}

export const STARTING_GRACE_MS = 30_000;

// What to call an agent's state. Right after a bind, Paseo may not know the agent
// yet ("agent not found"); call that "starting" for the first 30 s.
// frameCloud: cloud session cards in the frame still running (meta.paseo.cloudSessions).
// pendingStart: the frame's start is still under way (shared/start-pending.ts). Until the
// agent reports a real status it is "starting", never "checking…", "not found" or an
// error (a remote start can take minutes, and the host says "not found" until it is done).
export function displayStatus(view: AgentView | null, boundAt?: number, frameStatus?: string, frameSubagents?: number, frameCloud?: number, remoteHost?: string | null, pendingStart = false): string {
  if (pendingStart && startingView(view, remoteHost, !!staleRemoteStatus(view?.remote))) return "starting";
  // The start failed (the frame says error) and the agent never reported: error, not "checking…".
  if (frameStatus === "error" && startingView(view, remoteHost, !!staleRemoteStatus(view?.remote))) return "error";
  if(remoteHost && !view?.remote)return "checking…";
  const stale=staleRemoteStatus(view?.remote);
  if(stale)return stale;
  const fresh = !!boundAt && Date.now() - boundAt < STARTING_GRACE_MS;
  if (frameStatus === "requested") return "starting";
  if (!view) return fresh ? "starting" : frameStatus === "idle" && (frameSubagents ?? 0) > 0 ? "subagents" : frameStatus === "idle" && (frameCloud ?? 0) > 0 ? "cloud" : (frameStatus ?? "loading");
  if (view.status === "missing") return fresh ? "starting" : "missing";
  // The turn ended but background subagents still work: not finished.
  if (view.status === "idle" && subagentCount(view, frameSubagents) > 0) return "subagents";
  // The turn ended but a cloud session it dispatched still works: not finished either.
  if (view.status === "idle" && (frameCloud ?? 0) > 0) return "cloud";
  return view.status;
}

export function subagentCount(view: AgentView | null | undefined, frameSubagents?: number): number {
  return view ? (view.subagents ?? 0) : (frameSubagents ?? 0);
}

// STATUS_TEXT, with the number of running subagents for the "subagents" state.
export function statusLabel(status: string, subagents = 0): string {
  if (status === "subagents") return `working · ${subagents || 1} subagent${subagents > 1 ? "s" : ""}`;
  return STATUS_TEXT[status] ?? status;
}

export const STATUS_DOT: Record<string, string> = {
  idle: "#27ae60",
  running: "#2f80ed",
  subagents: "#2f80ed",
  cloud: "#2f80ed",
  "needs-permission": "#f2994a",
  error: "#eb5757",
  archived: "#9e9e9e",
  missing: "#9e9e9e",
  starting: "#9b51e0",
  loading: "#cccccc",
};

export const STATUS_TEXT: Record<string, string> = {
  idle: "idle",
  running: "working",
  subagents: "working · subagent",
  cloud: "paused · waiting on cloud agent",
  "needs-permission": "needs permission",
  error: "error",
  archived: "archived",
  missing: "not found",
  starting: "starting…",
  loading: "loading…",
};

export async function cancelAgent(agentId: string): Promise<void> {
  const res = await fetch(`/api/ui/agents/${encodeURIComponent(agentId)}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
}

// Which bound frame shows which agent, built once per document change and shared by
// every card (each card used to scan every page shape on every store change).
// Entries keep their identity while their fields are equal, and the Map itself while no
// entry changed, so a card re-renders only when its own frame's binding changes.
type BoundFrame = { host?: string; boundAt?: number; status?: string; subagents?: number; cloudSessions?: number; frameId: string };
const frameIndexes = new WeakMap<Editor, Computed<Map<string, BoundFrame>>>();
// Proof counter (window.__boardIndexStats): rebuilds of the index.
export const indexStats = { runs: 0 };
(window as unknown as { __boardIndexStats: typeof indexStats }).__boardIndexStats = indexStats;

export function boundFrameIndex(editor: Editor): Computed<Map<string, BoundFrame>> {
  let c = frameIndexes.get(editor);
  if (!c) {
    c = computed("paseo-bound-frames", (prev) => {
      indexStats.runs++;
      perfCount("bound-frame-index");
      const old = isUninitialized(prev) ? undefined : prev;
      const out = new Map<string, BoundFrame>();
      for (const s of editor.getCurrentPageShapes()) {
        if (s.type !== "frame") continue;
        // biome-ignore lint/suspicious/noExplicitAny: meta JSON.
        const p = (s.meta as any)?.paseo;
        if (!p?.agentId) continue;
        const was = old?.get(p.agentId);
        const same = was && was.frameId === s.id && was.host === p.host && was.boundAt === p.boundAt && was.status === p.status && was.subagents === p.subagents && was.cloudSessions === p.cloudSessions;
        out.set(p.agentId, same ? was : { host: p.host, boundAt: p.boundAt, status: p.status, subagents: p.subagents, cloudSessions: p.cloudSessions, frameId: s.id });
      }
      if (old && old.size === out.size && [...out].every(([id, entry]) => old.get(id) === entry)) return old;
      return out;
    });
    frameIndexes.set(editor, c);
  }
  return c;
}

const visibilitySubscribe=(fn:()=>void)=>{document.addEventListener('visibilitychange',fn);return()=>document.removeEventListener('visibilitychange',fn);};
export function usePageVisible():boolean {return useSyncExternalStore(visibilitySubscribe,()=>!document.hidden,()=>true);}
