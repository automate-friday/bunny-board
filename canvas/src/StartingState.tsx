import { useEffect, useState } from "react";
export function StartingState({ requestedAt, error, retry }: { requestedAt?: number; error?: string; retry?: { attempt?: number; nextAt?: number; lastError?: string } }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const elapsed = typeof requestedAt === "number" && Number.isFinite(requestedAt) ? Math.max(0, Math.floor((now - requestedAt) / 1000)) : null;
  return <div data-testid="frame-starting-state" role="status" style={{ flexBasis: "100%", color: "#805000" }}>
    Starting conversation{elapsed === null ? " · request time unavailable" : ` · ${elapsed}s since request`}. Waiting for Paseo to bind this frame.
    {retry ? <div>Same request retained{typeof retry.attempt === "number" ? ` · retry ${retry.attempt}` : ""}{typeof retry.nextAt === "number" ? retry.nextAt > now ? ` · next retry in ${Math.ceil((retry.nextAt - now) / 1000)}s` : " · retry due" : ""}. No second conversation requested.</div> : null}
    {error || retry?.lastError ? <div role="alert">{error ?? retry?.lastError}</div> : null}
  </div>;
}
