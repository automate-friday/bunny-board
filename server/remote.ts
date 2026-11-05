import {StartHostsCache,hostDeadline} from "./start-hosts-cache";
import {QuickPoll} from "./quick-poll";
import {readFleetWorkspaces,selectFleetWorkspace,resolveFleetWorkspace} from "./fleet-workspaces";
import type {StartHost} from "./runtime-fleet";
import {fleetHostsForRuntime} from "../shared/conversation-links";
import { hasRemoteRuntimeFiles, requestRuntimeFiles } from "./runtime-files";
import { bunnyEnv } from "./bunny-env";
import { createHash } from "node:crypto";
import {remoteStartCapability, runRemoteStart, type RemoteStartIntent} from "./remote-start";
import { HostClients, type HostSession } from "./host-clients";
import { withDaemonRead, transientDaemonError, daemonFailureReason } from "./daemon-health";
import { timelineRows } from "./timeline-pages";
import { statusOf } from "./paseo-bridge";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { hostOperation } from "./daemon-health";
import {BoundedWork} from "./bounded-work";
import { redactBoardTokens } from './timeline';
// Paseo agents on the user's other machines, through the Automate Friday network CLI
// (`af-network`, ~/.agents/skills/agent-network/SKILL.md). The board server only talks to
// its local daemon; another Mac's daemon is reached over its Paseo relay by af-network:
//   sessions --host H        list (the import picker's "Other Macs" source)
//   read H <id>              recent messages (cards and the sidebar, polled every 20 s)
//   send H <id> < JSON       deliver a delta or a reply; returns a receipt
// Sends are attributed to the declared network service "bunny" (AF_NETWORK_SERVICE_ID),
// so af-network adds its From/Purpose header and keeps a private receipt. An unconfirmed
// receipt is never retried automatically (it may have arrived).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TranscriptRow, TranscriptSnapshot, TranscriptStatus } from "../shared/components/transcript";
import { INTRO_MARK, INTRO_ROW, isSilentAck } from "../shared/components/transcript";
import type { DirectoryRow } from "./agent-directory";

export const SERVICE_ID = "bunny";
const LIST_TTL_MS = 60_000;
const DIRECTORY_RELAY_MS = 45_000;
export const POLL_MS = 20_000;
const MAX_ROWS = 60;

export interface RemoteHost {
  id: string;
  machine: string;
}

export interface RemoteRow extends DirectoryRow {
  host: string;
}

export interface Receipt {
  delivery: "accepted_by_paseo" | "unconfirmed" | string;
  traceId?: string;
  acceptedAt?: string;
  error?: string;
}

interface RemoteSendInput {
  reason: string;
  workRef: string;
  returnTo: string;
  message: string;
  messageId?: string;
}

type Run = (args: string[], input: string | null, timeoutMs: number) => Promise<string>;

function defaultRun(bin: string, env: Record<string, string>): Run {
  return (args, input, timeoutMs) =>
    new Promise((resolve, reject) => {
      const child = spawn(bin, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 5000).unref?.();
        reject(new Error(`af-network ${args[0]} timed out after ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      // af-network exiting before it reads stdin must not raise in the daemon.
      child.stdin.on("error", () => undefined);
      child.stdout.on("data", (d) => {
        out += d;
        if (out.length > 8_000_000) child.kill("SIGTERM");
      });
      child.stderr.on("data", (d) => {
        err += d;
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new Error((err.trim() || out.trim() || `exit ${code}`).split("\n").slice(-3).join(" ").slice(0, 500)));
      });
      if (input !== null) child.stdin.end(input);
      else child.stdin.end();
    });
}

// biome-ignore lint/suspicious/noExplicitAny: af-network JSON.
function statusFrom(c: any): TranscriptStatus {
  if (c.archivedAt) return "archived";
  if ((c.pendingPermissionCount ?? 0) > 0) return "needs-permission";
  const s = String(c.runtimeStatus ?? "idle");
  if (s === "running") return "running";
  if (s === "error") return "error";
  return "idle";
}

// biome-ignore lint/suspicious/noExplicitAny: af-network JSON.
export function remoteRow(host: string, c: any): RemoteRow {
  const status = statusFrom(c);
  const title: string | null = c.title ?? null;
  const workspaceName: string | null = c.workspace ?? null;
  return {
    host,
    id: String(c.agentId),
    title,
    workspaceId: c.workspaceId ?? null,
    workspaceName,
    provider: String(c.provider ?? "?"),
    model: c.model ?? null,
    status: status === "missing" ? "idle" : (status as DirectoryRow["status"]),
    attention: (c.pendingPermissionCount ?? 0) > 0 ? "permission" : null,
    needsAttention: status === "needs-permission" || status === "error",
    lastActivityAt: [c.updatedAt, c.lastUserMessageAt].filter(Boolean).sort().pop() ?? new Date(0).toISOString(),
    createdAt: null,
    archived: !!c.archivedAt,
    cwd: null,
    hay: `${title ?? ""}\n${workspaceName ?? ""}\n${host}`.toLowerCase(),
  };
}

// af-network read → card rows (user and agent messages; tool calls are not in the packet).
// biome-ignore lint/suspicious/noExplicitAny: af-network JSON.
export function remoteRows(c: any): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  for (const m of Array.isArray(c?.messages) ? c.messages : []) {
    let text = String(m.text ?? "");
    // Messages the board sent through af-network carry its handoff header; show the body.
    const via = /^\[Network handoff [^\]]+\]\n/.test(text);
    if (via) text = text.slice(text.indexOf("\n\n") + 2);
    text = redactBoardTokens(text).slice(0, 4000);
    if (via && text.slice(0, 300).includes(INTRO_MARK)) text = INTRO_ROW;
    if (!text.trim()) continue;
    const kind = m.role === "assistant" ? "assistant" : "user";
    rows.push({ kind: via && /^Board delta/.test(text) ? "plugin:board-delta" : kind, text, at: String(m.timestamp ?? ""), ...(kind === "assistant" && isSilentAck(text) ? { ack: true } : {}) });
  }
  return rows.slice(-MAX_ROWS);
}

interface Watched {
  host: string;
  agentId: string;
  snap: TranscriptSnapshot | null;
  polledAt: number;
  reading: Promise<void> | null;
  lastStatus: TranscriptStatus | null;
  session?:HostSession;
  unsub?:()=>void;
  refreshTimer?:ReturnType<typeof setTimeout>;
  readVersion?:number;
  quickPoll?:QuickPoll;
}

export class RemoteAgents {
  visible:((agentId:string)=>boolean)|null=null;
  readonly enabled: boolean;
  readonly bin: string;
  private readonly run: Run;
  private readonly hostReadiness=new Map<string,{row?:StartHost;good?:StartHost;at:number;pending?:Promise<void>;retry:boolean}>();
  private readonly startHostsCache=new StartHostsCache<StartHost>(()=>this.loadStartHosts(),60_000,rows=>rows.every(h=>h.enabled)&&!this.readinessPending());
  private readinessPending(){return [...this.hostReadiness.values()].some(e=>e.pending||e.retry);}
  startHostsSnapshot(force=false){const snap=this.startHostsCache.snapshot(force);return {...snap,refreshing:snap.refreshing||this.readinessPending()||snap.hosts.some(h=>h.state==='checking')||!!snap.note};}
  startHosts(){return this.startHostsCache.get();}
  private runtimeServerIds:Record<string,string> = {};
  private hostsMemo: RemoteHost[] | null = null;
  private hostsAt=0;
  private hostsLoading:Promise<RemoteHost[]>|null=null;
  private readonly clients:HostClients|null;
  private readonly workspaceTargets?:Record<string,string>;
  private readonly pairedReads=new BoundedWork(4,200);
  private readonly pairedPending=new Map<string,Promise<unknown>>();
  private list: { rows: RemoteRow[]; at: number; inflight: Promise<void> | null; errors: Record<string, string> } = { rows: [], at: 0, inflight: null, errors: {} };
  private readonly readPool=new BoundedWork(2,200);
  private stopped=false;
  private readonly watched = new Map<string, Watched>();
  private timer: ReturnType<typeof setInterval> | null = null;
  // Snapshot listeners (the transcript hub) and status listeners (the frame watcher).
  onSnapshot: ((agentId: string, snap: TranscriptSnapshot) => void) | null = null;
  onStatus: ((agentId: string, status: TranscriptStatus) => void) | null = null;
  readonly stats = { lists: 0, reads: 0, sends: 0, errors: 0 };

  constructor(
    private readonly log: (m: string) => void,
    opts: { enabled?: boolean; bin?: string; run?: Run; clients?:HostClients; workspaces?:Record<string,string> } = {},
  ) {
    this.workspaceTargets=opts.workspaces;
    this.clients=opts.clients??(opts.run||hasRemoteRuntimeFiles()?null:new HostClients(log));
    if(this.clients)this.clients.onConnection=(host,connection)=>{
      this.startHostsCache.invalidate();
      for(const w of this.watched.values())if(w.host===host&&w.snap){w.snap={...w.snap,connection};this.onSnapshot?.(w.agentId,w.snap);}
    };
    this.bin = opts.bin ?? process.env.AF_NETWORK_BIN ?? path.join(os.homedir(), ".local", "bin", "af-network");
    this.enabled = opts.enabled !== false && (!!opts.run || existsSync(this.bin));
    const run = opts.run ?? defaultRun(this.bin, { AF_NETWORK_SERVICE_ID: SERVICE_ID });
    this.run = async (args, input, timeoutMs) => {
      const host = args[0] === "sessions" ? args[2] : args[0] === "discover" ? "discovery" : args[1];
      const finish = hostOperation(log, host ?? "unknown", args[0]);
      try { const result = await run(args, input, timeoutMs); finish(); return result; }
      catch (error) { finish(error); throw error; }
    };
  }

  start(): void {
    if (!this.enabled || this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.pollAll(), POLL_MS);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    this.stopped=true;this.hostReadiness.clear();this.readPool.stop();this.pairedReads.stop();void this.clients?.stop();
    for(const w of this.watched.values()){w.quickPoll?.stop();w.unsub?.();if(w.refreshTimer)clearTimeout(w.refreshTimer);}
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get paseoServerIds(): Record<string,string> { return {...this.runtimeServerIds,...this.clients?.paseoServerIds}; }

  // Configured hosts other than this machine.
  async hosts(): Promise<RemoteHost[]> {
    if (!this.enabled) return [];
    if(this.hostsMemo&&Date.now()-this.hostsAt<30000)return this.hostsMemo;
    if(this.hostsLoading)return this.hostsLoading;
    this.hostsLoading=(async()=>{
      const out=JSON.parse(await this.run(['discover'],null,30000));
      const me=(process.env.BUNNY_RUNTIME_HOSTNAME??os.hostname()).replace(/\.local$/,'');
      const configured=(out.hosts??[]) as Array<{id:string;machine:string;paseoConnectionFile?:string;ssh?:string}>;
      const hosts=fleetHostsForRuntime(configured.filter(h=>h.machine).map(h=>({...h,host:h.machine})),me);
      this.clients?.configure(hosts);
      this.hostsAt=Date.now();
      return this.hostsMemo=hosts.map((h:{id:string;machine:string})=>({id:String(h.id),machine:String(h.machine)}));
    })().finally(()=>{this.hostsLoading=null;});
    return this.hostsLoading;
  }

  private workspaceTarget(host:string):string|undefined {
    const targets=this.workspaceTargets??readFleetWorkspaces(process.env.BUNNY_RUNTIME_FLEET_WORKSPACES);
    return Object.hasOwn(targets,host)?targets[host]:undefined;
  }

  private async loadStartHosts():Promise<StartHost[]> {
    if(!this.enabled)return [];
    if(hasRemoteRuntimeFiles()){
      let hosts:StartHost[];
      try{hosts=(await hostDeadline(requestRuntimeFiles({op:'fleet-hosts'}),8000)).hosts??[];}
      catch(error){
        if((error as Error).message!=='runtime companion lacks fleet support')throw error;
        return (await this.hosts()).map(h=>({host:h.machine,state:'failed',enabled:false,reason:'runtime companion lacks fleet support'}));
      }
      this.runtimeServerIds=Object.fromEntries(hosts.filter(h=>h.paseoServerId).map(h=>[h.host,h.paseoServerId!]));
      return hosts;
    }
    const hosts=await this.hosts();
    const active=new Set(hosts.map(h=>h.machine));
    for(const host of this.hostReadiness.keys())if(!active.has(host))this.hostReadiness.delete(host);
    return hosts.map(h=>{
      const host=h.machine,target=this.workspaceTarget(host);
      if(!target)return {host,state:'failed',enabled:false,reason:`${host}: no fleet workspace configured (BUNNY_RUNTIME_FLEET_WORKSPACES)`};
      if(!this.clients?.paired(host))return {host,state:'failed',enabled:false,reason:'No paired SDK connection configured'};
      let entry=this.hostReadiness.get(host);
      if(!entry){entry={at:0,retry:false};this.hostReadiness.set(host,entry);}
      const checking:StartHost={host,state:'checking',enabled:false,reason:'Still connecting…'};
      const maxAge=entry.retry||!entry.row?.enabled?1000:60_000;
      if(!entry.pending&&(!entry.row||Date.now()-entry.at>=maxAge||entry.row.enabled&&!entry.retry&&this.clients.health(host).state!=='connected')){
        const check=entry;
        // Readiness is observational. Keep one probe alive; a UI request never cancels
        // a slow paired connection or throws away its eventual successful result.
        check.pending=(async()=>{
          try{
            const session=await this.clients!.get(host);
            const reason=session?remoteStartCapability(session.daemon.getLastServerInfoMessage()):'No paired SDK connection configured';
            if(!reason&&session)await resolveFleetWorkspace(host,target,options=>withDaemonRead(()=>session.api.workspaces.list(options)));
            if(this.stopped||this.hostReadiness.get(host)!==check)return;
            check.row={...this.clients!.health(host),paseoServerId:this.clients!.paseoServerIds[host],enabled:!reason,...(reason?{reason}:{})};
            if(check.row.enabled)check.good=check.row;
            check.retry=false;
          }catch(error){
            if(this.stopped||this.hostReadiness.get(host)!==check)return;
            check.retry=daemonFailureReason(error)==='timeout';
            check.row=check.retry?(check.good??checking):{host,state:'failed',enabled:false,reason:(error as Error).message};
          }finally{
            check.at=Date.now();check.pending=undefined;
            if(!this.stopped)this.startHostsCache.invalidate();
          }
        })();
      }
      return entry.row??checking;
    });
  }

  async createOnHost(intent:RemoteStartIntent,input:{provider:string;title:string;prompt:string;modeId?:string;labels?:Record<string,string>},persist:(intent:RemoteStartIntent)=>void,createOnly=false){
    if(!this.enabled)throw Error('Remote connections disabled in this board environment');
    if(hasRemoteRuntimeFiles()){
      // Wire seed is identity only; never forward the board's persisted phase/payload.
      const seed={host:intent.host,key:intent.key,agentId:intent.agentId,messageId:intent.messageId,requestedAt:intent.requestedAt,phase:'prepared' as const};
      // Any lost companion acknowledgement must retain the same board operation.
      intent.phase='unknown';persist(intent);
      const created=await requestRuntimeFiles({op:'fleet-create',intent:seed,input});
      if(!created.intent)throw Error('Runtime returned no create receipt');
      const accept=(reply:RemoteStartIntent)=>{
        for(const key of ['host','key','agentId','messageId','requestedAt'] as const)if(reply[key]!==seed[key])throw Error('Runtime receipt identity mismatch');
        Object.assign(intent,reply);persist(intent);
      };
      if(!['created','sending','complete'].includes(created.intent.phase))throw Error('Runtime create outcome unknown');
      accept(created.intent); // Binding precedes opener.
      if(createOnly)return;
      const sent=await requestRuntimeFiles({op:'fleet-send',intent:seed,input});
      if(!sent.intent)throw Error('Runtime returned no opener receipt');
      if(sent.intent.phase!=='complete')throw Error('Runtime opener outcome unknown');
      accept(sent.intent);this.quickRefresh(intent.agentId);return;
    }
    const hosts=await this.hosts();
    if(!hosts.some(h=>h.machine===intent.host))throw Error(`Unknown remote host: ${intent.host}`);
    const workspaceTarget=this.workspaceTarget(intent.host);
    if(!workspaceTarget)selectFleetWorkspace(intent.host,undefined,[]);
    if(!this.clients?.paired(intent.host))throw Error(`${intent.host}: no paired SDK connection configured`);
    const session=await this.clients.get(intent.host);
    if(!session)throw Error(`${intent.host}: paired host unavailable`);
    await runRemoteStart(session,intent,{...input,workspaceTarget},persist,30000,createOnly);
    if(!createOnly)this.quickRefresh(intent.agentId);
  }

  // UI reads never wait for relay discovery. Keep one shared background scan;
  // a remote read budget is independent of the local Paseo connection health.
  directorySnapshot(forceRefresh = false) {
    if (!this.enabled || this.stopped) return {
      rows: [] as RemoteRow[], stale: false, ageMs: null, hasSnapshot: false,
      refreshing: false, directoryState: 'disabled' as const, retryAfterMs: null,
      message: 'Other Macs directory is disabled.', errors: {} as Record<string,string>,
    };
    const fresh = !!this.list.at && Date.now() - this.list.at < LIST_TTL_MS;
    if (forceRefresh || !fresh) void this.refreshList();
    const refreshing = !!this.list.inflight;
    const failed = Object.keys(this.list.errors).length > 0;
    const directoryState = refreshing ? 'asking' : failed ? (this.list.rows.length ? 'partial' : 'error') : 'ready';
    return {
      rows: this.list.rows, stale: !fresh || refreshing || failed,
      ageMs: this.list.at ? Date.now() - this.list.at : null,
      hasSnapshot: !!this.list.at, refreshing, directoryState,
      retryAfterMs: refreshing ? 2000 : null,
      message: refreshing ? 'Still asking the other Macs…' : failed ? 'Some remote hosts could not be listed. See host errors and retry.' : 'Other Macs directory ready.',
      errors: this.list.errors,
    };
  }

  // Remote agents for the picker, cached for a minute (a list takes 5-20 s over the relay).
  async rows(): Promise<{ rows: RemoteRow[]; stale: boolean; ageMs: number; errors: Record<string, string> }> {
    if (!this.enabled) return { rows: [], stale: false, ageMs: 0, errors: { all: "af-network is not installed on this machine" } };
    const fresh = this.list.at && Date.now() - this.list.at < LIST_TTL_MS;
    if (!fresh) {
      const p = this.refreshList();
      if (!this.list.at) await p;
    }
    return { rows: this.list.rows, stale: !fresh, ageMs: this.list.at ? Date.now() - this.list.at : 0, errors: this.list.errors };
  }

  find(agentId: string): RemoteRow | null {
    return this.list.rows.find((r) => r.id === agentId) ?? null;
  }

  // `host` is af-network's host id or machine name; rows carry the machine name.
  async lookup(host: string, agentId: string): Promise<RemoteRow | null> {
    const machine = (await this.hosts()).find((h) => h.id === host || h.machine === host)?.machine;
    if (!machine) return null;
    const hit = this.list.rows.find((r) => r.id === agentId && r.host === machine);
    if (hit) return hit;
    // Not in the last list (made since): list again, at most once a minute per miss.
    if (Date.now() - this.list.at > 15_000) await this.refreshList();
    return this.list.rows.find((r) => r.id === agentId && r.host === machine) ?? null;
  }

  private refreshList(): Promise<void> {
    if (this.list.inflight) return this.list.inflight;
    this.list.inflight = (async () => {
      const t0 = Date.now();
      const rows: RemoteRow[] = [];
      const errors: Record<string, string> = {};
      try {
        await Promise.all((await this.hosts()).map(async h => {
          try {
            const out = JSON.parse(await this.readPool.run(h.machine,()=>this.run(["sessions", "--host", h.machine], null, DIRECTORY_RELAY_MS)));
            const hostRows: RemoteRow[] = [];
            // biome-ignore lint/suspicious/noExplicitAny: af-network JSON.
            for (const hostPart of out.hosts ?? []) {
              if (hostPart.error) errors[h.machine] = String(hostPart.error);
              for (const c of hostPart.conversations ?? []) hostRows.push(remoteRow(h.machine, c));
            }
            rows.push(...hostRows);
            // Publish successful hosts immediately; one slow host must not hide
            // rows already received. Snapshot age still belongs to the last full scan.
            if (!this.stopped && !errors[h.machine])
              this.list.rows = [...this.list.rows.filter(r => r.host !== h.machine), ...hostRows];
          } catch (e) {
            errors[h.machine] = (e as Error).message;
          }
        }));
      } catch (e) {
        errors.all = (e as Error).message;
      }
      if(this.stopped)return;
      this.stats.lists++;
      // Keep the last good rows of a host that failed this time.
      const retained = this.list.rows.filter(r => errors.all || errors[r.host]);
      const publishedRows = [...new Map([...retained, ...rows].map(r => [`${r.host}/${r.id}`, r])).values()];
      this.list = { rows: publishedRows, at: Date.now(), inflight: null, errors };
      if (Object.keys(errors).length) {
        this.stats.errors++;
        this.log(`remote agents: ${publishedRows.length} listed, errors ${JSON.stringify(errors)}`);
      } else if (bunnyEnv("DEBUG")) this.log(`remote agents: ${publishedRows.length} listed in ${Date.now() - t0} ms`);
    })().finally(() => {
      this.list.inflight = null;
    });
    return this.list.inflight;
  }

  // --- cards and status -----------------------------------------------------------------

  watchStatus(host: string, agentId: string): void {
    if (!this.enabled || this.stopped) return;
    if (!this.watched.has(agentId)) this.watched.set(agentId, { host, agentId, snap: null, polledAt: 0, reading: null, lastStatus: null });
    this.start();
    if(!this.visible||this.visible(agentId))void this.read(agentId);
  }

  unwatch(agentId: string): void {
    const w=this.watched.get(agentId);w?.quickPoll?.stop();w?.unsub?.();if(w?.refreshTimer)clearTimeout(w.refreshTimer);
    this.watched.delete(agentId);
  }

  // Whether the board can stop this host's agents: only over a paired Paseo connection (the
  // same DaemonClient the board uses for its own daemon). af-network messages and the split
  // runtime companion have no stop.
  canCancel(host:string):boolean { return this.enabled && !hasRemoteRuntimeFiles() && !!this.clients?.paired(host); }
  cancelBlocked(host:string):string {
    if(!this.enabled)return 'Remote connections are disabled in this board environment';
    if(hasRemoteRuntimeFiles())return `${host}: this board's runtime companion cannot stop remote agents; stop it in Paseo on that machine`;
    return `${host} is reached by af-network messages only (no paired connection); stop it in Paseo on that machine`;
  }

  // Abort a remote agent's current turn over the host's paired connection.
  async cancel(host:string,agentId:string):Promise<void>{
    if(!this.canCancel(host))throw Object.assign(new Error(this.cancelBlocked(host)),{status:409});
    await this.hosts();
    const session=await this.clients!.get(host);
    if(!session)throw Object.assign(new Error(`${host}: paired host unavailable; try again or stop it in Paseo on that machine`),{status:503});
    await session.daemon.cancelAgent(agentId);
    this.quickRefresh(agentId);
  }

  quickRefresh(agentId:string):void {
    const w=this.watched.get(agentId);if(!w||this.stopped)return;
    w.quickPoll??=new QuickPoll(async()=>{
      await this.read(agentId);
      return !w.snap?.error && ['idle','archived','missing','error'].includes(w.snap?.status??'');
    });
    w.quickPoll.start();
  }

  isRemote(agentId: string): string | null {
    return this.watched.get(agentId)?.host ?? null;
  }

  snapshot(agentId: string): TranscriptSnapshot | null {
    const snap=this.watched.get(agentId)?.snap;return snap?{...snap,remote:snap.remote?{...snap.remote,coverage:"messages-only",stale:!!snap.error||!snap.remote.polledAt||Date.now()-snap.remote.polledAt>45000,staleAfterMs:45000}:undefined}:null;
  }

  unwatchView(agentId:string):void {const w=this.watched.get(agentId);if(!w)return;w.unsub?.();w.unsub=undefined;w.session=undefined;if(w.refreshTimer)clearTimeout(w.refreshTimer);w.refreshTimer=undefined;}

  prefetch(agentId:string,recent=false,retry=false):void {
    const w=this.watched.get(agentId);if(!w)return;
    if(retry&&w.snap)w.snap={...w.snap,availability:undefined,error:undefined};
    this.clients?.touch(w.host,recent);this.pairedReads.prioritize(agentId);
    if(!w.polledAt||Date.now()-w.polledAt>2000)void this.read(agentId);
  }
  private pairedOnce<T>(key:string,read:()=>Promise<T>):Promise<T>{
    const prior=this.pairedPending.get(key);if(prior)return prior as Promise<T>;
    const work=Promise.resolve().then(read);this.pairedPending.set(key,work);
    void work.finally(()=>{if(this.pairedPending.get(key)===work)this.pairedPending.delete(key);}).catch(()=>{});return work;
  }
  private async pairedRead(w:Watched,session:HostSession):Promise<TranscriptSnapshot>{
    const ref=session.api.agents.ref(w.agentId);
    if(w.session!==session||!w.unsub){
      w.unsub?.();w.session=session;
      if(!this.visible||this.visible(w.agentId)){
      const sub=ref.timeline.subscribe(()=>{
        if(!w.refreshTimer)w.refreshTimer=setTimeout(()=>{w.refreshTimer=undefined;void this.read(w.agentId);},350);
      });w.unsub=sub;
      void sub.ready.catch(()=>{w.unsub?.();w.session=undefined;w.unsub=undefined;});
      }
    }
    const version=w.readVersion=(w.readVersion??0)+1;
    const valid=()=>!this.stopped&&this.watched.get(w.agentId)===w&&w.session===session&&w.readVersion===version;
    const publish=()=>{if(valid()){w.snap=result;this.onSnapshot?.(w.agentId,result);}};
    let result:TranscriptSnapshot={...(w.snap??{agentId:w.agentId,title:null,status:'idle',rows:[]}),error:undefined,updatedAt:Date.now(),connection:this.clients!.health(w.host),remote:{host:w.host,polledAt:Date.now(),coverage:'messages-only',stale:false,staleAfterMs:45000}};
    await Promise.all([
      withDaemonRead(()=>this.pairedOnce(`${w.host}/${w.agentId}:metadata`,()=>ref.refresh()).then(value=>{if(!valid())return;result={...result,title:value?.agent.title??result.title,status:statusOf(value?.agent)};publish();})),
      withDaemonRead(()=>this.pairedOnce(`${w.host}/${w.agentId}:tail`,()=>ref.timeline.refetch({direction:'tail',limit:60,projection:'projected'})).then(page=>{
        if(!valid())return;
        result={...result,rows:remoteRows({messages:timelineRows(page,w.agentId).filter(row=>row.kind==='assistant'||row.kind==='user'||row.kind.startsWith('plugin:')).map(row=>({role:row.kind==='assistant'?'assistant':'user',text:row.text,timestamp:row.at}))}),updatedAt:Date.now()};
        publish();
      })),
    ]);
    return result;
  }

  // Read one agent now (or join the read in flight).
  read(agentId: string): Promise<void> {
    const w = this.watched.get(agentId);
    if (this.stopped || !w) return Promise.resolve();
    if (w.reading) return w.reading;
    w.reading = (async () => {
      this.stats.reads++;
      let snap: TranscriptSnapshot;
      try {
        if(this.clients)await this.hosts();
        const session=await this.clients?.get(w.host);
        if(session){snap=await this.pairedReads.run(agentId,()=>this.pairedRead(w,session));w.polledAt=Date.now();}
        else {
        const out = JSON.parse(await this.readPool.run(w.host,()=>this.run(["read", w.host, agentId], null, 45_000)));
        const h = (out.hosts ?? [])[0];
        const c = h?.conversations?.find((x: { agentId: string }) => x.agentId === agentId);
        if (!c) throw new Error(h?.error ?? h?.errors?.[0] ?? `agent ${agentId} not found on ${w.host}`);
        w.polledAt=Date.now();
        snap = { agentId, title: c.title ?? null, status: statusFrom(c), rows: remoteRows(c), updatedAt: Date.now(), remote: { host: w.host, polledAt: w.polledAt,coverage:"messages-only",stale:false,staleAfterMs:45000 } };
        }
      } catch (e) {
        this.stats.errors++;
        const msg = typeof (e as Error).message === "string" ? (e as Error).message : String(e);
        snap = { ...(w.snap ?? { agentId, title: null, status: "idle" as TranscriptStatus, rows: [], updatedAt: Date.now() }), connection:this.clients?.paired(w.host)?this.clients.health(w.host):{host:w.host,state:'failed',reason:'remote-read-failed'}, error: `Paseo read ${w.host}: ${msg}`.slice(0, 400), updatedAt: Date.now(), remote: { host: w.host, polledAt: w.polledAt || null,coverage:"messages-only",stale:true,staleAfterMs:45000 } };
      }
      if(this.stopped||this.watched.get(agentId)!==w)return;
      w.snap = snap;
      if (!snap.error) w.lastStatus = snap.status;
      this.onSnapshot?.(agentId, snap);
      // Every good read, not only changes: a turn can start and end between two polls.
      if (!snap.error && this.watched.has(agentId)) this.onStatus?.(agentId, snap.status);
    })().finally(() => {
      w.reading = null;
    });
    return w.reading;
  }

  private polling = false;

  private async pollAll(): Promise<void> {
    // One sweep at a time, one read at a time: each read opens a relay connection, and a
    // slow or offline host must not stack sweeps.
    if (this.polling) return;
    this.polling = true;
    try {
      await Promise.all([...this.watched.values()].filter(w=>!this.visible||this.visible(w.agentId)||w.polledAt>0&&Date.now()-w.polledAt>=300000).map(w=>this.read(w.agentId).catch(()=>undefined)));
    } finally {
      this.polling = false;
    }
  }

  // --- sending ------------------------------------------------------------------------------

  private async dispatchJournal() {
    if (!existsSync(this.bin)) return null;
    const launcher = await readFile(this.bin, 'utf8');
    const script = launcher.match(/'([^']+\/network\.mjs)'/)?.[1];
    if (!script) return null;
    return {
      network: await import(pathToFileURL(path.join(path.dirname(script), 'activity.mjs')).href),
      store: await import(pathToFileURL(script).href),
    };
  }

  async send(host: string, agentId: string, input: RemoteSendInput): Promise<Receipt> {
    if (!this.enabled) throw new Error("af-network is not installed on this machine");
    this.stats.sends++;
    // messageId belongs to Bunny's caller; af-network accepts it as traceId only.
    const { messageId, ...fields } = input;
    const remoteInput = { ...fields, message: input.message.slice(0, 23000) };
    const journal = messageId || this.clients ? await this.dispatchJournal() : null;
    if (messageId && journal) {
      const { network, store } = journal;
      const file = path.join(store.stateDir(), 'activity', createHash('sha256').update('dispatch:' + messageId).digest('hex') + '.json');
      const prior = store.readJson(file);
      if (prior) {
        // An old accepted trace must be recognized using its original envelope. Never
        // rewrite its receipt or mint a new wire ID to get past an uncertain outcome.
        const legacy = prior.sourceServiceId === 'paseo-board';
        const serviceId = legacy ? 'paseo-board' : SERVICE_ID;
        const workRef = legacy ? remoteInput.workRef.replace(/^bunny\//, 'paseo-board/') : remoteInput.workRef;
        const packet = network.prepareDispatch('send', { machine: host }, agentId,
          { ...remoteInput, workRef, traceId: messageId }, { ...process.env, AF_NETWORK_SERVICE_ID: serviceId });
        if (prior.bodySha256 !== packet.record.bodySha256 || prior.destinationHost !== host || prior.destinationSessionId !== agentId || prior.sourceServiceId !== serviceId)
          throw Error('Remote message ID was already used for different content or destination');
        if (prior.delivery === 'accepted_by_paseo') return { delivery: prior.delivery, traceId: prior.traceId, acceptedAt: prior.acceptedAt };
        throw Error('Remote message delivery unconfirmed for existing trace; inspect its receipt');
      }
    }
    if(this.clients){
      await this.hosts();
      const session=await this.clients.get(host);
      if(session){
        if (!journal) throw Error('Shared remote sends need the installed af-network journal module');
        const { network } = journal;
        let dispatched:Promise<Receipt>;
        const previous=process.env.AF_NETWORK_SERVICE_ID;
        process.env.AF_NETWORK_SERVICE_ID=SERVICE_ID;
        try{
          dispatched=network.dispatch('send',host,agentId,{...remoteInput,...(messageId?{traceId:messageId}:{})},undefined,async(packet:{record:{traceId:string};body:string})=>{
            for(let attempt=0;;attempt++){
              let durable=false;
              try{
                const current=await this.clients!.get(host);if(!current)throw Error('Remote pairing disappeared');
                durable=current.daemon.getLastServerInfoMessage()?.features?.agentRequestReceipts===true;
                await current.daemon.sendMessage(agentId,packet.body,{messageId:packet.record.traceId});
                return {destinationSessionId:agentId,delivery:'accepted_by_paseo',acceptedAt:new Date().toISOString(),note:'Accepted does not prove execution or completion.'};
              }catch(error){if(!durable)throw Error('Remote message delivery unconfirmed; durable receipts unavailable');if(attempt>=2||!transientDaemonError(error))throw error;}
            }
          });
        }finally{if(previous===undefined)delete process.env.AF_NETWORK_SERVICE_ID;else process.env.AF_NETWORK_SERVICE_ID=previous;}
        const receipt=await dispatched!;this.quickRefresh(agentId);return receipt;
      }
    }
    const oneLine = (t: string, n: number) => t.replace(/[\r\n]+/g, " ").trim().slice(0, n) || "-";
    const body = JSON.stringify({ ...(input.messageId ? {traceId:input.messageId} : {}), reason: oneLine(input.reason, 200), workRef: oneLine(input.workRef, 200), returnTo: oneLine(input.returnTo, 300), message: input.message.slice(0, 23_000) });
    let out: string;
    try {
      out = await this.run(["send", host, agentId], body, 120_000);
    } catch (e) {
      // "Delivery unconfirmed; trace <id>. …": the message may or may not have arrived.
      const msg = (e as Error).message;
      throw Object.assign(new Error(msg), { receipt: { delivery: "unconfirmed", traceId: msg.match(/trace ([A-Za-z0-9_-]+)/)?.[1], error: msg.slice(0, 300) } as Receipt });
    }
    const r = JSON.parse(out);
    // A later read shows the message (and the agent's answer) on the card.
    this.quickRefresh(agentId);
    return { delivery: String(r.delivery ?? "unknown"), traceId: r.traceId, acceptedAt: r.acceptedAt };
  }
}
