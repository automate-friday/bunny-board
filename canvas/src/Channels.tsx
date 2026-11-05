import { useContext, useEffect, useRef, useState } from "react";
import { type Editor, type TLShapeId, useValue } from "tldraw";
import { api } from "./api";
import { MobileCtx } from "./mobile/mobileMode";
import { channelBadge } from "./channelBadge";

interface Channel { id: string; arrow: string; active: boolean; members: { frame: string; agentId: string }[]; messages: Record<string, { status: string }> }
function endpoints(editor: Editor, arrow: string): string[] | null {
  const shape = editor.getShape(arrow as TLShapeId);
  if (shape?.type !== "arrow") return null;
  const bindings = editor.getBindingsFromShape(shape, "arrow");
  const start = bindings.find(b => b.props.terminal === "start"), end = bindings.find(b => b.props.terminal === "end");
  if (!start || !end || start.toId === end.toId) return null;
  const frames = [start.toId, end.toId].map(id => editor.getShape(id));
  if (frames.some(f => f?.type !== "frame")) return null;
  const agents = frames.map(f => (f?.meta.paseo as { agentId?: string } | undefined)?.agentId);
  return agents.every(Boolean) && agents[0] !== agents[1] ? [start.toId, end.toId] : null;
}
export function Channels({ editor, boardId }: { editor: Editor; boardId: string }) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string[]>([]);
  const selected = useValue("channel-selection", () => editor.getOnlySelectedShape(), [editor]);
  const mobile = useContext(MobileCtx);
  // Where each channel's badge goes, and how big it may be: its arrow's box on screen. Arrows
  // off screen or hidden (the phone shows only the open frame) get none.
  const positions = useValue("channel-positions", () => {
    const active = channels.filter(c => c.active);
    if (!active.length) return [];
    const pageId = editor.getCurrentPageId();
    return active.flatMap(c => {
      const shape = editor.getShape(c.arrow as TLShapeId);
      if (shape?.type !== "arrow" || editor.getAncestorPageId(shape) !== pageId || editor.isShapeHidden(shape)) return [];
      const bounds = editor.getShapePageBounds(shape);
      if (!bounds) return [];
      const tl = editor.pageToScreen({ x: bounds.x, y: bounds.y }), br = editor.pageToScreen({ x: bounds.x + bounds.w, y: bounds.y + bounds.h });
      const vp = editor.getViewportScreenBounds();
      if (br.x < vp.x || tl.x > vp.x + vp.w || br.y < vp.y || tl.y > vp.y + vp.h) return [];
      return [{ id: shape.id, point: editor.pageToScreen(bounds.center), w: br.x - tl.x, h: br.y - tl.y, zoom: editor.getZoomLevel() }];
    });
  }, [editor, channels]);
  const lifecycle = useRef(0);
  const base = `/api/ui/boards/${encodeURIComponent(boardId)}/channels`;
  useEffect(() => {
    let alive = true, ready = false;
    let fetchTask: Promise<void> | null = null;
    const generation = ++lifecycle.current;
    const pending = new Set<string>(), working = new Set<string>(), removed = new Set<string>();
    const refresh = async (force = false): Promise<void> => {
      if (fetchTask) { await fetchTask; if (force && alive) return refresh(); return; }
      fetchTask = (async () => {
        try {
          const r = await api<{ channels: Channel[] }>(base, { signal: AbortSignal.timeout(8000) });
          if (!alive) return;
          setChannels(r.channels);
          setErrors(old => { const next = { ...old }; delete next.server; return next; });
          for (const c of r.channels) if (!c.active) removed.add(c.arrow);
          ready = true;
        } catch (e) { if (alive) setErrors(old => ({ ...old, server: (e as Error).message })); }
      })();
      try { await fetchTask; } finally { fetchTask = null; }
    };
    const create = async (id: string, automatic: boolean) => {
      if (!alive || working.has(id) || (automatic && removed.has(id))) return;
      const members = endpoints(editor, id); if (!members) return;
      working.add(id); setBusy([...working]);
      try { await api(base, { method: "POST", body: JSON.stringify({ arrowId: id, members }) }); removed.delete(id); if (alive) setErrors(old => { const next = { ...old }; delete next[id]; return next; }); await refresh(true); }
      catch (e) { if (alive) setErrors(old => ({ ...old, [id]: (e as Error).message })); }
      finally { working.delete(id); if (alive) setBusy([...working]); }
    };
    actions.current = {
      create: id => void create(id, false),
      revoke: async channel => { if (working.has(channel.arrow)) return; removed.add(channel.arrow); working.add(channel.arrow); setBusy([...working]); try { await api(`${base}/${encodeURIComponent(channel.id)}/revoke`, { method: "POST", body: "{}" }); await refresh(true); } catch (e) { if (alive) setErrors(old => ({ ...old, [channel.arrow]: (e as Error).message })); } finally { working.delete(channel.arrow); if (alive) setBusy([...working]); } },
    };
    const stop = editor.store.listen(entry => {
      for (const r of [...Object.values(entry.changes.added), ...Object.values(entry.changes.updated).map(pair => pair[1])]) {
        if (r.typeName === "binding" && r.type === "arrow") pending.add(r.fromId);
        if (r.typeName === "shape" && r.type === "arrow" && entry.changes.added[r.id]) pending.add(r.id);
      }
    }, { scope: "document", source: "user" });
    const drain = setInterval(() => { if (!ready || editor.inputs.getIsPointing()) return; for (const id of pending) { pending.delete(id); void create(id, true); } }, 750);
    const poll = setInterval(() => void refresh(), 3000);
    void refresh();
    return () => { alive = false; if (lifecycle.current === generation) lifecycle.current++; stop(); clearInterval(drain); clearInterval(poll); };
  }, [editor, base]);
  const actions = useRef<{ create: (id: string) => void; revoke: (c: Channel) => void }>({ create: () => {}, revoke: () => {} });
  const active = channels.filter(c => c.active && positions.some(p => p.id === c.arrow));
  const selectedChannel = selected?.type === "arrow" ? channels.find(c => c.arrow === selected.id && c.active) : undefined;
  return <>
    {active.map(c => {
      const pos = positions.find(p => p.id === c.arrow);
      if (!pos) return null;
      const p = pos.point;
      const label = errors.server ? "Channel status unverified" : `Channel · ${Object.keys(c.messages).length} receipts`;
      // Full controls only on a desktop canvas at a working zoom; on the phone and when zoomed out,
      // a small badge that fits inside the arrow on screen (or nothing), never full-size buttons.
      const kind = channelBadge({ mobile, zoom: pos.zoom, w: pos.w, h: pos.h });
      if (kind.mode === "none") return null;
      if (kind.mode === "dot") return <button key={c.id} type="button" data-testid="channel-badge" data-mode="dot" aria-label={`${label}. Select the arrow for its controls`} title={label} onPointerDown={e => e.stopPropagation()} onClick={() => !mobile && editor.select(c.arrow as TLShapeId)} style={{ position: "fixed", left: p.x - kind.size / 2, top: p.y - kind.size / 2, width: kind.size, height: kind.size, padding: 0, borderRadius: kind.size / 2, border: "1px solid #529a59", background: errors.server ? "#fff3df" : "#edf7ed", color: "#2f6b35", font: `700 ${Math.max(8, Math.round(kind.size * 0.55))}px system-ui`, lineHeight: 1, display: "grid", placeItems: "center", pointerEvents: mobile ? "none" : "all", zIndex: 250, cursor: "pointer", overflow: "hidden" }}>⇄</button>;
      return <div key={c.id} data-testid="channel-badge" data-mode="full" style={{ position: "fixed", left: p.x, top: p.y, background: errors.server ? "#fff3df" : "#edf7ed", border: "1px solid #529a59", borderRadius: 6, padding: 5, font: "12px system-ui", pointerEvents: "all", zIndex: 250 }} onPointerDown={e => e.stopPropagation()}>
      <button type="button" onClick={() => editor.select(c.arrow as TLShapeId)}>{label}</button>{" "}
      <button type="button" data-testid="channel-remove" disabled={busy.includes(c.arrow)} onClick={() => actions.current.revoke(c)}>Remove channel</button>
    </div>;
    })}
    {errors.server ? <div role="alert" data-testid="channel-status-error" style={{ position: "absolute", bottom: 100, left: 12, background: "#fff3df", padding: 8, pointerEvents: "all", maxWidth: 320 }}>Channel status unavailable: {errors.server}. Existing memberships are unverified until refresh succeeds.</div> : null}
    {selected?.type === "arrow" ? <div data-testid="channel-controls" onPointerDown={e => e.stopPropagation()} style={{ position: "absolute", top: 58, left: "35%", background: "white", border: "1px solid #bbb", borderRadius: 8, padding: 10, pointerEvents: "all", font: "12px system-ui", maxWidth: 330 }}>
      {selectedChannel ? <div>{errors.server ? "Channel status unverified." : "Channel active."} Agents can send deliberate messages; transcripts are not forwarded.</div> : endpoints(editor, selected.id) ? <button type="button" data-testid="channel-create" disabled={busy.includes(selected.id)} onClick={() => actions.current.create(selected.id)}>{busy.includes(selected.id) ? "Creating channel…" : "Create channel between these frames"}</button> : <div>Bind both arrow ends to two different bound frames to create a channel.</div>}
      {selectedChannel ? Object.entries(selectedChannel.messages).map(([id, receipt]) => <div key={id}>Message {id.split('\0').at(-1)}: {receipt.status}</div>) : null}
      {errors[selected.id] ? <div role="alert">{errors[selected.id]}</div> : null}
      {errors.server ? <div role="alert">Channel status unavailable: {errors.server}</div> : null}
    </div> : null}
  </>;
}
