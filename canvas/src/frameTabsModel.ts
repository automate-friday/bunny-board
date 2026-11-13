// What the frame tabs (FrameTabs.tsx) show, run like a small CPU cache:
// - Pinned: the board's pins (pins.ts), in pin order, never evicted.
// - Needs you: frames whose agent is blocked on you; they come in on their own (an
//   interrupt) and leave once answered.
// - Recent: a fixed number of slots, newest first. A frame you only looked at is a clean
//   line; a frame you sent a message to (or started a conversation in) and have not looked
//   at since, or whose agent is still working on it, is a dirty one, for a day (DIRTY_MS):
//   an old unread send then ages like any other line instead of holding a slot forever. The most recently used lines always stay (what you
//   just clicked never drops out); past those, when there are more candidates than slots,
//   clean lines are evicted before dirty ones, least recently used first.

export type TabFrame = { id: string; name: string; agentId: string; status: string };
export type Recency = { at: number; dirty: boolean; sentAt?: number };
export const RECENT_SLOTS = 8;
/** Recent slots kept for the most recently used frames, dirty or clean. */
export const RECENT_KEEP = 4;
/** How long an unread send keeps a frame "dirty" (kept ahead of frames you only looked at). */
export const DIRTY_MS = 24 * 60 * 60 * 1000;
/** Sends are keyed by agent; starting a conversation (no agent yet) is keyed by its frame. */
export const frameSendKey = (frameId: string) => `frame:${frameId}`;

// Working on a turn. Not "subagents": a frame whose turn ended but still lists a subagent
// would otherwise stay "unread" (and active) for as long as the subagent lingers.
const WORKING = new Set(["running", "cloud", "starting", "requested"]);

export function frameTabs<T extends TabFrame>(input: {
  frames: readonly T[];
  pins: readonly string[];
  /** Frame ids blocked on you, in the order to show them. */
  needs: readonly string[];
  /** Frame id → when this viewer last looked at it. */
  viewed: ReadonlyMap<string, number>;
  /** Agent id (or frameSendKey) → when this viewer last sent it a message (or started it). */
  sent: ReadonlyMap<string, number>;
  slots?: number;
  keep?: number;
  now?: number;
}): { pinned: T[]; needsYou: T[]; recent: Array<T & Recency> } {
  const { frames, pins, needs, viewed, sent, slots = RECENT_SLOTS, keep: newestKept = RECENT_KEEP, now = Date.now() } = input;
  const byId = new Map(frames.map((f) => [f.id, f]));
  const pinned = pins.map((id) => byId.get(id)).filter((f): f is T => !!f);
  const taken = new Set(pinned.map((f) => f.id));
  const needsYou = needs.filter((id) => !taken.has(id)).map((id) => byId.get(id)).filter((f): f is T => !!f);
  for (const f of needsYou) taken.add(f.id);
  const candidates: Array<T & Recency> = [];
  for (const f of frames) {
    if (taken.has(f.id)) continue;
    const looked = viewed.get(f.id);
    const toAgent = f.agentId ? sent.get(f.agentId) : undefined;
    const started = sent.get(frameSendKey(f.id));
    const wrote = toAgent === undefined && started === undefined ? undefined : Math.max(toAgent ?? -Infinity, started ?? -Infinity);
    if (looked === undefined && wrote === undefined) continue;
    const at = Math.max(looked ?? -Infinity, wrote ?? -Infinity);
    const dirty = wrote !== undefined && now - wrote < DIRTY_MS && (wrote > (looked ?? -Infinity) || WORKING.has(f.status));
    candidates.push({ ...f, at, dirty, sentAt: wrote });
  }
  const newest = (a: { at: number; name: string }, b: { at: number; name: string }) => b.at - a.at || a.name.localeCompare(b.name);
  candidates.sort(newest);
  if (candidates.length <= slots) return { pinned, needsYou, recent: candidates };
  // The newest few always stay; then the newest dirty ones; then the newest clean.
  const keep = candidates.slice(0, Math.min(newestKept, slots));
  for (const c of candidates) {
    if (keep.length >= slots) break;
    if (c.dirty && !keep.includes(c)) keep.push(c);
  }
  for (const c of candidates) {
    if (keep.length >= slots) break;
    if (!keep.includes(c)) keep.push(c);
  }
  return { pinned, needsYou, recent: keep.sort(newest) };
}

/** Two letters for a tab's badge: initials of the first two words, or the first two letters. */
export function tabInitials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const first = (w: string) => Array.from(w)[0] ?? "";
  if (words.length > 1) return (first(words[0]) + first(words[1])).toUpperCase();
  const [a = "", b = ""] = Array.from(words[0]);
  return a.toUpperCase() + b.toLowerCase();
}

// Badge fills: distinct, dark enough for white initials (WCAG AA at 11px bold), and not the
// status colours' job (status is the ring round the badge).
export const BADGE_COLORS = ["#C2410C", "#B45309", "#4D7C0F", "#15803D", "#0F766E", "#0369A1", "#1D4ED8", "#6D28D9", "#A21CAF", "#BE123C", "#57534E"];

/** A frame's badge colour: from its id, so it is the same on every device and never changes. */
export function badgeColor(id: string): string {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return BADGE_COLORS[(h >>> 0) % BADGE_COLORS.length];
}
