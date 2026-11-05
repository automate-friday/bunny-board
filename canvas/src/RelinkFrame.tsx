import { useEffect, useRef, useState } from "react";
import type { Editor, TLFrameShape } from "tldraw";
import { api } from "./api";

export function RelinkFrame({ editor, frame, boardId, hint, onOpen }: { editor: Editor; frame: TLFrameShape; boardId: string; hint: { agentId: string; host?: string }; onOpen: () => void }) {
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false), requestId = useRef(`relink-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const link = async () => {
    if (inFlight.current) return;
    const current = editor.getShape(frame.id);
    const paseo = current?.meta.paseo as { agentId?: string; relink?: { agentId?: string; host?: string } } | undefined;
    if (!current || paseo?.agentId || paseo?.relink?.agentId !== hint.agentId || paseo.relink.host !== hint.host) { setError("The frame changed. Select it again before linking."); return; }
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const result = await api<{ created: { agentId: string }[]; skipped: { reason?: string }[] }>(`/api/ui/boards/${encodeURIComponent(boardId)}/import`, { method: "POST", body: JSON.stringify({ agentIds: [hint.agentId], ...(hint.host ? { host: hint.host } : {}), frameId: frame.id, pageId: editor.getAncestorPageId(frame), requestId: requestId.current, by: window.__board?.userName }) });
      if (!result.created.some(row => row.agentId === hint.agentId)) throw Error(result.skipped[0]?.reason ?? "The conversation was not linked.");
      if (alive.current) { setConfirm(false); onOpen(); }
    } catch (e) { if (alive.current) setError((e as Error).message); }
    finally { inFlight.current = false; if (alive.current) setBusy(false); }
  };
  return <div data-testid="frame-relink" style={{ flexBasis: "100%" }}>
    <span>Restored conversation: {hint.agentId}{hint.host ? ` on ${hint.host}` : ""}. The frame is unbound.</span>{" "}
    {confirm ? <><span>Link this existing conversation to this frame?</span> <button data-testid="relink-confirm" disabled={busy} onClick={() => void link()}>{busy ? "Linking…" : "Confirm re-link"}</button> <button disabled={busy} onClick={() => setConfirm(false)}>Cancel</button></> : <button data-testid="relink-open" onClick={() => setConfirm(true)}>Re-link existing conversation</button>}
    {error ? <div role="alert">{error}</div> : null}
  </div>;
}
