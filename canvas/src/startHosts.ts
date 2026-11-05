import {api} from './api';
export type StartHost={host:string;state:string;enabled:boolean;reason?:string};
type Result={hosts:StartHost[];note?:string;refreshing:boolean};
let memo:Result={hosts:[],refreshing:true};
let at=0;
let pending:Promise<Result>|null=null;
export const startHostsMemo=()=>memo;
function load(force:boolean){
 if(pending)return pending;
 pending=api<Result>(`/api/ui/start-hosts${force?'?fresh=1':''}`).then(result=>{memo=result;at=Date.now();return result;}).finally(()=>{pending=null;});
 return pending;
}
// Desktop and phone share last-known choices and one HTTP read in flight.
export function watchStartHosts(onResult:(r:Result)=>void,onError:(e:Error)=>void,force=false){
 let gone=false,timer:ReturnType<typeof setTimeout>|undefined;
 const update=async(fresh=false)=>{
  try{const result=await load(fresh);if(gone)return;onResult(result);if(result.refreshing)timer=setTimeout(()=>void update(),750);}
  catch(error){if(!gone)onError(error as Error);}
 };
 onResult(memo);
 if(force||memo.refreshing||Date.now()-at>=(memo.hosts.some(h=>!h.enabled)?1000:60000))void update(force);
 return ()=>{gone=true;if(timer)clearTimeout(timer);};
}
