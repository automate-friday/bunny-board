// What each backend the board sends through can actually promise for a chat reply, a
// queued message or a frame delta. Read by the prompt outbox (server/core.ts), the prompt
// route and the reply box, and tested as a table (test/send-matrix.test.ts).
//
// Paseo 0.11.4 has no "queue until the turn ends" send and no "reject if busy" send.
// send_agent_message takes activeTurnBehavior 'interrupt' (cancel the turn) or 'steer'.
// 'steer' goes through AgentManager.steerOrReplaceActiveTurn: when the provider declines
// the steer (no steerActiveTurn at all, a slash command, Claude while compacting, the turn
// changing during admission, a pi binary without the steer RPC), Paseo CANCELS the
// running turn and replaces it with the message. Paseo already has a steer-only path,
// AgentManager.steerAgentRun (answers "unavailable", never replaces), but no wire message
// reaches it. MISSING_PRIMITIVE names what would close the gap.
//
// So the board never relies on 'steer' where a decline is likely. It steers only for
// providers whose steering is unconditional in Paseo 0.11.4 (apart from the cases above),
// and otherwise holds the message on the board until the agent is seen idle, then sends.
// That check and the send are two steps: a turn that starts in between can still be
// cancelled. The residual risk is stated per mode: MODE_NOTES (technical, docs and tests)
// and USER_NOTES (plain words, shown in the reply box).
export const MISSING_PRIMITIVE = "Paseo send_agent_message has no steer-only or reject-if-busy mode (activeTurnBehavior is interrupt | steer, and steer falls back to replacing the turn); AgentManager.steerAgentRun implements steer-only but is not exposed on the wire.";

// Providers whose Paseo 0.11.4 steerActiveTurn accepts any non-slash prompt during a turn.
// Not pi: Paseo's pi client falls back to replace on binaries without the steer RPC, and
// the board cannot see the pi version. Not the ACP family (Copilot, Cursor, Kimi, Kiro,
// Trae, custom "extends":"acp"), which has no steering. Unknown ids (including providers
// derived from these under another name) hold too: uncertain means hold.
export const STEERING_PROVIDERS = ["claude", "codex", "opencode", "omp", "mock"] as const;

// steer: sent at once; a busy agent takes it into its running turn.
// wait-for-turn-end: held on the board while the local agent is busy (status read from
//   the daemon just before sending).
// wait-for-polled-idle: another Mac's agent; held until af-network's read of it says idle.
export type MidTurn = "steer" | "wait-for-turn-end" | "wait-for-polled-idle";
export type Confirmation = "timeline" | "host-ack";
export type SendCapabilities = {
  backend: "local-paseo" | "af-network";
  provider: string | null;
  midTurn: MidTurn;
  // How a send is known to have arrived: the agent's own timeline (message id matched),
  // or only the remote host's acknowledgement.
  confirmation: Confirmation;
  // A resend after a lost answer reuses the wire id, which the daemon (agentRequestReceipts)
  // or af-network's trace journal deduplicates. Without that, an unanswered send is never
  // resent until the timeline shows it missing.
  dedupe: "daemon-receipts" | "trace-journal" | "timeline-only";
  // An ambiguous send (daemon said outcome unknown, or retries ran out) is resent only after
  // the timeline shows it missing with no turn in flight; with no timeline, never.
  ambiguousRetry: "after-timeline-miss" | "never";
  // What can still go wrong for a busy agent, in words (shown in the reply box).
  residualRisk: string;
};

export const MODE_NOTES: Record<MidTurn, string> = {
  "steer": "Steered into a running turn. If the provider declines the steer (Claude while compacting, say), Paseo replaces the turn instead; the board cannot prevent that.",
  "wait-for-turn-end": "Held until the agent's turn ends (its provider cannot take messages mid-turn, or the board cannot tell). Checked just before sending: a turn that starts in that moment can still be interrupted.",
  "wait-for-polled-idle": "Held until the other Mac reports the agent idle. That report can be a few seconds old, so a turn that starts in between can still be interrupted. Arrival is acknowledged by that Mac, not confirmed in the conversation.",
};

// The same, for the person typing (the reply box's ⓘ): what happens to their message,
// what can still interrupt the agent, and what to do. No internal API names.
export const USER_NOTES: Record<MidTurn, { summary: string; detail: string }> = {
  "steer": {
    summary: "if the agent is busy, this joins its current turn",
    detail: "If the agent is working, your message is added to what it is doing; it is not stopped. Rarely (for example while it compacts its context) Paseo restarts the turn with your message instead, and the board cannot prevent that. To stop it on purpose, press Stop.",
  },
  "wait-for-turn-end": {
    summary: "waits for the agent to finish its current turn",
    detail: "This agent cannot take a message mid-turn without being interrupted, so the board holds yours until it is idle. Paseo has no safe way to queue a message, so if a new turn starts at the moment the board sends, that turn can still be interrupted. To interrupt on purpose, press Stop first; your message then goes out.",
  },
  "wait-for-polled-idle": {
    summary: "waits until the other Mac reports the agent idle",
    detail: "This agent runs on another Mac. The board holds your message until that Mac reports the agent idle (checked every few seconds), so it normally will not interrupt. A turn that starts between the check and the send can still be interrupted. The board can only confirm that the other Mac accepted the message, not that the agent read it. To interrupt on purpose, stop the agent in Paseo on that Mac.",
  },
};

export function providerSteers(provider: string | null | undefined): boolean {
  const id = String(provider ?? "").split("/")[0];
  return (STEERING_PROVIDERS as readonly string[]).includes(id);
}

export function sendCapabilities(input: { host: string | null; provider?: string | null; durableReceipts?: boolean | null }): SendCapabilities {
  const provider = input.provider ? String(input.provider).split("/")[0] : null;
  if (input.host) return { backend: "af-network", provider, midTurn: "wait-for-polled-idle", confirmation: "host-ack", dedupe: "trace-journal", ambiguousRetry: "never", residualRisk: MODE_NOTES["wait-for-polled-idle"] };
  const midTurn: MidTurn = providerSteers(provider) ? "steer" : "wait-for-turn-end";
  return {
    backend: "local-paseo",
    provider,
    midTurn,
    confirmation: "timeline",
    dedupe: input.durableReceipts === false ? "timeline-only" : "daemon-receipts",
    ambiguousRetry: "after-timeline-miss",
    residualRisk: MODE_NOTES[midTurn],
  };
}

// Whether a message may go out now. busy: the agent has a turn in flight; null when its
// status is not known (an unreachable or stale remote read): uncertain means hold.
// A slash command is never steerable (Paseo replaces the turn), so it always waits.
export type SendDecision = { send: true; mode: MidTurn } | { send: false; mode: MidTurn; reason: "waiting-turn" | "waiting-status" };
export function sendNow(caps: SendCapabilities, busy: boolean | null, text = ""): SendDecision {
  const slash = /^\s*\//.test(text);
  const mode: MidTurn = slash && caps.midTurn === "steer" ? "wait-for-turn-end" : caps.midTurn;
  if (mode === "steer") return { send: true, mode };
  if (busy === null) return { send: false, mode, reason: "waiting-status" };
  return busy ? { send: false, mode, reason: "waiting-turn" } : { send: true, mode };
}
