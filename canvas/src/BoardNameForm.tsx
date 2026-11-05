import { useEffect, useRef, useState } from "react";
import { api } from "./api";
type Resolution = { boardId: string; requestedName: string; matchedBy: string; existing: boolean };
export function BoardNameForm({ narrow, onOpen, onClose }: { narrow: boolean; onOpen: (id: string) => void; onClose: () => void }) {
  const [name, setName] = useState(""), [resolved, setResolved] = useState<Resolution | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const generation = useRef(0), controller = useRef<AbortController | null>(null);
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, []);
  const submit = async () => {
    if (busy || !name.trim()) return;
    if (resolved) { onOpen(resolved.boardId); return; }
    const token = ++generation.current; controller.current?.abort(); controller.current = new AbortController(); setBusy(true); setError(null);
    try {
      const result = await api<Resolution>(`/api/ui/boards/resolve?name=${encodeURIComponent(name)}`, { signal: controller.current.signal });
      if (generation.current === token) setResolved(result);
    } catch (e) { if (generation.current === token) setError((e as Error).message); }
    finally { if (generation.current === token) setBusy(false); }
  };
  return <form style={{ display: "flex", gap: 4, flexWrap: "wrap", maxWidth: 500 }} onSubmit={e => { e.preventDefault(); void submit(); }}>
    <input data-testid="new-board-name" autoFocus value={name} placeholder="Board name" style={{ width: narrow ? 110 : 150, padding: "4px 6px" }} onChange={e => { generation.current++; controller.current?.abort(); setBusy(false); setName(e.target.value); setResolved(null); setError(null); }} onKeyDown={e => { e.stopPropagation(); if (e.key === "Escape") onClose(); }} />
    <button type="submit" disabled={busy || !name.trim()}>{busy ? "Resolving…" : resolved ? "Open selected board" : "Resolve name"}</button><button type="button" onClick={onClose} aria-label="Cancel board name">×</button>
    {resolved ? <div data-testid="resolved-board" style={{ flexBasis: "100%" }}>{resolved.existing ? "Existing" : "New"} board: <strong>{resolved.boardId}</strong> · {resolved.matchedBy}</div> : null}
    {error ? <div role="alert" style={{ flexBasis: "100%", color: "#b00020" }}>{error}</div> : null}
  </form>;
}
