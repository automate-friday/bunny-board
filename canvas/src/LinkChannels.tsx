// Link channels on the board (server/frame-channels.ts; the list comes from channelState.ts).
// A link channel connects two frames, on any pages, through a pair of portal stickies, one in
// each frame. Here:
//  - a live channel sticky carries a small "Channel" mark (a dot and a label), and while it
//    is selected (desktop), "Remove channel"; its portal button (Portals.tsx) still opens
//    and jumps to the other frame;
//  - an agent's request to be connected shows as a quiet offer at the asking frame, beside
//    its name: Connect to “name”? with Approve and Decline, and in that frame's conversation
//    while it is open. No count, no dot elsewhere, no toast: it is there when you look at the
//    frame;
//  - the conversation ⋯ menu's Channels group: "Connect to…" (ConnectPicker.tsx) and one
//    "Connected to name" row per active channel, with Jump and Remove.
import { type CSSProperties, useContext, useMemo, useState } from "react";
import { type Editor, type TLFrameShape, type TLShapeId, useValue } from "tldraw";
import { B, chip, DOT, menuItem, softBtn, surface, UI_FONT } from "./bunnyTheme";
import { askConnect, channelList, channelListError, decideOffer, offerFailures, offersDecided, refreshChannels, removeChannel, setOfferFailure } from "./channelState";
import { channelErrorText, channelPeers, liveStickies, offerPlacement, type PendingOffer, pendingOffers, stickyMark } from "./linkChannelModel";
import { MobileCtx } from "./mobile/mobileMode";
import { jumpToFrame } from "./portals/Portals";

const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
const oneLine: CSSProperties = { minWidth: 0, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" };
// Inline-styled buttons do not dim on their own while an action is running.
const dim = (off: boolean): CSSProperties => (off ? { opacity: 0.5, cursor: "default" } : {});
const srOnly: CSSProperties = { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" };

function frameName(editor: Editor, id: string, fallback = ""): string {
  const name = (editor.getShape(id as TLShapeId)?.props as { name?: string } | undefined)?.name;
  return String(name ?? "").trim() || fallback.trim() || "Untitled frame";
}

// State is a dot and a muted label (docs/VISUAL-STANDARDS.md), never coloured text.
const StateDot = ({ color }: { color: string }) => <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: color, flex: "none" }} />;
const Problem = ({ text }: { text: string }) => (
  <span role="alert" style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, color: B.muted, font: `12px/1.35 ${UI_FONT}` }}>
    <StateDot color={B.danger} />
    <span style={{ minWidth: 0, overflowWrap: "break-word" }}>{text}</span>
  </span>
);

export function LinkChannels({ editor, boardId }: { editor: Editor; boardId: string }) {
  return (
    <>
      <StickyMarks editor={editor} boardId={boardId} />
      <OfferChips editor={editor} boardId={boardId} />
    </>
  );
}

// --- channel stickies ----------------------------------------------------------------------

type Mark = { id: string; channelId: string; name: string; x: number; y: number; mode: "label" | "dot"; selected: boolean };

function StickyMarks({ editor, boardId }: { editor: Editor; boardId: string }) {
  const mobile = useContext(MobileCtx);
  const channels = useValue(channelList);
  const unverified = !!useValue(channelListError);
  const live = useMemo(() => liveStickies(channels), [channels]);
  // Recomputed on every camera move, so it returns a string: an unchanged list re-renders
  // nothing. A board without a link channel never reads the camera.
  const json = useValue(
    "channel-sticky-marks",
    () => {
      if (!live.size) return "[]";
      const pageId = editor.getCurrentPageId();
      const vp = editor.getViewportPageBounds();
      const z = editor.getZoomLevel();
      const selectedId = editor.getOnlySelectedShapeId();
      const out: Mark[] = [];
      for (const [noteId, end] of live) {
        const note = editor.getShape(noteId as TLShapeId);
        if (note?.type !== "note" || (note.meta as { channel?: { id?: unknown } }).channel?.id !== end.channelId) continue;
        if (editor.getAncestorPageId(note) !== pageId || editor.isShapeHidden(note)) continue;
        const b = editor.getShapePageBounds(note.id);
        if (!b?.collides(vp)) continue;
        const selected = note.id === selectedId;
        const fit = stickyMark(b.w * z);
        // A selected sticky always gets its mark, so "Remove channel" is there at any zoom.
        const mode = fit === "none" ? (selected ? "dot" : null) : fit;
        if (!mode) continue;
        const p = editor.pageToViewport({ x: b.minX, y: b.minY });
        out.push({ id: note.id, channelId: end.channelId, name: frameName(editor, end.peer), x: Math.round(p.x), y: Math.round(p.y), mode, selected });
      }
      return JSON.stringify(out);
    },
    [editor, live],
  );
  const marks = useMemo(() => JSON.parse(json) as Mark[], [json]);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const remove = async (m: Mark) => {
    if (busy) return;
    setBusy(m.channelId);
    setErrors((old) => ({ ...old, [m.channelId]: "" }));
    try {
      await removeChannel(boardId, m.channelId);
    } catch (e) {
      setErrors((old) => ({ ...old, [m.channelId]: channelErrorText((e as Error).message) }));
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      {marks.map((m) => {
        const what = `Channel to “${m.name}”${unverified ? " (not confirmed just now)" : ""}`;
        // The phone shell has its own way of holding a shape (no plain selection to hang a
        // button on): there the mark only marks, and Remove is in the thread's ⋯ menu.
        const removable = m.selected && !mobile;
        return (
          // Above the sticky's top-left corner, clear of its text and of the portal button on
          // its top-right corner. It takes the pointer only while it has a button to press.
          <div
            key={m.id}
            data-testid="channel-sticky-mark"
            data-note={m.id}
            data-channel={m.channelId}
            data-mode={m.mode}
            style={{ position: "absolute", left: m.x, top: m.y - 6, transform: "translateY(-100%)", display: "flex", alignItems: "flex-end", gap: 6, pointerEvents: removable ? "all" : "none", zIndex: 250, maxWidth: "min(420px, 90vw)" }}
            onPointerDown={stop}
            onKeyDown={stop}
          >
            <span title={`${what}. The two agents can send each other deliberate messages.`} style={{ ...chip, gap: 5, background: B.cream, border: `1px solid ${B.line}`, color: B.muted }}>
              <StateDot color={unverified ? DOT.missing : DOT.idle} />
              <span style={m.mode === "label" ? undefined : srOnly}>Channel</span>
            </span>
            {removable ? (
              <button type="button" data-testid="channel-sticky-remove" disabled={busy === m.channelId} title={`Close the channel to “${m.name}”; both of its stickies leave the board`} style={{ ...softBtn, ...dim(busy === m.channelId) }} onClick={() => void remove(m)}>
                {busy === m.channelId ? "Removing…" : "Remove channel"}
              </button>
            ) : null}
            {removable && errors[m.channelId] ? (
              <span style={{ ...surface, boxShadow: "none", borderRadius: 9, padding: "6px 10px" }}>
                <Problem text={errors[m.channelId]} />
              </span>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

// --- proposals: an agent asked, a person answers ---------------------------------------------

type OfferEntry = { offer: PendingOffer; pending: boolean; message?: string };

// What to show: the proposals waiting in the document record, plus any whose decision the
// server refused (until dismissed), minus the ones this tab has just decided.
function useOfferEntries(editor: Editor): OfferEntry[] {
  const json = useValue("channel-offers", () => JSON.stringify(pendingOffers((editor.store.get("document:document" as never) as { meta?: unknown } | undefined)?.meta)), [editor]);
  const failures = useValue(offerFailures);
  const decided = useValue(offersDecided);
  return useMemo(() => {
    const pending = (JSON.parse(json) as PendingOffer[]).filter((o) => !decided[o.id]);
    const out: OfferEntry[] = pending.map((offer) => ({ offer, pending: true, message: failures[offer.id]?.message }));
    for (const f of Object.values(failures)) if (!pending.some((o) => o.id === f.offer.id)) out.push({ offer: f.offer, pending: false, message: f.message });
    return out;
  }, [json, failures, decided]);
}

type OfferGroup = { frame: string; mode: "full" | "compact"; x: number; bottom: number; room: number; ids: string[] };

// A frame's name (its heading, above its top-left corner) and its top edge on screen, for
// offerPlacement. A frame drawn without a heading gives an empty one at its corner.
function headingOnScreen(editor: Editor, frame: TLFrameShape) {
  const b = editor.getShapePageBounds(frame.id);
  if (!b) return null;
  const tl = editor.pageToViewport({ x: b.minX, y: b.minY });
  const tr = editor.pageToViewport({ x: b.maxX, y: b.minY });
  const geometry = editor.getShapeGeometry(frame) as { children?: { isLabel?: boolean; bounds: { corners: { x: number; y: number }[] } }[] };
  const label = geometry.children?.find((c) => c.isLabel);
  const transform = editor.getShapePageTransform(frame);
  const pts = label && transform ? label.bounds.corners.map((p) => editor.pageToViewport(transform.applyToPoint(p))) : [tl];
  const xs = pts.map((p) => p.x);
  return { headingLeft: Math.round(Math.min(...xs)), headingTop: Math.round(Math.min(...pts.map((p) => p.y))), headingRight: Math.round(Math.max(...xs)), frameTop: Math.round(tl.y), frameRight: Math.round(tr.x), frameWidth: Math.round(tr.x - tl.x) };
}

function OfferChips({ editor, boardId }: { editor: Editor; boardId: string }) {
  // The phone shows one frame at a time under its own header: there the offer is in the
  // frame's thread (ChannelOfferStrip), not over the canvas.
  const mobile = useContext(MobileCtx);
  const entries = useOfferEntries(editor);
  // One group per asking frame on this page, beside (or above) the frame's name. Inside the
  // frame the corners hold other things: the compression offer and review marks top-left, a
  // channel sticky's mark in the first slot, tldraw's style panel over a selected frame's top-right.
  const json = useValue(
    "channel-offer-chips",
    () => {
      if (mobile || !entries.length) return "[]";
      const pageId = editor.getCurrentPageId();
      const vp = editor.getViewportPageBounds();
      const groups = new Map<string, OfferGroup>();
      for (const { offer } of entries) {
        const known = groups.get(offer.from.frame);
        if (known) {
          known.ids.push(offer.id);
          continue;
        }
        const frame = editor.getShape<TLFrameShape>(offer.from.frame as TLShapeId);
        if (frame?.type !== "frame" || editor.getAncestorPageId(frame) !== pageId || editor.isShapeHidden(frame)) continue;
        if (!editor.getShapePageBounds(frame.id)?.collides(vp)) continue;
        const heading = headingOnScreen(editor, frame);
        if (heading) groups.set(frame.id, { frame: frame.id, ...offerPlacement(heading), ids: [offer.id] });
      }
      return JSON.stringify([...groups.values()]);
    },
    [editor, entries, mobile],
  );
  const groups = useMemo(() => JSON.parse(json) as OfferGroup[], [json]);
  const zoomTo = (frameId: string) => {
    const b = editor.getShapePageBounds(frameId as TLShapeId);
    if (b) editor.zoomToBounds(b, { inset: 80, targetZoom: 1, animation: { duration: editor.options.animationMediumMs } });
  };
  return (
    <>
      {groups.map((g) => (
        <div key={g.frame} data-testid="channel-offers" data-frame={g.frame} data-mode={g.mode} style={{ position: "absolute", left: g.x, top: g.bottom, transform: "translateY(-100%)", display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4, pointerEvents: "none", zIndex: 280 }}>
          {g.ids.map((id) => {
            const entry = entries.find((e) => e.offer.id === id);
            return entry ? <Offer key={id} editor={editor} boardId={boardId} entry={entry} variant={g.mode === "full" ? "chip" : "compact"} mobile={mobile} room={g.room} onZoom={() => zoomTo(g.frame)} /> : null;
          })}
        </div>
      ))}
    </>
  );
}

// One request, wherever it shows: a chip at the asking frame (full, or compact when the frame
// is small on screen) or a row in that frame's conversation.
function Offer({ editor, boardId, entry, variant, mobile, room, onZoom }: { editor: Editor; boardId: string; entry: OfferEntry; variant: "chip" | "compact" | "strip"; mobile: boolean; room?: number; onZoom?(): void }) {
  const { offer, pending, message } = entry;
  const [busy, setBusy] = useState<"approve" | "decline" | null>(null);
  const to = useValue("channel-offer-to", () => frameName(editor, offer.to.frame, offer.to.name), [editor, offer.to.frame, offer.to.name]);
  const from = useValue("channel-offer-from", () => frameName(editor, offer.from.frame, offer.from.name), [editor, offer.from.frame, offer.from.name]);
  const decide = async (decision: "approve" | "decline") => {
    if (busy) return;
    setBusy(decision);
    setOfferFailure(offer, null);
    try {
      await decideOffer(boardId, offer.id, decision);
    } catch (e) {
      setOfferFailure(offer, channelErrorText((e as Error).message));
      void refreshChannels();
    } finally {
      setBusy(null);
    }
  };
  const question = `Connect to “${to}”?`;
  const about = `The agent in “${from}” asked for a channel to “${to}”. Approve lets the two agents send each other deliberate messages; nothing is forwarded on its own.`;
  const attrs = { "data-testid": "channel-offer", "data-proposal": offer.id, "data-frame": offer.from.frame, "data-variant": variant };
  if (variant === "compact") {
    return (
      <button type="button" {...attrs} title={`${question} Zoom in to answer.`} aria-label={`${question} Zoom in to answer.`} onPointerDown={stop} onClick={onZoom} style={{ ...surface, pointerEvents: "all", cursor: "pointer", borderRadius: 999, padding: "4px 10px", font: `500 12px/18px ${UI_FONT}`, maxWidth: room, display: "flex" }}>
        <span style={oneLine}>{question}</span>
      </button>
    );
  }
  const strip = variant === "strip";
  const button: CSSProperties = { ...softBtn, flex: "none", ...(mobile ? { minHeight: 44, fontSize: 14 } : {}) };
  return (
    <div
      {...attrs}
      role="group"
      aria-label={`Channel request: ${question}`}
      onPointerDown={stop}
      onKeyDown={stop}
      style={
        strip
          ? { display: "flex", flexDirection: "column", gap: 4, minWidth: 0, color: B.espresso, font: `${mobile ? 14 : 13}px/1.35 ${UI_FONT}` }
          : { ...surface, pointerEvents: "all", padding: "3px 4px 3px 12px", display: "flex", flexDirection: "column", gap: 4, boxSizing: "border-box", maxWidth: room }
      }
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <span data-testid="channel-offer-text" title={`${question} ${about}`} style={{ ...oneLine, flex: "1 1 auto", paddingRight: 2 }}>
          {pending ? question : `Connect to “${to}”`}
        </span>
        {pending ? (
          <>
            <button type="button" data-testid="channel-offer-approve" disabled={!!busy} title={about} style={{ ...button, fontWeight: 600, ...dim(!!busy) }} onClick={() => void decide("approve")}>
              {busy === "approve" ? "Connecting…" : "Approve"}
            </button>
            <button type="button" data-testid="channel-offer-decline" disabled={!!busy} title="Leave the two frames unconnected. The asking agent can see that it was declined." style={{ ...button, ...dim(!!busy) }} onClick={() => void decide("decline")}>
              {busy === "decline" ? "Declining…" : "Decline"}
            </button>
          </>
        ) : (
          <button type="button" data-testid="channel-offer-dismiss" style={button} onClick={() => setOfferFailure(offer, null)}>
            Dismiss
          </button>
        )}
      </div>
      {message ? <Problem text={message} /> : null}
    </div>
  );
}

/** A frame's pending requests, as rows under its conversation's header (Sidebar.tsx). Nothing when there are none. */
export function ChannelOfferStrip({ editor, boardId, frameId, mobile = false }: { editor: Editor; boardId: string; frameId: string; mobile?: boolean }) {
  const entries = useOfferEntries(editor).filter((e) => e.offer.from.frame === frameId);
  if (!entries.length) return null;
  return (
    <div data-testid="channel-offer-strip" style={{ flexShrink: 0, display: "flex", flexDirection: "column", gap: 6, padding: "6px 8px 6px 14px", borderBottom: `1px solid ${B.line}`, color: B.espresso, font: `${mobile ? 14 : 13}px/1.35 ${UI_FONT}` }}>
      {entries.map((entry) => (
        <Offer key={entry.offer.id} editor={editor} boardId={boardId} entry={entry} variant="strip" mobile={mobile} />
      ))}
    </div>
  );
}

// --- the conversation ⋯ menu's Channels group (FrameActions.tsx) -----------------------------

export const CHANNEL_MENU_CSS = `
.bunny-menu-section .bunny-channel-act { box-sizing: border-box; flex: none; min-height: var(--row, 32px); padding: 0 10px; border: 0; border-radius: 9px; background: transparent; color: ${B.espresso}; font: 500 13px ${UI_FONT}; cursor: pointer; }
.bunny-menu-section .bunny-channel-act:hover:not(:disabled) { background: ${B.hover}; }
.bunny-menu-section .bunny-channel-act:disabled { opacity: .5; cursor: default; }
`;

/** "Connect to…" and one "Connected to name" row per active channel (either kind) of a frame with an agent. */
export function ChannelMenuItems({ editor, boardId, frameId, mobile = false, close }: { editor: Editor; boardId: string; frameId: string; mobile?: boolean; close(): void }) {
  const channels = useValue(channelList);
  const peers = useMemo(() => channelPeers(channels, frameId), [channels, frameId]);
  const namesJson = useValue("channel-menu-names", () => JSON.stringify(peers.map((p) => frameName(editor, p.frame))), [editor, peers]);
  const names = useMemo(() => JSON.parse(namesJson) as string[], [namesJson]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const row: CSSProperties = { ...menuItem, font: `500 13px ${UI_FONT}` };
  const remove = async (channelId: string) => {
    if (busy) return;
    setBusy(channelId);
    setError(null);
    try {
      await removeChannel(boardId, channelId);
    } catch (e) {
      setError(channelErrorText((e as Error).message));
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <button type="button" style={row} data-testid="menu-connect" title="Open a channel to another frame's agent, on any page: the two agents can then send each other deliberate messages" onClick={() => { close(); askConnect(frameId); }}>
        Connect to…
      </button>
      {peers.map((p, i) => (
        <div key={p.channelId} className="bunny-menu-row" data-testid="channel-row" data-channel={p.channelId} data-anchor={p.anchor} data-peer={p.frame} style={{ ...row, cursor: "default", padding: "0 0 0 10px", gap: 2 }}>
          <StateDot color={DOT.idle} />
          <span title={`Connected to “${names[i]}”`} style={{ ...oneLine, flex: "1 1 auto", marginLeft: 6 }}>
            Connected to {names[i]}
          </span>
          {/* The phone has its own way of moving between frames (no new entry point there). */}
          {mobile ? null : (
            <button type="button" className="bunny-channel-act" data-testid="channel-row-jump" title={`Move the board to “${names[i]}” (Back returns)`} onClick={() => { jumpToFrame(editor, p.frame); close(); }}>
              Jump
            </button>
          )}
          <button type="button" className="bunny-channel-act" data-testid="channel-row-remove" disabled={busy === p.channelId} title={p.anchor === "link" ? "Close this channel; its two stickies leave the board" : "Close this channel; the arrow stays as a plain arrow"} onClick={() => void remove(p.channelId)}>
            {busy === p.channelId ? "Removing…" : "Remove"}
          </button>
        </div>
      ))}
      {error ? (
        <div style={{ padding: "2px 10px 4px" }}>
          <Problem text={error} />
        </div>
      ) : null}
    </>
  );
}
