import { RuntimeFleet } from "./runtime-fleet";
import { RemoteAgents } from "./remote";
import { HostClients } from "./host-clients";
import { WebSocketServer, WebSocket } from "ws";
import { RuntimeTools, RuntimeToolsLive, type RuntimeToolProcess, type RuntimeToolRequest } from "./runtime-tools";
// M1 companion: file operations only, loopback-only, reached through a private SSH forward.
// Provider execution and credentials remain on the runtime host.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { Effect } from 'effect';
import { z } from 'zod';
import { RuntimeFilesLocalLive, runtimeFileRequest } from './runtime-files';
const env=process.env;
const required=(key:string)=>{const value=env[key];if(!value)throw Error(key+' is required');return value;};
const token=readFileSync(required('BUNNY_RUNTIME_FILES_TOKEN_FILE'),'utf8').trim();
if(!/^[a-f0-9]{64}$/.test(token))throw Error('Invalid companion credential');
const fleetRemote=new RemoteAgents(m=>console.error(m),{enabled:true,bin:required('BUNNY_RUNTIME_AF_NETWORK'),clients:new HostClients(m=>console.error(m))});
const fleet=new RuntimeFleet(required('BUNNY_RUNTIME_STATE'),fleetRemote);
const layer=RuntimeFilesLocalLive({fleet,stateDir:required('BUNNY_RUNTIME_STATE'),workspaceRoot:required('BUNNY_RUNTIME_WORKSPACES'),uploadRoot:required('BUNNY_RUNTIME_UPLOADS'),recordingsRoot:env.BUNNY_RUNTIME_RECORDINGS,mediaRoot:env.BUNNY_RUNTIME_MEDIA});
const fleetSeed=z.object({host:z.string().min(1).max(200),key:z.string().min(1).max(200),agentId:z.string().min(1).max(200),messageId:z.string().min(1).max(200),requestedAt:z.number(),phase:z.literal('prepared')}).strict();
const fleetInput=z.object({provider:z.string().min(1).max(200),title:z.string().max(1000),prompt:z.string().max(500000),modeId:z.string().max(200).optional(),labels:z.record(z.string(),z.string()).optional()}).strict();
const request=z.discriminatedUnion('op',[
 z.object({op:z.literal('fleet-hosts')}).strict(),
 z.object({op:z.literal('fleet-create'),intent:fleetSeed,input:fleetInput}).strict(),
 z.object({op:z.literal('fleet-send'),intent:fleetSeed,input:fleetInput}).strict(),
 z.object({op:z.literal('recordings')}).strict(),
 z.object({op:z.literal('inspect-video'),path:z.string().min(1).max(4096)}).strict(),
 z.object({op:z.literal('transcribe'),path:z.string().min(1).max(4096),hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
 z.object({op:z.literal('artifact'),path:z.string().min(1).max(4096),bundle:z.boolean().optional()}).strict(),
 z.object({op:z.literal('workspace'),board:z.string().min(1).max(200),readme:z.string().max(16000)}).strict(),
 z.object({op:z.literal('upload'),id:z.string().regex(/^[a-f0-9]{64}$/),name:z.string().min(1).max(200),hash:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.string().max(28*1024*1024)}).strict(),
]);
const tools=RuntimeToolsLive({codex:required('BUNNY_RUNTIME_CODEX'),gh:required('BUNNY_RUNTIME_GH'),'cloud-task':required('BUNNY_RUNTIME_CLOUD_TASK'),'af-network':required('BUNNY_RUNTIME_AF_NETWORK')},process.env);
const sockets=new WebSocketServer({noServer:true,maxPayload:8*1024*1024});
const server=createServer(async(req,res)=>{
 const supplied=Buffer.from(req.headers.authorization??'');const expected=Buffer.from('Bearer '+token);
 if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){res.writeHead(401);res.end();return;}
 if(req.method!=='POST'||req.url!=='/files'){res.writeHead(404);res.end();return;}
 try{
  const chunks:Buffer[]=[];let size=0;
  for await(const part of req){size+=part.length;if(size>29*1024*1024)throw Error('Runtime request exceeds limit');chunks.push(part);}
  const input=request.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  const out=await Effect.runPromise(runtimeFileRequest(input).pipe(Effect.provide(layer)));
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(out));
 }catch(e){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:(e as Error).message}));}
});
server.on('upgrade',(req,socket,head)=>{
 const supplied=Buffer.from(req.headers.authorization??'');const expected=Buffer.from('Bearer '+token);
 if(req.url!=='/tools'||supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){socket.destroy();return;}
 sockets.handleUpgrade(req,socket,head,ws=>sockets.emit('connection',ws));
});
sockets.on('connection',(ws:WebSocket)=>{
 let child:RuntimeToolProcess|undefined;let started=false;let closed=false;
 let tail=Promise.resolve();
 const send=(value:unknown)=>{if(ws.readyState!==WebSocket.OPEN)return;if(ws.bufferedAmount>8*1024*1024){ws.terminate();return;}ws.send(JSON.stringify(value));};
 ws.on('message',raw=>{tail=tail.then(async()=>{
  if(closed)return;const msg=JSON.parse(raw.toString());
  if(msg.type==='start'&&!started){started=true;child=await Effect.runPromise(Effect.flatMap(RuntimeTools,t=>t.start({tool:msg.tool,args:msg.args} as RuntimeToolRequest,{stdout:bytes=>send({type:'stdout',bytes:bytes.toString('base64')}),stderr:bytes=>send({type:'stderr',bytes:bytes.toString('base64')}),exit:code=>{send({type:'exit',code});ws.close();}})).pipe(Effect.provide(tools)));if(closed)child.stop();}
  else if(msg.type==='stdin'&&child&&typeof msg.bytes==='string')child.write(Buffer.from(msg.bytes,'base64'));
  else if(msg.type==='end'&&child)child.end();else throw Error('Invalid runtime stream');
 }).catch(()=>{child?.stop();send({type:'exit',code:1});ws.close();});});
 ws.on('close',()=>{closed=true;child?.stop();});ws.on('error',()=>{closed=true;child?.stop();});
});
server.requestTimeout=35000;server.headersTimeout=10000;
server.listen(Number(env.BUNNY_RUNTIME_FILES_PORT??18192),'127.0.0.1',()=>console.log(JSON.stringify({listening:'127.0.0.1',port:(server.address() as {port:number}).port})));
const stop=()=>{fleetRemote.stop();server.close(()=>process.exit(0));};process.on('SIGTERM',stop);process.on('SIGINT',stop);
