import { useEffect, useState } from "react";
import type { AgentView } from "./agents";
export function remoteFreshness(view: AgentView | null, now: number) {
  const remote = view?.remote, at = remote?.polledAt;
  const age = typeof at === "number" && Number.isFinite(at) ? Math.max(0, now - at) : null;
  const threshold = remote?.staleAfterMs && remote.staleAfterMs > 0 ? remote.staleAfterMs : 45000;
  return { age, stale: age === null || age >= threshold || !!remote?.stale || !!view?.error };
}
export function RemoteCoverage({ view, host }: { view: AgentView | null; host?: string | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  if (!host && !view?.remote) return null;
  const { age, stale } = remoteFreshness(view, now);
  return <div data-testid="remote-coverage" data-stale={stale ? "1" : "0"} style={{ color: stale ? "#9c4b00" : "#765396", fontSize: 11, whiteSpace: "normal" }}>
    {host ?? view?.remote?.host} · messages only · {age === null ? "first successful read pending; status unknown" : `last successful read ${Math.floor(age / 1000)}s ago; ${stale ? "stale; current status unknown" : "status from last poll"}`}.
    {view?.error ? <span role="alert"> {view.error} Cached messages retained.</span> : null}
    <span> No tool rows or full history.</span>
  </div>;
}
