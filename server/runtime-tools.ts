import { Context, Effect, Layer } from 'effect';
import { spawn } from 'node:child_process';
export interface RuntimeToolRequest {tool:'codex'|'gh'|'cloud-task'|'af-network';args:string[]}
export interface RuntimeToolProcess {write:(bytes:Buffer)=>void;end:()=>void;stop:()=>void}
export interface RuntimeToolEvents {stdout:(bytes:Buffer)=>void;stderr:(bytes:Buffer)=>void;exit:(code:number)=>void}
export class RuntimeTools extends Context.Tag('bunny/RuntimeTools')<RuntimeTools,{
 start:(input:RuntimeToolRequest,events:RuntimeToolEvents)=>Effect.Effect<RuntimeToolProcess,Error>;
}>() {}
export function validRuntimeTool(input:RuntimeToolRequest){
 if(!input||!Array.isArray(input.args)||input.args.length>80||input.args.some(a=>typeof a!=='string'||a.length>12000||a.includes('\0')))return false;
 if(input.tool==='codex')return input.args.length===1&&input.args[0]==='app-server';
 if(input.tool==='gh'){
  if(input.args[0]!=='api'||input.args.some(a=>a==='--input'||a.startsWith('--input=')))return false;
  let explicitGet=false;
  for(let i=1;i<input.args.length;i++){const a=input.args[i];if(a==='-X'||a==='--method'){if(input.args[++i]!=='GET')return false;explicitGet=true;}else if(a.startsWith('-X')||a.startsWith('--method=')){if(a!=='-XGET'&&a!=='--method=GET')return false;explicitGet=true;}}
  return explicitGet||!input.args.some(a=>a==='-f'||a==='-F'||a.startsWith('--field')||a.startsWith('--raw-field')||/^-f.|^-F./.test(a));
 }
 if(input.tool==='cloud-task')return ['doctor','status','session'].includes(input.args[0]);
 if(input.tool==='af-network')return ['discover','sessions','read','send'].includes(input.args[0]);
 return false;
}
export const RuntimeToolsMock=Layer.succeed(RuntimeTools,{start:(input:RuntimeToolRequest,events:RuntimeToolEvents)=>Effect.sync(()=>{
 if(!validRuntimeTool(input))throw Error('Runtime command is not permitted');
 return {write:(bytes:Buffer)=>events.stdout(bytes),end:()=>events.exit(0),stop:()=>events.exit(143)};
})});
export function RuntimeToolsLive(bins:Record<RuntimeToolRequest['tool'],string>,env:NodeJS.ProcessEnv){
 return Layer.succeed(RuntimeTools,{start:(input:RuntimeToolRequest,events:RuntimeToolEvents)=>Effect.try({try:()=>{
  if(!validRuntimeTool(input))throw Error('Runtime command is not permitted');
  const child=spawn(bins[input.tool],input.args,{env:{...env,AF_NETWORK_SERVICE_ID:'bunny'},stdio:['pipe','pipe','pipe']});
  let finished=false;const finish=(code:number)=>{if(!finished){finished=true;events.exit(code);}};
  child.stdout.on('data',events.stdout);child.stderr.on('data',events.stderr);child.stdin.on('error',()=>{});
  child.on('error',e=>{events.stderr(Buffer.from(e.message));finish(1);});child.on('close',code=>finish(code??1));
  return {write:(bytes:Buffer)=>{if(child.stdin.writableLength>4*1024*1024){child.kill();throw Error('Runtime input backpressure limit');}child.stdin.write(bytes);},end:()=>child.stdin.end(),stop:()=>{child.kill('SIGTERM');setTimeout(()=>{if(!finished)child.kill('SIGKILL');},5000).unref();}};
 },catch:e=>e instanceof Error?e:new Error(String(e))})});
}
