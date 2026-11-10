// The sidebar reply box's turn controls, right above the box: Stop while the agent works,
// Continue once it has stopped. Stop cancels the running turn through the board's cancel
// route (remote agents on a paired host too); a host the board cannot stop shows it
// disabled with the reason. Continue sends "Continue" through the reply box's own path
// (same delivery line and tracking as a typed reply). The phone keeps its square Stop in
// the Send button's place (mobile/StopButton) and gets only Continue here.

import { useState } from "react";
import { useAgentCapabilities } from "./agentCapabilities";
import { cancelAgent } from "./agents";
import { sendReply } from "./ChatComposer";
import { clearStopped, markStopped, useStopped } from "./mobile/StopButton";

export const CONTINUE_TEXT = "Continue";

export function TurnControls({ agentId, host, status, rows, canPrompt, showStop = true, large = false, onError }: {
  agentId: string;
  host?: string | null;
  status: string;
  rows: number;
  canPrompt: boolean;
  showStop?: boolean;
  large?: boolean;
  onError?: (message: string | null) => void;
}) {
  const capabilities = useAgentCapabilities(agentId, `${agentId}:${host ?? "local"}`);
  const [stopping, setStopping] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const stoppedHere = useStopped(agentId, rows);
  const busy = status === "running" || status === "needs-permission";
  // Unknown until the capability check answers: allowed (the route itself refuses).
  const can = capabilities.value ? capabilities.can("stop") : true;
  const where = (capabilities.value as { remoteHost?: string | null } | null)?.remoteHost ?? host ?? null;
  const reason = refused ?? (can ? null : where ? `${where}: this agent can't be stopped from the board (no paired connection); stop it in Paseo on that machine` : "This agent can't be stopped from here");

  const stop = async () => {
    if (stopping || reason) { if (reason) onError?.(reason); return; }
    setStopping(true);
    onError?.(null);
    try {
      await cancelAgent(agentId);
      markStopped(agentId, rows);
    } catch (e) {
      const msg = (e as Error).message;
      if (/stop it in Paseo|cannot stop|af-network/i.test(msg)) setRefused(msg);
      onError?.(`Not stopped: ${msg}`);
    } finally {
      setStopping(false);
    }
  };
  const resume = async () => {
    if (continuing || !canPrompt) return;
    setContinuing(true);
    onError?.(null);
    try {
      const sent = await sendReply(agentId, CONTINUE_TEXT);
      if (sent && sent.outcome !== "failed") clearStopped(agentId);
    } finally {
      setContinuing(false);
    }
  };

  // Stop while working; Continue after a stop made here, or after a turn that errored.
  const offerContinue = !busy && (stoppedHere || status === "error");
  if (!(busy && showStop) && !offerContinue) return null;
  const font = large ? 14 : 12;
  const btn: React.CSSProperties = { flex: "none", borderRadius: 8, background: "light-dark(#fff, var(--bunny-surface))", font: `${font}px system-ui`, padding: large ? "6px 14px" : "3px 10px", cursor: "pointer", minHeight: large ? 36 : undefined };
  return (
    <div data-testid="turn-controls" data-state={busy ? "working" : "stopped"} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: font - 1, color: "light-dark(#64748b, var(--bunny-muted))" }}>
      {busy && showStop ? (
        <>
          <span style={{ flex: 1, minWidth: 0 }}>{status === "needs-permission" ? "Waiting for permission" : stopping ? "Stopping…" : "● Agent working"}</span>
          <button type="button" data-testid="sidebar-stop" aria-disabled={!!reason || stopping} disabled={stopping}
            title={reason ?? "Stop the agent's current turn. Queued replies then go out."}
            onClick={() => void stop()}
            style={{ ...btn, border: `1px solid ${reason ? "light-dark(#cbd5e1, hsl(213 35% 39%))" : "light-dark(#fca5a5, hsl(0 35% 39%))"}`, color: reason ? "light-dark(#94a3b8, var(--bunny-muted))" : "light-dark(#b91c1c, hsl(0 74% 74%))", cursor: reason ? "not-allowed" : "pointer" }}>
            {stopping ? "Stopping…" : "■ Stop"}
          </button>
        </>
      ) : (
        <>
          {/* The phone's thread already says "■ Stopped" (Sidebar thread-stopped). */}
          <span data-testid="turn-stopped" style={{ flex: 1, minWidth: 0, color: status === "error" ? "light-dark(#b00020, hsl(349 88% 74%))" : "light-dark(#7f1d1d, hsl(0 63% 74%))" }}>{status === "error" ? "The turn ended with an error" : showStop ? "■ Stopped" : ""}</span>
          <button type="button" data-testid="turn-continue" disabled={!canPrompt || continuing}
            title={canPrompt ? `Send “${CONTINUE_TEXT}” so the agent picks up where it stopped` : "Sending is unavailable for this agent"}
            onClick={() => void resume()}
            style={{ ...btn, border: "1px solid light-dark(#93c5fd, hsl(212 35% 39%))", color: "light-dark(#1d4ed8, hsl(224 76% 74%))", cursor: canPrompt ? "pointer" : "default" }}>
            {continuing ? "Sending…" : "▶ Continue"}
          </button>
        </>
      )}
    </div>
  );
}
