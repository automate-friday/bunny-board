import {workspaceDeadline} from './board-workspaces';
import path from 'node:path';

export interface FleetWorkspace {
  id:string;
  workspaceDirectory?:string|null;
  projectRootPath?:string|null;
  workspaceKind?:string;
  archivingAt?:string|null;
  archivedAt?:string|null;
}
export function readFleetWorkspaces(raw?:string):Record<string,string>{
  if(!raw)return {};
  let value:unknown;
  try{value=JSON.parse(raw);}catch{throw Error('BUNNY_RUNTIME_FLEET_WORKSPACES must be a JSON object of host to exact workspace ID');}
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.values(value).some(v=>typeof v!=='string'||!v.trim()))throw Error('BUNNY_RUNTIME_FLEET_WORKSPACES must contain nonempty workspace strings');
  if(Object.values(value).some(v=>(v as string).includes('/')||(v as string).includes('\\')))throw Error('BUNNY_RUNTIME_FLEET_WORKSPACES requires exact workspace IDs; directory values are not supported');
  return value as Record<string,string>;
}
export const canonicalFleetDirectory=(value:string)=>path.posix.normalize(value).replace(/\/+$/, "")||"/";
export function selectFleetWorkspace<T extends FleetWorkspace>(host:string,target:string|undefined,entries:readonly T[]):T{
  if(!target)throw Error(`${host}: no fleet workspace configured (BUNNY_RUNTIME_FLEET_WORKSPACES)`);
  if(target.includes('/')||target.includes('\\'))throw Error(`${host}: configured workspace ${target} requires an exact workspace ID; directory values are not supported`);
  const matches=entries.filter(w=>{
    const cwd=w.workspaceDirectory||w.projectRootPath;
    if(w.archivingAt||w.archivedAt||w.workspaceKind==='worktree'||!cwd||!path.posix.isAbsolute(cwd))return false;
    return w.id===target;
  });
  if(!matches.length)throw Error(`${host}: configured workspace ${target} not found (must be active and not a worktree)`);
  if(matches.length!==1)throw Error(`${host}: configured workspace ${target} is ambiguous`);
  return matches[0];
}

// SDK 0.11.4 ref(id).refresh() also scans pages, without a cursor/page bound.
// Use the list transport directly so malformed pagination cannot loop forever.
export async function resolveFleetWorkspace<T extends FleetWorkspace>(host:string,target:string|undefined,list:(options?:{page:{limit:number;cursor?:string}})=>Promise<{entries:T[];pageInfo?:{nextCursor?:string|null;hasMore?:boolean}}>):Promise<T>{
  if(!target) return selectFleetWorkspace(host,target,[]);
  if(target.includes('/')||target.includes('\\'))return selectFleetWorkspace(host,target,[]);
  const seen=new Set<string>();
  let cursor:string|undefined;
  for(let page=0;page<20;page++){
    const result=await workspaceDeadline(list({page:{limit:200,...(cursor?{cursor}:{})}}),10000,`${host}: remote workspace lookup`);
    const matches=result.entries.filter(entry=>entry.id===target);
    if(matches.length)return selectFleetWorkspace(host,target,matches);
    const next=result.pageInfo?.nextCursor;
    if(!next){
      if(result.pageInfo?.hasMore)throw Error(`${host}: workspace pagination has more results but no next cursor`);
      return selectFleetWorkspace(host,target,[]);
    }
    if(seen.has(next))throw Error(`${host}: workspace pagination repeated cursor`);
    seen.add(next);cursor=next;
  }
  throw Error(`${host}: workspace lookup exceeded 20 pages for ${target}`);
}
