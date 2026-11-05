import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AgentView } from "./agents";
import { stop } from "./TimelineItemView";
import { rememberAgentSend } from "./jumpPaletteModel";
import { PhotoIcon, PhotoTray } from "./mobile/PhotoTray";
import { type MidTurn, USER_NOTES } from "../../shared/send-capabilities";
import { composerBegin, composerEdit, composerSends, composerSettle, type ComposerState, deliveryLabel, enterSends, newMessageId, pendingSend, previousSend, type PromptResponse, restoreComposer, type Sent, sendId, settleSend } from "./frameChatDelivery";

// The reply box shared by the sidebar and transcript cards. Drafts and the last send are
// kept per agent for the page's lifetime, so popping a card out to the sidebar (or
// closing the sidebar mid-send) keeps both. Enter sends, Shift+Enter is a new line.
// The state transitions (what the box holds after each send, edit and outcome) live in
// frameChatDelivery.ts so the unit tests run them.
const states = new Map<string, ComposerState>();
const listeners = new Map<string, Set<() => void>>();
function stateFor(agentId: string): ComposerState {
  let s = states.get(agentId);
  if (!s) {
    s = { text: "", sent: null };
    try { s = restoreComposer(JSON.parse(sessionStorage.getItem(`board-composer:${agentId}`) ?? "null")); }
    catch {/* In-memory drafts still work when storage is unavailable. */}
    states.set(agentId, s);
  }
  return s;
}
function update(agentId: string, patch: Partial<ComposerState> | ((s: ComposerState) => ComposerState)) {
  const s = stateFor(agentId);
  states.set(agentId, typeof patch === "function" ? patch(s) : { ...s, ...patch });
  try{sessionStorage.setItem(`board-composer:${agentId}`,JSON.stringify(states.get(agentId)));}catch{}
  for (const notify of listeners.get(agentId) ?? []) notify();
}
function subscribe(agentId: string, notify: () => void) {
  let set = listeners.get(agentId);
  if (!set) {
    set = new Set();
    listeners.set(agentId, set);
  }
  set.add(notify);
  return () => {
    set.delete(notify);
    if (!set.size) listeners.delete(agentId);
  };
}

// Every send still on its way is checked until it settles, not only the latest: a newer
// message never hides what happens to an earlier one. Runs while a composer or a
// SendWatcher for the agent is mounted (the phone's collapsed thread keeps one).
function usePendingChecks(agentId: string, state: ComposerState) {
  const pending=composerSends(state).filter((x)=>x.messageId&&pendingSend(x));
  const pendingKey=pending.map((x)=>`${x.messageId}:${x.outcome}`).join(',');
  useEffect(()=>{
    if(!pending.length)return;
    let active=true;const timers:ReturnType<typeof setTimeout>[]=[];
    const controller=new AbortController();
    const watch=(one:Sent)=>{
      const check=async()=>{
        try {
          // Re-posting under the same id is idempotent: it returns the existing receipt, or
          // files the send if the first post never reached the server.
          const response=await fetch(`/api/ui/agents/${encodeURIComponent(agentId)}/prompt`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:one.text,messageId:one.messageId,...(one.prev?{prev:one.prev}:{})}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(20000)])});
          if(!active)return;
          const current=composerSends(stateFor(agentId)).find((x)=>x.messageId===one.messageId);if(!current)return;
          if(response.status>=400&&response.status<500){
            // The board already holds this message (or may), so it is not "failed": a
            // Send again under a fresh id could deliver it twice. Its text goes back in
            // the box, and sending that text again reuses this id.
            const error=((await response.json().catch(()=>null)) as {error?:string}|null)?.error;
            const unconfirmed:Sent={...current,outcome:'unconfirmed',detail:`The board can no longer check this message${error?` (${error})`:''}; it may have arrived.`};
            update(agentId,(s)=>composerSettle(s,unconfirmed));return;
          }
          if(response.ok||response.status===202){
            const result=await response.json() as PromptResponse;
            if(!active)return;
            const settled=settleSend(current,{response:result});
            update(agentId,(s)=>composerSettle(s,settled));
            if(!pendingSend(settled))return;
          }
        }catch{/* Keep the stable id and draft while the board itself reconnects. */}
        if(active)timers.push(setTimeout(()=>void check(),1500));
      };
      timers.push(setTimeout(()=>void check(),400));
    };
    for(const one of pending)watch(one);
    return()=>{active=false;controller.abort();for(const t of timers)clearTimeout(t);};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[agentId,pendingKey]);
}

// The phone's collapsed thread: keeps checking sends after the reply box closed.
export function SendWatcher({ agentId }: { agentId: string }) {
  const state = useSyncExternalStore((n) => subscribe(agentId, n), () => stateFor(agentId));
  usePendingChecks(agentId, state);
  return null;
}

// The newest send and how far it got, for the phone's collapsed thread.
export function useLastSend(agentId: string, view: AgentView | null, status: string): { text: string; label: { text: string; tone: keyof typeof TONE } } | null {
  const state = useSyncExternalStore((n) => subscribe(agentId, n), () => stateFor(agentId));
  if (!state.sent) return null;
  const reply = (view?.rows ?? []).findLast((r) => r.kind === "assistant" && !r.ack && r.text.trim());
  return { text: state.sent.text, label: deliveryLabel(state.sent, reply?.at ?? null, status) as { text: string; tone: keyof typeof TONE } };
}

// Posts a begun send to the prompt route and settles it (the reply box's own path; also
// used by sendReply below).
async function postReply(agentId: string, begun: Sent) {
  // Sending an unconfirmed message's text again reuses its id (the server dedupes it).
  const prior=composerSends(stateFor(agentId)).findLast((x)=>x.text===begun.text&&x.outcome==='unconfirmed')??null;
  // The reply sent just before this one, so the board keeps them in typed order even if
  // this POST reaches it first.
  const prev=previousSend(stateFor(agentId));
  const sending:Sent={...begun,messageId:sendId(prior,begun.text,newMessageId),...(prev?{prev}:{})};
  update(agentId, { sent: sending });
  // The jump palette (⌘K) orders frames by when you last messaged or jumped to them.
  try { rememberAgentSend(window.localStorage, agentId); } catch { /* storage blocked */ }
  let settled: Sent;
  // Straight to the prompt route: it answers with the receipt. A slow or failed answer
  // leaves the send queued under its id; the check below posts it again (deduplicated).
  try {
    const result = await fetch(`/api/ui/agents/${encodeURIComponent(agentId)}/prompt`, { method: "POST", headers:{'content-type':'application/json'},body: JSON.stringify({ text: sending.text, messageId:sending.messageId, ...(sending.prev?{prev:sending.prev}:{}) }), signal: AbortSignal.timeout(20000) });
    const response=await result.json() as PromptResponse;
    settled=result.status>=400&&result.status<500?{...sending,outcome:'failed',detail:response.error??`HTTP ${result.status}`} : result.status<300?settleSend(sending,{response}):{...sending,outcome:'queued',detail:response.error};
  } catch {
    settled = {...sending,outcome:"queued",detail:"Board server slow to answer; still trying"};
  }
  update(agentId, (s) => composerSettle(s, settled));
}

// Send `text` to an agent exactly as its reply box would (same delivery tracking, same
// "You: …" line in its thread), from outside the box: the phone's Tell Bunny. Resolves once
// the board answered (or the send is queued for the checks to finish).
export async function sendReply(agentId: string, text: string): Promise<Sent | null> {
  const prev = stateFor(agentId);
  const started = composerBegin({ ...prev, text }, true, Date.now(), false);
  if (!started) return null;
  // Keep any draft the person had in that agent's box.
  update(agentId, { ...started.next, text: prev.text });
  try { await postReply(agentId, started.begun); }
  catch (e) { update(agentId, (s) => composerSettle(s, { ...started.begun, outcome: "failed", detail: `Not sent: ${(e as Error)?.message ?? String(e)}` })); }
  return stateFor(agentId).sent;
}

// Photos picked on the phone, per agent like drafts, for the page's lifetime.
const photoDrafts = new Map<string, File[]>();

const TONE = { pending: "#64748b", ok: "#16a34a", working: "#2563eb", warn: "#9c4b00", error: "#b00020" };

export function ChatComposer({ agentId, view, status, canPrompt, unavailable, compact = false, large = false, placeholder, maxHeight, attach, onSent, busyAction }: {
  agentId: string;
  view: AgentView | null;
  status: string;
  canPrompt: boolean;
  unavailable?: string | null;
  compact?: boolean;
  large?: boolean;
  placeholder?: string;
  // Phone only: the reply box's height cap, a photo button whose pictures go to the frame
  // (and its agent) through the same path as a desktop drop, and what to do after a send
  // (close the keyboard and collapse the thread).
  maxHeight?: number;
  attach?: (files: File[]) => Promise<void>;
  onSent?: () => void;
  // Phone, like Paseo: while the agent works and the box is empty, this (a Stop button)
  // takes the Send button's place; typing brings Send back.
  busyAction?: React.ReactNode;
}) {
  const [photos, setPhotosState] = useState<File[]>(() => photoDrafts.get(agentId) ?? []);
  const setPhotos = (next: File[]) => {
    if (next.length) photoDrafts.set(agentId, next);
    else photoDrafts.delete(agentId);
    setPhotosState(next);
  };
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [sendingPhotos, setSendingPhotos] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const previews = useMemo(() => photos.map((f) => URL.createObjectURL(f)), [photos]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);
  const state = useSyncExternalStore((n) => subscribe(agentId, n), () => stateFor(agentId));
  const { text, sent } = state;
  const earlier = state.earlier ?? [];
  const reply = (view?.rows ?? []).findLast((r) => r.kind === "assistant" && !r.ack && r.text.trim());
  const label = sent ? deliveryLabel(sent, reply?.at ?? null, status) : null;

  // sending → accepted → delivered → agent working → replied stay distinct. The board
  // server retries until the conversation shows the message; the page never resends.
  // Anything that throws is shown as a failed send with Send again; it is never left to
  // an unhandled rejection that makes Enter look like it did nothing.
  // The box empties as soon as a send begins (the "You: …" line shows what went out), so
  // text typed while it is in flight is a new draft. resend: "Send again" for the failed
  // send; only the block the composer restored for it leaves the box (composerBegin).
  const submit = async () => {
    const files = photos;
    const hasText = !!stateFor(agentId).text.trim();
    if (files.length && attach) {
      setSendingPhotos(true);
      setPhotoError(null);
      try {
        await attach(files);
        setPhotos([]);
      } catch (e) {
        setPhotoError((e as Error).message);
        setSendingPhotos(false);
        return;
      }
      setSendingPhotos(false);
    }
    if (hasText) await send();
    else if (files.length && attach) done();
  };
  // Phone: the keyboard closes and the thread collapses to its peek once a send is under way.
  const done = () => {
    if (!onSent) return;
    (document.activeElement as HTMLElement | null)?.blur?.();
    onSent();
  };
  const send = async (resend = false) => {
    const started = composerBegin(stateFor(agentId), canPrompt, Date.now(), resend);
    if (!started) return;
    update(agentId, started.next);
    done();
    const { begun } = started;
    try { await postReply(agentId, begun); }
    catch (e) {
      const current = stateFor(agentId).sent;
      const failed: Sent = { ...(current?.at === begun.at ? current : begun), outcome: "failed", detail: `Not sent: ${(e as Error)?.message ?? String(e)}` };
      update(agentId, (s) => composerSettle(s, failed));
    }
  };
  usePendingChecks(agentId, state);

  // Phone: the box grows with its text up to its cap. iOS Safari has no field-sizing (the
  // desktop path), so it is sized here: one line at least, never shorter than its text.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !large) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 2, maxHeight ?? 160)}px`;
  }, [text, large, maxHeight]);

  // A send on its way never blocks the next one (the server keeps them in order).
  const ready = canPrompt && (!!text.trim() || (!!attach && photos.length > 0)) && !sendingPhotos;
  // On a phone the "You: …" lines wrap (up to three lines) instead of being cut to one.
  const youLine: React.CSSProperties = large ? { color: "#64748b", minWidth: 0, maxWidth: "100%", flex: "1 1 100%", overflowWrap: "anywhere", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" } : { color: "#64748b", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, maxWidth: "100%", flex: "0 1 auto" };
  return (
    <div data-testid="composer" onPointerDown={stop} onPointerUp={stop} onKeyDown={stop} style={{ flexShrink: 0, display: "flex", flexDirection: "column", gap: 4, padding: compact ? "6px 6px 6px" : "8px 10px 10px", borderTop: "1px solid #e2e8f0", background: "#fff", pointerEvents: "all" }}>
      {earlier.map((e) => {
        const l = deliveryLabel(e, reply?.at ?? null, status);
        return (
          <div key={e.messageId ?? e.at} data-testid="reply-earlier" data-outcome={e.outcome} style={{ display: "flex", flexWrap: "wrap", columnGap: 6, fontSize: compact ? 10 : 11, minWidth: 0 }}>
            <span style={youLine}>You: “{e.text}”</span>
            <span style={{ color: TONE[l.tone], minWidth: 0 }}>{e.outcome === "failed" || e.outcome === "unconfirmed" ? `${l.text.replace(/ — draft kept$/, "")} · put back in the box` : l.text}</span>
          </div>
        );
      })}
      {sent && label ? (
        <div data-testid="reply-delivery" data-outcome={sent.outcome} style={{ display: "flex", flexWrap: "wrap", columnGap: 6, fontSize: compact ? 10 : 11, minWidth: 0 }}>
          <span style={youLine}>You: “{sent.text}”</span>
          <span style={{ color: TONE[label.tone], minWidth: 0 }}>{label.text}</span>
        </div>
      ) : null}
      {sent?.mode && sent.mode in USER_NOTES ? (
        // What happens to this message if the agent is busy, what can still interrupt it,
        // and what to do (shared/send-capabilities.ts USER_NOTES; the technical version
        // is MODE_NOTES / MISSING_PRIMITIVE, for docs).
        <details data-testid="reply-mode" data-mode={sent.mode} style={{ fontSize: compact ? 10 : 11, color: "#64748b" }}>
          <summary style={{ cursor: "pointer" }}>ⓘ {USER_NOTES[sent.mode as MidTurn].summary}</summary>
          <div>{USER_NOTES[sent.mode as MidTurn].detail}</div>
        </details>
      ) : null}
      {sent?.outcome === "failed" ? (
        <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: compact ? 10 : 11, color: "#64748b" }}>
          {sent.detail ? <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sent.detail}</span> : null}
          <button type="button" data-testid="reply-resend" disabled={!canPrompt}
            onClick={() => void send(true)}
            style={{ flex: "none", border: "1px solid #b00020", color: "#b00020", background: "#fff", borderRadius: 6, padding: "1px 8px", font: "inherit", cursor: "pointer" }}>
            Send again
          </button>
        </div>
      ) : null}
      {sent?.receipt && sent.outcome === "unconfirmed" ? (
        <details style={{ fontSize: 11 }}>
          <summary>Delivery receipt</summary>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{sent.receipt}</pre>
        </details>
      ) : null}
      {attach ? <PhotoTray photos={photos} previews={previews} setPhotos={setPhotos} disabled={sendingPhotos} /> : null}
      {photoError ? <div role="alert" data-testid="reply-photo-error" style={{ fontSize: 11, color: "#b00020" }}>{photoError}</div> : null}
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
        {attach ? (
          <>
            <input ref={picker} type="file" accept="image/*" multiple hidden data-testid="reply-photo-input"
              onChange={(e) => { const picked = Array.from(e.target.files ?? []); e.target.value = ""; if (picked.length) { setPhotoError(null); setPhotos([...photos, ...picked].slice(0, 6)); } }} />
            <button type="button" data-testid="reply-photo" aria-label="Add photos" title="Add photos" disabled={!canPrompt || sendingPhotos} onClick={() => picker.current?.click()}
              style={{ flex: "none", width: 44, height: 44, borderRadius: 12, border: "1px solid #cbd5e1", background: "#fff", color: "#2E1F16", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <PhotoIcon />
            </button>
          </>
        ) : null}
        <textarea
          ref={box}
          data-testid="reply"
          value={text}
          rows={1}
          disabled={!canPrompt}
          placeholder={canPrompt ? (placeholder ?? "Reply…") : (unavailable ?? "Sending is unavailable for this agent")}
          onChange={(e) => { const value = e.target.value; update(agentId, (s) => composerEdit(s, value)); }}
          onKeyDown={(e) => {
            if (enterSends({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.nativeEvent.keyCode })) {
              e.preventDefault();
              void submit();
            }
          }}
          style={{ flex: 1, minWidth: 0, boxSizing: "border-box", resize: "none", border: "1px solid #cbd5e1", borderRadius: 10, padding: compact ? "5px 8px" : "8px 10px", font: "inherit", fontSize: large ? 16 : compact ? 12 : 13, lineHeight: compact ? "16px" : "20px", minHeight: compact ? 28 : 38, maxHeight: maxHeight ?? (compact ? 80 : 160), overflowY: "auto", fieldSizing: "content", background: "#fff", color: "#0f172a" } as React.CSSProperties}
        />
        {busyAction && !text.trim() && !photos.length && !sendingPhotos ? busyAction : (
        <button type="submit" data-testid="reply-send" aria-label="Send" disabled={!ready}
          style={{ flex: "none", width: compact ? 28 : 38, height: compact ? 28 : 38, borderRadius: compact ? 8 : 10, border: "none", background: ready ? "#2f80ed" : "#cbd5e1", color: "#fff", cursor: ready ? "pointer" : "default", font: `${compact ? 13 : 16}px system-ui` }}>
          {sendingPhotos ? "…" : "↑"}
        </button>
        )}
      </form>
    </div>
  );
}
