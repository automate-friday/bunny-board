// QuickStart prompts: the starter cards under an opening message ("what can I use this
// for?"). New users get a fixed spread of use cases; once someone has started frames, the
// cards follow what they asked before: a recent opener of theirs comes back, the kinds of
// request they make most rank next, and one kind they have not tried is kept as "Try:". Everything runs on this device from localStorage; no model call.

export type StarterKind = "plan" | "build" | "research" | "review" | "write" | "design";
// `title` and `detail` are the card's two lines; `prompt` is what a click puts in the box.
// `badge`: "recent" for one of the person's own openers, "new" for a kind they have not tried.
export type Starter = { kind: StarterKind; title: string; detail: string; prompt: string; badge?: "recent" | "new" };

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

// A past opener as a card: its first few words as the title, the rest as the detail.
function fromHistory(prompt: string): Starter {
  const words = prompt.replace(/\s+/g, " ").trim().split(" ");
  const cut = Math.min(words.length, words.length > 6 ? 4 : words.length);
  return { kind: kindOf(prompt) ?? "plan", title: words.slice(0, cut).join(" "), detail: words.slice(cut).join(" ") || "Ask again", prompt, badge: "recent" };
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
