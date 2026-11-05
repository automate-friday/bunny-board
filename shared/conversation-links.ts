// Start target maps onto the existing create request; builder applies only to workers.
export function initialRunsOn(info?: { cloudDefault?: boolean } | null, saved?: string | null): boolean {
  if (saved === "worker") return true;
  if (saved === "runtime") return false;
  return info?.cloudDefault ?? false;
}
export function runsOnRequest<P extends string>(cloud: boolean, cloudProvider: P, host?: string) {
  if (host) return { cloud: false, host };
  return cloud ? { cloud, cloudProvider } : { cloud };
}

export interface PaseoLinkState { url: string | null; hidden: boolean; reason?: string }
export function paseoLink(input: {
  agentId?: string;
  serverId?: string | null;
  snapshotUrl?: string | null;
  remoteHost?: string | null;
  remoteServerIds?: Record<string, string>;
  capabilities?: { paseoLink?: boolean; paseoServerId?: string | null } | null;
}): PaseoLinkState {
  if (input.capabilities?.paseoLink === false) return { url: null, hidden: true };
  const serverId = input.remoteHost ? input.remoteServerIds?.[input.remoteHost] : input.serverId;
  const url = input.agentId && serverId
    ? `paseo://h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(input.agentId)}`
    : !input.remoteHost ? input.snapshotUrl : null;
  return { url: url || null, hidden: false, reason: url ? undefined : input.remoteHost
    ? `Remote host ${input.remoteHost}: Paseo server id unknown.`
    : 'No Paseo server id configured.' };
}

export function fleetHostsForRuntime<T extends {host:string}>(hosts:T[],runtime:string):T[] {
  const normalize=(host:string)=>host.toLowerCase().replace(/\.local$/, "");
  const seen=new Set([normalize(runtime)]);
  return hosts.filter(h=>{const key=normalize(h.host);if(seen.has(key))return false;seen.add(key);return true;});
}
