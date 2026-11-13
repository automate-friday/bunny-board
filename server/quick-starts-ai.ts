// Next-step suggestions for a start form (canvas/src/quickStartPrompts.ts): every card the
// person sees comes from this model call. The model is shown what can be observed: the frame
// being started, the work in the frames around it (what each agent was asked and what it
// reported back), the workspace repository (suggestion-signals.ts), the person's own recent
// requests, and the suggestions they were shown and passed over. It first lists the open
// loops it sees, then fills three slots from them: the request the person is about to type
// anyway ("next"), something that looks done but is unverified or broken ("check"), and
// something useful nobody has asked for ("idea"). Every card quotes the observation it
// rests on, and a slot with no evidence stays empty. Someone new, with no history, gets the
// same three slots from the repository alone.
//
// The call runs on the same model path as the board organizer (organizer-brain.ts): a
// `codex app-server` with every tool off, one structured-output turn, warm threads per board.
// That path works where the board server runs without agent CLIs of its own (the compose
// board image), because BUNNY_CODEX can name the runtime's codex. When codex cannot answer,
// the host's `claude` CLI is tried. The same question is answered from a cache for CACHE_MS,
// and each user gets at most MAX_CALLS model calls per WINDOW_MS. The last RECENT_CALLS calls
// are kept in memory (recent()) so the cards, and any error, can be reviewed.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { bunnyEnv } from "./bunny-env";
import { FOLLOW_UP_MODEL, OrganizerBrain } from "./organizer-brain";
import type { RepoDigest } from "./suggestion-signals";

export const QUICK_STARTS_MODEL = bunnyEnv("QUICK_STARTS_MODEL") ?? FOLLOW_UP_MODEL;
export const QUICK_STARTS_CLAUDE_MODEL = bunnyEnv("QUICK_STARTS_CLAUDE_MODEL") ?? "claude-haiku-5-5";
export const CACHE_MS = 30 * 60 * 1000;
export const WINDOW_MS = 10 * 60 * 1000;
export const MAX_CALLS = 12;
export const IDEAS_PER_CALL = 6;
export const RECENT_CALLS = 30;
const SLOTS = ["next", "check", "idea"] as const;
export type Slot = (typeof SLOTS)[number];
// The icon an older canvas draws for each slot (it knows kinds, not slots).
const KIND_OF: Record<Slot, "build" | "review" | "plan"> = { next: "build", check: "review", idea: "plan" };
const MAX_PROMPTS = 12;
const MAX_PROMPT_CHARS = 300;
const MAX_CACHE = 200;
const TIMEOUT_MS = 60_000;

// `detail` is the card's second line: what was observed that makes this worth doing now.
// `evidence` is the quote the model based it on (kept for review, not shown).
export type AiStarter = { slot: Slot; kind: "build" | "review" | "plan"; title: string; detail: string; prompt: string; evidence: string };

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["open_loops", "goals", "starters"],
  properties: {
    open_loops: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["what", "quote"], properties: { what: { type: "string" }, quote: { type: "string" } } },
    },
    goals: { type: "array", items: { type: "string" } },
    starters: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["slot", "evidence", "title", "why", "prompt"],
        properties: { slot: { type: "string", enum: [...SLOTS] }, evidence: { type: "string" }, title: { type: "string" }, why: { type: "string" }, prompt: { type: "string" } },
      },
    },
  },
};

// The page around the frame being started, as the canvas sends it (pageContext.ts), capped:
// the frame's own name and stickies, and the other frames near it with their agent's status
// and a few of their notes. `asked` and `report` are added here from each frame's
// conversation (suggestion-signals.ts): what its agent was asked and what it said last.
export type BoardFrame = { id: string; name: string; status: string; notes: string[]; asked?: string; report?: string };
export type PageContext = { page: string; frame: string; stickies: string[]; images: number; links: number; board: BoardFrame[] };

const str = (x: unknown, max: number) => (typeof x === "string" ? x.replace(/\s+/g, " ").trim().slice(0, max) : "");
const list = (x: unknown, n: number, max: number) => (Array.isArray(x) ? x.map((y) => str(y, max)).filter(Boolean).slice(0, n) : []);
const count = (x: unknown) => (typeof x === "number" && x > 0 ? Math.min(99, Math.floor(x)) : 0);

export function cleanContext(v: unknown): PageContext | null {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const board: BoardFrame[] = (Array.isArray(o.board) ? o.board : [])
    .map((f) => {
      const b = (f && typeof f === "object" ? f : {}) as Record<string, unknown>;
      return { id: str(b.id, 80), name: str(b.name, 80), status: str(b.status, 20), notes: list(b.notes, 4, 140) };
    })
    .filter((f) => f.name || f.notes.length || f.id)
    .slice(0, 12);
  const ctx = { page: str(o.page, 60), frame: str(o.frame, 80), stickies: list(o.stickies, 12, 160), images: count(o.images), links: count(o.links), board };
  return ctx.page || ctx.frame || ctx.stickies.length || ctx.images || ctx.links || ctx.board.length ? ctx : null;
}

// Everything one suggestion call is made from.
export type Signals = {
  prompts: string[];
  context: PageContext | null;
  repo: RepoDigest | null;
  // Cards already on screen for this frame ("Show others"), cards shown before and passed
  // over, and cards the person picked.
  avoid: string[];
  ignored: string[];
  picked: string[];
};

export function cleanSignals(body: { prompts?: unknown; context?: unknown; avoid?: unknown; ignored?: unknown; picked?: unknown }, repo: RepoDigest | null = null): Signals {
  return { prompts: list(body.prompts, MAX_PROMPTS, MAX_PROMPT_CHARS), context: cleanContext(body.context), repo, avoid: list(body.avoid, 24, 200), ignored: list(body.ignored, 20, 80), picked: list(body.picked, 8, 80) };
}

// Pure: someone with no requests of their own and no agent work around them.
export function isNewPerson(s: Signals): boolean {
  return !s.prompts.length && !(s.context?.board ?? []).some((f) => f.asked || f.report);
}

export function suggestionPrompt(s: Signals): string {
  const ctx = s.context;
  const here = ctx && (ctx.frame || ctx.stickies.length || ctx.images || ctx.links);
  const fresh = isNewPerson(s);
  const repo = s.repo;
  const nothing = fresh && !here && !ctx?.page && !ctx?.board.length && !repo;
  const section = (title: string, body: string[]) => (body.length ? ["", `== ${title} ==`, ...body] : []);
  return [
    "You suggest what a person should ask an AI agent to do next on Bunny, a shared whiteboard where each frame can hold an agent (Claude Code or Codex) that researches, plans, writes, designs and builds code, and reports back in its frame.",
    "",
    "Everything below is what can be observed about their work. Suggest only from it.",
    ...(ctx && here
      ? section("The frame they are starting an agent on", [
          ...(ctx.frame ? [`Name: ${ctx.frame}`] : []),
          ...(ctx.page ? [`On the page: ${ctx.page}`] : []),
          ...(ctx.stickies.length ? ["Stickies in it:", ...ctx.stickies.map((t) => `- ${t}`)] : []),
          ...(ctx.images || ctx.links ? [`It also holds ${[ctx.images ? `${ctx.images} image${ctx.images > 1 ? "s" : ""}` : "", ctx.links ? `${ctx.links} link${ctx.links > 1 ? "s" : ""}` : ""].filter(Boolean).join(" and ")}.`] : []),
        ])
      : []),
    ...(ctx?.page && !here ? section("The page they are on", [ctx.page]) : []),
    ...section(
      "Work in the frames around it, nearest first",
      (ctx?.board ?? []).flatMap((f) => [
        `- "${f.name || "(unnamed)"}"${f.status ? ` [agent ${f.status}]` : ""}`,
        ...(f.asked ? [`  asked: ${f.asked}`] : []),
        ...(f.report ? [`  agent's last report: ${f.report}`] : []),
        ...(f.notes.length ? [`  notes: ${f.notes.join(" | ")}`] : []),
      ]),
    ),
    ...(repo
      ? section(`The workspace "${repo.name}"`, [
          ...(repo.readme ? [`README: ${repo.readme}`] : []),
          ...(repo.commits.length ? ["Recent commits, newest first:", ...repo.commits.map((c) => `- ${c}`)] : []),
          ...(repo.branches.length ? [`Branches worked on last: ${repo.branches.join(", ")}`] : []),
          ...(repo.todos.length ? ["TODO and FIXME lines:", ...repo.todos.map((t) => `- ${t}`)] : []),
          ...(!repo.commits.length && repo.folders.length ? [`Folders: ${repo.folders.join(", ")}`] : []),
        ])
      : []),
    ...section("Their own recent requests, newest first (their voice, and what is already asked)", s.prompts.map((p, i) => `${i + 1}. ${p}`)),
    ...section("Suggestions already on their screen (do not repeat or rephrase)", s.avoid.map((t) => `- ${t}`)),
    ...section("Suggestions they were shown before and did not pick (do not offer these or close variants)", s.ignored.map((t) => `- ${t}`)),
    ...section("Suggestions they picked before (this kind lands)", s.picked.map((t) => `- ${t}`)),
    ...(nothing
      ? [
          "",
          "There is nothing to observe yet: a new person, an empty board, no workspace to read. An agent can find the context itself, so suggest three first requests that make it do that. Leave open_loops and goals empty, and `evidence` empty.",
          '- "next": have the agent interview them: a few short questions about what they are working on, then a first plan as stickies in the frame.',
          '- "check": have the agent look through the folder it runs in and report what is there and what state it is in.',
          '- "idea": one small, concrete thing that shows what agents here can do, such as researching a question on the web and reporting the findings as stickies.',
          "Each prompt is a complete request an agent could act on exactly as sent, in plain words. title: starts with a verb, at most 6 words. why: at most 8 words. prompt: at most 45 words.",
        ]
      : [
          "",
          "Work in this order.",
          "",
          "1. open_loops: up to 6 things the observations leave unfinished, unverified, broken or promised. For example a report that names a next step or a limit, an agent in error, a branch that never merged, a TODO, a claim nobody checked, a request with no result. `quote` is the exact words it rests on.",
          "2. goals: the 2 or 3 larger things this person is trying to get done.",
          `3. starters: up to ${IDEAS_PER_CALL} opening messages, at most two per slot, best first within a slot.`,
          ...(fresh
            ? [
                "This person is new here, so the slots mean:",
                '   - "next": pick up the newest thing that looks unfinished (the latest commits, a branch, a TODO, or what the frame and page are named for), named exactly.',
                '   - "check": get oriented. Ask an agent to map how a real, named part of this workspace works, or to confirm it builds and its tests pass.',
                '   - "idea": a small first win: one concrete, safe improvement an agent could finish in one go, named from what is there.',
              ]
            : [
                '   - "next": the request they are most likely about to type anyway. Test: they read it and think "I was just about to ask that". It continues their newest unfinished work.',
                '   - "check": something that looks done but is unverified, failing, in error, or contradicted by another observation. Ask an agent to verify it or fix it.',
                '   - "idea": something that serves one of their goals and appears nowhere in their requests or the reports: new functionality, or a link between two pieces of their work.',
              ]),
          "",
          "Rules:",
          "- Every starter rests on one open loop or goal. Put the words that prompted it in `evidence`, quoted from above. No evidence, no starter: return fewer, or none for a slot, rather than filler.",
          "- Name the real thing (the frame, feature, file, branch or commit) in the words used above. Each prompt is a complete request an agent could act on exactly as sent, with no blank to fill in.",
          "- Write each prompt the way this person writes their own requests: their vocabulary, their level of detail, their bluntness.",
          "- Never repeat or rephrase a request they already made or a suggestion listed above, unless the reports show that work failed.",
          "- A frame whose agent is running is being handled. Do not suggest its work again; suggest what comes after it, or leave it.",
          ...(here ? ['- If the frame being started has a name or stickies, the first "next" starter is about it.'] : []),
          "- title: starts with a verb, at most 6 words. why: at most 8 words, naming what you observed that makes this worth doing now. prompt: at most 45 words.",
        ]),
  ].join("\n");
}

// Keeps only well-formed, short cards with nothing left to fill in, and deals them out one
// slot at a time (next, check, idea, next, …) so any three in a row cover the slots present.
export function parseStarters(stdout: string): AiStarter[] {
  let out: unknown = JSON.parse(stdout);
  const o = out as { structured_output?: unknown; result?: unknown };
  if (o && typeof o === "object" && ("structured_output" in o || "result" in o)) {
    out = o.structured_output ?? (typeof o.result === "string" ? JSON.parse(o.result.replace(/^```(json)?|```$/g, "").trim()) : o.result);
  }
  const starters = (out as { starters?: unknown })?.starters;
  if (!Array.isArray(starters)) throw new Error("model returned no starters");
  const seen = new Set<string>();
  const clean = starters
    .map((s) => {
      const slot: Slot = SLOTS.includes(s?.slot) ? s.slot : "next";
      return { slot, kind: KIND_OF[slot], title: str(s?.title, 60), detail: str(s?.why ?? s?.detail, 90), prompt: str(s?.prompt, 420), evidence: str(s?.evidence, 200) };
    })
    .filter((s) => s.title && s.prompt && !s.prompt.endsWith(":") && !seen.has(s.prompt.toLowerCase()) && !!seen.add(s.prompt.toLowerCase()));
  const bySlot = SLOTS.map((slot) => clean.filter((s) => s.slot === slot));
  const dealt: AiStarter[] = [];
  for (let i = 0; dealt.length < clean.length; i++) for (const group of bySlot) if (group[i]) dealt.push(group[i]);
  return dealt.slice(0, IDEAS_PER_CALL);
}

// Where a call runs: `key` keeps warm threads per board, `cwd` is a directory the model
// process can start in.
export type Scope = { key: string; cwd: string };
type Run = (input: string, scope: Scope) => Promise<string>;

// The CLI's own words when it fails (`--output-format json` prints them on stdout, e.g. "Not
// logged in"), else the process error.
export function claudeFailure(err: (Error & { code?: unknown }) | null, stdout: string): string | null {
  try {
    const o = JSON.parse(stdout) as { is_error?: boolean; result?: unknown };
    if (o?.is_error) return `claude: ${String(o.result ?? "error").slice(0, 160)}`;
  } catch { /* not JSON */ }
  if (!err) return null;
  if (err.code === "ENOENT") return "claude: not installed on the board host";
  return `claude: ${err.message.split("\n")[0].slice(0, 160)}`;
}

// Runs outside any project (cwd: tmpdir), so no repository's CLAUDE.md colours the ideas.
function runClaude(input: string): Promise<string> {
  const args = ["-p", "--model", QUICK_STARTS_CLAUDE_MODEL, "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--output-format", "json", "--json-schema", JSON.stringify(SCHEMA)];
  return new Promise((resolve, reject) => {
    const child = execFile(bunnyEnv("CLAUDE_BIN") ?? "claude", args, { cwd: tmpdir(), timeout: TIMEOUT_MS, maxBuffer: 1_000_000 }, (err, stdout) => {
      const failure = claudeFailure(err, String(stdout ?? ""));
      if (failure) reject(new Error(failure));
      else resolve(stdout);
    });
    child.stdin?.end(input);
  });
}

const BASE_INSTRUCTIONS = "You suggest what a person should ask an AI agent to do next on a shared whiteboard. Each message gives you everything observed at one moment and asks for suggestions. Earlier messages in this conversation were other moments: use only the observations in the latest message. Answer with JSON only, in the given schema.";

// codex first (the organizer's model path), then the host's claude CLI. Errors name both.
export function modelRunner(log: (m: string) => void, fallback: (input: string) => Promise<string> = runClaude): Run {
  const brain = new OrganizerBrain(BASE_INSTRUCTIONS, log, { model: QUICK_STARTS_MODEL, effort: bunnyEnv("QUICK_STARTS_EFFORT") ?? "low" });
  return async (input, scope) => {
    try {
      return await brain.decide(`suggest:${scope.key}`, scope.cwd, input, SCHEMA);
    } catch (codexError) {
      const codex = `codex: ${(codexError as Error).message.split("\n")[0].slice(0, 160)}`;
      try {
        return await fallback(input);
      } catch (claudeError) {
        throw new Error(`${codex}; ${(claudeError as Error).message}`);
      }
    }
  };
}

// One model call as kept for review: which signals it had, how long it took, what came back.
export type RecentCall = { at: number; by: string; ms: number; newPerson: boolean; signals: { requests: number; frames: number; reports: number; repo: boolean; shown: number; ignored: number; picked: number }; starters: AiStarter[]; error?: string };

export class QuickStartsAi {
  private calls = new Map<string, number[]>();
  private cache = new Map<string, { at: number; starters: AiStarter[] }>();
  private inflight = new Map<string, Promise<AiStarter[]>>();
  private log: RecentCall[] = [];
  constructor(private run: Run = (input) => runClaude(input), private now: () => number = Date.now, private note: (m: string) => void = () => undefined) {}

  // The latest model calls, newest first.
  recent(): RecentCall[] {
    return [...this.log].reverse();
  }

  // `retryAfterMs` when this user has used their model calls for the current window.
  async suggest(user: string, s: Signals, scope: Scope = { key: "board", cwd: tmpdir() }): Promise<{ starters: AiStarter[] } | { retryAfterMs: number }> {
    const input = suggestionPrompt(s);
    const key = createHash("sha1").update(input).digest("hex");
    const now = this.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < CACHE_MS) return { starters: hit.starters };
    const pending = this.inflight.get(key);
    if (pending) return { starters: await pending };
    const who = user || "anonymous";
    const recent = (this.calls.get(who) ?? []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= MAX_CALLS) return { retryAfterMs: WINDOW_MS - (now - recent[0]) };
    this.calls.set(who, [...recent, now]); // a failed call still counts: no retry storm
    const call = this.run(input, scope).then(parseStarters);
    this.inflight.set(key, call);
    const entry: RecentCall = {
      at: now,
      by: who,
      ms: 0,
      newPerson: isNewPerson(s),
      signals: { requests: s.prompts.length, frames: s.context?.board.length ?? 0, reports: (s.context?.board ?? []).filter((f) => f.report).length, repo: !!s.repo, shown: s.avoid.length, ignored: s.ignored.length, picked: s.picked.length },
      starters: [],
    };
    const started = Date.now();
    try {
      const starters = await call;
      entry.starters = starters;
      if (starters.length) {
        if (this.cache.size >= MAX_CACHE) this.cache.delete(this.cache.keys().next().value as string);
        this.cache.set(key, { at: now, starters });
      }
      return { starters };
    } catch (error) {
      entry.error = (error as Error).message.slice(0, 400);
      this.note(`suggestions failed for ${who}: ${entry.error}`);
      throw error;
    } finally {
      entry.ms = Date.now() - started;
      this.log = [...this.log, entry].slice(-RECENT_CALLS);
      this.inflight.delete(key);
    }
  }
}
