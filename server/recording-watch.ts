import { finalizedRecording, readableRecording } from "./recording-probe";
export { finalizedRecording } from "./recording-probe";
import { hasRemoteRuntimeFiles, requestRuntimeFiles } from "./runtime-files";
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
// Poll a configured local recording inbox. Never sweep manually handled paths.
// Finalized MP4/MOV containers are eligible after a quiet period; fragmented or
// unfinished containers wait for explicit completion instead of transcribing a prefix.
import {constants,closeSync,existsSync,fstatSync,lstatSync,mkdirSync,openSync,readFileSync,readSync,readdirSync,realpathSync,renameSync,writeFileSync} from 'node:fs';
import path from 'node:path';
export class DirectoryRecordingSource {
 private timer:ReturnType<typeof setInterval>|null=null;
 private pollCount=0;private lastPollAt:string|null=null;
 private stopped=false;private polling=false;private lastError:string|null=null;
 private candidates=new Map<string,{fingerprint:string;at:number}>();
 private completed:Record<string,string>;private file:string;private ignored:Map<string,string>;private fromMs:number;
 constructor(dir:string,private recordings:string,history:Array<{path:string;sourceFingerprint?:string}>,private intake:(file:string)=>Promise<unknown>,private pollMs=5000,private settleMs=10000,watchFrom=new Date().toISOString(),private probe:(file:string)=>Promise<boolean>=readableRecording,private log:(message:string)=>void=()=>{}){
  mkdirSync(dir,{recursive:true});this.file=path.join(dir,'completed.json');this.completed=existsSync(this.file)?JSON.parse(readFileSync(this.file,'utf8')):{};
  this.recordings=hasRemoteRuntimeFiles({op:'recordings'})?path.resolve(recordings):realpathSync(recordings);this.ignored=new Map(history.map(i=>{let p:string;try{p=hasRemoteRuntimeFiles({op:'recordings'})?path.resolve(i.path):realpathSync(i.path);}catch{p=path.resolve(i.path);}return [p,i.sourceFingerprint??'unverified'];}));this.fromMs=Date.parse(watchFrom);if(!Number.isFinite(this.fromMs))throw new Error('watchFrom must be an ISO timestamp');
 }
 status(){return {kind:'directory',connected:!this.stopped,lastError:this.lastError,pendingCompletions:this.candidates.size,ignoredPaths:this.ignored.size,recordingsDir:this.recordings,pollMs:Math.max(1000,this.pollMs),pollCount:this.pollCount,lastPollAt:this.lastPollAt};}
 start(){this.log(`video intake: ${this.ignored.size} seeded recordings already processed (handled/skipped); watching ${this.recordings}; polling every ${Math.max(1000,this.pollMs)}ms`);void this.poll();this.timer=setInterval(()=>void this.poll(),Math.max(1000,this.pollMs));this.timer.unref();}
 stop(){this.stopped=true;if(this.timer)clearInterval(this.timer);}
 private save(){if(this.stopped)return;writeFileSync(this.file+'.tmp',JSON.stringify(this.completed,null,2));renameSync(this.file+'.tmp',this.file);}
 async poll(now=Date.now()){
  if(this.stopped||this.polling)return;this.polling=true;this.pollCount++;this.lastPollAt=new Date(now).toISOString();
  try{
   const remote=hasRemoteRuntimeFiles({op:'recordings'})?await requestRuntimeFiles({op:'recordings'}):null;
   if(remote&&remote.path!==this.recordings)throw new Error('Runtime recordings root does not match board configuration');
   const remoteEntries=new Map((remote?.recordings??[]).map(f=>[f.path,f]));
   const names=remote?[...remoteEntries.keys()].map(f=>path.basename(f)).sort():readdirSync(this.recordings).filter(n=>/\.(mp4|mov|mkv|webm)$/i.test(n)).sort();
   if(this.pollCount===1)this.log(`video intake: first inbox poll found ${names.length} recording files; ${this.ignored.size} seeded identities excluded`);
   if(names.length>5000)throw new Error('Recording inbox exceeds 5000 files; intake held');
   const seen=new Set<string>();const errors:string[]=[];
   for(const name of names){
    if(this.stopped)break;const file=path.join(this.recordings,name);
    try{
    const st=remoteEntries.get(file)??lstatSync(file);if(!remote&&!lstatSync(file).isFile())continue;seen.add(file);const fingerprint=`${st.size}:${st.mtimeMs}`;
    if(this.completed[file]===fingerprint||this.ignored.get(file)===fingerprint)continue;
    if(Math.max(st.birthtimeMs,st.mtimeMs)<this.fromMs){errors.push(`Historical file not in verified baseline held: ${name}`);continue;}
    const prior=this.candidates.get(file);
    if(!prior||prior.fingerprint!==fingerprint){this.candidates.set(file,{fingerprint,at:now});continue;}
    if(now-prior.at<this.settleMs)continue;
    if(!/\.(mp4|mov)$/i.test(name)||!(remote?remoteEntries.get(file)?.finalized:finalizedRecording(file))){errors.push(`Awaiting finalized MP4/MOV: ${name}; unfinished/fragmented or other formats need explicit completion`);continue;}
    if(!(remote?remoteEntries.get(file)?.readable:await this.probe(file)))throw new Error('Finalized recording is not readable: '+name);if(this.stopped)break;
    await this.intake(file);if(this.stopped)break;
    this.completed[file]=fingerprint;this.candidates.delete(file);this.save();
    }catch(e){errors.push(`${name}: ${(e as Error).message}`);}
   }
   for(const file of this.candidates.keys())if(!seen.has(file))this.candidates.delete(file);
   this.lastError=errors.length?errors.join("; ").slice(0,300):null;
  }catch(e){this.lastError=String((e as Error).message).slice(0,300);}finally{this.polling=false;}
 }
}
