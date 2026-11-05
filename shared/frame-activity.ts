// When each frame last saw activity, from what the board's own records carry, so it works on
// any board, bound or not, and on a copy whose bindings were stripped (board-env --state copy):
// - the frame's binding times (meta.paseo: boundAt, lastDeltaAt, a start/link request,
//   the last delivery receipt) or, on a copy, their read-only preview (meta.paseoPreview);
// - shapes inside it: stamps (props.at), cloud session cards (activityAt, startedAt);
// - comment threads pinned to it or to a shape inside it (page meta: created, edited,
//   resolved).
// The server adds the newest settled History edit (frame-history.ts, frameActivity). A
// time counts for every frame that encloses the shape, so a nested frame's activity shows
// on its parent too. Times are epoch ms; frames with none are left out.

type Rec = { id: string; typeName: string; type?: string; parentId?: string; props?: unknown; meta?: unknown };

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const ms = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v === "string" && v) {
    const t = Date.parse(v);
    return Number.isFinite(t) && t > 0 ? t : null;
  }
  return null;
};

// The binding's own times, from meta.paseo or (on a board-env copy) meta.paseoPreview.
export function bindingTimes(meta: unknown): number[] {
  const out: number[] = [];
  for (const key of ["paseo", "paseoPreview"]) {
    const p = obj(obj(meta)[key]);
    for (const t of [p.boundAt, p.lastDeltaAt, obj(p.request).requestedAt, obj(p.lastReceipt).at, p.lastActivityAt]) {
      const v = ms(t);
      if (v) out.push(v);
    }
  }
  return out;
}

function shapeTimes(r: Rec): number[] {
  const p = obj(r.props);
  if (r.type === "stamp") return [ms(p.at)].filter((v): v is number => !!v);
  if (r.type === "cloud-session") return [ms(p.activityAt), ms(p.startedAt)].filter((v): v is number => !!v);
  return [];
}

function threadTimes(meta: unknown): { shapeId: string; at: number }[] {
  const out: { shapeId: string; at: number }[] = [];
  const m = obj(meta);
  const threads = new Map<string, { shapeId: string; times: number[] }>();
  for (const [k, v] of Object.entries(m)) {
    if (!k.startsWith("paseoCommentThread:")) continue;
    const t = obj(v);
    const shapeId = obj(t.anchor).shapeId;
    if (typeof shapeId !== "string" || !shapeId) continue;
    const times = [ms(t.createdAt), ms(obj(t.resolved).at)].filter((x): x is number => !!x);
    for (const msg of Object.values(obj(t.messages))) times.push(...[ms(obj(msg).createdAt), ms(obj(msg).editedAt)].filter((x): x is number => !!x));
    threads.set(String(t.id ?? k.slice(19)), { shapeId, times });
  }
  // Messages may also live under their own keys (paseoCommentMsg:<thread>:<message>).
  for (const [k, v] of Object.entries(m)) {
    if (!k.startsWith("paseoCommentMsg:")) continue;
    const threadId = k.slice(16).split(":")[0];
    const t = threads.get(threadId);
    if (!t) continue;
    for (const x of [ms(obj(v).createdAt), ms(obj(v).editedAt)]) if (x) t.times.push(x);
  }
  for (const t of threads.values()) if (t.times.length) out.push({ shapeId: t.shapeId, at: Math.max(...t.times) });
  return out;
}

export function frameTimes(records: Iterable<Rec>): Map<string, number> {
  const byId = new Map<string, Rec>();
  for (const r of records) byId.set(r.id, r);
  const out = new Map<string, number>();
  const bump = (id: string, at: number) => {
    if (at > (out.get(id) ?? 0)) out.set(id, at);
  };
  // Every frame enclosing (or being) this shape.
  const framesOf = (id: string): string[] => {
    const res: string[] = [];
    const seen = new Set<string>();
    for (let r = byId.get(id); r && r.typeName === "shape" && !seen.has(r.id); r = byId.get(r.parentId ?? "")) {
      seen.add(r.id);
      if (r.type === "frame") res.push(r.id);
    }
    return res;
  };
  for (const r of byId.values()) {
    if (r.typeName === "page") {
      for (const t of threadTimes(r.meta)) for (const f of framesOf(t.shapeId)) bump(f, t.at);
      continue;
    }
    if (r.typeName !== "shape") continue;
    const times = r.type === "frame" ? bindingTimes(r.meta) : shapeTimes(r);
    if (!times.length) continue;
    const at = Math.max(...times);
    for (const f of framesOf(r.id)) bump(f, at);
  }
  return out;
}
