// Phone: Tell Bunny. Tap Bunny (the corner launcher, or Bunny on the tiles bar) to report
// something, usually a bug with screenshots. Bunny ranks the agent frames by how well the
// words match each frame's name, agent title, text and recent conversation (route.ts over
// fuzzySearch.ts buildDocs) and offers the best: "Send to <frame>?" with a one-line reason and
// two alternatives, or, when nothing matches well, "New agent next to <closest frame>" with
// a suggested name. Nothing is sent or created until a tap. A send waits a few seconds
// (Undo send) and then goes exactly like a thread reply: photos into the frame and to the
// agent, then the text through the reply box's path (ChatComposer sendReply). Screenshots are
// not read here (no image model on the phone); they go along to the agent, which reads them.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "tldraw";
import { agentStore } from "../agents";
import { BunnyMark } from "../BunnyMark";
import { sendReply } from "../ChatComposer";
import { sendPhotosToFrame } from "../fileDrop";
import { buildDocs } from "./fuzzySearch";
import { PhotoIcon, PhotoTray } from "./PhotoTray";
import { chooseRoute, rankFrames, type Route, routeReason, suggestName, words } from "./route";
import { askStartBeside, useVisibleViewport } from "./StartSheet";
import "./startSheet.css";
import "./tellBunny.css";
import { useModalHold } from "./modalHold";

let open = false;
const listeners = new Set<() => void>();
export function openTellBunny(on = true) {
  open = on;
  for (const l of listeners) l();
}
const useOpen = () => useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => open);

type TFrame = { id: string; name: string; agentId: string; agentTitle: string; pageId: string; host: string; rawStatus: string };
type Outbox = { frameId: string; name: string; agentId: string; text: string; files: File[]; phase: "waiting" | "sending" | "sent" | "failed"; detail?: string };

export const UNDO_SEND_MS = 5000;

// Bunny on the tiles bar (the corner launcher steps aside on the tiles).
export function TellBunnyButton() {
  return (
    <button type="button" className="bm-tell" data-testid="mobile-tell-bunny" aria-label="Tell Bunny: send a bug or screenshot to the right agent" onClick={() => openTellBunny()}>
      <BunnyMark size={34} mood="idle" />
    </button>
  );
}

export function TellBunny({ editor, boardId, frames, touched, current, openFrame }: { editor: Editor; boardId: string; frames: readonly TFrame[]; touched: ReadonlyMap<string, number>; current: string | null; openFrame: (id: string) => void }) {
  const isOpen = useOpen();
  useModalHold(isOpen);
  const [text, setText] = useState("");
  const [photos, setPhotos] = useState<File[]>([]);
  const [routing, setRouting] = useState(false);
  const [outbox, setOutbox] = useState<Outbox | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const vp = useVisibleViewport();
  const previews = useMemo(() => photos.map((f) => URL.createObjectURL(f)), [photos]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);
  useEffect(() => {
    if (!isOpen) setRouting(false);
  }, [isOpen]);

  // The agents' recent conversation, for matching: loaded while the sheet is open.
  const [loaded, setLoaded] = useState(0);
  const agentIds = useMemo(() => [...frames].filter((f) => f.agentId).sort((a, b) => (touched.get(b.id) ?? 0) - (touched.get(a.id) ?? 0)).slice(0, 60).map((f) => f.agentId), [frames, touched]);
  useEffect(() => {
    if (!isOpen) return;
    const stops = agentIds.map((id) => agentStore.subscribe(id, () => setLoaded((n) => n + 1)));
    for (const id of agentIds) agentStore.prefetch(id);
    return () => stops.forEach((stop) => stop());
  }, [isOpen, agentIds]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `loaded` re-reads the conversations.
  const choice = useMemo(() => {
    if (!routing) return null;
    const docs = buildDocs(frames.map((f) => ({ id: f.id, name: f.name, agentId: f.agentId, agentTitle: f.agentTitle, harness: "", host: f.host })), editor.store.allRecords(), (id) => ((agentStore.get(id)?.rows ?? []) as { kind: string; text: string; primer?: unknown; ack?: unknown }[]).filter((r) => !r.primer && !r.ack));
    const ranked = rankFrames(docs, text, { agentFrames: new Set(frames.filter((f) => f.agentId).map((f) => f.id)), touched });
    // Only photos, no words: the frame you are in, if it has an agent.
    const here = current ? frames.find((f) => f.id === current && f.agentId) : null;
    if (!words(text).length && here) return { best: { id: here.id, score: 0, terms: [], where: "name" as const }, alternatives: [], here: true };
    return { ...chooseRoute(ranked), here: false };
  }, [routing, text, frames, touched, current, editor, loaded]);
  const byId = (id: string) => frames.find((f) => f.id === id);
  // Where a new agent goes: beside the frame you are in, else the best (weak) match, else the
  // most recently active frame.
  const closest = choice ? (current && byId(current)) || (choice.alternatives[0] && byId(choice.alternatives[0].id)) || [...frames].sort((a, b) => (touched.get(b.id) ?? -Infinity) - (touched.get(a.id) ?? -Infinity))[0] || null : null;

  const reset = () => {
    setText("");
    setPhotos([]);
    setRouting(false);
  };
  const send = (r: Route) => {
    const f = byId(r.id);
    if (!f?.agentId) return;
    const item: Outbox = { frameId: f.id, name: f.name, agentId: f.agentId, text: text.trim(), files: photos, phase: "waiting" };
    openTellBunny(false);
    reset();
    setOutbox(item);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void deliver(item), UNDO_SEND_MS);
  };
  const deliver = async (item: Outbox) => {
    timer.current = null;
    setOutbox({ ...item, phase: "sending" });
    try {
      if (item.files.length) await sendPhotosToFrame(editor, boardId, item.frameId, item.agentId, item.files);
      if (item.text) {
        const sent = await sendReply(item.agentId, item.text);
        if (sent?.outcome === "failed") throw Error(sent.detail ?? "not sent");
      }
      setOutbox({ ...item, phase: "sent" });
      timer.current = setTimeout(() => setOutbox(null), 6000);
    } catch (e) {
      setOutbox({ ...item, phase: "failed", detail: (e as Error).message });
    }
  };
  const undo = () => {
    if (!outbox || outbox.phase !== "waiting") return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setText(outbox.text);
    setPhotos(outbox.files);
    setOutbox(null);
    openTellBunny();
  };
  const newAgent = () => {
    if (!closest) return;
    askStartBeside(closest.id, { prompt: text.trim() ? `${text.trim()}\n\n` : "", name: suggestName(text), files: photos });
    openTellBunny(false);
    reset();
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const toast = outbox ? (
    <div className="bm-tell-toast" data-mobile-ui data-testid="tell-toast" data-phase={outbox.phase} role="status">
      <span>
        {outbox.phase === "waiting" ? <>Sending to <b>{outbox.name}</b>…</> : outbox.phase === "sending" ? <>Sending to <b>{outbox.name}</b>…</> : outbox.phase === "sent" ? <>Sent to <b>{outbox.name}</b></> : <>Not sent to <b>{outbox.name}</b>: {outbox.detail}</>}
      </span>
      <button type="button" data-testid="tell-toast-open" onClick={() => { const id = outbox.frameId; if (outbox.phase !== "waiting") setOutbox(null); openFrame(id); }}>
        Open
      </button>
      {outbox.phase === "waiting" ? (
        <button type="button" data-testid="tell-undo" onClick={undo}>
          Undo send
        </button>
      ) : outbox.phase === "failed" ? (
        <button type="button" onClick={() => void deliver({ ...outbox, phase: "waiting" })}>
          Try again
        </button>
      ) : null}
      {outbox.phase === "waiting" ? <i className="bm-tell-count" style={{ animationDuration: `${UNDO_SEND_MS}ms` }} /> : null}
    </div>
  ) : null;

  if (!isOpen) return toast ? createPortal(toast, document.body) : null;
  const best = choice?.best ? byId(choice.best.id) : null;
  return createPortal(
    <>
      <div className="bm-start-layer" data-mobile-ui data-testid="tell-bunny" style={{ top: vp.top, height: vp.height, zIndex: 1003 }}>
        <div className="bm-start-scrim" onPointerDown={() => openTellBunny(false)} />
        <div className="bm-start-sheet" role="dialog" aria-modal="true" aria-label="Tell Bunny" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") openTellBunny(false); }}>
          <div className="bm-start-head">
            <span className="bm-grip-bar" aria-hidden="true" />
            <b className="bm-tell-title"><BunnyMark size={26} mood="idle" /> Tell Bunny</b>
            <small>{routing ? "Nothing is sent until you tap" : "A bug, a screenshot: Bunny finds the agent for it"}</small>
          </div>
          <div className="bm-start-body">
            {!routing ? (
              <>
                <textarea data-testid="tell-text" className="bm-start-text" rows={3} placeholder="What's wrong, or what should happen?" value={text} onChange={(e) => setText(e.target.value)} />
                <PhotoTray photos={photos} previews={previews} setPhotos={setPhotos} />
                <input ref={picker} type="file" accept="image/*" multiple hidden data-testid="tell-photo-input" onChange={(e) => { const picked = Array.from(e.target.files ?? []); e.target.value = ""; if (picked.length) setPhotos([...photos, ...picked].slice(0, 6)); }} />
                <button type="button" className="bm-tell-photo" data-testid="tell-photo" onClick={() => picker.current?.click()}>
                  <PhotoIcon /> Add screenshots
                </button>
              </>
            ) : (
              <div data-testid="tell-route" className="bm-tell-route">
                {best && choice?.best ? (
                  <div className="bm-tell-card" data-testid="tell-best" data-frame-id={best.id}>
                    <span>
                      Send to <b>{best.name}</b>?
                    </span>
                    <small data-testid="tell-reason">{choice.here ? "the frame you are in" : routeReason(choice.best)}</small>
                    <button type="button" className="bm-start-go" data-testid="tell-send" onClick={() => send(choice.best!)}>
                      Send{photos.length ? ` with ${photos.length} screenshot${photos.length === 1 ? "" : "s"}` : ""}
                    </button>
                  </div>
                ) : (
                  <div className="bm-tell-card" data-testid="tell-new" data-near={closest?.id ?? ""}>
                    <span>No agent looks right for this.</span>
                    {closest ? (
                      <>
                        <small>
                          New agent <b>“{suggestName(text)}”</b> next to <b>{closest.name}</b>
                        </small>
                        <button type="button" className="bm-start-go" data-testid="tell-new-agent" onClick={newAgent}>
                          Start a new agent…
                        </button>
                      </>
                    ) : (
                      <small>No frames on this board yet: use + Start agent.</small>
                    )}
                  </div>
                )}
                {choice?.alternatives.length ? (
                  <div className="bm-tell-alts" data-testid="tell-alternatives">
                    <span className="bm-field-label">{best ? "Or" : "Closest matches"}</span>
                    {choice.alternatives.map((r) => {
                      const f = byId(r.id);
                      return f ? (
                        <button key={r.id} type="button" data-testid="tell-alt" data-frame-id={r.id} onClick={() => send(r)}>
                          <span>Send to {f.name}</span>
                          <small>{routeReason(r)}</small>
                        </button>
                      ) : null;
                    })}
                  </div>
                ) : null}
                {best && closest ? (
                  <button type="button" className="bm-tell-link" data-testid="tell-new-instead" onClick={newAgent}>
                    New agent next to {closest.name} instead
                  </button>
                ) : null}
              </div>
            )}
          </div>
          <div className="bm-start-foot">
            {routing ? (
              <button type="button" className="bm-start-cancel" data-testid="tell-edit" onClick={() => setRouting(false)}>
                ← Edit
              </button>
            ) : (
              <button type="button" className="bm-start-cancel" onClick={() => openTellBunny(false)}>
                Cancel
              </button>
            )}
            {routing ? null : (
              <button type="button" className="bm-start-go" data-testid="tell-find" disabled={!text.trim() && !photos.length} onClick={() => { (document.activeElement as HTMLElement | null)?.blur?.(); setRouting(true); }}>
                Find the agent
              </button>
            )}
          </div>
        </div>
      </div>
      {toast}
    </>,
    document.body,
  );
}
