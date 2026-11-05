import {hostMetrics} from './host-metrics';
// Deadlines apply to reads only. Mutations retain their stable operation identity
// and await the SDK's response/timeout before an explicit retry is scheduled.
export const PICKER_READ_MS = 8000;
export function transientDaemonError(error:unknown):boolean {
  return /timeout|timed out|not connected|disconnected|reconnecting|daemon client closed|client is disposed|connection (?:closed|lost|refused)|ECONNREFUSED|ECONNRESET|EPIPE|websocket|transport/i.test(String((error as Error)?.message ?? error));
}
// Only binding recovery uses these responses. A failed lookup or a create-ID
// conflict after an unknown response must retain the reserved identity. This does
// not authorize resending an uncertain message or choosing a replacement agent.
export function retryableBindingError(error:unknown):boolean {
  return transientDaemonError(error) || /subscription request failed|\bagent_id_conflict\b/i.test(String((error as Error)?.message ?? error));
}
export function threadNotLoaded(error:unknown):boolean {return /thread not loaded|thread.*not.*loaded/i.test(String((error as Error)?.message??error));}
export function missingAgent(error:unknown):boolean {
  return /not found|unknown agent|\b404\b/i.test(String((error as Error)?.message ?? error));
}
export function withDaemonRead<T>(read:()=>Promise<T>,ms=PICKER_READ_MS):Promise<T>{
  let timer:ReturnType<typeof setTimeout>;
  return Promise.race([Promise.resolve().then(read),new Promise<T>((_,reject)=>{
    timer=setTimeout(()=>reject(Object.assign(new Error('Paseo host disconnected or slow. Retry in a few seconds.'),{status:503,code:'PASEO_UNAVAILABLE',retryAfterMs:2000})),ms);
  })]).finally(()=>clearTimeout(timer));
}

// Log categories, never raw error bodies: daemon errors can contain prompt text,
// pairing URLs or credentials. Keep these names stable for per-host aggregation.
export function daemonFailureReason(error: unknown): string {
  const e = error as { code?: string; message?: string; cause?: { code?: string } };
  const text = `${e?.code ?? e?.cause?.code ?? ""} ${e?.message ?? String(error)}`;
  if (/ECONNRESET|socket hang up/i.test(text)) return "reset";
  if (/ECONNREFUSED|connection refused/i.test(text)) return "refused";
  if (/ENOTFOUND|EHOSTUNREACH|ENETUNREACH/i.test(text)) return "unreachable";
  if(e?.code==='PASEO_UNAVAILABLE')return 'timeout';
  if (/timeout|timed out|deadline/i.test(text)) return "timeout";
  if (/token does not authorise/i.test(text)) return "binding-revoked";
  if (/not connected|disconnected|reconnect|daemon client closed|client is disposed|connection closed|EPIPE|websocket.*closed/i.test(text)) return "disconnected";
  if (threadNotLoaded(error)) return "not-loaded";
  if (/not found|unknown agent/i.test(text)) return "missing";
  return "rejected";
}

export function hostOperation(log: (message: string) => void, host: string, operation: string) {
  const started = performance.now();
  const metrics = hostMetrics(log);
  let finished=false;
  return (error?: unknown) => {
    if(finished)return;finished=true;
    metrics.record(host,operation,Math.round(performance.now()-started),error===undefined?undefined:daemonFailureReason(error));
  };
}
