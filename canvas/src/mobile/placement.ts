// "+ Agent here" / "Start agent about this" from a thread: the new frame goes right beside
// the one you are in, on the same page, in free space (never on top of another frame).

type Box = { x: number; y: number; w: number; h: number };
const overlaps = (a: Box, b: Box, gap: number) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

// Right of the source first (top-aligned), then below it, then left, then above; each side
// slides outward past whatever is in the way.
export function besideFrame(source: Box, others: readonly Box[], size = { w: 960, h: 640 }, gap = 80, tries = 40): { x: number; y: number } {
  const free = (b: Box) => !others.some((o) => overlaps(b, o, gap / 2));
  const sides: ((n: number) => Box)[] = [
    (n) => ({ x: source.x + source.w + gap + n * (size.w / 4), y: source.y, ...size }),
    (n) => ({ x: source.x, y: source.y + source.h + gap + n * (size.h / 4), ...size }),
    (n) => ({ x: source.x - gap - size.w - n * (size.w / 4), y: source.y, ...size }),
    (n) => ({ x: source.x, y: source.y - gap - size.h - n * (size.h / 4), ...size }),
  ];
  for (let n = 0; n < tries; n++) for (const side of sides) { const b = side(n); if (free(b)) return { x: Math.round(b.x), y: Math.round(b.y) }; }
  const right = Math.max(source.x + source.w, ...others.map((o) => o.x + o.w));
  return { x: Math.round(right + gap), y: Math.round(source.y) };
}

// The opening message for "Start agent about this": the message quoted, and where it came from.
export function aboutMessage(text: string, from: { name: string; url: string }, max = 700): string {
  const body = text.trim().length > max ? `${text.trim().slice(0, max).replace(/\s+\S*$/, "")} …` : text.trim();
  const quoted = body.split("\n").map((l) => `> ${l}`).join("\n");
  return `${quoted}\n\nFrom the frame "${from.name}": ${from.url}\n\n`;
}

// The start sheet's model and Runs-on for "same as this agent": provider/model when both are
// known, the binding's remote host, or the cloud path with its builder.
export function sameAs(agent: { provider?: string | null; model?: string | null } | null, binding: { host?: unknown; cloud?: unknown; cloudProvider?: unknown } | null): { provider: string | null; host: string; worker: boolean; cloudProvider: string | null } {
  const provider = agent?.provider ? (agent.model && !agent.model.startsWith(`${agent.provider}/`) ? `${agent.provider}/${agent.model}` : agent.model || agent.provider) : null;
  const host = typeof binding?.host === "string" ? binding.host : "";
  const worker = !host && !!binding?.cloud;
  return { provider, host, worker, cloudProvider: worker && typeof binding?.cloudProvider === "string" ? binding.cloudProvider : null };
}

// Where a frame sits relative to its nearest neighbour on the page, for "Name · right of
// Pricing page · Page 1": the closest other frame (by gap between edges) and the side.
export function nearestNeighbour<T extends Box & { id: string }>(target: Box & { id: string }, others: readonly T[]): { neighbour: T; side: "right of" | "left of" | "below" | "above" } | null {
  let best: { neighbour: T; d: number } | null = null;
  for (const o of others) {
    if (o.id === target.id) continue;
    const dx = Math.max(0, o.x - (target.x + target.w), target.x - (o.x + o.w));
    const dy = Math.max(0, o.y - (target.y + target.h), target.y - (o.y + o.h));
    const d = Math.hypot(dx, dy);
    if (!best || d < best.d) best = { neighbour: o, d };
  }
  if (!best) return null;
  const n = best.neighbour;
  const cx = target.x + target.w / 2 - (n.x + n.w / 2), cy = target.y + target.h / 2 - (n.y + n.h / 2);
  const side = Math.abs(cx) >= Math.abs(cy) ? (cx > 0 ? "right of" : "left of") : cy > 0 ? "below" : "above";
  return { neighbour: n, side };
}

// The view for "show it among its neighbours": the frame and the frames around it (within
// about two frame-sizes), as one box.
export function neighbourhood(target: Box, others: readonly Box[], reach = 2): Box {
  const near = others.filter((o) => Math.abs(o.x + o.w / 2 - (target.x + target.w / 2)) < target.w * reach + o.w / 2 && Math.abs(o.y + o.h / 2 - (target.y + target.h / 2)) < target.h * reach + o.h / 2);
  const all = [target, ...near];
  const x = Math.min(...all.map((b) => b.x)), y = Math.min(...all.map((b) => b.y));
  return { x, y, w: Math.max(...all.map((b) => b.x + b.w)) - x, h: Math.max(...all.map((b) => b.y + b.h)) - y };
}

// The board view on a page whose content is spread far apart (clusters with empty space between):
// the boxes chained to `seed` by gaps under `gap` (single linkage), as one box. With no seed,
// the biggest cluster.
export function clusterAround(boxes: readonly Box[], seed: Box | null, gap = 2000): Box | null {
  if (!boxes.length) return seed;
  const near = (a: Box, b: Box) => a.x - gap < b.x + b.w && b.x - gap < a.x + a.w && a.y - gap < b.y + b.h && b.y - gap < a.y + a.h;
  const left = new Set(boxes.map((_, i) => i));
  const groups: Box[][] = [];
  while (left.size) {
    const first = left.values().next().value as number;
    left.delete(first);
    const group = [boxes[first]];
    for (let k = 0; k < group.length; k++) for (const i of [...left]) if (near(group[k], boxes[i])) { left.delete(i); group.push(boxes[i]); }
    groups.push(group);
  }
  const pick = (seed && groups.find((g) => g.some((b) => near(b, seed)))) || groups.sort((a, b) => b.length - a.length)[0];
  const x = Math.min(...pick.map((b) => b.x)), y = Math.min(...pick.map((b) => b.y));
  return { x, y, w: Math.max(...pick.map((b) => b.x + b.w)) - x, h: Math.max(...pick.map((b) => b.y + b.h)) - y };
}
