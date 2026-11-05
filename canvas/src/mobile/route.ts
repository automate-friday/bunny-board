// Tell Bunny (phone): which agent frame a message (a bug report, usually with a screenshot)
// belongs to. Words of the message are matched against each frame's search document
// (fuzzySearch.ts buildDocs: name, agent title, the frame's text, the agent's recent
// conversation), weighted by where they matched and by how rare the word is across the
// board, so "mobile" or "pricing" counts and "the" or "fix" barely does. Recent activity
// breaks ties. Pure, so the unit tests run it.

import { norm, type SearchDoc, type SearchField } from "./fuzzySearch";

export type Route = { id: string; score: number; terms: string[]; where: SearchField };

const STOP = new Set(("a an and are as at be but by can could do does for from has have how i if in into is it its just me my no not of on or our please so that the their them then there these this to too up us was we were what when where which while who why will with would you your " +
  "bug issue problem fix fixed broken broke wrong doesnt dont cant isnt see seen look looks like need needs want got get gets also still again here now some any one two thing things way").split(" "));

const WEIGHT: Record<SearchField, number> = { name: 4, agent: 3.5, content: 2, conversation: 1.5, host: 0.5 };
const KEEP = 3;

export function words(text: string): string[] {
  return norm(text).split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
}

// Crude stemming, so "screenshots" finds "screenshot" and "scrolling" finds "scroll".
const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, "") || w;

// Frames ranked for `text`, best first; only frames with an agent (or `all`). `touched`: last
// activity per frame, for ties and a small recency boost.
export function rankFrames(docs: readonly SearchDoc[], text: string, opts: { agentFrames?: ReadonlySet<string>; touched?: ReadonlyMap<string, number>; now?: number } = {}): Route[] {
  const terms = [...new Set(words(text).map(stem))];
  if (!terms.length) return [];
  // Each doc's stems per field.
  const fields = docs.map((d) => {
    const by = new Map<SearchField, Set<string>>();
    for (const e of d.entries) {
      const set = by.get(e.field) ?? new Set<string>();
      for (const w of words(e.text)) set.add(stem(w));
      by.set(e.field, set);
    }
    return { doc: d, by };
  });
  // Rare words count more (inverse document frequency over the candidate frames); a word
  // every candidate has (the board's own introduction, say) counts for nothing.
  const pool = opts.agentFrames ? fields.filter((f) => opts.agentFrames!.has(f.doc.id)) : fields;
  const df = new Map<string, number>();
  for (const f of pool) for (const t of terms) if ([...f.by.values()].some((s) => s.has(t))) df.set(t, (df.get(t) ?? 0) + 1);
  const n = Math.max(1, pool.length);
  const idf = (t: string) => Math.log(n / Math.max(1, df.get(t) ?? n));
  const now = opts.now ?? Date.now();
  const out: Route[] = [];
  for (const { doc, by } of fields) {
    if (opts.agentFrames && !opts.agentFrames.has(doc.id)) continue;
    let score = 0;
    let where: SearchField = "conversation";
    let best = 0;
    const hit: string[] = [];
    for (const t of terms) {
      let w = 0;
      let at: SearchField | null = null;
      for (const [field, set] of by) if (set.has(t) && WEIGHT[field] > w) { w = WEIGHT[field]; at = field; }
      if (!at || idf(t) === 0) continue;
      const s = w * idf(t);
      score += s;
      hit.push(t);
      if (s > best) { best = s; where = at; }
    }
    if (!hit.length) continue;
    // A frame touched in the last hour gets a little extra (the bug is usually in what you were just doing).
    const age = now - (opts.touched?.get(doc.id) ?? 0);
    if (age < 3_600_000) score *= 1.1;
    out.push({ id: doc.id, score: +score.toFixed(3), terms: hit, where });
  }
  return out.sort((a, b) => b.score - a.score || (opts.touched?.get(b.id) ?? 0) - (opts.touched?.get(a.id) ?? 0));
}

// The route Bunny offers: the best frame when it clears the bar (a strong word in its name or
// title, or enough evidence elsewhere), else a new agent; plus up to two alternatives.
export const SEND_BAR = 3;
export function chooseRoute(ranked: readonly Route[]): { best: Route | null; alternatives: Route[] } {
  const top = ranked[0] ?? null;
  const best = top && top.score >= SEND_BAR ? top : null;
  return { best, alternatives: ranked.filter((r) => r !== best).slice(0, best ? 2 : KEEP) };
}

// "matches “mobile”, “toggle” in its conversation"
export function routeReason(r: Route): string {
  const where = { name: "its name", agent: "the agent's title", content: "the frame", conversation: "its conversation", host: "its machine" }[r.where];
  return `matches ${r.terms.slice(0, 3).map((t) => `“${t}”`).join(", ")} in ${where}`;
}

// A name for a new agent from the message: its first words without filler.
export function suggestName(text: string): string {
  const w = text.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean).slice(0, 6).join(" ").replace(/[\s,.;:!?-]+$/, "");
  return w ? w[0].toUpperCase() + w.slice(1) : "New agent";
}
