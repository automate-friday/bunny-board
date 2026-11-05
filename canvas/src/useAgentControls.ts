import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentControls } from "../../shared/agent-controls";

// The board's proxy for Paseo's agent controls (docs/changelog/contracts.md, "Paseo
// parity"). GET /api/ui/agents/:id/controls, refetched when the agent's status changes
// and after every setter. A 404/501 (older server, remote agent) means "no controls":
// every picker and permission card hides and the caller keeps its old fallback.
export type ControlsState = {
  controls: AgentControls | null;
  // The route is missing or refuses this agent (404/501): hide everything.
  unsupported: boolean;
  notice: { text: string; tone: "ok" | "error" } | null;
  busy: string | null;
  post: (path: string, body: unknown, label?: string) => Promise<boolean>;
};

const base = (agentId: string) => `/api/ui/agents/${encodeURIComponent(agentId)}`;

export function useAgentControls(agentId: string | undefined, status: string, enabled: boolean): ControlsState {
  const [controls, setControls] = useState<AgentControls | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [notice, setNotice] = useState<ControlsState["notice"]>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = enabled && !!agentId;

  useEffect(() => {
    setControls(null);
    setUnsupported(false);
    setNotice(null);
  }, [agentId]);

  useEffect(() => {
    if (!live || !agentId) return;
    const ctrl = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`${base(agentId)}/controls`, { signal: ctrl.signal });
        if (res.status === 404 || res.status === 501 || res.status === 405) {
          setUnsupported(true);
          setControls(null);
          return;
        }
        const body = await res.json().catch(() => null);
        // A failed fetch keeps the last controls; the next status change or setter retries.
        if (!res.ok || !body || typeof body !== "object") return;
        setUnsupported(false);
        setControls(normalize(body as AgentControls));
      } catch {
        // Aborted or offline: same as a failed fetch.
      }
    })();
    return () => ctrl.abort();
  }, [agentId, live, status, version]);

  // A pending permission can be answered elsewhere (Paseo, another tab): look again now
  // and then while one is open.
  const pending = controls?.pendingPermissions.length ?? 0;
  useEffect(() => {
    if (!live || (!pending && status !== "needs-permission")) return;
    // ponytail: polls every 8 s while a permission is pending; switch to the agent event stream if it carries permission changes.
    const t = setInterval(() => setVersion((v) => v + 1), 8000);
    return () => clearInterval(t);
  }, [live, pending, status]);

  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);

  const show = useCallback((text: string, tone: "ok" | "error") => {
    setNotice({ text, tone });
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), tone === "error" ? 8000 : 4000);
  }, []);

  const post = useCallback(
    async (path: string, body: unknown, label?: string) => {
      if (!agentId) return false;
      setBusy(path);
      try {
        const res = await fetch(`${base(agentId)}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
        const out = (await res.json().catch(() => ({}))) as { ok?: boolean; notice?: string; error?: string };
        if (!res.ok || out.error) throw new Error(out.error ?? `HTTP ${res.status}`);
        show(out.notice ?? (label ? `${label} ✓` : "Done ✓"), "ok");
        return true;
      } catch (e) {
        show((e as Error).message, "error");
        return false;
      } finally {
        setBusy(null);
        setVersion((v) => v + 1);
      }
    },
    [agentId, show],
  );

  return { controls: live ? controls : null, unsupported, notice, busy, post };
}

// Tolerate a partial body from an older or newer server.
function normalize(c: AgentControls): AgentControls {
  return {
    ...c,
    models: Array.isArray(c.models) ? c.models : [],
    modes: Array.isArray(c.modes) ? c.modes : [],
    features: Array.isArray(c.features) ? c.features : [],
    pendingPermissions: Array.isArray(c.pendingPermissions) ? c.pendingPermissions : [],
    modelId: c.modelId ?? null,
    modeId: c.modeId ?? null,
    thinkingOptionId: c.thinkingOptionId ?? null,
    can: { model: !!c.can?.model, mode: !!c.can?.mode, thinking: !!c.can?.thinking, features: !!c.can?.features, permissions: !!c.can?.permissions },
  };
}
