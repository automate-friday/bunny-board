// Compact text outline of a frame or a whole board (design section 4).

import { componentOutline, type OutlineContext } from "../shared/components";
import { isAreaPortal, portalOf } from "../shared/portal";
import { childBoxes, freeGridSlot, overlappingPairs } from "./layout";
import {
  absPos,
  ancestors,
  describeShape,
  gridCell,
  isShape,
  kindLabel,
  quote,
  type Rec,
  type RecMap,
  shapeSize,
  shapeText,
} from "./records";

const MAX_CHARS = 12_000;

function sortReading(a: Rec, b: Rec): number {
  const rowA = Math.round(a.y / 80);
  const rowB = Math.round(b.y / 80);
  return rowA - rowB || a.x - b.x;
}

function children(records: RecMap, parentId: string): Rec[] {
  const out: Rec[] = [];
  for (const r of records.values()) if (isShape(r) && r.parentId === parentId) out.push(r);
  return out.sort(sortReading);
}

function authorTag(s: Rec): string {
  const a = s.meta?.author;
  if (!a) return "";
  return a.kind === "agent" ? " [agent]" : " [human]";
}

function arrowEnds(records: RecMap, arrow: Rec): { from?: Rec; to?: Rec } {
  const out: { from?: Rec; to?: Rec } = {};
  for (const r of records.values()) {
    if (r.typeName !== "binding" || r.type !== "arrow" || r.fromId !== arrow.id) continue;
    const target = records.get(r.toId);
    if (r.props?.terminal === "start") out.from = target;
    else out.to = target;
  }
  return out;
}

// The frame (bound or not) a shape sits in, for naming a portal target.
function enclosingFrame(records: RecMap, s: Rec): Rec | null {
  let p = records.get(s.parentId);
  let guard = 0;
  while (isShape(p) && guard++ < 50) {
    if (p.type === "frame") return p;
    p = records.get(p.parentId);
  }
  return null;
}

function areaInFrame(records: RecMap, p: { x: number; y: number; w: number; h: number }, f: Rec): boolean {
  const a = absPos(records, f);
  const cx = p.x + p.w / 2;
  const cy = p.y + p.h / 2;
  return cx >= a.x && cy >= a.y && cx <= a.x + f.props.w && cy <= a.y + f.props.h;
}

/** " ⤳ portal → …" for a sticky that links somewhere, else "". */
export function portalSuffix(records: RecMap, s: Rec): string {
  const p = portalOf(s as never);
  if (!p) return "";
  if (isAreaPortal(p)) {
    // Name the frame the area's centre falls in, if any.
    const cx = p.x + p.w / 2;
    const cy = p.y + p.h / 2;
    let inFrame: Rec | null = null;
    for (const r of records.values()) {
      if (!isShape(r) || r.type !== "frame") continue;
      const a = absPos(records, r);
      if (cx >= a.x && cy >= a.y && cx <= a.x + r.props.w && cy <= a.y + r.props.h) inFrame = r;
    }
    const where = inFrame ? ` in frame ${quote(inFrame.props.name || "(unnamed)", 40)} (${inFrame.id})` : "";
    return ` ⤳ portal → area @page(${p.x},${p.y}) ${p.w}x${p.h}${where}`;
  }
  const t = records.get(p.id);
  // The target was deleted: the link stays in meta (an undo brings it back), but it leads nowhere.
  if (!isShape(t)) return ` ⤳ portal → missing target (${p.id})`;
  if (t.type === "frame") return ` ⤳ portal → frame ${quote(t.props.name || "(unnamed)", 40)} (${t.id})`;
  const f = enclosingFrame(records, t);
  return ` ⤳ portal → ${describeShape(t, 40)} (${t.id})${f ? ` in frame ${quote(f.props.name || "(unnamed)", 40)} (${f.id})` : ""}`;
}

function frameHeader(f: Rec): string {
  const p = f.meta?.paseo ?? {};
  const bits = [`${Math.round(f.props.w)}x${Math.round(f.props.h)}`];
  if (p.agentId) bits.push(`agent ${p.agentId}`);
  if (p.status) bits.push(`status ${p.status}`);
  if (p.subagents) bits.push(`${p.subagents} subagent${p.subagents > 1 ? "s" : ""} still running`);
  if (p.mode) bits.push(`mode ${p.mode}`);
  return `frame ${quote(f.props.name || "(unnamed)")} (${f.id}) ${bits.join(" · ")}`;
}

function outlineChildren(records: RecMap, frame: Rec, depth: number, lines: string[], ctx: OutlineContext | null): void {
  const pad = "  ".repeat(depth);
  const kids = children(records, frame.id);
  const w = frame.props.w;
  const h = frame.props.h;
  const arrows: Rec[] = [];
  for (const s of kids) {
    if (s.type === "arrow") {
      arrows.push(s);
      continue;
    }
    const size = shapeSize(s);
    const cell = gridCell(s.x + size.w / 2, s.y + size.h / 2, w, h);
    const pos = `@(${Math.round(s.x)},${Math.round(s.y)}) ${Math.round(size.w)}x${Math.round(size.h)}`;
    if (s.type === "frame") {
      const bound = s.meta?.paseo?.agentId;
      lines.push(`${pad}[${cell}] ${frameHeader(s)} ${pos}${bound ? " (nested bound frame, summarised)" : ""}`);
      if (!bound) outlineChildren(records, s, depth + 1, lines, ctx);
      continue;
    }
    const comp = componentOutline(s as never, ctx);
    if (comp && s.type === "stamp") {
      // A stamp is a mark on top of other shapes, not a card: nothing to write around.
      lines.push(`${pad}[${cell}] ${comp} (${s.id}) ${pos}${authorTag(s)}`);
      continue;
    }
    if (comp) {
      // Cards are big; say plainly that their rectangle is taken.
      lines.push(`${pad}[${cell}] ${comp} (${s.id}) ${pos} [occupied: write around it]${authorTag(s)}`);
    } else {
      const col = s.props?.color ? ` ${s.props.color}` : "";
      lines.push(`${pad}[${cell}] ${kindLabel(s)}${col} ${shapeText(s) ? quote(shapeText(s), 200) : ""} (${s.id}) ${pos}${authorTag(s)}${portalSuffix(records, s)}`);
    }
    // Stamps attached to this shape (its children), with their response state.
    for (const st of children(records, s.id)) if (st.type === "stamp") lines.push(`${pad}  ↳ ${componentOutline(st as never, ctx)} (${st.id})${authorTag(st)}`);
  }
  for (const a of arrows) {
    const { from, to } = arrowEnds(records, a);
    const label = shapeText(a);
    const f = from ? describeShape(from) : "point";
    const t = to ? describeShape(to) : "point";
    lines.push(`${pad}arrow ${f} → ${t}${label ? ` ${quote(label)}` : ""} (${a.id})${authorTag(a)}`);
  }
  if (kids.length === 0) lines.push(`${pad}(empty)`);
  const pairs = overlappingPairs(records, frame.id);
  if (pairs.length) {
    const shown = pairs.slice(0, 4).map(([a, b]) => `${describeShape(a, 30)} (${a.id}) and ${describeShape(b, 30)} (${b.id})`);
    lines.push(
      `${pad}⚠ ${pairs.length} overlapping pair${pairs.length === 1 ? "" : "s"} in this frame: ${shown.join("; ")}${pairs.length > 4 ? "; …" : ""}. Call board_layout({strategy:'grid'}) to re-flow your shapes (a person's shapes and cards stay put).`,
    );
  }
}

// Next free 200x200 slots on the 240 px grid (where a new sticky can go).
function freeSlots(records: RecMap, frame: Rec, n: number): string[] {
  const boxes: Array<{ x: number; y: number; w: number; h: number }> = childBoxes(records, frame.id);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const s = freeGridSlot(boxes, { w: frame.props.w, h: frame.props.h }, { w: 200, h: 200 });
    if (!s) break;
    out.push(`(${s.x},${s.y})`);
    boxes.push({ ...s, w: 200, h: 200 });
  }
  return out;
}

function cap(text: string, hint = 'Use format:"json" with ids to narrow.'): string {
  if (text.length <= MAX_CHARS) return text;
  return `${text.slice(0, MAX_CHARS)}\n… truncated (${text.length} chars). ${hint}`;
}

export function frameOutline(records: RecMap, frameId: string, ctx: OutlineContext | null = null): string {
  const frame = records.get(frameId);
  if (!frame || frame.type !== "frame") return `frame ${frameId} not found`;
  const free = freeSlots(records, frame, 3);
  const lines = [
    frameHeader(frame),
    "Positions are frame-relative (x right, y down; origin = frame top-left). Sizes include text growth (estimated).",
    free.length ? `Free sticky slots on the 240 px grid: ${free.join(" ")}.` : "No free 200x200 slot left: link more content with a portal sticky (board_write note with portal:{id}) to where there is room, grow the frame with board_frame({resize}), or tidy it with board_layout.",
  ];
  // Stickies elsewhere on the board that are portals into this frame, listed before the
  // frame's contents so the outline's length cap never drops them: the other side of a
  // link always shows.
  const inbound: string[] = [];
  for (const r of records.values()) {
    if (r.type !== "note" || !isShape(r) || ancestors(records, r).includes(frameId)) continue;
    const p = portalOf(r as never);
    if (!p) continue;
    const hit = isAreaPortal(p) ? areaInFrame(records, p, frame) : p.id === frameId || (records.get(p.id) ? ancestors(records, records.get(p.id)!) : []).includes(frameId);
    if (!hit) continue;
    const f = enclosingFrame(records, r);
    inbound.push(`  ${describeShape(r, 40)} (${r.id})${f ? ` in frame ${quote(f.props.name || "(unnamed)", 40)} (${f.id})` : ""}${portalSuffix(records, r)}`);
  }
  if (inbound.length) lines.push(`Portals into this frame from elsewhere (${inbound.length}):`, ...inbound.slice(0, 20), ...(inbound.length > 20 ? [`  … and ${inbound.length - 20} more`] : []));
  outlineChildren(records, frame, 1, lines, ctx);
  return cap(lines.join("\n"));
}

// Find frames by name: one line per frame (nested ones included, any page) whose name or
// agent title contains every whitespace-separated term, case-insensitive. Only pages with a
// match get a heading, so a big board answers in a few lines instead of a truncated outline.
function findFrames(records: RecMap, query: string, ownFrameId: string | undefined, titleOf: ((agentId: string) => string | null | undefined) | undefined): string {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = quote(query.trim(), 60);
  const pages = [...records.values()].filter((r) => r.typeName === "page");
  const byPage = new Map<string, Array<{ f: Rec; line: string }>>();
  let total = 0;
  for (const f of records.values()) {
    if (!isShape(f) || f.type !== "frame") continue;
    const chain = ancestors(records, f);
    const top = chain.length ? records.get(chain[chain.length - 1])! : f;
    if (records.get(top.parentId)?.typeName !== "page") continue;
    total++;
    const p = f.meta?.paseo ?? {};
    // The agent's own title where it differs from the frame's: the last name both agreed on,
    // and the one Paseo reports now.
    const titles = [p.syncedName, p.agentId ? titleOf?.(String(p.agentId)) : null].filter((t): t is string => typeof t === "string" && !!t.trim());
    const hay = [String(f.props?.name ?? ""), ...titles].join("\n").toLowerCase();
    if (!terms.every((t) => hay.includes(t))) continue;
    const outer = enclosingFrame(records, f);
    const abs = absPos(records, f);
    const size = shapeSize(f);
    const title = titles.find((t) => t.trim() !== String(f.props?.name ?? "").trim());
    const line =
      `  ${frameHeader(f)} @page(${Math.round(abs.x)},${Math.round(abs.y)}) ${Math.round(size.w)}x${Math.round(size.h)} · ${children(records, f.id).length} shapes` +
      `${title ? ` · agent title ${quote(title, 60)}` : ""}${outer ? ` · inside frame ${quote(outer.props?.name || "(unnamed)", 40)} (${outer.id})` : ""}${f.id === ownFrameId ? " ← YOUR FRAME" : ""}`;
    const list = byPage.get(top.parentId) ?? [];
    list.push({ f, line });
    byPage.set(top.parentId, list);
  }
  const matched = [...byPage.values()].reduce((n, l) => n + l.length, 0);
  if (!matched) return `No frame name or agent title contains ${shown} (${total} frame${total === 1 ? "" : "s"} on ${pages.length} page${pages.length === 1 ? "" : "s"}). Every term must match; try fewer or shorter terms.`;
  const lines = [`Frames matching ${shown}: ${matched} of ${total}.`];
  let used = lines[0].length;
  let listed = 0;
  for (const page of pages) {
    const hits = byPage.get(page.id);
    if (!hits) continue;
    hits.sort((a, b) => sortReading({ ...a.f, ...absPos(records, a.f) }, { ...b.f, ...absPos(records, b.f) }));
    const head = `page ${quote(page.name)} (${page.id})`;
    // Whole lines only: a match is never cut in half by the length cap.
    if (used + head.length + hits[0].line.length + 2 > MAX_CHARS) break;
    lines.push(head);
    used += head.length + 1;
    for (const h of hits) {
      if (used + h.line.length + 1 > MAX_CHARS) break;
      lines.push(h.line);
      used += h.line.length + 1;
      listed++;
    }
  }
  if (listed < matched) lines.push(`… and ${matched - listed} more matching frame${matched - listed === 1 ? "" : "s"}; add a term to narrow the query.`);
  return lines.join("\n");
}

// A page read contains its full shape tree and only bindings whose endpoints are
// both on that page. The page record supplies identity; other pages/assets stay out.
export function recordsOnPage(records: RecMap, pageId: string): RecMap {
  const selected: RecMap = new Map();
  const page = records.get(pageId);
  if (page?.typeName === "page") selected.set(pageId, page);
  for (const r of records.values()) {
    if (!isShape(r)) continue;
    const chain = ancestors(records, r);
    const top = chain.length ? records.get(chain[chain.length - 1])! : r;
    if (top.parentId === pageId) selected.set(r.id, r);
  }
  for (const r of records.values()) {
    if (r.typeName === "binding" && selected.has(r.fromId) && selected.has(r.toId)) selected.set(r.id, r);
  }
  return selected;
}

export function boardOutline(records: RecMap, ownFrameId?: string, opts: { pageId?: string; ctx?: OutlineContext | null; query?: string; titleOf?: (agentId: string) => string | null | undefined } = {}): string {
  if (opts.pageId) records = recordsOnPage(records, opts.pageId);
  if (typeof opts.query === "string" && opts.query.trim()) return findFrames(records, opts.query, ownFrameId, opts.titleOf);
  const lines: string[] = [];
  const pages = [...records.values()].filter((r) => r.typeName === "page");
  if (!opts.pageId) lines.push("Pages (read one with scope:'board', pageId):", ...pages.map(page => `  ${quote(page.name)} (${page.id})`), "");
  for (const page of pages) {
    lines.push(`page ${quote(page.name)} (${page.id})`);
    if (opts.pageId) {
      const shapes = [...records.values()].filter(isShape).sort((a, b) => sortReading({ ...a, ...absPos(records, a) }, { ...b, ...absPos(records, b) }) || a.id.localeCompare(b.id));
      for (const s of shapes) {
        const abs = absPos(records, s);
        const label = s.type === "frame" ? frameHeader(s) : componentOutline(s as never, opts.ctx ?? null) || describeShape(s, 200);
        lines.push(`  ${label}${s.type === "frame" ? "" : ` (${s.id})`} @page(${Math.round(abs.x)},${Math.round(abs.y)})${s.parentId === page.id ? "" : ` inside ${s.parentId}`}${portalSuffix(records, s)}`);
      }
      continue;
    }
    for (const s of children(records, page.id)) {
      const abs = absPos(records, s);
      const size = shapeSize(s);
      const pos = `@page(${Math.round(abs.x)},${Math.round(abs.y)}) ${Math.round(size.w)}x${Math.round(size.h)}`;
      if (s.type === "frame") {
        const n = children(records, s.id).length;
        const mine = s.id === ownFrameId ? " ← YOUR FRAME" : "";
        lines.push(`  ${frameHeader(s)} ${pos} · ${n} shapes${mine}`);
        for (const r of records.values()) {
          if (r.type !== "note" || !isShape(r) || enclosingFrame(records, r)?.id !== s.id) continue;
          const suffix = portalSuffix(records, r);
          if (suffix) lines.push(`    ${describeShape(r, 40)} (${r.id})${suffix}`);
        }
      } else if (s.type !== "arrow") {
        lines.push(`  ${describeShape(s)} (${s.id}) ${pos} (unframed)${portalSuffix(records, s)}`);
      }
    }
  }
  return cap(lines.join("\n"), opts.pageId
    ? `Continue with board_read({scope:'board',pageId:${JSON.stringify(opts.pageId)},format:'json',offset:0,limit:300}); follow nextOffset until null.`
    : "Read one page with scope:'board', pageId, or use format:'json', offset:0, limit:300 and follow nextOffset until null.");
}
