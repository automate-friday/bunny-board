import type { RuntimeFleet, StartHost, FleetStartInput } from "./runtime-fleet";
import type { RemoteStartIntent } from "./remote-start";
import { createReadStream } from "node:fs";
import { copyFile, lstat, readdir, stat, link, rm } from "node:fs/promises";
import { offlineTranscribe } from "./video-transcribe";
import { finalizedRecording, readableRecording } from "./recording-probe";
// The board owns durable board state; the runtime host owns agent files.
// All new external I/O is supplied by a Live layer. Tests default to the Mock.
import { Context, Effect, Layer } from 'effect';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readArtifactFile } from './artifact-files';
import { collectArtifactBundle } from './artifact-bundle';

export type RuntimeFileRequest =
 | {op:'fleet-hosts'}
 | {op:'fleet-create'|'fleet-send';intent:RemoteStartIntent;input:FleetStartInput}
 | {op:'artifact';path:string;bundle?:boolean}
 | {op:'workspace';board:string;readme:string}
 | {op:'upload';id:string;name:string;hash:string;bytes:string}
 | {op:'recordings'} | {op:'inspect-video';path:string} | {op:'transcribe';path:string;hash:string};
export interface RuntimeVideo {id:string;path:string;hash:string;size:number;mtimeMs:number;transcript?:string;timedTranscript?:string;text?:string;timedText?:string}
export interface RuntimeRecording {path:string;size:number;mtimeMs:number;birthtimeMs:number;finalized:boolean;readable:boolean}
export interface RuntimeFileReply {path:string;hosts?:StartHost[];intent?:RemoteStartIntent;video?:RuntimeVideo;recordings?:RuntimeRecording[];files?:Array<{name:string;bytes:string}>;entryName?:string}
export class RuntimeFiles extends Context.Tag('bunny/RuntimeFiles')<RuntimeFiles,{
 readonly request:(input:RuntimeFileRequest)=>Effect.Effect<RuntimeFileReply,Error>;
}>() {}
const error=(e:unknown)=>e instanceof Error?e:new Error(String(e));
export const runtimeFileRequest=(input:RuntimeFileRequest)=>Effect.flatMap(RuntimeFiles,s=>s.request(input));
export const RuntimeFilesMock=(answers:ReadonlyMap<string,RuntimeFileReply>=new Map())=>Layer.succeed(RuntimeFiles,{
 request:(input:RuntimeFileRequest)=>Effect.suspend(()=>{const reply=answers.get(JSON.stringify(input));return reply?Effect.succeed(structuredClone(reply)):Effect.fail(new Error('Runtime file request unavailable'));}),
});
export interface RuntimeFilesLocalOptions {fleet?:Pick<RuntimeFleet,'hosts'|'start'>;stateDir:string;workspaceRoot:string;uploadRoot:string;recordingsRoot?:string;mediaRoot?:string}
export function RuntimeFilesLocalLive(options:RuntimeFilesLocalOptions) {
 const pending=new Map<string,Promise<RuntimeFileReply>>();
 const probeCache=new Map<string,{key:string;finalized:boolean;readable:boolean}>();
 const hashFile=async(file:string)=>{const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');};
 const inspectVideo=async(file:string):Promise<RuntimeVideo>=>{
  if(!options.recordingsRoot)throw Error('Recording root is not configured');
  const root=await realpath(options.recordingsRoot);const resolved=await realpath(file);const before=await stat(resolved);
  if(!resolved.startsWith(root+path.sep)||!before.isFile()||! /\.(mp4|mov|mkv|webm)$/i.test(resolved))throw Error('Expected a video in the configured recording root');
  const hash=await hashFile(resolved);const after=await stat(resolved);
  if(before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw Error('Recording is still changing');
  return {id:createHash('sha256').update(resolved+'\0'+hash).digest('hex'),path:resolved,hash,size:after.size,mtimeMs:after.mtimeMs};
 };
 return Layer.succeed(RuntimeFiles,{request:(input:RuntimeFileRequest)=>Effect.tryPromise({try:async()=>{
  if(input.op==='fleet-hosts'){if(!options.fleet)throw Error('Fleet runtime capability unavailable');return {path:'',hosts:await options.fleet.hosts()};}
  if(input.op==='fleet-create'||input.op==='fleet-send'){if(!options.fleet)throw Error('Fleet runtime capability unavailable');return {path:'',intent:await options.fleet.start(input.op==='fleet-create'?'create':'send',input.intent,input.input)};}
  if(input.op==='recordings'){
   if(!options.recordingsRoot)throw Error('Recording root is not configured');const root=await realpath(options.recordingsRoot);
   const names=(await readdir(root)).filter(n=>/\.(mp4|mov|mkv|webm)$/i.test(n));if(names.length>5000)throw Error('Recording inbox exceeds5000files');
   const recordings:RuntimeRecording[]=[];
   for(const name of names){const file=path.join(root,name);const st=await lstat(file);if(!st.isFile())continue;const key=`${st.size}:${st.mtimeMs}`;let probe=probeCache.get(file);if(!probe||probe.key!==key){const finalized=finalizedRecording(file);probe={key,finalized,readable:finalized?await readableRecording(file).catch(()=>false):false};probeCache.set(file,probe);}recordings.push({path:file,size:st.size,mtimeMs:st.mtimeMs,birthtimeMs:st.birthtimeMs,finalized:probe.finalized,readable:probe.readable});}
   const seen=new Set(recordings.map(f=>f.path));for(const file of probeCache.keys())if(!seen.has(file))probeCache.delete(file);
   return {path:root,recordings};
  }
  if(input.op==='inspect-video')return {path:input.path,video:await inspectVideo(input.path)};
  if(input.op==='transcribe'){
   if(!options.mediaRoot||!/^[a-f0-9]{64}$/.test(input.hash))throw Error('Invalid media request');
   const key=JSON.stringify([input.path,input.hash]);let work=pending.get(key);
   if(!work){work=(async()=>{
    const video=await inspectVideo(input.path);if(video.hash!==input.hash)throw Error('Recording bytes changed');
    const out=path.join(options.mediaRoot!,video.id);await mkdir(out,{recursive:true});const source=path.join(out,'source'+path.extname(video.path));
    let text:string;try{text=await readFile(path.join(out,'transcript.txt'),'utf8');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;text='';}
    if(!text.trim()){await copyFile(video.path,source);if(await hashFile(source)!==video.hash)throw Error('Recording changed during freeze');text=await offlineTranscribe(source,out);}
    if(!text.trim())throw Error('Transcription returned no text');
    let timedText:string|undefined;try{timedText=await readFile(path.join(out,'parakeet.srt'),'utf8');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    return {path:video.path,video:{...video,transcript:path.join(out,'transcript.txt'),text,...(timedText?{timedTranscript:path.join(out,'parakeet.srt'),timedText}:{})}};
   })().finally(()=>pending.delete(key));pending.set(key,work);}
   return await work;
  }
  if(input.op==='artifact'){
   const bytes=readArtifactFile(input.path,options.stateDir);
   if(input.bundle){const bundle=collectArtifactBundle(input.path,p=>readArtifactFile(p,options.stateDir));return {path:input.path,entryName:bundle.entryName,files:bundle.files.map(f=>({name:f.name,bytes:f.bytes.toString('base64')}))};}
   return {path:input.path,files:[{name:path.basename(input.path),bytes:bytes.toString('base64')}]};
  }
  if(input.op==='workspace'){
   if(!input.board||input.board==='.'||input.board==='..'||input.board.length>200||input.readme.length>16000)throw Error('Invalid workspace request');
   await mkdir(options.workspaceRoot,{recursive:true});const root=await realpath(options.workspaceRoot);const dir=path.join(root,encodeURIComponent(input.board));
   await mkdir(dir,{recursive:true});if(await realpath(dir)!==dir)throw Error('Workspace refuses symlink directory');
   try{await writeFile(path.join(dir,'README.md'),input.readme,{flag:'wx'});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
   return {path:dir};
  }
  if(input.op==='upload'){
   if(!/^[a-f0-9]{64}$/.test(input.id)||!/^[a-f0-9]{64}$/.test(input.hash)||input.name!==path.basename(input.name)||!input.name||input.name==='.'||input.name==='..'||/[\\\x00-\x1f\x7f]/.test(input.name)||input.name.length>200)throw Error('Invalid upload identity');
   const bytes=Buffer.from(input.bytes,'base64');if(!bytes.length||bytes.length>20*1024*1024||createHash('sha256').update(bytes).digest('hex')!==input.hash)throw Error('Upload checksum mismatch');
   await mkdir(options.uploadRoot,{recursive:true});const root=await realpath(options.uploadRoot);const dir=path.join(root,input.id);await mkdir(dir,{recursive:true});if(await realpath(dir)!==dir)throw Error('Upload refuses symlink directory');
   const file=path.join(dir,input.name);
   try{const prior=await readFile(file);if(createHash('sha256').update(prior).digest('hex')!==input.hash)throw Error('Upload id already has different content');return {path:file};}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
   const temp=file+'.'+randomUUID()+'.tmp';await writeFile(temp,bytes,{mode:0o600,flag:'wx'});
   try{await link(temp,file);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST'||createHash('sha256').update(await readFile(file)).digest('hex')!==input.hash)throw e;}finally{await rm(temp,{force:true});}return {path:file};
  }
  throw Error('Unknown runtime file operation');
 },catch:error})});
}
export function RuntimeFilesRemoteLive(url:string,tokenFile:string) {
 const endpoint=new URL(url);
 // Reach through the private transport. Never send credentials to redirects or guessed public hosts.
 if(endpoint.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(endpoint.hostname)||endpoint.username||endpoint.password)throw Error('Runtime files requires a loopback HTTP transport');
 return Layer.succeed(RuntimeFiles,{request:(input:RuntimeFileRequest)=>Effect.tryPromise({try:async()=>{
  const token=(await readFile(tokenFile,'utf8')).trim();if(!/^[a-f0-9]{64}$/.test(token))throw Error('Invalid runtime file credential');
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),input.op==='transcribe'?30*60*1000:30000);
  try{
  const reply=await fetch(new URL('/files',endpoint),{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(input),redirect:'error',signal:controller.signal});
  const text=await reply.text();if(text.length>30*1024*1024)throw Error('Runtime file reply exceeds limit');
  const value=JSON.parse(text);if(!reply.ok){
    if(input.op==='fleet-hosts'&&reply.status===400&&typeof value.error==='string'&&/No matching discriminator|Invalid discriminator|Unsupported.*fleet/i.test(value.error))throw Error('runtime companion lacks fleet support');
    throw Error(value.error??'Runtime host unavailable');
  }
  if(!value||typeof value.path!=='string'||(value.files&&(!Array.isArray(value.files)||value.files.length>100||value.files.some((f:{name?:unknown;bytes?:unknown})=>typeof f.name!=='string'||typeof f.bytes!=='string'))))throw Error('Invalid runtime file reply');
  return value as RuntimeFileReply;
  }finally{clearTimeout(timer);}
 },catch:error})});
}
let configured:Layer.Layer<RuntimeFiles>=RuntimeFilesMock();
let remote=false;
let legacy:Layer.Layer<RuntimeFiles>|null=null;
let legacyRoot='';
const legacyOwns=(input?:RuntimeFileRequest)=>!!legacy&&!!input&&(
 ['recordings','inspect-video','transcribe'].includes(input.op)||
 (input.op==='artifact'&&!!legacyRoot&&input.path.startsWith(legacyRoot+'/')));
export function configureRuntimeFiles(env:NodeJS.ProcessEnv=process.env){
 remote=!!env.BUNNY_RUNTIME_FILES_URL;
 configured=remote?RuntimeFilesRemoteLive(env.BUNNY_RUNTIME_FILES_URL!,env.BUNNY_RUNTIME_FILES_TOKEN_FILE??''):RuntimeFilesMock();
 legacy=env.BUNNY_LEGACY_RUNTIME_FILES_URL?RuntimeFilesRemoteLive(env.BUNNY_LEGACY_RUNTIME_FILES_URL,env.BUNNY_LEGACY_RUNTIME_FILES_TOKEN_FILE??''):null;
 legacyRoot=(env.BUNNY_LEGACY_RUNTIME_FILES_ROOT??'').replace(/\/+$/,'');
}
export const hasRemoteRuntimeFiles=(input?:RuntimeFileRequest)=>remote||legacyOwns(input);
export const requestRuntimeFiles=(input:RuntimeFileRequest)=>Effect.runPromise(runtimeFileRequest(input).pipe(Effect.provide(legacyOwns(input)?legacy!:configured)));
