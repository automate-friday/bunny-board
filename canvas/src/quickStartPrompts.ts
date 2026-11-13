// Next-step suggestions: the cards inside an empty opening-message box. Every card comes
// from the model call in server/quick-starts-ai.ts, which is shown what this person asked
// for, what the agents around the frame reported, and the workspace, and proposes what to
// ask next. There are no fixed starters and no replays of past openers: with nothing from
// the model there are no cards. This file holds what the canvas contributes to that call
// (the opener history on this device, which cards were shown and which were picked) and
// what keeps it cheap (a per-frame cache of the cards, and paging for "more").

// What a card is for: the request the person is likely to make next, something that looks
// done but is unverified or broken, or something useful they have not asked for.
export type StarterSlot = "next" | "check" | "idea";
// `title` and `detail` are the card's two lines; `prompt` is what a click puts in the box.
export type Starter = { slot?: StarterSlot; title: string; detail: string; prompt: string };

// The page around the frame being started (pageContext.ts): the page's name, the frame's own
// name and content, and the frames near it with their agent's status and a few notes.
export type BoardFrame = { id: string; name: string; status: string; notes: string[] };
export type PageContext = { page: string; frame: string; stickies: string[]; images: number; links: number; board: BoardFrame[] };

const HISTORY = "bunny:opening-prompts";
const MAX_HISTORY = 40;

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

// The empty-board hint draws a frame for a chosen card; its start form picks this up.
const pending = new Map<string, string>();
export function setPendingPrompt(frameId: string, prompt: string) { pending.set(frameId, prompt); }
export function takePendingPrompt(frameId: string): string | undefined {
  const p = pending.get(frameId);
  pending.delete(frameId);
  return p;
}

// Suggestions are on unless the person turned them off on this device.
const AI_SWITCH = "bunny:quick-starts-ai";
export function aiEnabled(): boolean {
  try { return localStorage.getItem(AI_SWITCH) !== "off"; } catch { return true; }
}
export function setAiEnabled(on: boolean) {
  try { localStorage.setItem(AI_SWITCH, on ? "on" : "off"); } catch { /* storage blocked */ }
}

// Pure: what the cards were made for. The same frame content, neighbours and recent openers
// reuse the cached cards; a change in any of them asks again.
export function contextKey(history: string[], ctx: PageContext | null | undefined): string {
  const text = JSON.stringify([history.slice(0, 5), ctx?.page ?? "", ctx?.frame ?? "", ctx?.stickies ?? [], ctx?.images ?? 0, ctx?.links ?? 0, (ctx?.board ?? []).map((f) => `${f.name}·${f.status}`)]);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Cards per frame context, kept on this device: `ideas` grows with each "Show others" call.
const CACHE = "bunny:next-ideas";
export const IDEAS_TTL_MS = 60 * 60 * 1000;
export const RETRY_MS = 2 * 60 * 1000;
export const MAX_IDEAS = 24;
const MAX_KEYS = 12;
type Entry = { at: number; ideas: Starter[]; failedAt?: number; error?: string };
type Cache = Record<string, Entry>;

function readCache(): Cache {
  try {
    const v = JSON.parse(localStorage.getItem(CACHE) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Cache) : {};
  } catch {
    return {};
  }
}
function writeEntry(key: string, entry: Entry) {
  try {
    const all = { ...readCache(), [key]: entry };
    const keep = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_KEYS);
    localStorage.setItem(CACHE, JSON.stringify(Object.fromEntries(keep)));
  } catch { /* storage blocked */ }
}
function entry(key: string, now = Date.now()): Entry | null {
  const e = readCache()[key];
  return e && typeof e.at === "number" && Array.isArray(e.ideas) && now - e.at < IDEAS_TTL_MS ? e : null;
}

export function cachedIdeas(key: string, now = Date.now()): Starter[] {
  return entry(key, now)?.ideas ?? [];
}

// Pure: the cards for "Show others" step `page`, and whether to ask the model for more first.
// Once MAX_IDEAS have been made (or no more can be had) the steps wrap around.
export function pageOf(ideas: Starter[], count: number, page: number, canAsk = true): { cards: Starter[]; needMore: boolean } {
  const start = page * count;
  if (start + count <= ideas.length) return { cards: ideas.slice(start, start + count), needMore: false };
  if (canAsk && ideas.length < MAX_IDEAS) return { cards: ideas.slice(start, start + count), needMore: true };
  if (!ideas.length) return { cards: [], needMore: false };
  const by = start % ideas.length;
  return { cards: [...ideas.slice(by), ...ideas.slice(0, by)].slice(0, count), needMore: false };
}

// Pure: whether a failed call for this context is recent enough to hold off asking again.
export function heldOff(e: { failedAt?: number } | null | undefined, now = Date.now()): boolean {
  return typeof e?.failedAt === "number" && now - e.failedAt < RETRY_MS;
}
export function askAllowed(key: string, now = Date.now()): boolean {
  return !heldOff(readCache()[key], now);
}
// Why the last call for this context gave no cards (shown in the message box).
export function lastError(key: string): string {
  return readCache()[key]?.error ?? NOTHING;
}

export const NOTHING = "Nothing to suggest here yet";
// Pure: what to show for a failed suggestion request, from its status and the server's error.
export function failureText(status: number, error: unknown): string {
  if (status === 429) return "Too many suggestion requests: try again in a few minutes";
  const detail = typeof error === "string" ? error.replace(/\s+/g, " ").trim().slice(0, 300) : "";
  return detail ? `Suggestions unavailable: ${detail}` : "Suggestions unavailable";
}

// Which cards this person has been shown and which they picked, by title, newest first.
// The model is told what was passed over (so it does not come back) and what landed.
const FEEDBACK = "bunny:idea-feedback";
type Feedback = { shown: string[]; picked: string[] };
function readFeedback(): Feedback {
  try {
    const v = JSON.parse(localStorage.getItem(FEEDBACK) ?? "{}");
    const titles = (x: unknown) => (Array.isArray(x) ? x.filter((t): t is string => typeof t === "string") : []);
    return { shown: titles(v?.shown), picked: titles(v?.picked) };
  } catch {
    return { shown: [], picked: [] };
  }
}
// Pure: `titles` put at the front of `list`, without repeats, capped.
export function remember(list: string[], titles: string[], max: number): string[] {
  return [...new Set([...titles, ...list])].slice(0, max);
}
export function noteShown(titles: string[]) {
  try { const f = readFeedback(); localStorage.setItem(FEEDBACK, JSON.stringify({ ...f, shown: remember(f.shown, titles, 60) })); } catch { /* storage blocked */ }
}
export function notePicked(title: string) {
  try { const f = readFeedback(); localStorage.setItem(FEEDBACK, JSON.stringify({ ...f, picked: remember(f.picked, [title], 20) })); } catch { /* storage blocked */ }
}
// Pure: what to tell the model. Passed over: shown, never picked, and not on screen now.
export function feedbackFor(f: Feedback, onScreen: string[]): { ignored: string[]; picked: string[] } {
  return { ignored: f.shown.filter((t) => !f.picked.includes(t) && !onScreen.includes(t)).slice(0, 20), picked: f.picked.slice(0, 8) };
}

export type IdeasResult = { ideas: Starter[] } | { error: string };
const inflight = new Map<string, Promise<IdeasResult>>();

// Asks for more cards for this context, on top of the ones already cached (which the model
// is told not to repeat). Resolves to the full list, or to why there are none.
export function fetchIdeas(key: string, history: string[], context: PageContext | null | undefined, where: { frameId?: string | null } = {}): Promise<IdeasResult> {
  const running = inflight.get(key);
  if (running) return running;
  const have = cachedIdeas(key);
  const call = (async (): Promise<IdeasResult> => {
    const fail = (error: string) => {
      writeEntry(key, { at: entry(key)?.at ?? Date.now(), ideas: have, failedAt: Date.now(), error });
      return { error };
    };
    try {
      const res = await fetch("/api/ui/quick-starts/suggest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          by: window.__board?.userName ?? "",
          boardId: window.__board?.boardId,
          frameId: where.frameId ?? undefined,
          prompts: history.slice(0, 12),
          context: context ?? undefined,
          avoid: have.map((s) => `${s.title}: ${s.prompt}`),
          ...feedbackFor(readFeedback(), have.map((s) => s.title)),
        }),
      });
      if (!res.ok) return fail(failureText(res.status, ((await res.json().catch(() => null)) as { error?: unknown } | null)?.error));
      const body = (await res.json()) as { starters?: Starter[] };
      const fresh = (body.starters ?? []).filter((s) => s && typeof s.title === "string" && typeof s.prompt === "string" && !have.some((h) => h.prompt === s.prompt));
      if (!fresh.length) return fail(NOTHING);
      const ideas = [...have, ...fresh].slice(0, MAX_IDEAS);
      writeEntry(key, { at: entry(key)?.at ?? Date.now(), ideas });
      return { ideas };
    } catch {
      return fail("Suggestions unavailable: the board server did not answer");
    }
  })();
  inflight.set(key, call);
  void call.finally(() => inflight.delete(key));
  return call;
}
