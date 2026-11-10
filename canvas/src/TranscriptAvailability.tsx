import {agentStore,type AgentView} from './agents';

export function TranscriptAvailability({view}:{view:AgentView|null}){
 if(view?.availability!=='not-loaded')return null;
 return <div data-testid="transcript-not-loaded" role="status" onPointerDown={e=>e.stopPropagation()} style={{padding:'8px 12px',fontSize:12,color:'light-dark(#7c4a03, hsl(35 88% 74%))'}}>
  Not loaded. {view.paseoUrl?<a href={view.paseoUrl}>Resume in Paseo</a>:<span>Resume this conversation in Paseo.</span>}
  {' '}<button type="button" onClick={()=>agentStore.prefetch(view.agentId,true,true)}>Retry after resuming</button>
 </div>;
}
