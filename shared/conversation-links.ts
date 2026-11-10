// Start target maps onto the existing create request; builder applies only to workers.
export function initialRunsOn(info?: { cloudDefault?: boolean; defaultProvider?: string } | null, saved?: string | null): boolean {
  if (upstashDefault(info)) return false;
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
  const serverId = input.capabilities?.paseoServerId ?? (input.remoteHost ? input.remoteServerIds?.[input.remoteHost] : input.serverId);
  const url = input.agentId && serverId
    ? `paseo://h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(input.agentId)}`
    : !input.remoteHost ? input.snapshotUrl : null;
  return { url: url || null, hidden: false, reason: url ? undefined : input.remoteHost
    ? `Remote host ${input.remoteHost}: Paseo server id unknown.`
    : 'No Paseo server id configured.' };
}

// Start form "Runs on" wording: plain machine names, never "worker". A cloud start still runs
// the agent on the board's runtime machine; the cloud only writes the code (skills/cloud-dev).
const sameHost = (a: string, b: string) => !!a && !!b && a.toLowerCase().replace(/\.local$/, "") === b.toLowerCase().replace(/\.local$/, "");
export function machineLabel(host: string, boardHost?: string | null): string {
  if (!host) return "the board's Mac";
  return sameHost(host, boardHost ?? "") ? `${host} (the board's Mac)` : host;
}
export function runsOnSummary(o: { machine: string; boardHost?: string | null; cloudProvider?: "claude" | "codex" | null }): string {
  const where = `The agent runs on ${machineLabel(o.machine, o.boardHost)}.`;
  if (!o.cloudProvider) return where;
  return `${where} Code changes go to ${o.cloudProvider === "codex" ? "a Codex cloud task" : "a Claude Code cloud session"}.`;
}

export function fleetHostsForRuntime<T extends {host:string}>(hosts:T[],runtime:string):T[] {
  const normalize=(host:string)=>host.toLowerCase().replace(/\.local$/, "");
  const seen=new Set([normalize(runtime)]);
  return hosts.filter(h=>{const key=normalize(h.host);if(seen.has(key))return false;seen.add(key);return true;});
}

export function upstashDefault(info?: {defaultProvider?: string} | null): boolean {
  return /^upstash-(codex|claude)(\/|$)/.test(info?.defaultProvider ?? "");
}
export function executionProvider(chosen: string, defaultProvider: string, host?: string): string {
  if (!upstashDefault({defaultProvider})) return chosen;
  const base = chosen.replace(/^upstash-/, "");
  if (host) return base;
  if (!/^(codex|claude)(\/|$)/.test(base)) throw new Error("Upstash supports Codex and Claude; choose one of those models.");
  return `upstash-${base}`;
}
export function executionLabel(host: string): string { return host.match(/(?:^|-)(m[0-9]+)$/i)?.[1].toUpperCase() ?? host; }
