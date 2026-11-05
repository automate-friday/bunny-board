// Fuzzy search for the phone's "Jump to frame or agent…" sheet, over a frame's name, its
// agent, the harness and machine, the frame's own text (stickies, text, shape labels, card
// titles) and the agent conversation the page has loaded (the bound agent's and transcript
// cards' latest messages, cloud session cards' newest message).
//
// A query matches a field when every word of it matches, each as (best first):
// - substring: "compet" in "Competitor scan";
// - subsequence, compactly: "mobfrst" in "Mobile First Option" (letters in order, spread
//   over at most 2.5x their count, starting at a word start in long text);
// - typo: a word within 1 edit (2 for 8+ letters) of a word, or of its prefix: "competiter".
// Results rank name and agent hits above harness/machine hits above context hits, then
// substring above subsequence above typo, then by recency. Each says what matched.
// Pure (no tldraw), so it is unit-tested (test/mobile-shell.test.ts).

export type SearchField = "name" | "agent" | "host" | "content" | "conversation";
export interface SearchEntry { field: SearchField; label: string; text: string; norm?: string }
export interface SearchDoc { id: string; name: string; entries: SearchEntry[] }
export type MatchKind = "substring" | "subsequence" | "typo";
export interface SearchHit { id: string; field: SearchField; label: string; kind: MatchKind; snippet: string }

const TIER: Record<SearchField, number> = { name: 0, agent: 0, host: 1, content: 2, conversation: 2 };
const KIND: Record<MatchKind, number> = { substring: 0, subsequence: 1, typo: 2 };

export function norm(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// Optimal string alignment distance (Damerau-Levenshtein with adjacent swaps), capped.
export function editDistance(a: string, b: string, cap = 3): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > cap) return cap + 1;
  }
  return d[a.length][b.length];
}

const isWordStart = (t: string, i: number) => i === 0 || !/[a-z0-9]/.test(t[i - 1]);

// One query word against normalized text: where it matched and how. Typos are only tried
// when `typos` (names, agents, machines): over long context text they are both slow and noisy.
function matchWord(word: string, t: string, long: boolean, typos = true): { kind: MatchKind; at: number; end: number } | null {
  const at = t.indexOf(word);
  if (at >= 0) return { kind: "substring", at, end: at + word.length };
  // Compact subsequence: the shortest window holding the letters in order.
  if (word.length >= 2) {
    const limit = Math.max(word.length + 2, Math.ceil(word.length * 2.5));
    let best: { at: number; end: number } | null = null;
    for (let i = t.indexOf(word[0]); i >= 0 && i < t.length; i = t.indexOf(word[0], i + 1)) {
      if (long && !isWordStart(t, i)) continue;
      let k = 1;
      let j = i + 1;
      for (; j < t.length && k < word.length && j - i < limit; j++) if (t[j] === word[k]) k++;
      if (k === word.length && (!best || j - i < best.end - best.at)) best = { at: i, end: j };
    }
    if (best) return { kind: "subsequence", ...best };
  }
  // Typos, word by word (whole word, or its prefix of the same length).
  if (typos && word.length >= 4) {
    const cap = word.length >= 8 ? 2 : 1;
    const re = /[a-z0-9]+/g;
    for (let m = re.exec(t); m; m = re.exec(t)) {
      const w = m[0];
      if (editDistance(word, w, cap) <= cap || (w.length > word.length && editDistance(word, w.slice(0, word.length), cap) <= cap)) return { kind: "typo", at: m.index, end: m.index + w.length };
    }
  }
  return null;
}

// The query against one field's text; every word must match. Null when it does not.
export function fuzzyMatch(query: string, text: string, opts: { normalized?: string; typos?: boolean } = {}): { kind: MatchKind; at: number; end: number } | null {
  const q = norm(query).trim();
  if (!q) return null;
  const t = opts.normalized ?? norm(text);
  const long = t.length > 80;
  const whole = t.indexOf(q);
  if (whole >= 0) return { kind: "substring", at: whole, end: whole + q.length };
  let kind: MatchKind = "substring";
  let first: { at: number; end: number } | null = null;
  for (const word of q.split(/\s+/)) {
    const m = matchWord(word, t, long, opts.typos ?? true);
    if (!m) return null;
    if (KIND[m.kind] > KIND[kind]) kind = m.kind;
    if (!first || m.at < first.at) first = m;
  }
  return first ? { kind, ...first } : null;
}

// One line around the match.
function snippet(text: string, at: number, end: number, width = 70): string {
  const flat = text.replace(/\s+/g, " ");
  // Normalization can shift offsets slightly; this is for display only.
  const start = Math.max(0, Math.min(at, flat.length) - Math.floor((width - (end - at)) / 2));
  const s = flat.slice(start, start + width).trim();
  return `${start > 0 ? "…" : ""}${s}${start + width < flat.length ? "…" : ""}`;
}

export function searchDocs(docs: readonly SearchDoc[], query: string, touched: ReadonlyMap<string, number>): SearchHit[] {
  if (!query.trim()) return [];
  const hits: (SearchHit & { tier: number; rank: number })[] = [];
  for (const doc of docs) {
    let best: (SearchHit & { tier: number; rank: number }) | null = null;
    for (const e of doc.entries) {
      if (!e.text) continue;
      const m = fuzzyMatch(query, e.text, { normalized: e.norm, typos: TIER[e.field] < 2 });
      if (!m) continue;
      const tier = TIER[e.field];
      const rank = KIND[m.kind];
      if (best && (best.tier < tier || (best.tier === tier && best.rank <= rank))) continue;
      best = { id: doc.id, field: e.field, label: e.label, kind: m.kind, snippet: e.field === "name" ? `${e.label}: ${e.text}` : `${e.label}: ${snippet(e.text, m.at, m.end)}`, tier, rank };
      if (tier === 0 && rank === 0) break;
    }
    if (best) hits.push(best);
  }
  const name = new Map(docs.map((d) => [d.id, d.name]));
  hits.sort((a, b) => a.tier - b.tier || a.rank - b.rank || (touched.get(b.id) ?? -Infinity) - (touched.get(a.id) ?? -Infinity) || (name.get(a.id) ?? "").localeCompare(name.get(b.id) ?? ""));
  return hits.map(({ tier: _t, rank: _r, ...h }) => h);
}

// --- building the documents from board records -------------------------------------------

type Rec = { id: string; typeName: string; type?: string; parentId?: string; props?: unknown; meta?: unknown };
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

// The plain text of a tldraw rich-text document.
export function richTextPlain(rt: unknown): string {
  const out: string[] = [];
  const walk = (n: unknown) => {
    const o = obj(n);
    if (typeof o.text === "string") out.push(o.text);
    if (Array.isArray(o.content)) {
      for (const c of o.content) walk(c);
      if (o.type === "paragraph") out.push(" ");
    }
  };
  walk(rt);
  return out.join("").replace(/\s+/g, " ").trim();
}

const LABEL: Record<string, string> = { note: "Sticky", text: "Text", geo: "Shape", arrow: "Arrow", frame: "Frame", bookmark: "Link", "cloud-session": "Cloud session", checklist: "Checklist", link: "Link" };

export interface DocFrame { id: string; name: string; agentId: string; agentTitle: string; harness: string; host: string }
export type AgentRows = (agentId: string) => { kind: string; text: string }[];

// One document per frame: its own fields, the text of every shape inside it (nested frames'
// shapes count for the outer frame too), and the loaded conversation of its agent and of the
// transcript cards in it.
export function buildDocs(frames: readonly DocFrame[], records: Iterable<Rec>, agentRows: AgentRows, perFrame = 400): SearchDoc[] {
  const byId = new Map<string, Rec>();
  for (const r of records) byId.set(r.id, r);
  const docs = new Map<string, SearchDoc>();
  for (const f of frames) {
    const entries: SearchEntry[] = [{ field: "name", label: "Name", text: f.name }];
    if (f.agentTitle && f.agentTitle !== f.name) entries.push({ field: "agent", label: "Agent", text: f.agentTitle });
    if (f.harness || f.host) entries.push({ field: "host", label: "Agent", text: [f.harness, f.host].filter(Boolean).join(" · ") });
    docs.set(f.id, { id: f.id, name: f.name, entries });
  }
  const conversation = (agentId: string, into: SearchEntry[]) => {
    for (const r of agentRows(agentId).slice(-30).reverse()) {
      if (!r.text?.trim() || (r.kind !== "assistant" && r.kind !== "user")) continue;
      into.push({ field: "conversation", label: r.kind === "user" ? "You said" : "Agent said", text: r.text.slice(0, 1200) });
    }
  };
  for (const f of frames) if (f.agentId) conversation(f.agentId, docs.get(f.id)!.entries);
  for (const r of byId.values()) {
    if (r.typeName !== "shape" || docs.has(r.id)) continue;
    const owners: SearchDoc[] = [];
    const seen = new Set<string>();
    for (let p = byId.get(r.parentId ?? ""); p && p.typeName === "shape" && !seen.has(p.id); p = byId.get(p.parentId ?? "")) {
      seen.add(p.id);
      const d = docs.get(p.id);
      if (d) owners.push(d);
    }
    if (!owners.length) continue;
    const props = obj(r.props);
    const texts: SearchEntry[] = [];
    const plain = props.richText ? richTextPlain(props.richText) : typeof props.text === "string" ? props.text : "";
    if (plain) texts.push({ field: "content", label: LABEL[r.type ?? ""] ?? "Text", text: plain.slice(0, 600) });
    if (typeof props.name === "string" && props.name) texts.push({ field: "content", label: LABEL[r.type ?? ""] ?? "Name", text: props.name });
    if (typeof props.title === "string" && props.title) texts.push({ field: "content", label: LABEL[r.type ?? ""] ?? "Title", text: props.title });
    if (r.type === "cloud-session" && typeof props.message === "string" && props.message) texts.push({ field: "conversation", label: "Cloud session said", text: props.message.slice(0, 600) });
    if (r.type === "transcript" && typeof props.agentId === "string" && props.agentId) conversation(props.agentId, texts);
    for (const d of owners) if (d.entries.length < perFrame) d.entries.push(...texts);
  }
  // Normalized once here, not on every keystroke.
  for (const d of docs.values()) for (const e of d.entries) e.norm ??= norm(e.text);
  return [...docs.values()];
}
