// Read-only OBS 5.x completion adapter. Never starts/stops recording.
// Protocol: obsproject/obs-websocket docs/generated/protocol.md (RecordStateChanged).
import WebSocket from 'ws';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
export function completedRecording(message:unknown):string|null {
  const m=message as {op?:number;d?:{eventType?:string;eventData?:{outputActive?:boolean;outputState?:string;outputPath?:string}}};
  const e=m?.d?.eventData;
  return m?.op===5&&m.d?.eventType==='RecordStateChanged'&&e?.outputActive===false&&e.outputState==='OBS_WEBSOCKET_OUTPUT_STOPPED'&&typeof e.outputPath==='string'&&!!e.outputPath?e.outputPath:null;
}
export class ObsRecordingSource {
  private socket:WebSocket|null=null;
  private retry:ReturnType<typeof setTimeout>|null=null;
  private sweep:ReturnType<typeof setInterval>|null=null;
  private stopped=false;
  private draining=false;
  private connected=false;
  private observed:Record<string,string>;
  private candidates=new Map<string,{fingerprint:string;at:number}>();
  private pendingStatus:string|null=null;
  private statusRequestedAt=0;
  private statusTimer:ReturnType<typeof setInterval>|null=null;
  private observedFile:string;
  private completionFiles(){return readdirSync(this.dir).filter(f=>f.endsWith('.json')&&f!=='observed.json');}
  private files(){
    const names=readdirSync(this.recordings).filter(f=>/\.(mp4|mov|mkv|webm)$/i.test(f)&&!/(?:^|[-_])take_12\./i.test(f));
    if(names.length>5000)throw new Error('OBS reconciliation exceeds 5000 files; use a smaller configured recordings directory');
    return Object.fromEntries(names.map(name=>{const st=statSync(path.join(this.recordings,name));return [name,`${st.size}:${st.mtimeMs}`];}));
  }
  private saveObserved(){writeFileSync(this.observedFile+'.tmp',JSON.stringify(this.observed));renameSync(this.observedFile+'.tmp',this.observedFile);}
  // Only reconcile after TWO idle observations separated by quiet time. While OBS
  // is active or disconnected, never infer completion from file stability.
  reconcileIdle(active:boolean,now=Date.now()){
    if(this.stopped)return;
    if(active){this.candidates.clear();return;}
    const files=this.files();
    for(const [name,fingerprint] of Object.entries(files)){
      if(this.observed[name]===fingerprint)continue;
      const prior=this.candidates.get(name);
      if(prior?.fingerprint===fingerprint&&now-prior.at>=2000){this.record(path.join(this.recordings,name));this.observed[name]=fingerprint;this.candidates.delete(name);}
      else if(prior?.fingerprint!==fingerprint)this.candidates.set(name,{fingerprint,at:now});
    }
    this.saveObserved();
  }
  private requestStatus(){
    if(!this.connected||this.socket?.readyState!==WebSocket.OPEN)return;
    if(this.pendingStatus&&Date.now()-this.statusRequestedAt<8000)return;
    this.statusRequestedAt=Date.now();this.pendingStatus=randomUUID();this.socket.send(JSON.stringify({op:6,d:{requestType:'GetRecordStatus',requestId:this.pendingStatus}}));
  }
  private lastError:string|null=null;
  constructor(private dir:string,private recordings:string,private url:string,private password:string,private intake:(file:string)=>Promise<unknown>,private log:(message:string)=>void){mkdirSync(dir,{recursive:true});this.observedFile=path.join(dir,'observed.json');this.observed=existsSync(this.observedFile)?JSON.parse(readFileSync(this.observedFile,'utf8')):this.files();this.saveObserved();}
  status(){return {kind:'obs-websocket',connected:this.connected,lastError:this.lastError,pendingCompletions:this.completionFiles().length};}
  start(){this.connect();void this.drain();this.sweep=setInterval(()=>void this.drain(),30000);this.sweep.unref();this.statusTimer=setInterval(()=>this.requestStatus(),5000);this.statusTimer.unref();}
  private connect(){
    if(this.stopped)return;
    const ws=new WebSocket(this.url,{handshakeTimeout:10000,maxPayload:1000000});this.socket=ws;
    ws.on('message',raw=>{
      try{
        const m=JSON.parse(raw.toString());
        if(m.op===0){
          const a=m.d?.authentication;let authentication:string|undefined;
          if(a){const secret=createHash('sha256').update(this.password+a.salt).digest('base64');authentication=createHash('sha256').update(secret+a.challenge).digest('base64');}
          ws.send(JSON.stringify({op:1,d:{rpcVersion:1,eventSubscriptions:64,...(authentication?{authentication}:{})}}));
        }else if(m.op===2){this.connected=true;this.lastError=null;this.requestStatus();}
        else if(m.op===7&&m.d?.requestId===this.pendingStatus){this.pendingStatus=null;if(m.d.requestStatus?.result&&typeof m.d.responseData?.outputActive==='boolean')this.reconcileIdle(m.d.responseData.outputActive);else this.lastError='OBS status unavailable; completion reconciliation held';}
        else {if(m.op===5&&m.d?.eventType==='RecordStateChanged'&&m.d.eventData?.outputActive){this.pendingStatus=null;this.candidates.clear();}const file=completedRecording(m);if(file){this.record(file);this.requestStatus();}}
      }catch{this.lastError='Invalid OBS event';}
    });
    ws.on('error',()=>{this.lastError='OBS connection failed; check configured endpoint and password environment variable';});
    ws.on('close',()=>{this.connected=false;this.pendingStatus=null;this.candidates.clear();if(!this.stopped){this.retry=setTimeout(()=>this.connect(),10000);this.retry.unref();}});
  }
  record(outputPath:string){
    // OBS may run on another configured host; only the completed basename is mapped
    // into this server's configured recording library. Never read arbitrary OBS paths.
    if(this.stopped)return;
    const file=path.join(this.recordings,path.basename(outputPath));const target=path.join(this.dir,randomUUID()+'.json');
    writeFileSync(target+'.tmp',JSON.stringify({path:file,source:outputPath,completedAt:new Date().toISOString()}));renameSync(target+'.tmp',target);
    void this.drain();
  }
  async drain(){
    if(this.draining||this.stopped)return;this.draining=true;
    try{for(const name of this.completionFiles()){
      if(this.stopped)break;const file=path.join(this.dir,name);
      try{const event=JSON.parse(readFileSync(file,'utf8'));await this.intake(event.path);if(this.stopped)break;unlinkSync(file);}
      catch(e){this.lastError=(e as Error).message.slice(0,300);this.log('recording completion held: '+this.lastError);}
    }}finally{this.draining=false;}
  }
  stop(){this.stopped=true;if(this.retry)clearTimeout(this.retry);if(this.sweep)clearInterval(this.sweep);if(this.statusTimer)clearInterval(this.statusTimer);this.socket?.terminate();}
}
