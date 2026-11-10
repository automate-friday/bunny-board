// After a bound frame is deleted in this tab: "Archive agent X?" with Keep / Archive.
// The server has already stopped deltas and cleared the agent's board labels; archiving
// is only allowed for agents it released in the last 30 minutes.

import { useState } from "react";
import { api } from "./api";

export interface ReleasedAgent {
  agentId: string;
  title: string;
  frameName: string;
}

const btn: React.CSSProperties = { padding: "6px 10px", borderRadius: 6, border: "1px solid light-dark(#bbb, var(--bunny-line))", background: "light-dark(#f7f7f7, var(--bunny-raised))", cursor: "pointer", font: "inherit" };

async function archive(agentId: string): Promise<void> {
  const go = () => api(`/api/ui/released/${encodeURIComponent(agentId)}/archive`, { method: "POST", body: "{}" });
  try {
    await go();
  } catch (e) {
    // The delete may still be on its way to the server.
    if (!/not released/.test((e as Error).message)) throw e;
    await new Promise((r) => setTimeout(r, 1500));
    await go();
  }
}

export function ReleasedPrompt({ agents, onDone }: { agents: ReleasedAgent[]; onDone: (agentId: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div
      data-testid="released-prompt"
      onPointerDown={(e) => e.stopPropagation()}
      style={{ width: "min(400px, 45vw)", flexShrink: 0, background: "light-dark(#fafafa, var(--bunny-surface))", borderLeft: "1px solid light-dark(#ddd, var(--bunny-line))", boxShadow: "-4px 0 18px rgba(0,0,0,0.08)", pointerEvents: "all", display: "flex", flexDirection: "column", gap: 10, padding: 14, font: "13px system-ui, sans-serif", zIndex: 400, overflowY: "auto" }}
    >
      {agents.map((a) => (
        <div key={a.agentId} data-testid="released-agent" data-agent-id={a.agentId} style={{ background: "light-dark(#fff, var(--bunny-surface))", border: "1px solid light-dark(#e4e4e4, var(--bunny-line))", borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          <div>
            You deleted the frame <b>{a.frameName || "(unnamed)"}</b>. Its conversation is still running in Paseo.
          </div>
          <div style={{ fontWeight: 600 }}>Archive agent “{a.title}”?</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" style={btn} data-testid="released-keep" disabled={busy === a.agentId} onClick={() => onDone(a.agentId)}>
              Keep agent
            </button>
            <button
              type="button"
              data-testid="released-archive"
              style={{ ...btn, background: "#c62828", borderColor: "light-dark(#c62828, hsl(0 35% 39%))", color: "#fff" }}
              disabled={busy === a.agentId}
              onClick={() => {
                setBusy(a.agentId);
                setErr(null);
                archive(a.agentId)
                  .then(() => onDone(a.agentId))
                  .catch((e: Error) => setErr(e.message))
                  .finally(() => setBusy(null));
              }}
            >
              {busy === a.agentId ? "Archiving…" : "Archive agent"}
            </button>
          </div>
        </div>
      ))}
      {err ? <div style={{ color: "light-dark(#c00, hsl(0 88% 74%))" }}>{err}</div> : null}
    </div>
  );
}
