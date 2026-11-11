// QuickStart prompts: the starter cards under an opening message ("what can I use this
// for?"). New users get a fixed spread of use cases; once someone has started frames, the
// cards follow what they asked before: a recent opener of theirs comes back, the kinds of
// request they make most rank next, and one kind they have not tried is kept as "Try:". Everything runs on this device from localStorage; no model call.

export type StarterKind = "plan" | "build" | "research" | "review" | "write" | "design";
// `title` and `detail` are the card's two lines; `prompt` is what a click puts in the box.
// `badge`: "recent" for one of the person's own openers, "new" for a kind they have not tried,
// "ai" for a card from the opt-in model call, "page" for one about what is on the page.
export type Starter = { kind: StarterKind; title: string; detail: string; prompt: string; badge?: "recent" | "new" | "ai" | "page" };

const HISTORY = "bunny:opening-prompts";
const MAX_HISTORY = 40;

export const STARTERS: Starter[] = [
  { kind: "plan", title: "Plan from stickies", detail: "Turn notes into next steps", prompt: "Read the stickies in this frame and turn them into a prioritised plan with next steps." },
  { kind: "build", title: "Build a feature", detail: "With a preview link to check", prompt: "Build this feature and give me a preview link to check it: " },
  { kind: "research", title: "Research a topic", detail: "Key findings as stickies", prompt: "Research this and summarise the key findings as stickies in this frame: " },
  { kind: "review", title: "Review a repo", detail: "Top risks and quick wins", prompt: "Review the repository and list the top risks and quick wins, one sticky each." },
  { kind: "write", title: "Draft a doc", detail: "Outline first, on the board", prompt: "Draft this for me and put the outline on the board: " },
  { kind: "design", title: "Sketch UI options", detail: "Three options, compared", prompt: "Sketch three UI options for this and compare them on the board: " },
  { kind: "build", title: "Fix a bug", detail: "And show how it was checked", prompt: "Find and fix this bug, then show me how you checked it: " },
  { kind: "plan", title: "Brainstorm", detail: "Ten ideas, grouped", prompt: "Brainstorm ten ideas for this and group them on the board: " },
  { kind: "research", title: "Compare options", detail: "Recommend one, pros and cons", prompt: "Compare these options and recommend one, with pros and cons on the board: " },
];

// Word cues for each kind of request, checked in order (first hit wins).
const CUES: Array<[StarterKind, RegExp]> = [
  ["review", /\b(review|audit|risks?|check|critique|feedback)\b/i],
  ["build", /\b(build|fix|bug|implement|code|feature|refactor|deploy|add|ship|repo|test)\b/i],
  ["design", /\b(design|ui|ux|mock(up)?|layout|sketch|wireframe|style|icon)\b/i],
  ["research", /\b(research|find|compare|investigate|look up|summari[sz]e|what is|why)\b/i],
  ["write", /\b(write|draft|doc|post|email|blog|copy|readme|announce)\b/i],
  ["plan", /\b(plan|organi[sz]e|brainstorm|roadmap|prioriti[sz]e|ideas?|steps|todo)\b/i],
];

export function kindOf(prompt: string): StarterKind | null {
  for (const [kind, re] of CUES) if (re.test(prompt)) return kind;
  return null;
}

// Politeness and filler that open a request ("Could you", "Please", "Hey Bunny,"): left off a
// card's title so it starts with what is asked ("Could you make a" said nothing).
const FILLER = /^(?:(?:hey|hi|ok(?:ay)?|so|please|pls)\b[\s,]*|(?:bunny|claude)\b[\s,]*|(?:could|can|would|will) you(?: please)?\s+|i(?:'d| would) like (?:you )?to\s+|i (?:want|need) (?:you )?to\s+|let'?s\s+)+/i;
// Words a title never ends on ("Make a", "Read the frame of").
const DANGLING = /^(a|an|the|of|to|for|and|or|in|on|at|with|my|our|this|that|is|be)$/i;

// A past opener as a card: its first few words (no filler, never ending on "a" or "the") as
// the title, the rest as the detail.
function fromHistory(prompt: string): Starter {
  const words = prompt.replace(/\s+/g, " ").trim().replace(FILLER, "").split(" ").filter(Boolean);
  let cut = Math.min(words.length, words.length > 6 ? 4 : words.length);
  while (cut < words.length && cut < 7 && DANGLING.test(words[cut - 1] ?? "")) cut++;
  const title = words.slice(0, cut).join(" ");
  return { kind: kindOf(prompt) ?? "plan", title: title ? title[0].toUpperCase() + title.slice(1) : prompt.slice(0, 40), detail: words.slice(cut).join(" ") || "Ask again", prompt, badge: "recent" };
}

// Pure: the cards for a prompt history (newest first). `page` is "Show others": each step
// rotates to the next starters for the same ranking.
export function suggestStarters(history: string[], count = 4, page = 0): Starter[] {
  const past = history.map((p) => p.trim()).filter(Boolean);
  const rotate = <T,>(list: T[], by: number) => (list.length ? [...list.slice(by % list.length), ...list.slice(0, by % list.length)] : list);
  if (!past.length) {
    const firstOfKind = STARTERS.filter((s, i, all) => all.findIndex((t) => t.kind === s.kind) === i);
    const pool = [...firstOfKind, ...STARTERS.filter((s) => !firstOfKind.includes(s))];
    return rotate(pool, page * count).slice(0, count);
  }
  const tally = new Map<StarterKind, number>();
  past.forEach((p, i) => {
    const k = kindOf(p);
    if (k) tally.set(k, (tally.get(k) ?? 0) + 1 + (i < 5 ? 0.5 : 0)); // recent asks weigh a little more
  });
  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const recents = [...new Set(past)].slice(0, 5).map(fromHistory);
  // One starter per familiar kind first (most-used kind leading), then their second picks.
  const byKind = ranked.map((k) => STARTERS.filter((s) => s.kind === k));
  const familiar = [0, 1, 2].flatMap((i) => byKind.map((list) => list[i]).filter((s): s is Starter => !!s));
  const fresh = STARTERS.filter((s) => !tally.has(s.kind)).map((s) => ({ ...s, title: `Try: ${s.title.toLowerCase()}`, badge: "new" as const }));
  const out: Starter[] = [rotate(recents, page)[0]];
  for (const s of rotate(familiar, page)) if (out.length < count - (fresh.length ? 1 : 0) && !out.some((o) => o.prompt === s.prompt)) out.push(s);
  if (fresh.length) out.push(rotate(fresh, page)[0]);
  for (const s of STARTERS) if (out.length < count && !out.some((o) => o.prompt === s.prompt)) out.push(s);
  return out.slice(0, count);
}

// The page around the frame being started (pageContext.ts).
export type PageContext = { frame: string; stickies: string[]; images: number; links: number; nearby: string[] };

const quote = (t: string, max = 28) => {
  const one = t.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
};

// Pure: up to `max` starters about what is on the page: this frame's stickies, images
// and links, its name, and the frames next to it. Each prompt is complete (no blanks).
export function pageStarters(ctx: PageContext | null | undefined, max = 3): Starter[] {
  if (!ctx) return [];
  const out: Starter[] = [];
  const n = ctx.stickies.length;
  const about = ctx.frame ? ` about "${ctx.frame}"` : "";
  if (n >= 2) out.push({ kind: "plan", title: `Plan from ${n} stickies`, detail: quote(ctx.stickies.slice(0, 2).join(" · "), 34), prompt: `Read the ${n} stickies in this frame${about} and turn them into a prioritised plan with next steps.`, badge: "page" });
  else if (n === 1) out.push({ kind: "plan", title: "Expand this sticky", detail: quote(ctx.stickies[0], 34), prompt: `Expand the sticky "${quote(ctx.stickies[0], 80)}" into a plan with next steps, as stickies in this frame.` , badge: "page" });
  if (ctx.images) out.push({ kind: "review", title: ctx.images > 1 ? `Review ${ctx.images} images` : "Review this image", detail: "Issues and ideas, one sticky each", prompt: `Look at the ${ctx.images > 1 ? `${ctx.images} images` : "image"} in this frame and list issues and improvement ideas, one sticky each.`, badge: "page" });
  if (ctx.links) out.push({ kind: "research", title: ctx.links > 1 ? `Summarise ${ctx.links} links` : "Summarise this link", detail: "Key points as stickies", prompt: `Read the ${ctx.links > 1 ? "links" : "link"} in this frame and summarise the key points as stickies.`, badge: "page" });
  if (ctx.frame && !n) out.push({ kind: "research", title: `Research: ${quote(ctx.frame, 18)}`, detail: "Findings as stickies here", prompt: `Research "${ctx.frame}" and put the key findings as stickies in this frame.`, badge: "page" });
  // The frame next door is usually what this one continues: pick up where it left off.
  if (ctx.nearby.length) out.push({ kind: "plan", title: `Follow up on “${quote(ctx.nearby[0], 40)}”`, detail: "Pick up its next open step", prompt: `Read the frame "${ctx.nearby[0]}" next to this one (its stickies and its conversation) and take on the next step it leaves open${about ? `, here${about}` : ""}.`, badge: "page" });
  return out.slice(0, max);
}

// Page cards first (they are about what is in front of the person), keeping the recent
// opener on top when there is one.
export function withPageStarters(base: Starter[], page: Starter[], count = 4, maxPage = 2): Starter[] {
  if (!page.length) return base;
  const recent = base.find((s) => s.badge === "recent");
  const out = [...(recent ? [recent] : []), ...page.slice(0, maxPage)];
  for (const s of base) if (out.length < count && !out.some((o) => o.prompt === s.prompt)) out.push(s);
  return out.slice(0, count);
}

// Pure: the phone's short list. Only what is about this person's work: cards about the page
// (this frame, the frame next door) and their own recent openers, AI cards when on; the
// generic use-case starters only for someone with neither (a brand-new board and user).
// Nothing that needs stickies the frame does not have.
export function relevantStarters(history: string[], ctx: PageContext | null | undefined, count = 3, page = 0): Starter[] {
  const recents = [...new Set(history.map((p) => p.trim()).filter(Boolean))].slice(0, 6).map(fromHistory);
  const here = pageStarters(ctx, 5);
  const pool = [...here.slice(0, 2), ...recents.slice(0, 2), ...here.slice(2), ...recents.slice(2)];
  const fill = suggestStarters([], STARTERS.length).filter((s) => ctx?.stickies.length || !/stickies in this frame/.test(s.prompt));
  const list = pool.length ? pool : fill;
  const by = list.length ? (page * count) % list.length : 0;
  return [...list.slice(by), ...list.slice(0, by)].slice(0, count);
}

// Pure: complete ideas for the ghost typewriter in the message box, best first: AI cards,
// page starters, the person's recent openers, then starters with nothing to fill in.
export function ghostIdeas(history: string[], ctx: PageContext | null | undefined, ai: Starter[] | null): string[] {
  const ideas = [...(ai ?? []).map((s) => s.prompt), ...pageStarters(ctx, 5).map((s) => s.prompt), ...history.slice(0, 3), ...STARTERS.map((s) => s.prompt).filter((p) => !p.trimEnd().endsWith(":"))];
  return [...new Set(ideas.map((p) => p.trim()).filter((p) => p && !p.endsWith(":")))];
}

export function promptHistory(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(HISTORY) ?? "[]");
    return Array.isArray(v) ? v.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

// Called when a conversation starts with an opening message.
export function recordOpeningPrompt(prompt: string | undefined) {
  const p = prompt?.trim();
  if (!p) return;
  try {
    const next = [p, ...promptHistory().filter((q) => q !== p)].slice(0, MAX_HISTORY);
    localStorage.setItem(HISTORY, JSON.stringify(next));
  } catch { /* storage blocked */ }
}

// The empty-board hint draws a frame for a chosen starter; its start form picks this up.
const pending = new Map<string, string>();
export function setPendingPrompt(frameId: string, prompt: string) { pending.set(frameId, prompt); }
export function takePendingPrompt(frameId: string): string | undefined {
  const p = pending.get(frameId);
  pending.delete(frameId);
  return p;
}

// "Smarter with AI" (server/quick-starts-ai.ts): off unless the person turns it on. At
// most one request per AI_COOLDOWN_MS from this device, whether it worked or not; the
// cards it returns are kept and shown until the next one.
const AI_ON = "bunny:quick-starts-ai";
const AI_CACHE = "bunny:quick-starts-ai-cache";
export const AI_COOLDOWN_MS = 4 * 60 * 60 * 1000;
type AiCache = { at: number; starters: Starter[] };

export function aiEnabled(): boolean {
  try { return localStorage.getItem(AI_ON) === "on"; } catch { return false; }
}
export function setAiEnabled(on: boolean) {
  try { if (on) localStorage.setItem(AI_ON, "on"); else localStorage.removeItem(AI_ON); } catch { /* storage blocked */ }
}
export function aiCache(): AiCache | null {
  try {
    const v = JSON.parse(localStorage.getItem(AI_CACHE) ?? "null");
    return v && typeof v.at === "number" && Array.isArray(v.starters) ? v : null;
  } catch {
    return null;
  }
}

// Pure: whether this device may ask now.
export function aiDue(cache: AiCache | null, now = Date.now()): boolean {
  return !cache || now - cache.at >= AI_COOLDOWN_MS;
}

// Mixes the person's recent opener (from the local cards) with up to three AI cards.
export function withAiStarters(local: Starter[], ai: Starter[], count = 4): Starter[] {
  const recent = local.find((s) => s.badge === "recent");
  const picked = ai.filter((s) => s.prompt !== recent?.prompt).slice(0, count - (recent ? 1 : 0)).map((s) => ({ ...s, badge: "ai" as const }));
  const out = [...(recent ? [recent] : []), ...picked];
  for (const s of local) if (out.length < count && !out.some((o) => o.prompt === s.prompt)) out.push(s);
  return out;
}

export async function fetchAiStarters(history: string[], context?: PageContext | null): Promise<Starter[] | null> {
  const prior = aiCache();
  if (!aiDue(prior)) return prior?.starters.length ? prior.starters : null;
  // Claim the slot before the call so two open forms do not both ask.
  try { localStorage.setItem(AI_CACHE, JSON.stringify({ at: Date.now(), starters: prior?.starters ?? [] })); } catch { /* storage blocked */ }
  try {
    const res = await fetch("/api/ui/quick-starts/suggest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ by: window.__board?.userName ?? "", prompts: history.slice(0, 20), context: context ?? undefined }) });
    if (!res.ok) return prior?.starters.length ? prior.starters : null;
    const body = (await res.json()) as { starters?: Starter[] };
    const starters = (body.starters ?? []).filter((s) => s && typeof s.title === "string" && typeof s.prompt === "string");
    if (!starters.length) return prior?.starters.length ? prior.starters : null;
    try { localStorage.setItem(AI_CACHE, JSON.stringify({ at: Date.now(), starters })); } catch { /* storage blocked */ }
    return starters;
  } catch {
    return prior?.starters.length ? prior.starters : null;
  }
}
