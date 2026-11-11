// "Smarter with AI" QuickStart prompts (canvas/src/quickStartPrompts.ts): an opt-in, rare model
// call that turns someone's recent opening messages, and the frame they are starting on,
// into four tailored starter cards. It
// runs the host's own `claude` CLI (its existing login, no API key in Bunny) on a small
// model with every tool off and no saved session, and answers each user at most once per
// COOLDOWN_MS; the canvas also caches the result for the same period.
import { execFile } from "node:child_process";
import { bunnyEnv } from "./bunny-env";

export const QUICK_STARTS_MODEL = bunnyEnv("QUICK_STARTS_MODEL") ?? "claude-haiku-5-5";
export const COOLDOWN_MS = 4 * 60 * 60 * 1000;
const KINDS = ["plan", "build", "research", "review", "write", "design"] as const;
const MAX_PROMPTS = 20;
const MAX_PROMPT_CHARS = 400;
const TIMEOUT_MS = 60_000;

export type AiStarter = { kind: (typeof KINDS)[number]; title: string; detail: string; prompt: string };

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["starters"],
  properties: {
    starters: {
      type: "array",
      minItems: 4,
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "title", "detail", "prompt"],
        properties: { kind: { type: "string", enum: [...KINDS] }, title: { type: "string" }, detail: { type: "string" }, prompt: { type: "string" } },
      },
    },
  },
};

// The page around the frame being started, as the canvas sends it (pageContext.ts), capped.
export type PageContext = { frame: string; stickies: string[]; nearby: string[] };
export function cleanContext(v: unknown): PageContext | null {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const str = (x: unknown, max: number) => (typeof x === "string" ? x.replace(/\s+/g, " ").trim().slice(0, max) : "");
  const list = (x: unknown, n: number, max: number) => (Array.isArray(x) ? x.map((y) => str(y, max)).filter(Boolean).slice(0, n) : []);
  const ctx = { frame: str(o.frame, 80), stickies: list(o.stickies, 10, 160), nearby: list(o.nearby, 5, 80) };
  return ctx.frame || ctx.stickies.length || ctx.nearby.length ? ctx : null;
}

export function suggestionPrompt(prompts: string[], context: PageContext | null = null): string {
  return [
    "You suggest starter prompts for Bunny, a shared whiteboard where each frame gets an AI agent that writes stickies, researches, plans and builds code.",
    ...(prompts.length ? ["These are the person's recent opening messages, newest first:", ...prompts.map((p, i) => `${i + 1}. ${p}`)] : []),
    ...(context
      ? [
          "They are about to start an agent on this frame:",
          ...(context.frame ? [`Frame name: ${context.frame}`] : []),
          ...(context.stickies.length ? ["Stickies in it:", ...context.stickies.map((t) => `- ${t}`)] : []),
          ...(context.nearby.length ? [`Nearby frames: ${context.nearby.join("; ")}`] : []),
          "Prefer suggestions about this frame's content.",
        ]
      : []),
    "",
    "Suggest 4 new opening messages this person is likely to want next: concrete, in their own domain and wording, not copies of the list.",
    "Mix 3 that follow their pattern with 1 useful kind of request they have not tried.",
    "title: at most 4 words. detail: at most 6 words. prompt: one complete request (under 30 words); end with ': ' if they must fill in a subject.",
    "kind: one of plan, build, research, review, write, design.",
  ].join("\n");
}

// Keeps only well-formed, short cards; anything else from the model is dropped.
export function parseStarters(stdout: string): AiStarter[] {
  let out: unknown = JSON.parse(stdout);
  const o = out as { structured_output?: unknown; result?: unknown };
  if (o && typeof o === "object" && ("structured_output" in o || "result" in o)) {
    out = o.structured_output ?? (typeof o.result === "string" ? JSON.parse(o.result.replace(/^```(json)?|```$/g, "").trim()) : o.result);
  }
  const list = (out as { starters?: unknown })?.starters;
  if (!Array.isArray(list)) throw new Error("model returned no starters");
  const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
  return list
    .map((s) => ({ kind: KINDS.includes(s?.kind) ? s.kind : "plan", title: clean(s?.title, 32), detail: clean(s?.detail, 48), prompt: clean(s?.prompt, 300) }) as AiStarter)
    .filter((s) => s.title && s.prompt)
    .slice(0, 4);
}

type Run = (input: string) => Promise<string>;

function runClaude(input: string): Promise<string> {
  const args = ["-p", "--model", QUICK_STARTS_MODEL, "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--output-format", "json", "--json-schema", JSON.stringify(SCHEMA)];
  return new Promise((resolve, reject) => {
    const child = execFile(bunnyEnv("CLAUDE_BIN") ?? "claude", args, { timeout: TIMEOUT_MS, maxBuffer: 1_000_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    child.stdin?.end(input);
  });
}

export class QuickStartsAi {
  private last = new Map<string, number>();
  private inflight = new Map<string, Promise<AiStarter[]>>();
  constructor(private run: Run = runClaude, private now: () => number = Date.now) {}

  // `retryAfterMs` when this user already had a call in the last COOLDOWN_MS.
  async suggest(user: string, prompts: unknown, context?: unknown): Promise<{ starters: AiStarter[] } | { retryAfterMs: number }> {
    const list = (Array.isArray(prompts) ? prompts : []).filter((p): p is string => typeof p === "string" && !!p.trim()).slice(0, MAX_PROMPTS).map((p) => p.trim().slice(0, MAX_PROMPT_CHARS));
    const ctx = cleanContext(context);
    if (!list.length && !ctx) throw new Error("no opening messages or page to learn from");
    const key = user || "anonymous";
    const pending = this.inflight.get(key);
    if (pending) return { starters: await pending };
    const since = this.now() - (this.last.get(key) ?? -Infinity);
    if (since < COOLDOWN_MS) return { retryAfterMs: COOLDOWN_MS - since };
    this.last.set(key, this.now()); // a failed call still counts: no retry storm
    const call = this.run(suggestionPrompt(list, ctx)).then(parseStarters);
    this.inflight.set(key, call);
    try {
      return { starters: await call };
    } finally {
      this.inflight.delete(key);
    }
  }
}
