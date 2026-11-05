import { useEffect, useState } from "react";
import { api } from "./api";
import { boardInfo } from "./info";

// Model and machine for a conversation header ("claude-sonnet-5 · mac-1 · idle").
// Paseo may not know a just-created agent yet, so the model is asked for once `ready`.
export function useAgentMeta(agentId: string | undefined, remoteHost: string | null, ready: boolean) {
  const [meta, setMeta] = useState<{ model?: string; machine?: string }>({});
  useEffect(() => {
    let live = true;
    void boardInfo()
      .then((i) => live && setMeta((m) => ({ ...m, machine: (i as { machine?: string }).machine })))
      .catch(() => undefined);
    if (agentId && !remoteHost && ready)
      void api<{ provider?: string; model?: string }>(`/api/ui/agents/${encodeURIComponent(agentId)}`)
        .then((a) => live && setMeta((m) => ({ ...m, model: a.model ?? a.provider })))
        .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [agentId, remoteHost, ready]);
  return { model: meta.model, machine: remoteHost ?? meta.machine };
}
