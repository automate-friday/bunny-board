import { bunnyEnv } from "./bunny-env";
// The organizer's model: one shared `codex app-server` process for every board, started on
// first use, with a small pool of warm threads that requests reuse.
// Each request is a single structured-output turn (a decision), not a tool-calling loop:
// the server applies the returned actions itself. Measured on the original install (2026-10-29): a warm
// Luna turn on the fast tier answers in 1.6-7 s; a Paseo agent's first request took 55-133 s.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const BRAIN_MODEL = bunnyEnv("ORGANIZER_MODEL") ?? "gpt-6-luna";
// Follow-up turns (after a "look" at a big frame) need more judgement than Luna showed on
// The owner's real board (2026-11-01); they are rare, so they use a stronger model.
export const FOLLOW_UP_MODEL = bunnyEnv("ORGANIZER_FOLLOW_UP_MODEL") ?? "gpt-6.1-terra";
const TIER = bunnyEnv("ORGANIZER_TIER") ?? "fast";
const TURN_TIMEOUT_MS = 120_000;
const MAX_TURNS = 8;
const RPC_TIMEOUT_MS = 30_000;
const PRIMER_SCHEMA = { type: "object", additionalProperties: false, required: ["summary"], properties: { summary: { type: "string" } } };

// The organizer only decides; it never runs commands, edits files, or browses.
const SLIM_CONFIG = {
  "features.shell_tool": false,
  "features.apply_patch_freeform": false,
  "features.plugins": false,
  "features.apps": false,
  "features.memories": false,
  "features.skills": false,
  web_search: "disabled",
  mcp_servers: {},
};

function codexBin(): string {
  const configured = bunnyEnv("CODEX");
  if (configured) return configured;
  const local = path.join(os.homedir(), ".local", "bin", "codex");
  return existsSync(local) ? local : "codex";
}

type Msg = { id?: number; method?: string; params?: any; result?: any; error?: { message: string } };

export class OrganizerBrain {
  private proc: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 0;
  private pending = new Map<number, (m: Msg) => void>();
  private listeners = new Set<(m: Msg) => void>();

  // `opts`: the model and effort for this brain's threads (the suggestion cards use their own).
  constructor(
    private readonly instructions: string,
    private readonly log: (m: string) => void,
    private readonly opts: { model?: string; effort?: string } = {},
  ) {}

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const t0 = Date.now();
    const proc = spawn(codexBin(), ["app-server"], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    this.proc = proc;
    // A write after codex exits must not throw EPIPE into the daemon.
    proc.stdin!.on("error", () => undefined);
    let buf = "";
    proc.stdout!.setEncoding("utf8");
    proc.stdout!.on("data", (d: string) => {
      buf += d;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) this.onMessage(line);
      }
    });
    proc.stderr!.on("data", () => undefined);
    proc.on("exit", (code) => {
      this.log(`organizer brain: codex app-server exited (${code})`);
      if (this.proc === proc) this.reset(new Error(`codex app-server exited (${code})`));
    });
    proc.on("error", (e) => {
      this.log(`organizer brain: could not start codex: ${e.message}`);
      if (this.proc === proc) this.reset(e);
    });
    this.ready = (async () => {
      await this.rpc("initialize", { clientInfo: { name: "bunny-organizer", version: "0.3" }, capabilities: null });
      this.notify("initialized");
      this.up = true;
      this.log(`organizer brain: codex app-server up in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    })();
    this.ready.catch(() => this.reset(new Error("codex app-server failed to initialize")));
    return this.ready;
  }

  private reset(e: Error): void {
    this.proc = null;
    this.ready = null;
    this.up = false;
    this.pools.clear();
    for (const fn of this.pending.values()) fn({ error: { message: e.message } });
    this.pending.clear();
    for (const fn of this.listeners) fn({ method: "brain/exited", params: { message: e.message } });
  }

  private onMessage(line: string): void {
    let m: Msg;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id !== undefined && m.method === undefined) {
      this.pending.get(m.id)?.(m);
      this.pending.delete(m.id);
      return;
    }
    // A request from the server (approvals, user input): the organizer never grants any.
    if (m.id !== undefined && m.method) {
      this.write({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "the board organizer does not grant requests" } });
      return;
    }
    for (const fn of this.listeners) fn(m);
  }

  private write(obj: object): void {
    this.proc?.stdin?.write(`${JSON.stringify(obj)}\n`);
  }

  private notify(method: string, params?: object): void {
    this.write({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }

  // Every call has a deadline, so a hung codex cannot freeze the queue.
  private rpc(method: string, params: object, timeoutMs = RPC_TIMEOUT_MS): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex did not answer ${method} in ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pending.set(id, (m) => {
        clearTimeout(timer);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  // Start the process early (the popover opened); harmless if it is already up.
  warm(key: string, cwd: string): void {
    void this.start()
      .then(async () => {
        if (this.pool(key).length || this.priming.has(key)) return;
        // A thread's first turn is the slow one: spend it now, while the user types.
        this.priming.add(key);
        try {
          const t = await this.newThread(cwd);
          await this.turn(t.id, "Warm-up, not a request. Answer only {\"summary\":\"ready\"}.", PRIMER_SCHEMA);
          t.turns++;
          this.pool(key).push(t);
        } finally {
          this.priming.delete(key);
        }
      })
      .catch(() => undefined);
  }

  // Warm threads, reused one request at a time: a thread's first turn is slow (≈10-20 s
  // measured), later turns are quick. Parallel requests take separate threads. A thread is
  // retired after MAX_TURNS so the conversation (old board snapshots) stays short.
  // One pool per board: a thread's history holds that board's snapshots, so it is never
  // reused for another board.
  private pools = new Map<string, Array<{ id: string; turns: number }>>();
  private up = false;
  private priming = new Set<string>();

  private pool(key: string) {
    let p = this.pools.get(key);
    if (!p) this.pools.set(key, (p = []));
    return p;
  }

  private async newThread(cwd: string): Promise<{ id: string; turns: number }> {
    const r = await this.rpc("thread/start", {
      model: this.opts.model ?? BRAIN_MODEL,
      serviceTier: TIER,
      ephemeral: true,
      cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      baseInstructions: this.instructions,
      config: SLIM_CONFIG,
    });
    return { id: r?.thread?.id as string, turns: 0 };
  }

  // One decision. `followUp` may answer a reply with a further message in the same thread
  // (e.g. the contents of a frame the model asked to look at); it returns null when done.
  async decide(key: string, cwd: string, text: string, schema: object, followUp?: (answer: string) => string | null): Promise<string> {
    await this.start();
    const thread = this.pool(key).shift() ?? (await this.newThread(cwd));
    // A failed thread is not reused (turn() throws before it is returned to the pool).
    let answer = await this.turn(thread.id, text, schema);
    thread.turns++;
    for (let next = followUp?.(answer); next; next = followUp?.(answer)) {
      answer = await this.turn(thread.id, next, schema, FOLLOW_UP_MODEL);
      thread.turns++;
    }
    if (thread.turns < MAX_TURNS) this.pool(key).push(thread);
    return answer;
  }

  private async turn(threadId: string, text: string, schema: object, model?: string): Promise<string> {
    let last = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let fn: ((m: Msg) => void) | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (fn) this.listeners.delete(fn);
    };
    const done = new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`no answer in ${TURN_TIMEOUT_MS / 1000}s`));
      }, TURN_TIMEOUT_MS);
      fn = (m: Msg) => {
        if (m.method === "brain/exited") {
          cleanup();
          reject(new Error(m.params?.message ?? "codex exited"));
          return;
        }
        if (m.params?.threadId !== threadId) return;
        if (m.method === "item/completed" && m.params.item?.type === "agentMessage") last = m.params.item.text ?? last;
        if (m.method === "turn/completed") {
          cleanup();
          const err = m.params.turn?.error;
          if (err && !last) reject(new Error(err.message ?? "turn failed"));
          else resolve(last);
        }
      };
      this.listeners.add(fn);
    });
    // `done` may settle while turn/start is still pending (codex exits); never leave it unhandled.
    done.catch(() => undefined);
    try {
      await this.rpc("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }], outputSchema: schema, effort: this.opts.effort ?? "low", ...(model ? { model } : {}) });
    } catch (e) {
      cleanup();
      throw e;
    }
    return done;
  }

  // How ready the organizer is, for the warm/cold indicator: cold (no process), starting
  // (process booting), warming (spending a thread's slow first turn), warm (a thread is ready).
  state(key: string): "cold" | "starting" | "warming" | "warm" {
    if (!this.ready) return "cold";
    if (!this.up) return "starting";
    if (this.pool(key).length) return "warm";
    return this.priming.has(key) ? "warming" : "cold";
  }

  stop(): void {
    this.proc?.kill();
    this.reset(new Error("stopped"));
  }
}
