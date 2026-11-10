// Room for an agent's own frame (board_frame): which way it can grow, where it could
// move, and, when it is boxed in, which ways out exist. Growth and moves change only the
// caller's frame; push, annex and ask-user are reported here, not performed.
import { type Box, childBoxes, overlaps } from "./layout";
import { describeShape, isShape, type Rec, type RecMap } from "./records";

export const ANCHORS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;
export type Anchor = (typeof ANCHORS)[number];
export const MAX_FRAME = 6000;
// Space kept between a moved or annexed frame and its neighbours.
export const FRAME_GAP = 40;

export function isAnchor(a: unknown): a is Anchor {
  return typeof a === "string" && (ANCHORS as readonly string[]).includes(a);
}

// The frame's box (in its parent) after a resize to w x h that keeps `anchor` in place:
// a right anchor grows to the left, a bottom anchor grows upwards.
export function grownBox(frame: Rec, w: number, h: number, anchor: Anchor = "top-left"): Box {
  const x = anchor.endsWith("right") ? frame.x + frame.props.w - w : frame.x;
  const y = anchor.startsWith("bottom") ? frame.y + frame.props.h - h : frame.y;
  return { x, y, w, h };
}

// Everything a frame occupying `box` would run into: other frames, shapes beside it that
// it does not already cover (a person's stickies would otherwise be swallowed), or the
// edge of a parent frame.
export function blockersAt(records: RecMap, frame: Rec, box: Box): Rec[] {
  const out: Rec[] = [];
  const parent = records.get(frame.parentId);
  if (isShape(parent) && parent.type === "frame" && (box.x < 0 || box.y < 0 || box.x + box.w > parent.props.w || box.y + box.h > parent.props.h)) out.push(parent);
  const now = { x: frame.x, y: frame.y, w: frame.props.w, h: frame.props.h };
  for (const s of childBoxes(records, frame.parentId)) {
    if (s.id === frame.id) continue;
    if (s.rec.type === "frame" ? overlaps(box, s, -1) : overlaps(box, s, -1) && !overlaps(now, s, -1)) out.push(s.rec);
  }
  return out;
}

// Largest width (at the current height) and height (at the current width) the frame can
// grow to with this anchor. Growth only adds area, so blocking is monotonic: bisect.
export function maxGrowth(records: RecMap, frame: Rec, anchor: Anchor): { w: number; h: number } {
  const fits = (w: number, h: number) => blockersAt(records, frame, grownBox(frame, w, h, anchor)).length === 0;
  const search = (cur: number, ok: (n: number) => boolean) => {
    let lo = Math.round(cur);
    let hi = MAX_FRAME;
    if (!ok(lo)) return lo;
    if (ok(hi)) return hi;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ok(mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  return {
    w: search(frame.props.w, (w) => fits(w, frame.props.h)),
    h: search(frame.props.h, (h) => fits(frame.props.w, h)),
  };
}

// The free spot nearest to the frame (in its parent's coordinates) where a w x h frame
// fits clear of every other shape there, FRAME_GAP apart. Candidates sit beside existing
// shapes (left, right, above, below) and at the frame's own spot; the nearest wins. The
// frame itself is not in the way (it is the one moving) unless `besideSelf` (an annex).
export function nearestFreeSpot(records: RecMap, frame: Rec, size: { w: number; h: number }, besideSelf = false): { x: number; y: number } | null {
  const parent = records.get(frame.parentId);
  const bounds = isShape(parent) && parent.type === "frame" ? { w: parent.props.w, h: parent.props.h } : null;
  const others = childBoxes(records, frame.parentId).filter((b) => besideSelf || b.id !== frame.id);
  const g = FRAME_GAP;
  const xs = new Set<number>([frame.x, frame.x + frame.props.w - size.w]);
  const ys = new Set<number>([frame.y, frame.y + frame.props.h - size.h]);
  for (const b of others) {
    xs.add(b.x + b.w + g).add(b.x - size.w - g).add(b.x);
    ys.add(b.y + b.h + g).add(b.y - size.h - g).add(b.y);
  }
  if (bounds) {
    xs.add(g);
    ys.add(g);
  }
  let best: { x: number; y: number; d: number } | null = null;
  for (const x of xs) {
    for (const y of ys) {
      const box = { x: Math.round(x), y: Math.round(y), w: size.w, h: size.h };
      if (bounds && (box.x < 0 || box.y < 0 || box.x + box.w > bounds.w || box.y + box.h > bounds.h)) continue;
      if (others.some((b) => overlaps(box, b, g - 1))) continue;
      const d = Math.hypot(box.x - frame.x, box.y - frame.y);
      if (!best || d < best.d) best = { x: box.x, y: box.y, d };
    }
  }
  return best && { x: best.x, y: best.y };
}

// Set by the server when a person drags or reshapes the frame (frame-watcher): the person
// chose that spot, so agents do not move it, and other agents may not push it.
export function humanMovedAt(frame: Rec): number | undefined {
  const at = frame.meta?.layout?.humanMovedAt;
  return typeof at === "number" ? at : undefined;
}

// Can the server push this blocker aside for a neighbour (option 4, detection only)?
export function pushability(blocker: Rec, frame: Rec): { pushable: boolean; why: string } {
  if (blocker.id === frame.parentId) return { pushable: false, why: "it is the edge of the parent frame" };
  if (blocker.type !== "frame") return { pushable: false, why: blocker.meta?.author?.kind === "agent" ? "it is a loose shape, not a frame" : "it is a person's shape" };
  const p = blocker.meta?.paseo ?? {};
  if (!p.agentId) return { pushable: false, why: "it is a person's frame (no agent)" };
  if (humanMovedAt(blocker)) return { pushable: false, why: "a person placed it" };
  if (p.status === "running" || p.status === "needs-permission") return { pushable: false, why: `its agent is ${p.status}` };
  return { pushable: true, why: `agent frame, ${p.status ?? "idle"}, never moved by a person` };
}

function label(r: Rec): string {
  return r.type === "frame" ? `frame ${r.id} ${JSON.stringify(r.props?.name ?? "")}` : `${describeShape(r, 40)} (${r.id})`;
}

function side(frame: Rec, b: Rec): string {
  if (b.id === frame.parentId) return "parent edge";
  const fx = frame.x + frame.props.w / 2;
  const fy = frame.y + frame.props.h / 2;
  const w = b.props?.w ?? 0;
  const h = b.props?.h ?? 0;
  const dx = b.x + w / 2 - fx;
  const dy = b.y + h / 2 - fy;
  return Math.abs(dx) * frame.props.h >= Math.abs(dy) * frame.props.w ? (dx > 0 ? "right" : "left") : dy > 0 ? "below" : "above";
}

export interface RoomReport {
  blockers: Array<{ id: string; label: string; side: string; pushable: boolean; why: string }>;
  maxSize: Record<Anchor, { w: number; h: number }>;
  move: { x: number; y: number } | null;
  options: {
    push: { possible: boolean; frames: string[] };
    annex: { possible: boolean; x?: number; y?: number; w: number; h: number };
    askUser: { suggested: string };
  };
}

// Everything a boxed-in agent needs to decide: what is in the way, how far each anchor
// can grow, where the frame could move at the requested size, and the three ways out
// that need more than the agent's own frame (push, annex, ask the person).
export function roomReport(records: RecMap, frame: Rec, w: number, h: number, anchor: Anchor, humanName: string): RoomReport {
  const hits = blockersAt(records, frame, grownBox(frame, w, h, anchor));
  const blockers = hits.map((b) => ({ id: b.id, label: label(b), side: side(frame, b), ...pushability(b, frame) }));
  const maxSize = Object.fromEntries(ANCHORS.map((a) => [a, maxGrowth(records, frame, a)])) as Record<Anchor, { w: number; h: number }>;
  const pushIds = blockers.filter((b) => b.pushable).map((b) => b.id);
  // Pushing helps only when every blocker can move and the result stays clear of others.
  const pushPossible = blockers.length > 0 && pushIds.length === blockers.length;
  const extraW = Math.max(0, w - frame.props.w);
  const extraH = Math.max(0, h - frame.props.h);
  const annexSize = extraW >= extraH ? { w: Math.max(240, extraW), h: Math.max(200, h) } : { w: Math.max(240, w), h: Math.max(200, extraH) };
  const annexAt = nearestFreeSpot(records, frame, annexSize, true);
  return {
    blockers,
    maxSize,
    move: humanMovedAt(frame) ? null : nearestFreeSpot(records, frame, { w, h }),
    options: {
      push: { possible: pushPossible, frames: pushIds },
      annex: { possible: !!annexAt, ...(annexAt ?? {}), ...annexSize },
      askUser: { suggested: `Ask ${humanName} to make room: "my frame needs ${w}x${h}; it is blocked by ${blockers.map((b) => b.label).join(", ") || "its surroundings"}".` },
    },
  };
}

export function reportText(frame: Rec, w: number, h: number, anchor: Anchor, r: RoomReport): string {
  const sz = (s: { w: number; h: number }) => `${s.w}x${s.h}`;
  const lines = [
    `resizing to ${w}x${h} (anchor ${anchor}) is blocked by ${r.blockers.map((b) => `${b.label} on the ${b.side}`).join("; ")}.`,
    `Room per anchor (max width at current height / max height at current width): ${ANCHORS.map((a) => `${a} ${r.maxSize[a].w}w/${r.maxSize[a].h}h`).join(", ")}. Pass resize.anchor to grow left or up.`,
    r.move
      ? `Free spot for a ${w}x${h} frame: (${r.move.x}, ${r.move.y}); board_frame({resize:{w:${w},h:${h}}, move:'auto'}) moves your frame there with its contents.`
      : humanMovedAt(frame)
        ? "A person placed your frame, so it cannot be moved automatically."
        : `No free spot for a ${w}x${h} frame nearby.`,
    `Other options (not done automatically): push ${r.options.push.possible ? `possible (${r.options.push.frames.join(", ")} could be pushed aside)` : `not possible (${r.blockers.filter((b) => !b.pushable).map((b) => `${b.id}: ${b.why}`).join("; ") || "nothing to push"})`}; ` +
      `annex ${r.options.annex.possible ? `possible: a ${sz(r.options.annex)} frame fits at (${r.options.annex.x}, ${r.options.annex.y}); put overflow there and link it with a portal sticky` : "not possible: no free space nearby"}; ` +
      `ask-user: ${r.options.askUser.suggested}`,
  ];
  return lines.join("\n");
}
