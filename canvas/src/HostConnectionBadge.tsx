import type { AgentView } from "./agents";

export function HostConnectionBadge({view}:{view:AgentView|null}) {
  const state=view?.connection?.state??"connecting";
  return <span data-testid="host-connection-state" data-state={state} role="status" title={view?.connection?.reason??view?.connection?.host??"Waiting for host status"} style={{fontSize:11,color:state==="connected"?"light-dark(#397047, hsl(135 50% 74%))":state==="failed"?"light-dark(#b00020, hsl(349 88% 74%))":"light-dark(#8a651a, hsl(40 68% 74%))",whiteSpace:"nowrap"}}>{state==="connected"?"● connected":state==="failed"?"● connection failed":state==="reconnecting"?"◌ reconnecting":"◌ connecting"}</span>;
}
