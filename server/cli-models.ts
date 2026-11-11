// Claude's live model list, from the installed `claude` CLI itself, for the start form's model
// picker (shared/start-catalogue.ts withLiveModels). Paseo's own Claude catalogue is a list
// shipped inside Paseo, so a model released after that Paseo version (or after Bunny's) would
// be missing; the CLI's `initialize` control request reports the models this CLI and account
// can use right now (each alias with its resolved model id and effort levels). No prompt is
// sent and no tokens are used: the process is closed as soon as it answers. The answer is
// cached for TTL_MS and refreshed in the background; a failure keeps the last good list.
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { bunnyEnv } from "./bunny-env";

export type LiveModel = { id: string; label: string; description?: string; thinkingOptions?: Array<{ id: string; label: string }> };

const TTL_MS = 30 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 20_000;
const EFFORT_LABEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max" };

// The control response's `models` → one row per resolved model id ("opus" and "default" both
// resolve to the same model; the first wins). Pure.
export function parseClaudeInitModels(stdout: string): LiveModel[] {
  const out: LiveModel[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.includes("control_response")) continue;
    let msg: unknown;
    try { msg = JSON.parse(line); } catch { continue; }
    // biome-ignore lint/suspicious/noExplicitAny: CLI control protocol payload.
    const models = (msg as any)?.response?.response?.models;
    if (!Array.isArray(models)) continue;
    for (const m of models) {
      const id = typeof m?.resolvedModel === "string" ? m.resolvedModel.trim() : typeof m?.value === "string" && m.value.startsWith("claude-") ? m.value.trim() : "";
      if (!/^claude-[a-z0-9.[\]-]+$/i.test(id) || out.some((x) => x.id === id)) continue;
      const desc = typeof m.description === "string" ? m.description.replace(/\s+/g, " ").trim() : "";
      // "Fable 5.1 · Most capable …": the name before the first "·" is the model's own label.
      const named = desc.split("·")[0].trim().replace(/^Use the default model \(currently (.+)\)$/i, "$1").trim();
      const label = named && named.length <= 40 && !/default/i.test(named) ? named : id;
      const levels: string[] = Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.filter((l: unknown): l is string => typeof l === "string" && !!l) : [];
      out.push({ id, label, ...(desc ? { description: desc.slice(0, 300) } : {}), ...(m.supportsEffort !== false && levels.length ? { thinkingOptions: levels.map((l) => ({ id: l, label: EFFORT_LABEL[l] ?? l })) } : {}) });
    }
    break;
  }
  return out;
}

type Run = () => Promise<string>;

function runClaudeInit(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bunnyEnv("CLAUDE_BIN") ?? "claude", ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--strict-mcp-config"], { cwd: tmpdir(), stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    const done = (err?: Error) => {
      clearTimeout(timer);
      child.kill();
      if (err) reject(err);
      else resolve(out);
    };
    const timer = setTimeout(() => done(new Error("claude did not answer initialize")), TIMEOUT_MS);
    child.on("error", (e) => done(e));
    child.on("exit", () => done(out.includes("control_response") ? undefined : new Error("claude exited before answering")));
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
      if (out.length > 2_000_000) done(new Error("claude initialize answer too large"));
      else if (/"type":"control_response"[^\n]*\n/.test(out)) done();
    });
    child.stdin.end(`${JSON.stringify({ type: "control_request", request_id: "bunny-models", request: { subtype: "initialize" } })}\n`);
  });
}

export class ClaudeCliModels {
  private list: LiveModel[] | null = null;
  private at = 0;
  private failedAt = -Infinity;
  private pending: Promise<LiveModel[] | null> | null = null;
  constructor(private run: Run = runClaudeInit, private now: () => number = Date.now) {}

  // The cached list, refreshed when stale. Waits at most `waitMs` for a refresh (the picker
  // never waits long; a later open gets the fresh list).
  async models(waitMs = 1500): Promise<LiveModel[] | null> {
    const stale = !this.list ? this.now() - this.failedAt >= RETRY_MS : this.now() - this.at >= TTL_MS;
    if (stale && !this.pending) {
      this.pending = this.run()
        .then(parseClaudeInitModels)
        .then((list) => {
          if (list.length) { this.list = list; this.at = this.now(); } else this.failedAt = this.now();
          return this.list;
        })
        .catch(() => { this.failedAt = this.now(); if (this.list) this.at = this.now() - TTL_MS + RETRY_MS; return this.list; })
        .finally(() => { this.pending = null; });
    }
    if (!this.pending || waitMs <= 0) return this.list;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = await Promise.race([this.pending, new Promise<null>((r) => { timer = setTimeout(() => r(null), waitMs); })]);
    clearTimeout(timer);
    return waited ?? this.list;
  }
}
