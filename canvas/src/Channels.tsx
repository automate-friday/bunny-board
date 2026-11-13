import { useContext, useEffect, useRef, useState } from "react";
import { type Editor, type TLShapeId, useValue } from "tldraw";
import { api } from "./api";
import { MobileCtx } from "./mobile/mobileMode";
import { channelBadge } from "./channelBadge";
import { channelList, channelListError, setChannelRefresher } from "./channelState";
import { type ChannelInfo, isArrowChannel, offersRev } from "./linkChannelModel";

// This file draws arrow channels and reads the board's channel list for everyone (channelState.ts).
// Link channels (anchor "link", arrow "", a pair of stickies) are in that list too; their
// stickies, proposals and "Connect to…" are drawn by LinkChannels.tsx and ConnectPicker.tsx.
type Channel = ChannelInfo;
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
  const all = useValue(channelList);
  // Only arrow channels have an arrow to badge; a link channel's `arrow` is "".
  const channels = all.filter(isArrowChannel);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string[]>([]);
  const selected = useValue("channel-selection", () => editor.getOnlySelectedShape(), [editor]);
  const mobile = useContext(MobileCtx);
  // Where each channel's badge goes, and how big it may be: its arrow's box on screen. Arrows
  // off screen or hidden (the phone shows only the open frame) get none.
  const positions = useValue("channel-positions", () => {
    const active = all.filter(c => c.active && isArrowChannel(c));
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
  }, [editor, all]);
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
          channelList.set(r.channels);
          channelListError.set(null);
          setErrors(old => { const next = { ...old }; delete next.server; return next; });
          for (const c of r.channels) if (!c.active && isArrowChannel(c)) removed.add(c.arrow);
          ready = true;
        } catch (e) { if (alive) { channelListError.set((e as Error).message); setErrors(old => ({ ...old, server: (e as Error).message })); } }
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
    // A link channel opens and closes through its stickies and through proposals, which reach
    // this tab by sync: read the list again as soon as a channel sticky comes, goes or loses
    // its mark, or the pending proposals change, instead of waiting for the next poll.
    let soon: ReturnType<typeof setTimeout> | null = null;
    const marked = (r: { typeName: string; type?: string; meta?: unknown }) => r.typeName === "shape" && r.type === "note" && !!(r.meta as { channel?: unknown } | undefined)?.channel;
    const stopLinks = editor.store.listen(entry => {
      const c = entry.changes;
      const hit = Object.values(c.added).some(marked) || Object.values(c.removed).some(marked) ||
        Object.values(c.updated).some(([before, after]) => marked(before) !== marked(after) || (after.typeName === "document" && offersRev(before.meta) !== offersRev(after.meta)));
      if (!hit || soon) return;
      soon = setTimeout(() => { soon = null; void refresh(true); }, 120);
    }, { scope: "document" });
    setChannelRefresher(() => refresh(true));
    const drain = setInterval(() => { if (!ready || editor.inputs.getIsPointing()) return; for (const id of pending) { pending.delete(id); void create(id, true); } }, 750);
    const poll = setInterval(() => void refresh(), 3000);
    void refresh();
    return () => { alive = false; if (lifecycle.current === generation) lifecycle.current++; stop(); stopLinks(); if (soon) clearTimeout(soon); setChannelRefresher(null); channelList.set([]); channelListError.set(null); clearInterval(drain); clearInterval(poll); };
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
      if (kind.mode === "dot") return <button key={c.id} type="button" data-testid="channel-badge" data-mode="dot" aria-label={`${label}. Select the arrow for its controls`} title={label} onPointerDown={e => e.stopPropagation()} onClick={() => !mobile && editor.select(c.arrow as TLShapeId)} style={{ position: "fixed", left: p.x - kind.size / 2, top: p.y - kind.size / 2, width: kind.size, height: kind.size, padding: 0, borderRadius: kind.size / 2, border: "1px solid light-dark(#529a59, hsl(126 35% 39%))", background: errors.server ? "light-dark(#fff3df, hsl(38 45% 21%))" : "light-dark(#edf7ed, var(--bunny-raised))", color: "light-dark(#2f6b35, hsl(126 50% 74%))", font: `700 ${Math.max(8, Math.round(kind.size * 0.55))}px system-ui`, lineHeight: 1, display: "grid", placeItems: "center", pointerEvents: mobile ? "none" : "all", zIndex: 250, cursor: "pointer", overflow: "hidden" }}>⇄</button>;
      return <div key={c.id} data-testid="channel-badge" data-mode="full" style={{ position: "fixed", left: p.x, top: p.y, background: errors.server ? "light-dark(#fff3df, hsl(38 45% 21%))" : "light-dark(#edf7ed, var(--bunny-raised))", border: "1px solid light-dark(#529a59, hsl(126 35% 39%))", borderRadius: 6, padding: 5, font: "12px system-ui", pointerEvents: "all", zIndex: 250 }} onPointerDown={e => e.stopPropagation()}>
      <button type="button" onClick={() => editor.select(c.arrow as TLShapeId)}>{label}</button>{" "}
      <button type="button" data-testid="channel-remove" disabled={busy.includes(c.arrow)} onClick={() => actions.current.revoke(c)}>Remove channel</button>
    </div>;
    })}
    {errors.server
      // A small note that never takes a pointer; the detail is in its tooltip and in the arrow's controls.
      ? <div role="status" data-testid="channel-status-error" title={`Channel status unavailable: ${errors.server}. Existing memberships are unverified until refresh succeeds.`} style={{ position: "absolute", ...(mobile ? { top: 104 } : { bottom: 100 }), left: 12, background: "light-dark(#fff3dfe6, color-mix(in srgb, hsl(38 45% 21%) 90%, transparent))", color: "light-dark(#7a4b00, hsl(37 88% 74%))", borderRadius: 999, padding: "3px 10px", font: "11px system-ui", pointerEvents: "none", maxWidth: "calc(100vw - 24px)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", zIndex: 250 }}>Channels: checking…</div>
      : null}
    {selected?.type === "arrow" ? <div data-testid="channel-controls" onPointerDown={e => e.stopPropagation()} style={{ position: "absolute", top: 58, left: "35%", background: "light-dark(white, var(--bunny-surface))", border: "1px solid light-dark(#bbb, var(--bunny-line))", borderRadius: 8, padding: 10, pointerEvents: "all", font: "12px system-ui", maxWidth: 330 }}>
      {selectedChannel ? <div>{errors.server ? "Channel status unverified." : "Channel active."} Agents can send deliberate messages; transcripts are not forwarded.</div> : endpoints(editor, selected.id) ? <button type="button" data-testid="channel-create" disabled={busy.includes(selected.id)} onClick={() => actions.current.create(selected.id)}>{busy.includes(selected.id) ? "Creating channel…" : "Create channel between these frames"}</button> : <div>Bind both arrow ends to two different bound frames to create a channel.</div>}
      {selectedChannel ? Object.entries(selectedChannel.messages).map(([id, receipt]) => <div key={id}>Message {id.split('\0').at(-1)}: {receipt.status}</div>) : null}
      {errors[selected.id] ? <div role="alert">{errors[selected.id]}</div> : null}
      {errors.server ? <div role="alert">Channel status unavailable: {errors.server}</div> : null}
    </div> : null}
  </>;
}
