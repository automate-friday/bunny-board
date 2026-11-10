import { useEffect, useState } from "react";
import type { AgentView } from "./agents";
export function remoteFreshness(view: AgentView | null, now: number) {
  const remote = view?.remote, at = remote?.polledAt;
  const age = typeof at === "number" && Number.isFinite(at) ? Math.max(0, now - at) : null;
  const threshold = remote?.staleAfterMs && remote.staleAfterMs > 0 ? remote.staleAfterMs : 45000;
  return { age, stale: age === null || age >= threshold || !!remote?.stale || !!view?.error };
}
// starting: the frame's start is still pending. The host's "Agent not found" then means
// "not created yet", so it is not shown; the board keeps reading until the agent exists.
export function RemoteCoverage({ view, host, starting = false }: { view: AgentView | null; host?: string | null; starting?: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  if (!host && !view?.remote) return null;
  const color = "light-dark(#765396, hsl(271 50% 74%))", warn = "light-dark(#9c4b00, hsl(29 88% 74%))";
  const where = host ?? view?.remote?.host;
  if (starting) return <div data-testid="remote-coverage" data-starting="1" title="The board keeps checking until the agent is up. Replies you send wait for it." style={{ color, fontSize: 11 }}>Starting on {where}…</div>;
  const { age, stale } = remoteFreshness(view, now);
  const messagesOnly = view?.remote?.coverage !== "projected-timeline";
  // Full provenance lives in the tooltip; inline text only when something is actually off.
  const detail = `${where} · ${messagesOnly ? "messages only; no tool rows or full history" : "conversation and tool history"} · ${age === null ? "first successful read pending; status unknown" : `last successful read ${Math.floor(age / 1000)}s ago; ${stale ? "stale; current status unknown" : "status from last poll"}`}.`;
  if (!stale && !messagesOnly) return <span data-testid="remote-coverage" data-stale="0" title={detail} hidden />;
  return <div data-testid="remote-coverage" data-stale={stale ? "1" : "0"} title={detail} style={{ color: stale ? warn : color, fontSize: 11 }}>
    {stale ? (age === null ? "Waiting for first update" : "Status may be out of date") : "Messages only"}
    {view?.error ? <span role="alert"> · {view.error} Cached messages kept.</span> : null}
  </div>;
}
