import {Context,Effect,Layer} from 'effect';
import {readFile,mkdir,writeFile,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
export const DEFAULT_WORKER_SETTINGS={maxConcurrentWorkers:10,ttlSeconds:86400};
export function validateWorkerSettings(value){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Worker settings must be an object');
 const {maxConcurrentWorkers,ttlSeconds}=value;
 if(!Number.isInteger(maxConcurrentWorkers)||maxConcurrentWorkers<1||maxConcurrentWorkers>25)throw Error('Concurrent workers must be between 1 and 25');
 if(!Number.isInteger(ttlSeconds)||ttlSeconds<180||ttlSeconds>259200)throw Error('Maximum age must be between 3 minutes and 72 hours');
 return {maxConcurrentWorkers,ttlSeconds};
}
export class WorkerSettings extends Context.Tag('bunny/WorkerSettings')() {}
const attempt=fn=>Effect.tryPromise({try:fn,catch:e=>e instanceof Error?e:new Error(String(e))});
export function WorkerSettingsLive(file,defaults=DEFAULT_WORKER_SETTINGS){
 const fallback=validateWorkerSettings(defaults);
 return Layer.succeed(WorkerSettings,{
  read:()=>attempt(async()=>{try{return validateWorkerSettings(JSON.parse(await readFile(file,'utf8')));}catch(e){if(e.code==='ENOENT')return {...fallback};throw e;}}),
  save:value=>attempt(async()=>{const next=validateWorkerSettings(value);await mkdir(path.dirname(file),{recursive:true,mode:0o700});const tmp=file+'.'+randomUUID();try{await writeFile(tmp,JSON.stringify(next),{mode:0o600});await rename(tmp,file);}finally{await rm(tmp,{force:true});}return next;})
 });
}
export function WorkerSettingsMock(defaults=DEFAULT_WORKER_SETTINGS){let current=validateWorkerSettings(defaults);return Layer.succeed(WorkerSettings,{
 read:()=>Effect.sync(()=>({...current})),save:value=>Effect.try({try:()=>{current=validateWorkerSettings(value);return {...current};},catch:e=>e})
});}
export const workerSettingsRuntime=layer=>({read:()=>Effect.runPromise(Effect.flatMap(WorkerSettings,s=>s.read()).pipe(Effect.provide(layer))),save:value=>Effect.runPromise(Effect.flatMap(WorkerSettings,s=>s.save(value)).pipe(Effect.provide(layer)))});
