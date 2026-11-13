// The board's channels as the server lists them, shared by everything that shows a channel:
// the arrow badges (Channels.tsx, which also owns the one poll that fills this), the channel
// stickies and proposal offers (LinkChannels.tsx), the "Connect to…" picker and the
// conversation menu's Channels group. Liveness comes from this list, never from a sticky's
// own meta.channel.
import { atom } from "tldraw";
import { api } from "./api";
import type { ChannelInfo, PendingOffer } from "./linkChannelModel";

export const channelList = atom<ChannelInfo[]>("bunny-channels", []);
/** Why the last read of the list failed (the list then shows the last good answer), or null. */
export const channelListError = atom<string | null>("bunny-channels-error", null);

// Channels.tsx registers its refresh while it is mounted; before that there is nothing to ask.
let refresher: (() => Promise<void>) | null = null;
export function setChannelRefresher(fn: (() => Promise<void>) | null): void {
  refresher = fn;
}
/** Read the list again now (after connecting, removing or deciding a proposal). */
export const refreshChannels = (): Promise<void> => refresher?.() ?? Promise.resolve();

export const channelsUrl = (boardId: string) => `/api/ui/boards/${encodeURIComponent(boardId)}/channels`;

/** Open a link channel between two frames (any pages). Rejects with the server's refusal. */
export async function connectFrames(boardId: string, from: string, to: string): Promise<ChannelInfo> {
  const channel = await api<ChannelInfo>(channelsUrl(boardId), { method: "POST", body: JSON.stringify({ members: [from, to] }) });
  void refreshChannels();
  return channel;
}

/** Close a channel of either kind; the server takes a link channel's two stickies off the board. */
export async function removeChannel(boardId: string, channelId: string): Promise<void> {
  await api(`${channelsUrl(boardId)}/${encodeURIComponent(channelId)}/revoke`, { method: "POST", body: "{}" });
  await refreshChannels();
}

/** Approve or decline an agent's proposal, as the person using this board. */
export async function decideOffer(boardId: string, proposalId: string, decision: "approve" | "decline"): Promise<void> {
  await api(`${channelsUrl(boardId)}/proposals/${encodeURIComponent(proposalId)}/${decision}`, { method: "POST", body: JSON.stringify({ by: window.__board?.userName ?? "User" }) });
  offersDecided.set({ ...offersDecided.get(), [proposalId]: true });
  void refreshChannels();
}

// Proposals this tab has just decided: hidden at once, without waiting for the document
// record to say so (a second click in that gap would be refused as "already approved").
export const offersDecided = atom<Record<string, true>>("bunny-channel-offers-decided", {});

// A decision the server refused, kept after the proposal has left the pending list (an
// expired one does), so the person still sees why nothing happened, until they dismiss it.
export const offerFailures = atom<Record<string, { offer: PendingOffer; message: string }>>("bunny-channel-offer-failures", {});
export function setOfferFailure(offer: PendingOffer, message: string | null): void {
  const next = { ...offerFailures.get() };
  if (message) next[offer.id] = { offer, message };
  else if (offer.id in next) delete next[offer.id];
  else return;
  offerFailures.set(next);
}

/** The frame whose "Connect to…" picker is open (ConnectPicker.tsx), or null. */
export const connectFor = atom<string | null>("bunny-connect-for", null);
export function askConnect(frameId: string | null): void {
  connectFor.set(frameId);
}
