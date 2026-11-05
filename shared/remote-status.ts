type RemoteEvidence = {
  host: string;
  polledAt?: number | null;
  staleAfterMs?: number;
  stale?: boolean;
};

export function staleRemoteStatus(
  remote: Omit<RemoteEvidence, "host"> | undefined,
  now = Date.now(),
): string | null {
  if (!remote) return null;
  if (!remote.polledAt) return "checking…";
  const age = Math.max(0, now - remote.polledAt);
  return remote.stale || age > (remote.staleAfterMs ?? 45000)
    ? `last seen ${Math.floor(age / 1000)}s ago`
    : null;
}

// Keep reported state and its age together, without repeating “last reported/last seen”.
export function remoteStatusLabel(
  remote: RemoteEvidence | undefined,
  status: string,
  now = Date.now(),
): string {
  if (!remote) return status;
  const pendingOrStale = staleRemoteStatus(remote, now);
  const age = Math.floor(Math.max(0, now - (remote.polledAt ?? now)) / 1000);
  return `${remote.host} · ${pendingOrStale ?? `${status} · ${age}s ago`}`;
}

// Cached rows remain useful; their status is unverified after restoring/reconnecting.
export function checkingRemoteSnapshot<T extends { agentId: string; remote?: RemoteEvidence }>(snapshot: T): T {
  return snapshot.remote
    ? { ...snapshot, remote: { ...snapshot.remote, polledAt: null, stale: false } }
    : snapshot;
}
