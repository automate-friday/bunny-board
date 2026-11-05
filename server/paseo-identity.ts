// Explicit configuration wins. Otherwise use the identity advertised by the
// selected daemon, which may be on another machine or arrive after HTTP starts.
export function resolvePaseoServerId(
  configured: string | null,
  daemon: { getLastServerInfoMessage(): { serverId: string } | null } | null,
): string | null {
  return configured ?? daemon?.getLastServerInfoMessage()?.serverId ?? null;
}
