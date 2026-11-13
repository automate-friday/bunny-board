// Connect by name (link channels), the parts with no editor or DOM in them: which frames the
// "Connect to…" picker offers, which stickies are live channel ends, what an agent's pending
// proposals are, and the words shown when the server refuses. The server contract is in
// docs/changelog/contracts.md ("Link channels and channel proposals v1").
import type { PaletteFrame } from "./jumpPaletteModel";

/** One entry of GET /api/ui/boards/:board/channels. Arrow channels may lack `anchor` (an older server). */
export interface ChannelInfo {
  id: string;
  arrow: string;
  active: boolean;
  anchor?: "arrow" | "link";
  members: { frame: string; agentId: string }[];
  stickies?: { frame: string; note: string }[];
  messages: Record<string, { status: string }>;
}

export const isLinkChannel = (c: ChannelInfo): boolean => c.anchor === "link";
/** An arrow channel: it has an arrow shape to draw its badge on. A link channel's `arrow` is "". */
export const isArrowChannel = (c: ChannelInfo): boolean => c.anchor !== "link" && !!c.arrow;

export interface ChannelPeer {
  channelId: string;
  /** The frame at the other end. */
  frame: string;
  anchor: "arrow" | "link";
}

/** The other end of every active channel (either kind) this frame is a member of. */
export function channelPeers(channels: readonly ChannelInfo[], frameId: string): ChannelPeer[] {
  const out: ChannelPeer[] = [];
  for (const c of channels) {
    if (!c.active || c.members.length !== 2 || !c.members.some((m) => m.frame === frameId)) continue;
    const peer = c.members.find((m) => m.frame !== frameId);
    if (peer) out.push({ channelId: c.id, frame: peer.frame, anchor: isLinkChannel(c) ? "link" : "arrow" });
  }
  return out;
}

/**
 * The frames "Connect to…" offers for a frame: every other frame with a conversation, on any
 * page, that this frame has no active channel with. Left out as well: a frame whose agent is
 * still starting (its binding is not finished) and a frame on the same conversation (the
 * server refuses both). Nothing is offered when the frame itself has no conversation.
 */
export function connectCandidates(frames: readonly PaletteFrame[], selfId: string, channels: readonly ChannelInfo[]): PaletteFrame[] {
  const self = frames.find((f) => f.id === selfId);
  if (!self?.agentId) return [];
  const connected = new Set(channelPeers(channels, selfId).map((p) => p.frame));
  return frames.filter((f) => f.id !== selfId && !!f.agentId && f.status !== "starting" && f.agentId !== self.agentId && !connected.has(f.id));
}

export interface ChannelEnd {
  channelId: string;
  /** The frame the sticky is in. */
  frame: string;
  /** The frame it leads to. */
  peer: string;
}

/**
 * Sticky id → its channel, for the stickies of active link channels. This list, not a sticky's
 * own meta.channel, says whether a sticky is a live channel end (a copied or restored sticky
 * can still carry the mark for a moment).
 */
export function liveStickies(channels: readonly ChannelInfo[]): Map<string, ChannelEnd> {
  const out = new Map<string, ChannelEnd>();
  for (const c of channels) {
    if (!c.active || !isLinkChannel(c) || c.stickies?.length !== 2) continue;
    for (const s of c.stickies) {
      const peer = c.stickies.find((o) => o.frame !== s.frame);
      if (peer) out.set(s.note, { channelId: c.id, frame: s.frame, peer: peer.frame });
    }
  }
  return out;
}

/** An agent's request to be connected, as the server mirrors it in the document record. */
export interface PendingOffer {
  id: string;
  at: number;
  from: { frame: string; name: string };
  to: { frame: string; name: string };
}

const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const end = (v: unknown): { frame: string; name: string } | null => {
  const r = record(v);
  return r && typeof r.frame === "string" && r.frame ? { frame: r.frame, name: typeof r.name === "string" ? r.name : "" } : null;
};

/** The pending proposals in the document record's meta (`paseoChannels.pending`); malformed entries are dropped. */
export function pendingOffers(documentMeta: unknown): PendingOffer[] {
  const pending = record(record(documentMeta)?.paseoChannels)?.pending;
  if (!Array.isArray(pending)) return [];
  const out: PendingOffer[] = [];
  for (const entry of pending) {
    const r = record(entry);
    const from = end(r?.from);
    const to = end(r?.to);
    if (!r || typeof r.id !== "string" || !r.id || !from || !to || out.some((o) => o.id === r.id)) continue;
    out.push({ id: r.id, at: typeof r.at === "number" ? r.at : 0, from, to });
  }
  return out;
}

/** `paseoChannels.rev`: changes whenever the pending proposals do (a new one, or one decided). */
export function offersRev(documentMeta: unknown): number {
  const rev = record(record(documentMeta)?.paseoChannels)?.rev;
  return typeof rev === "number" ? rev : 0;
}

/**
 * What to say when the server refuses a connect, a remove or a proposal decision: its known
 * refusals in plain words, anything else with the ids taken out.
 */
export function channelErrorText(message: string): string {
  const raw = String(message ?? "").trim();
  const m = raw.toLowerCase();
  if (m.includes("already connected")) return "These two frames are already connected.";
  if (m.includes("distinct conversations")) return "Both frames belong to the same conversation, so there is nothing to connect.";
  if (m.includes("must be a bound frame") || m.includes("no conversation bound")) return "One of these frames no longer has a conversation. Pick a frame with an agent.";
  if (m.includes("two distinct member frames")) return "Pick a different frame to connect to.";
  if (m.includes("no longer bound to the conversation")) return "One of the frames changed conversation since this was asked, so nothing was connected.";
  const decided = /was already (approved|declined|expired)/.exec(m);
  if (decided) return decided[1] === "expired" ? "This request is no longer valid: one of its frames changed." : `This request was already ${decided[1]}.`;
  if (m.includes("no channel proposal")) return "This request is no longer waiting.";
  if (m.includes("could not be written")) return "The board could not be saved just now, so nothing was connected. Try again.";
  if (m.includes("unknown channel")) return "This channel is already gone.";
  if (m.includes("from the board page")) return "This only works from the board page. Reload it and try again.";
  if (!raw || /^http \d+$/.test(m) || m.includes("failed to fetch") || m.includes("networkerror") || m.includes("load failed") || m.includes("timed out") || m.includes("aborted")) return "Could not reach the board. Check the connection and try again.";
  const plain = raw.replace(/\s*\(shape:[^)]*\)/g, "").replace(/\s+(?:channel|proposal)\s+[0-9a-f]{8}-[0-9a-f-]{27}/gi, "").trim();
  const text = plain || raw;
  return `${text[0].toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? "" : "."}`;
}

/**
 * How a live channel sticky is marked, from its width on screen: the "Channel" label when
 * there is room for the word, the dot alone when the sticky is small, nothing when it is tiny.
 */
export const STICKY_LABEL_MIN = 96;
export const STICKY_DOT_MIN = 40;
export function stickyMark(widthOnScreen: number): "label" | "dot" | "none" {
  return widthOnScreen >= STICKY_LABEL_MIN ? "label" : widthOnScreen >= STICKY_DOT_MIN ? "dot" : "none";
}

/**
 * Where a frame's proposal offers go on screen, and how they show. They sit on the row of the
 * frame's name, to its right and just above the frame's top edge, so they cover neither the
 * frame's content nor its name; when the name leaves no room there (a long name, a narrow
 * frame) they go above the name instead. A frame too small on screen to hold the question
 * and its two buttons without cutting the name short gets the question alone ("compact"),
 * which zooms to the frame when pressed.
 * All numbers are screen pixels; `x` is the offers' left edge, `bottom` their bottom edge and
 * `room` the width they may take.
 */
export const OFFER_FULL_MIN = 340;
export const OFFER_MAX = 420;
export function offerPlacement(o: { headingLeft: number; headingTop: number; headingRight: number; frameTop: number; frameRight: number; frameWidth: number }): { mode: "full" | "compact"; x: number; bottom: number; room: number } {
  const above = { x: o.headingLeft, bottom: o.headingTop - 4 };
  if (o.frameWidth < OFFER_FULL_MIN) return { mode: "compact", ...above, room: Math.max(140, o.frameWidth) };
  const x = o.headingRight + 8;
  const beside = o.frameRight - x;
  if (beside >= OFFER_FULL_MIN) return { mode: "full", x, bottom: o.frameTop - 4, room: Math.min(OFFER_MAX, beside) };
  return { mode: "full", ...above, room: Math.min(OFFER_MAX, o.frameWidth) };
}
