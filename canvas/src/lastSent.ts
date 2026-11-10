// "You: …": the last message the person sent an agent (shared/last-message.ts), for the
// thread strip (Sidebar), phone tiles, quick-switch chips, search results and transcript
// cards.
//
// Threads and on-screen cards already hold the agent's rows and derive it from them. Tiles,
// chips and search results read the agent summary (GET /api/ui/agents/<id>, whose
// lastUserMessage the server derives from rows it already holds or one tail page): one
// request per agent, shared, refreshed at most every 30 s, and at once after a send from
// this page (agentSummaryChanged).

import { useEffect, useState } from "react";
import { api } from "./api";
import type { LastSent } from "../../shared/last-message";

export type LastUserMessage = { text: string; at: string; images: number; files: number };
export type AgentSummary = { provider?: string; model?: string; lastUserMessage?: LastUserMessage | null };

const FRESH_MS = 30_000;
const summaries = new Map<string, { at: number; value: Promise<AgentSummary | null>; done?: AgentSummary | null }>();
const listeners = new Map<string, Set<() => void>>();

export function agentSummary(agentId: string, force = false): Promise<AgentSummary | null> {
  const hit = summaries.get(agentId);
  if (hit && !force && Date.now() - hit.at < FRESH_MS) return hit.value;
  const entry: { at: number; value: Promise<AgentSummary | null>; done?: AgentSummary | null } = { at: Date.now(), value: Promise.resolve(null) };
  entry.value = api<AgentSummary>(`/api/ui/agents/${encodeURIComponent(agentId)}`)
    .catch(() => null)
    .then((v) => {
      entry.done = v;
      for (const fn of listeners.get(agentId) ?? []) fn();
      return v;
    });
  summaries.set(agentId, entry);
  return entry.value;
}

// After a send from this page: the next read asks again.
export function agentSummaryChanged(agentId: string): void {
  summaries.delete(agentId);
  void agentSummary(agentId);
}

// The agent's summary, fetched when `on` (a tile on screen), refreshed when stale.
export function useAgentSummary(agentId: string, on = true): AgentSummary | null {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!agentId || !on) return;
    const set = listeners.get(agentId) ?? new Set();
    const fn = () => tick((n) => n + 1);
    set.add(fn);
    listeners.set(agentId, set);
    void agentSummary(agentId);
    const t = setInterval(() => void agentSummary(agentId), FRESH_MS);
    return () => {
      clearInterval(t);
      set.delete(fn);
    };
  }, [agentId, on]);
  return (agentId && summaries.get(agentId)?.done) || null;
}

// What the strip and lines show: rows (exact, scrollable) first; a send just made from this
// page while its row has not arrived; else the summary's.
export function chooseLastSent(fromRows: LastSent | null, composer: { text: string; at: number } | null, summary: LastUserMessage | null | undefined): { text: string; at: string; full: string | null; inRows: boolean } | null {
  const rowsAt = fromRows ? Date.parse(fromRows.at) || 0 : 0;
  if (composer && composer.text.trim() && composer.at > rowsAt + 1000) return { text: oneLine(composer.text), at: new Date(composer.at).toISOString(), full: composer.text, inRows: false };
  if (fromRows) return { text: fromRows.text, at: fromRows.at, full: null, inRows: true };
  if (summary) return { text: summary.text, at: summary.at, full: summary.text, inRows: false };
  return null;
}

function oneLine(text: string, max = 200): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
