// Executable adapter for the board's existing codex, gh, cloud-task and af-network runners.
import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import path from 'node:path';
const endpoint=new URL(process.env.BUNNY_RUNTIME_FILES_URL??'');
if(endpoint.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(endpoint.hostname))throw Error('Private loopback transport required');
endpoint.protocol='ws:';endpoint.pathname='/tools';
const token=readFileSync(process.env.BUNNY_RUNTIME_FILES_TOKEN_FILE??'','utf8').trim();
const tool=process.env.BUNNY_RUNTIME_TOOL??path.basename(process.argv[1]);
const socket=new WebSocket(endpoint.toString(),{headers:{authorization:'Bearer '+token},maxPayload:8*1024*1024});
let ending=false;
function fail(){if(ending)return;ending=true;process.exitCode=1;socket.terminate();process.stdin.destroy();}
socket.on('open',()=>{
 socket.send(JSON.stringify({type:'start',tool,args:process.argv.slice(2)}));
 process.stdin.on('data',bytes=>{if(socket.bufferedAmount>4*1024*1024)return fail();socket.send(JSON.stringify({type:'stdin',bytes:Buffer.from(bytes).toString('base64')}));});
 process.stdin.on('end',()=>socket.send(JSON.stringify({type:'end'})));
 process.stdin.resume();
});
socket.on('message',raw=>{
 try{const msg=JSON.parse(raw.toString());
  if(msg.type==='stdout'||msg.type==='stderr')(msg.type==='stdout'?process.stdout:process.stderr).write(Buffer.from(msg.bytes,'base64'));
  else if(msg.type==='exit'){ending=true;process.exitCode=Number.isInteger(msg.code)?msg.code:1;process.stdin.destroy();socket.close();}
 }catch{fail();}
});
socket.on('error',e=>{process.stderr.write('Bunny runtime transport: '+e.message+'\n');fail();});socket.on('close',()=>{if(!ending)fail();});
process.on('SIGTERM',()=>{socket.close();process.stdin.destroy();process.exit(143);});
