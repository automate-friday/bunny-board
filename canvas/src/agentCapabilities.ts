import { useEffect, useState } from "react";
import { api } from "./api";
export type AgentOperation = "read" | "prompt" | "stop" | "restartWithTools" | "paseoLink" | "fileContext" | "localArtifactPath" | "exactTimeline" | "olderTimeline" | "toolRows";
export type AgentCapabilities = Record<AgentOperation, boolean> & { source: string; coverage: string; remoteHost?: string | null; paseoServerId?: string | null };
export async function readAgentCapabilities(agentId: string, signal?: AbortSignal) {
  const result = await api<{ agentId: string; capabilities: AgentCapabilities }>(`/api/ui/agents/${encodeURIComponent(agentId)}/capabilities`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
  if (result.agentId !== agentId || !result.capabilities) throw Error("Agent controls could not be verified.");
  return result.capabilities;
}
export function useAgentCapabilities(agentId?: string, bindingKey?: string) {
  const [state, setState] = useState<{ id?: string; key?: string; value: AgentCapabilities | null; error: string | null }>({ value: null, error: null });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const ctl = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    if (!agentId) { setState({ value: null, error: null }); return; }
    const load = async () => {
      try { const value = await readAgentCapabilities(agentId, ctl.signal); if (!ctl.signal.aborted) setState({ id: agentId, key: bindingKey, value, error: null }); }
      // A failed refresh keeps the last known capabilities (a slow host should not disable the reply box).
      catch (e) { if (!ctl.signal.aborted) setState((s) => ({ id: agentId, key: bindingKey, value: s.id === agentId && s.key === bindingKey ? s.value : null, error: (e as Error).message })); }
      finally { if (!ctl.signal.aborted) timer = setTimeout(() => void load(), 30000); }
    };
    void load(); return () => { ctl.abort(); clearTimeout(timer); };
  }, [agentId, bindingKey, revision]);
  const current = state.id === agentId && state.key === bindingKey ? state : null;
  return { value: current?.value ?? null, error: current?.error ?? null, can: (op: AgentOperation) => current?.value?.[op] === true, retry: () => setRevision(n => n + 1) };
}
