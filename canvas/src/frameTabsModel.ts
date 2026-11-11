// What the frame tabs (FrameTabs.tsx) show, run like a small CPU cache:
// - Pinned: the board's pins (pins.ts), in pin order, never evicted.
// - Needs you: frames whose agent is blocked on you; they come in on their own (an
//   interrupt) and leave once answered.
// - Recent: a fixed number of slots, newest first. A frame you only looked at is a clean
//   line; a frame you sent a message to and have not looked at since (or whose agent is
//   still working on it) is a dirty one. When there are more candidates than slots, clean
//   lines are evicted before dirty ones, least recently used first.
// "Sent" narrows Recent to the frames you messaged, by when you last sent.

export type TabFrame = { id: string; name: string; agentId: string; status: string };
export type Recency = { at: number; dirty: boolean; sentAt?: number };
export type RecentFilter = "all" | "sent";
export const RECENT_SLOTS = 8;

const WORKING = new Set(["running", "subagents", "cloud", "starting", "requested"]);

export function frameTabs<T extends TabFrame>(input: {
  frames: readonly T[];
  pins: readonly string[];
  /** Frame ids blocked on you, in the order to show them. */
  needs: readonly string[];
  /** Frame id → when this viewer last looked at it. */
  viewed: ReadonlyMap<string, number>;
  /** Agent id → when this viewer last sent it a message. */
  sent: ReadonlyMap<string, number>;
  filter?: RecentFilter;
  slots?: number;
}): { pinned: T[]; needsYou: T[]; recent: Array<T & Recency> } {
  const { frames, pins, needs, viewed, sent, filter = "all", slots = RECENT_SLOTS } = input;
  const byId = new Map(frames.map((f) => [f.id, f]));
  const pinned = pins.map((id) => byId.get(id)).filter((f): f is T => !!f);
  const taken = new Set(pinned.map((f) => f.id));
  const needsYou = needs.filter((id) => !taken.has(id)).map((id) => byId.get(id)).filter((f): f is T => !!f);
  for (const f of needsYou) taken.add(f.id);
  const candidates: Array<T & Recency> = [];
  for (const f of frames) {
    if (taken.has(f.id)) continue;
    const looked = viewed.get(f.id);
    const wrote = f.agentId ? sent.get(f.agentId) : undefined;
    if (filter === "sent" && wrote === undefined) continue;
    if (looked === undefined && wrote === undefined) continue;
    const at = filter === "sent" ? (wrote as number) : Math.max(looked ?? -Infinity, wrote ?? -Infinity);
    const dirty = wrote !== undefined && (wrote > (looked ?? -Infinity) || WORKING.has(f.status));
    candidates.push({ ...f, at, dirty, sentAt: wrote });
  }
  const newest = (a: { at: number; name: string }, b: { at: number; name: string }) => b.at - a.at || a.name.localeCompare(b.name);
  candidates.sort(newest);
  if (candidates.length <= slots) return { pinned, needsYou, recent: candidates };
  // Evict clean lines first: keep the newest dirty ones, then fill with the newest clean.
  const keep = candidates.filter((c) => c.dirty).slice(0, slots);
  for (const c of candidates) {
    if (keep.length >= slots) break;
    if (!c.dirty) keep.push(c);
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

// Pages as tab groups: one group per page, in page order, listing the page's active frames
// (working, waiting on you, or looked at / messaged lately) first; the rest behind "Show all".
// Errors alone do not make a frame active (boards keep many idle errored frames).
export const GROUP_RECENT_MS = 3 * 24 * 60 * 60 * 1000;
const WAITING = new Set(["needs-permission"]);
export type PageGroup<T> = { id: string; name: string; active: T[]; rest: T[] };

export function pageGroups<T extends TabFrame & { pageId: string }>(input: {
  frames: readonly T[];
  pages: readonly { id: string; name: string }[];
  needs: readonly string[];
  viewed: ReadonlyMap<string, number>;
  sent: ReadonlyMap<string, number>;
  now: number;
  recentMs?: number;
}): PageGroup<T>[] {
  const { frames, pages, needs, viewed, sent, now, recentMs = GROUP_RECENT_MS } = input;
  const waiting = new Set(needs);
  const touched = (f: T) => Math.max(viewed.get(f.id) ?? -Infinity, f.agentId ? (sent.get(f.agentId) ?? -Infinity) : -Infinity);
  const rank = (f: T) => (waiting.has(f.id) || WAITING.has(f.status) ? 0 : WORKING.has(f.status) ? 1 : 2);
  const isActive = (f: T) => rank(f) < 2 || now - touched(f) <= recentMs;
  const byName = (a: T, b: T) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  const groups: PageGroup<T>[] = [];
  for (const page of pages) {
    const mine = frames.filter((f) => f.pageId === page.id);
    if (!mine.length) continue;
    const active = mine.filter(isActive).sort((a, b) => rank(a) - rank(b) || touched(b) - touched(a) || byName(a, b));
    const rest = mine.filter((f) => !isActive(f)).sort(byName);
    groups.push({ id: page.id, name: page.name, active, rest });
  }
  return groups;
}
