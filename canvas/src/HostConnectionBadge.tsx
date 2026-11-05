import type { AgentView } from "./agents";

export function HostConnectionBadge({view}:{view:AgentView|null}) {
  const state=view?.connection?.state??"connecting";
  return <span data-testid="host-connection-state" data-state={state} role="status" title={view?.connection?.reason??view?.connection?.host??"Waiting for host status"} style={{fontSize:11,color:state==="connected"?"#397047":state==="failed"?"#b00020":"#8a651a",whiteSpace:"nowrap"}}>{state==="connected"?"● connected":state==="failed"?"● connection failed":state==="reconnecting"?"◌ reconnecting":"◌ connecting"}</span>;
}
