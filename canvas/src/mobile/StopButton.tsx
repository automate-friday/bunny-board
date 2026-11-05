// Phone: Stop, like Paseo's composer. While the agent works, the reply box's Send button
// becomes a square Stop (ChatComposer `busyAction`), and the collapsed thread peek has one
// too. Local agents and remote ones on a paired host stop through the board's cancel route
// (server: RemoteAgents.cancel for remote); a host the board cannot stop shows it disabled
// with the reason. After a stop the thread says "Stopped" (useStopped).

import { useState, useSyncExternalStore } from "react";
import { useAgentCapabilities } from "../agentCapabilities";
import { cancelAgent } from "../agents";

// Stops this page made, per agent: when, and how many timeline rows there were then (the
// "Stopped" note stays until the agent writes something new).
const stopped = new Map<string, { at: number; rows: number }>();
const listeners = new Set<() => void>();
export function markStopped(agentId: string, rows: number) {
  stopped.set(agentId, { at: Date.now(), rows });
  for (const l of listeners) l();
}
export function useStopped(agentId: string | undefined, rows: number): boolean {
  const s = useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => (agentId ? stopped.get(agentId) : undefined));
  return !!s && rows <= s.rows + 1;
}

export function StopButton({ agentId, host, rows, size = 44, onError }: { agentId: string; host?: string | null; rows: number; size?: number; onError?: (message: string | null) => void }) {
  const capabilities = useAgentCapabilities(agentId, `${agentId}:${host ?? "local"}`);
  const [stopping, setStopping] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  // Unknown until the capability check answers: allowed (the route itself refuses).
  const can = capabilities.value ? capabilities.can("stop") : true;
  // The host the server says the agent runs on (its binding, or what the capability check reports).
  const where = (capabilities.value as { remoteHost?: string | null } | null)?.remoteHost ?? host ?? null;
  const reason = refused ?? (can ? null : where ? `${where}: this agent can't be stopped from the board (no paired connection); stop it in Paseo on that machine` : "This agent can't be stopped from here");
  const stop = async () => {
    if (stopping || !can) return;
    setStopping(true);
    onError?.(null);
    try {
      await cancelAgent(agentId);
      markStopped(agentId, rows);
    } catch (e) {
      const msg = (e as Error).message;
      // A host that cannot stop (409) stays disabled with its reason; other errors can be retried.
      if (/stop it in Paseo|cannot stop|af-network/i.test(msg)) setRefused(msg);
      onError?.(`Not stopped: ${msg}`);
    } finally {
      setStopping(false);
    }
  };
  return (
    <button
      type="button"
      data-testid="reply-stop"
      data-can={!reason}
      aria-label={reason ? `Stop (unavailable: ${reason})` : stopping ? "Stopping" : "Stop the agent"}
      title={reason ?? "Stop the agent's current turn"}
      aria-disabled={!!reason || stopping}
      onClick={(e) => {
        e.stopPropagation();
        if (reason) onError?.(reason);
        else void stop();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      style={{ flex: "none", width: size, height: size, borderRadius: size >= 40 ? 12 : 8, border: "none", background: reason ? "#cbd5e1" : stopping ? "#7f1d1d" : "#0f172a", color: "#fff", cursor: reason ? "not-allowed" : "pointer", display: "grid", placeItems: "center", padding: 0, opacity: stopping ? 0.7 : 1 }}
    >
      <span aria-hidden="true" style={{ width: Math.round(size * 0.32), height: Math.round(size * 0.32), borderRadius: 3, background: "currentColor" }} />
    </button>
  );
}
