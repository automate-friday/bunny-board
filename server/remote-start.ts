import {selectFleetWorkspace,resolveFleetWorkspace,canonicalFleetDirectory} from "./fleet-workspaces";
import type {CreateAgentRequestOptions} from '@getpaseo/client/internal/daemon-client';
import type {HostSession} from './host-clients';
import {workspaceDeadline} from './board-workspaces';

export interface RemoteStartIntent {
  host: string;
  requestedAt: number;
  observedAgentId?: string;
  key: string;
  agentId: string;
  messageId: string;
  phase: 'prepared'|'creating'|'created'|'sending'|'complete'|'unknown';
  payload?: CreateAgentRequestOptions;
  prompt?: string;
}
type ServerInfo = {version?:string|null;features?:{creationLifecycle?:boolean;agentRequestReceipts?:boolean};permissions?:string[]};
export function remoteStartCapability(info:ServerInfo|null):string|undefined {
  const v=info?.version?.match(/^(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number);
  if(!v || (v[0]===0 && (v[1]<11 || (v[1]===11 && v[2]<4))))return 'Requires Paseo 0.11.4 or newer';
  if(!info?.features?.creationLifecycle || !info.features.agentRequestReceipts)return 'Host lacks durable creation and observation';
  for(const permission of ['workspace.read','workspace.write'])if(info.permissions&&!info.permissions.includes(permission))return `Pairing lacks ${permission}`;
}

// The modern SDK observes this SAME key on reconnect. Its pending operation is
// retained after our UI deadline; replay never invents a new creation identity.
export async function runRemoteStart(session:HostSession,intent:RemoteStartIntent,
  input:{workspaceTarget?:string;provider:string;title:string;prompt:string;modeId?:string;thinkingOptionId?:string;labels?:Record<string,string>},persist:(intent:RemoteStartIntent)=>void,
  timeoutMs=30000,createOnly=false):Promise<void> {
  const reason=remoteStartCapability(session.daemon.getLastServerInfoMessage());
  if(reason)throw Error(`${intent.host}: ${reason}`);
  if(intent.phase==='complete')return;
  if(!input.workspaceTarget)selectFleetWorkspace(intent.host,undefined,[]);
  const workspace=await resolveFleetWorkspace(intent.host,input.workspaceTarget,options=>session.api.workspaces.list(options));
  const cwd=workspace.workspaceDirectory||workspace.projectRootPath!;
  const frozenCwd=intent.payload?.config?.cwd??intent.payload?.cwd;
  if(intent.payload&&(intent.payload.workspaceId!==workspace.id||typeof frozenCwd!=="string"||canonicalFleetDirectory(frozenCwd)!==canonicalFleetDirectory(cwd)))throw Error(`${intent.host}: pending remote start workspace differs from configured workspace ${input.workspaceTarget}; reconcile ${intent.key}`);
  if(!intent.payload){
    const [provider,...model]=input.provider.split('/');
    if(!model.length)throw Error('Remote start requires provider/model');
    intent.payload=JSON.parse(JSON.stringify({agentId:intent.agentId,idempotencyKey:intent.key,workspaceId:workspace.id,...(input.labels?{labels:input.labels}:{}),
      config:{provider,model:model.join('/'),cwd,title:input.title,...(input.modeId?{modeId:input.modeId}:{}),...(input.thinkingOptionId?{thinkingOptionId:input.thinkingOptionId}:{})}}));
    intent.prompt=input.prompt;
    persist(intent); // Must succeed before any external mutation.
  }
  try{
    if(intent.phase!=='created'&&intent.phase!=='sending'){
      intent.phase='creating';
      try { persist(intent); } catch(error) { intent.phase='prepared';delete intent.payload;throw Error(`Remote start not dispatched: could not save intent. ${(error as Error).message}`); }
      const agent=await workspaceDeadline(session.daemon.createAgent(intent.payload!),timeoutMs,'Remote create acknowledgement');
      if(agent.id!==intent.agentId){intent.observedAgentId=agent.id;throw Error(`Host assigned ${agent.id}, expected ${intent.agentId}`);}
      intent.phase='created';persist(intent);
    }
    if(createOnly)return;
    intent.phase='sending';persist(intent);
    await workspaceDeadline(session.daemon.sendMessage(intent.agentId,intent.prompt!,{messageId:intent.messageId}),timeoutMs,'Remote opening message acknowledgement');
    intent.phase='complete';persist(intent);
  }catch(error){
    // Sending can be retried independently with its stable message identity.
    if(intent.phase==='prepared')throw error;
    if(intent.phase!=='sending')intent.phase='unknown';
    persist(intent);
    throw Error(`${intent.host}: outcome-unknown for ${intent.key}; recheck this same operation. ${(error as Error).message}`);
  }
}
