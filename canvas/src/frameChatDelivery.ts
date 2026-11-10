// The frame chat dock's send states, kept free of React and tldraw so the unit tests can
// run them (test/frame-chat-delivery.test.ts). Contract: docs/changelog/contracts.md
// "Round2 chat-on-frame specimen". Sending, accepted, agent working and replied stay
// distinct; the box empties when a send begins, and an unconfirmed or failed send puts
// its draft back without erasing text typed since. The board server retries a
// send itself until the agent's timeline shows it (delivered) or gives up (failed).

// queued: filed with the board server, waiting to go (reason says for what).
// accepted: Paseo answered and the board is checking the conversation for it.
// unknown: the send's outcome is ambiguous (its answer was lost midway); the board reads
//   the conversation before it ever resends, so it is still pending.
// delivered: the conversation shows the message.
// acknowledged: the host accepted it and that is all the board can know (another Mac's
//   agent, whose conversation the board cannot read exactly). Final; never resent.
// unconfirmed: may or may not have arrived and nothing more will be learned; not resent.
export type Outcome = "sending" | "queued" | "accepted" | "unknown" | "delivered" | "acknowledged" | "unconfirmed" | "failed";
export const OUTCOMES: readonly Outcome[] = ["sending", "queued", "accepted", "unknown", "delivered", "acknowledged", "unconfirmed", "failed"];
// restored: its failure already put the text back in the box (see composerSettle).
// reason: the board server's word for what a queued send waits for, or why it ended.
// mode: how the server sends it to a busy agent (shared/send-capabilities MidTurn).
// prev: the messageId of the reply sent just before this one (keeps typed order on the server).
export type Sent = { messageId?: string; receipts?: boolean; text: string; at: number; outcome: Outcome; detail?: string; receipt?: string; attempts?: number; restored?: boolean; reason?: string; host?: string | null; mode?: string; prev?: string };
export type PromptResponse = { ok: boolean; status?: string; final?: boolean; reason?: string; host?: string | null; mode?: string | null; messageId?: string; receipt?: unknown; error?: string };

// The text to send, or null when nothing may be sent (empty draft or no prompt
// capability). A send still on its way does not block the next one: the board server
// keeps each agent's messages in order, and the box was emptied when the earlier one
// began, so a message is never posted twice by a second Enter.
export function beginSend(draft: string, _last: Sent | null, canPrompt: boolean, now: number): Sent | null {
  const text = draft.trim();
  if (!canPrompt || !text) return null;
  return { text, at: now, outcome: "sending" };
}

// What the prompt route answered (200 ok, 202 unconfirmed) or the error it threw.
export function settleSend(sent: Sent, result: { response: PromptResponse } | { error: Error }): Sent {
  if ("error" in result) return { ...sent, outcome: "failed", detail: result.error.message };
  const r = result.response;
  const attempts = typeof (r.receipt as { attempts?: unknown } | undefined)?.attempts === "number" ? (r.receipt as { attempts: number }).attempts : sent.attempts;
  // ok: delivered (older board servers answered ok at the daemon's acknowledgement).
  // unknown: the server is checking the conversation before any resend, so still pending.
  // accepted + final: the host's acknowledgement is as far as this backend can confirm.
  const outcome: Outcome = r.ok ? "delivered" : r.status === "accepted" ? (r.final ? "acknowledged" : "accepted") : r.status === "unknown" ? "unknown" : r.status === "queued" || r.status === "sending" ? "queued" : r.status === "failed" ? "failed" : "unconfirmed";
  const detail = r.ok ? undefined : outcome === "failed" ? (FAILURE[r.reason ?? ""] ?? r.reason ?? r.error) : r.error;
  return { ...sent, outcome, attempts, detail, reason: r.ok ? undefined : r.reason, ...(r.host !== undefined ? { host: r.host } : {}), ...(r.mode ? { mode: r.mode } : {}), receipt: !r.ok && outcome === "unconfirmed" && r.receipt ? JSON.stringify(r.receipt, null, 2) : undefined };
}

// The board server's failure reasons (server/prompt-outbox.ts, daemon-health.ts), in words.
const FAILURE: Record<string, string> = {
  missing: "Paseo has no such agent any more",
  "retries-exhausted": "not in the conversation after every retry",
  expired: "not in the conversation; too old to resend",
  "binding-revoked": "the frame was rebound to another conversation",
  rejected: "Paseo refused the message",
  "earlier-missing": "not sent: your earlier message never reached the board, and this one must not overtake it",
};

// Still on its way: the composer keeps polling the receipt.
export function pendingSend(sent: Sent | null): boolean {
  return !!sent && (sent.outcome === "sending" || sent.outcome === "queued" || sent.outcome === "accepted" || sent.outcome === "unknown");
}

// A fresh message id (UUID v4). crypto.randomUUID exists only in secure contexts, and the
// board is opened over plain http on the tailnet IP, where it is undefined: calling it
// threw before any request, so the reply box silently did nothing. getRandomValues works
// in any context; Math.random is the last resort. Matches the server's
// /^[A-Za-z0-9_-]{8,100}$/.
export function newMessageId(c: Partial<Pick<Crypto, "randomUUID" | "getRandomValues">> | undefined = globalThis.crypto): string {
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  if (typeof c?.getRandomValues === "function") c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// The id to post a draft under. Sending an unconfirmed message's text again reuses its id,
// so the board server answers with the existing receipt instead of delivering it twice.
// Anything else is a new message, even the same words while the first is still queued
// ("yes", then "yes" again, is two messages).
export function sendId(prior: Sent | null, text: string, fresh: () => string): string {
  return prior?.text === text && prior.messageId && prior.outcome === "unconfirmed" ? prior.messageId : fresh();
}

// The reply box as a value: the draft, the last send, and the block of the draft the
// composer itself put back after that send failed. Ownership is explicit, never inferred
// by searching the draft for the sent text (a newer "concatenate" contains a failed "cat").
//   restored.block: exactly what was inserted at the start of the draft: the failed text,
//     plus "\n" when there was newer text after it. Every edit that changes a byte of it
//     (or types right after a block with no separator) gives up ownership.
//   restored.of: the send it came from (messageId, else its time), so a repeated failure
//     report restores once.
export type Restored = { block: string; of: string };
// earlier: sends that were still on their way when a newer one began, oldest first, kept
// (and polled) until they are delivered or acknowledged. A failed one stays listed until
// the next send, with its text back in the box.
export type ComposerState = { text: string; sent: Sent | null; restored?: Restored | null; earlier?: Sent[] };
const sendKey = (s: Sent) => s.messageId ?? `at:${s.at}`;

// Enter or the send button: the whole box is the message, so the box empties at once and
// text typed while it is in flight is a new draft. resend ("Send again"): the failed text
// is posted again and only the block the composer restored for it leaves the box, if it is
// still intact; everything else (all of it, if the block was edited) stays byte-for-byte.
export function composerBegin(s: ComposerState, canPrompt: boolean, now: number, resend = false): { next: ComposerState; begun: Sent } | null {
  if (resend && s.sent?.outcome !== "failed") return null;
  const begun = beginSend(resend ? s.sent!.text : s.text, s.sent, canPrompt, now);
  if (!begun) return null;
  // The send this one replaces as "latest" keeps being tracked while it is on its way.
  const earlier = [...(s.earlier ?? []).filter(pendingSend), ...(s.sent && pendingSend(s.sent) ? [s.sent] : [])];
  if (!resend) return { begun, next: { ...s, text: "", restored: null, earlier } };
  const own = s.restored && s.restored.of === sendKey(s.sent!) && s.text.startsWith(s.restored.block) ? s.restored.block : "";
  return { begun, next: { ...s, text: s.text.slice(own.length), restored: null, earlier } };
}

// The id of the latest earlier send still on its way, if any: a new send names it as prev.
export function previousSend(s: ComposerState): string | undefined {
  return (s.earlier ?? []).filter((x) => x.messageId && pendingSend(x)).at(-1)?.messageId;
}

// The reply box from sessionStorage after a reload. Every send still on its way comes back,
// however many there are (each is polled again, and a later failure still puts its text
// back): unresolved sends are never dropped to save space. Invalid entries are skipped.
// The draft comes back even when it is long; the sends do not depend on it.
const ID = /^[A-Za-z0-9_-]{8,100}$/;
const validSent = (x: unknown): x is Sent => {
  const v = x as Sent | null;
  return !!v && typeof v.text === "string" && typeof v.messageId === "string" && ID.test(v.messageId) && OUTCOMES.includes(v.outcome) && (v.prev === undefined || (typeof v.prev === "string" && ID.test(v.prev)));
};
export function restoreComposer(saved: unknown): ComposerState {
  const s: ComposerState = { text: "", sent: null };
  const v = saved as { text?: unknown; sent?: unknown; earlier?: unknown; restored?: { block?: unknown; of?: unknown } } | null;
  if (!v || typeof v !== "object") return s;
  if (typeof v.text === "string") s.text = v.text;
  if (validSent(v.sent)) s.sent = v.sent;
  if (Array.isArray(v.earlier)) { const earlier = v.earlier.filter(validSent); if (earlier.length) s.earlier = earlier; }
  const r = v.restored;
  if (s.sent && r && typeof r.block === "string" && typeof r.of === "string" && r.block && s.text.startsWith(r.block)) s.restored = { block: r.block, of: r.of };
  return s;
}

// Every send the box still tracks, oldest first.
export function composerSends(s: ComposerState): Sent[] {
  return [...(s.earlier ?? []), ...(s.sent ? [s.sent] : [])];
}

// A send settled. A failed or unconfirmed send puts its text back at the start of the box,
// ahead of whatever was typed since, which is kept byte-for-byte; nothing is searched for or
// deduplicated. (Resending the same unconfirmed text reuses its id, so the server dedupes
// it.) Any other outcome leaves the box alone: it was emptied when the send began.
export function composerSettle(s: ComposerState, settled: Sent): ComposerState {
  const of = sendKey(settled);
  const i = (s.earlier ?? []).findIndex((e) => sendKey(e) === of);
  if (i >= 0) return settleEarlier(s, i, settled);
  if (settled.outcome !== "failed" && settled.outcome !== "unconfirmed") return { ...s, sent: settled };
  if (s.sent && sendKey(s.sent) === of && s.sent.restored) return { ...s, sent: { ...settled, restored: true } };
  const block = s.text ? `${settled.text}\n` : settled.text;
  return { ...s, text: block + s.text, sent: { ...settled, restored: true }, restored: { block, of } };
}

// An earlier send settled while a newer one is the latest. Delivered or acknowledged: it
// leaves the list. Failed or unconfirmed: its text goes back at the start of the box, once,
// and it stays listed so the person sees which message did not make it.
function settleEarlier(s: ComposerState, i: number, settled: Sent): ComposerState {
  const earlier = [...(s.earlier ?? [])];
  const prior = earlier[i];
  if (settled.outcome === "delivered" || settled.outcome === "acknowledged") {
    earlier.splice(i, 1);
    return { ...s, earlier };
  }
  if ((settled.outcome !== "failed" && settled.outcome !== "unconfirmed") || prior.restored) {
    earlier[i] = { ...settled, restored: prior.restored };
    return { ...s, earlier };
  }
  earlier[i] = { ...settled, restored: true };
  const block = s.text ? `${settled.text}\n` : settled.text;
  // The box's restored block stays the latest send's, if it has one.
  return { ...s, earlier, text: block + s.text, restored: s.restored ? null : { block, of: sendKey(settled) } };
}

// The person edited the box. The restored block stays the composer's only while none of
// its bytes changed: the edit must start after it (for a block without a trailing "\n",
// typing right after it joins the failed text, so that counts as touching it).
export function composerEdit(s: ComposerState, text: string): ComposerState {
  const r = s.restored;
  if (!r) return { ...s, text };
  let same = 0;
  while (same < s.text.length && same < text.length && s.text[same] === text[same]) same++;
  const keep = r.block.endsWith("\n") ? same >= r.block.length : same > r.block.length;
  return { ...s, text, restored: keep ? r : null };
}

// Enter sends; Shift+Enter is a new line; Enter that confirms an IME candidate never sends
// (isComposing in Chrome and Firefox; Safari reports it only as keyCode 229).
export function enterSends(e: { key: string; shiftKey: boolean; isComposing?: boolean; keyCode?: number }): boolean {
  return e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229;
}

export type DeliveryLabel = { text: string; tone: "pending" | "ok" | "working" | "warn" | "error" };

// replyAt: when the latest assistant reply arrived (ISO), if any.
export function deliveryLabel(sent: Sent, replyAt: string | null, status: string): DeliveryLabel {
  const tries = sent.attempts && sent.attempts > 1 ? ` (try ${sent.attempts})` : "";
  if (sent.outcome === "queued") {
    // Never a bare "delivering…" that could sit there for good: say what it waits for.
    if (sent.reason === "waiting-turn") return { text: "queued · waits for the agent's turn to end (it can't take messages mid-turn)", tone: "pending" };
    if (sent.reason === "waiting-host") return { text: "queued · Paseo unreachable; sends when it reconnects", tone: "pending" };
    if (sent.reason === "waiting-status") return { text: `queued · waits until ${sent.host ?? "the other Mac"} reports the agent idle`, tone: "pending" };
    if (sent.reason === "waiting-start") return { text: "queued · sends once the agent has started", tone: "pending" };
    if (sent.reason === "waiting-earlier") return { text: "queued · goes after your earlier message", tone: "pending" };
    if (sent.detail && !sent.reason) return { text: `queued · ${sent.detail}`, tone: "pending" };
    return { text: `queued · delivering${tries}…`, tone: "pending" };
  }
  if (sent.outcome === "sending") return { text: "sending…", tone: "pending" };
  if (sent.outcome === "accepted") return { text: `sent · confirming it reached the agent${tries}…`, tone: "pending" };
  if (sent.outcome === "unknown") return { text: "? outcome unknown · checking the conversation before any resend", tone: "warn" };
  if (sent.outcome === "acknowledged") return sent.reason === "host-ack"
    ? { text: `accepted by ${sent.host ?? "the other Mac"} · delivery can't be confirmed from this board`, tone: "pending" }
    : { text: "accepted by Paseo · not confirmed in the conversation", tone: "pending" };
  if (sent.outcome === "failed") return { text: `✗ not delivered${sent.attempts ? ` after ${sent.attempts} ${sent.attempts === 1 ? "try" : "tries"}` : ""} — draft kept`, tone: "error" };
  if (sent.outcome === "unconfirmed") return { text: "? unconfirmed — may have arrived; not resent", tone: "warn" };
  if (replyAt && Date.parse(replyAt) >= sent.at - 1000) return { text: "delivered ✓ · replied", tone: "ok" };
  if (status === "running") return { text: "delivered ✓ · agent working…", tone: "working" };
  return { text: "delivered ✓", tone: "ok" };
}

// A queued reply the person may still take back (Edit / Remove): filed with the board but
// never sent. The board server has the last word (it refuses once a send was tried).
export function canWithdraw(sent: Sent): boolean {
  return sent.outcome === "queued" && !!sent.messageId && !sent.attempts;
}

// The board server took a queued reply back. It leaves the box's list; "edit" puts its
// text at the start of the box (ahead of anything typed since, kept byte-for-byte) so the
// person can correct it and send it again, "remove" drops it. A newer send, if any, stays
// the latest.
export function composerWithdraw(s: ComposerState, messageId: string, mode: "edit" | "remove"): ComposerState {
  const all = composerSends(s);
  const gone = all.find((x) => x.messageId === messageId);
  if (!gone) return s;
  const rest = all.filter((x) => x !== gone);
  const latestGone = s.sent === gone;
  const earlier = latestGone ? rest.slice(0, -1) : rest.filter((x) => x !== s.sent);
  const sent = latestGone ? rest.at(-1) ?? null : s.sent;
  // The restored block belonged to the send that put it there; editing the box's start
  // here would shift it, so ownership ends (a Send again then keeps the whole box).
  const next: ComposerState = { ...s, sent, earlier: earlier.length ? earlier : undefined };
  if (mode === "remove") return next;
  return { ...next, text: s.text ? `${gone.text}\n${s.text}` : gone.text, restored: null };
}

// Settle only a send the box still tracks: a check that was in flight when the person
// withdrew a message must not bring it (or its text) back.
export function composerSettleTracked(s: ComposerState, settled: Sent): ComposerState {
  if (settled.messageId && !composerSends(s).some((x) => x.messageId === settled.messageId)) return s;
  return composerSettle(s, settled);
}
