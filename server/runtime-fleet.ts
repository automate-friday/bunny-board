import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import path from 'node:path';
import type {RemoteAgents} from './remote';
import type {RemoteStartIntent} from './remote-start';

export interface FleetStartInput {provider:string;title:string;prompt:string;modeId?:string;labels?:Record<string,string>}
export interface StartHost {host:string;state:string;enabled:boolean;reason?:string;paseoServerId?:string}
// The companion owns paired sessions and a durable receipt for each board operation.
// Creation returns before the opener: the board must save its binding before send.
export class RuntimeFleet {
  private readonly pending=new Map<string,Promise<RemoteStartIntent>>();
  constructor(private readonly stateDir:string,private readonly remote:Pick<RemoteAgents,'startHosts'|'createOnHost'>){}
  hosts():Promise<StartHost[]> { return this.remote.startHosts(); }
  async start(stage:'create'|'send',seed:RemoteStartIntent,input:FleetStartInput):Promise<RemoteStartIntent>{
    const previous=this.pending.get(seed.key);
    const task=(previous??Promise.resolve()).catch(()=>{}).then(()=>this.run(stage,seed,input));
    this.pending.set(seed.key,task);
    try{return await task;}finally{if(this.pending.get(seed.key)===task)this.pending.delete(seed.key);}
  }
  private async run(stage:'create'|'send',seed:RemoteStartIntent,input:FleetStartInput){
    const dir=path.join(this.stateDir,'fleet-starts');mkdirSync(dir,{recursive:true,mode:0o700});
    const file=path.join(dir,createHash('sha256').update(seed.key).digest('hex')+'.json');
    let intent:RemoteStartIntent;
    try{intent=JSON.parse(readFileSync(file,'utf8'));}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;if(stage==='send')throw Error('Create receipt required before opener');intent={host:seed.host,key:seed.key,agentId:seed.agentId,messageId:seed.messageId,requestedAt:seed.requestedAt,phase:'prepared'};}
    for(const key of ['host','key','agentId','messageId','requestedAt'] as const)if(intent[key]!==seed[key])throw Error('Remote start identity changed');
    if(intent.phase==='complete'||(stage==='create'&&['created','sending'].includes(intent.phase)))return structuredClone(intent);
    if(stage==='send'&&!['created','sending'].includes(intent.phase))throw Error('Create must be acknowledged before opener');
    const persist=(value:RemoteStartIntent)=>{const tmp=file+'.'+randomUUID();writeFileSync(tmp,JSON.stringify(value),{mode:0o600});renameSync(tmp,file);};
    persist(intent);
    await this.remote.createOnHost(intent,input,persist,stage==='create');
    return structuredClone(intent);
  }
}
