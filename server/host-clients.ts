import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import os from 'node:os';
import type {PaseoApi} from '@getpaseo/client';
import {createPaseoApi} from '@getpaseo/client';
import {DaemonClient, type DaemonClientConfig} from '@getpaseo/client/internal/daemon-client';
import type {HostConnection} from '../shared/components/transcript';
import {daemonFailureReason, hostOperation, withDaemonRead} from './daemon-health';

type Pairing={url:string;password?:string;authHeader?:string;e2ee?:DaemonClientConfig['e2ee']};
export interface HostSession {daemon:DaemonClient;api:PaseoApi}
interface Entry {session:HostSession|null;key:string;task:Promise<HostSession|null>|null;lastUsed:number;warmUntil:number;resolvedAt:number;off:(()=>void)|null;error?:string}
interface Options {resolve?:(host:string)=>Promise<Pairing|null>;create?:(config:DaemonClientConfig)=>HostSession}

// One paired SDK session per configured host. Pairing material stays private;
// endpoint refresh never falls back to an unencrypted or guessed address.
export class HostClients {
  private readonly entries=new Map<string,Entry>();
  private readonly files=new Map<string,string>();
  private readonly serverIds=new Map<string,string>();
  get paseoServerIds(): Record<string,string> { return Object.fromEntries(this.serverIds); }
  private stopped=false;
  private readonly requestedWarm=new Map<string,number>();
  private readonly timer:ReturnType<typeof setInterval>;
  onConnection:((host:string,state:HostConnection)=>void)|null=null;
  constructor(private readonly log:(message:string)=>void,private readonly opts:Options={}){
    this.timer=setInterval(()=>void this.sweep(),30000);this.timer.unref();
  }
  configure(routes:Array<{machine:string;paseoConnectionFile?:string}>){
    this.files.clear();this.serverIds.clear();
    for(const r of routes)if(r.paseoConnectionFile){
      const file=r.paseoConnectionFile;
      this.files.set(r.machine,file);
      // Only publish the non-secret server identity, never pairing material.
      void readFile(file.replace(/^~\//,os.homedir()+'/'),'utf8').then(raw=>{
        const pairing=JSON.parse(raw) as {url?:string;serverId?:string};
        const id=pairing.serverId || (pairing.url ? new URL(pairing.url).searchParams.get('serverId') : null);
        if(id && this.files.get(r.machine)===file)this.serverIds.set(r.machine,id);
      }).catch(()=>{});
    }
  }
  get size(){return this.entries.size;}
  paired(host:string){return this.files.has(host)||!!this.opts.resolve;}
  touch(host:string,recent=false){if(recent)this.requestedWarm.set(host,Date.now()+600000);const e=this.entries.get(host);if(e){e.lastUsed=Date.now();if(recent)e.warmUntil=Date.now()+600000;}}
  health(host:string):HostConnection {
    const e=this.entries.get(host),state=e?.session?.daemon.getConnectionState().status;
    return {host,state:state==='connected'?'connected':e?.error?'failed':state==='disconnected'?'reconnecting':'connecting',...(e?.error?{reason:e.error}:{})};
  }
  get(host:string):Promise<HostSession|null>{
    if(this.stopped)return Promise.reject(Error('Host connections stopped'));
    let e=this.entries.get(host);
    if(!e){e={session:null,key:'',task:null,lastUsed:Date.now(),warmUntil:this.requestedWarm.get(host)??0,resolvedAt:0,off:null};this.entries.set(host,e);}
    this.touch(host);
    if(e.task)return e.task;
    if(e.session?.daemon.isConnected && Date.now()-e.resolvedAt<30000)return Promise.resolve(e.session);
    const entry=e;
    entry.task=this.connect(host,entry).finally(()=>{entry.task=null;});return entry.task;
  }
  private async connect(host:string,e:Entry):Promise<HostSession|null>{
    const finish=hostOperation(this.log,host,e.session?'reconnect':'connect');
    try{
      const file=this.files.get(host);
      const pairing=this.opts.resolve?await this.opts.resolve(host):file?JSON.parse(await readFile(file.replace(/^~\//,os.homedir()+'/'),'utf8')) as Pairing:null;
      if(this.stopped)return null;
      if(!pairing){this.entries.delete(host);return null;}
      if(typeof pairing.url!=='string'||!pairing.url.startsWith('wss://')||pairing.e2ee?.enabled!==true||!pairing.e2ee.daemonPublicKeyB64)throw Error('Remote host requires TLS and E2EE pairing');
      const key=createHash('sha256').update(JSON.stringify(pairing)).digest('hex');e.resolvedAt=Date.now();
      if(e.session&&key!==e.key){e.off?.();await e.session.daemon.close();e.session=null;}
      if(this.stopped)return null;
      if(!e.session){
        const config:DaemonClientConfig={url:pairing.url,password:pairing.password,authHeader:pairing.authHeader,e2ee:pairing.e2ee,clientId:`board-host-${process.pid}-${host}`,clientType:'cli',appVersion:'0.11.4',connectTimeoutMs:8000,reconnect:{enabled:true,baseDelayMs:500,maxDelayMs:10000},logger:{debug(){},info(){},warn(){},error(){}}};
        e.session=this.opts.create?this.opts.create(config):(()=>{const daemon=new DaemonClient(config);return {daemon,api:createPaseoApi(daemon)};})();e.key=key;
        e.off=e.session.daemon.subscribeConnectionStatus(state=>{
          if(state.status==='connected')delete e.error;
          this.onConnection?.(host,this.health(host));
        });
      }
      await withDaemonRead(()=>e.session!.daemon.connect());
      const serverId=e.session.daemon.getLastServerInfoMessage?.()?.serverId;
      if(serverId)this.serverIds.set(host,serverId);
      delete e.error;finish();return e.session;
    }catch(error){e.error=daemonFailureReason(error);finish(error);this.onConnection?.(host,this.health(host));throw error;}
  }
  async sweep(){
    for(const [host,e]of this.entries)if(!e.task&&Date.now()-e.lastUsed>60000&&Date.now()>e.warmUntil){e.off?.();this.entries.delete(host);await e.session?.daemon.close().catch(()=>{});}
  }
  async stop(){this.stopped=true;clearInterval(this.timer);const entries=[...this.entries.values()];this.entries.clear();await Promise.all(entries.map(async e=>{e.off?.();await e.session?.daemon.close().catch(()=>{});}));}
}
