import { bunnyEnv } from "./bunny-env";
// Running provider subagents per parent agent.
//
// A Claude agent can end its turn while a background Task subagent keeps working.
// Paseo then reports the parent idle, so its frame turned green and looked finished.
// The daemon still tracks the child (agent.provider_subagents.*); this keeps a count of
// the children it reports running, so the board can show "working · 1 subagent" while
// the parent's own status (which gates prompts and delta delivery) stays idle.
//
// Pushes are not relied on: a parent is re-listed on turn events, when its card or
// frame is first watched, on any upsert the daemon does send, and every POLL_MS while
// it still has a running child.

import type { PaseoBridge } from "./paseo-bridge";

// ponytail: pushes are only hints, so this poll is what clears a missed 'remove'; it
// runs only while a parent has a running child.
const POLL_MS = 5000;
// ponytail: 6 failures (~30 s) rides out a daemon restart; past that a stale "working"
// is worse than showing none.
const MAX_FAILURES = 6;

export class SubagentTracker {
  private readonly counts = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inflight = new Set<string>();
  private readonly again = new Set<string>();
  private readonly failures = new Map<string, number>();
  private offRaw: (() => void) | null = null;
  private stopped = false;

  constructor(
    private readonly bridge: PaseoBridge,
    private readonly onChange: (agentId: string, running: number) => void,
    private readonly log: (m: string) => void,
    private readonly visible:(agentId:string)=>boolean=()=>true,
    private readonly remoteHost:(agentId:string)=>string|null=()=>null,
  ) {}

  // Listen for the upserts the daemon pushes (a hint only; check() re-lists).
  attach(): void {
    if (this.offRaw || !this.bridge.aux) return;
    this.offRaw = this.bridge.aux.subscribeRawMessages((m) => {
      // biome-ignore lint/suspicious/noExplicitAny: wide wire union.
      const p = (m as any).type === "agent.provider_subagents.update" ? (m as any).payload : null;
      const parent = p?.kind === "upsert" ? p.subagent?.parentAgentId : p?.kind === "remove" ? p.parentAgentId : null;
      if (typeof parent === "string") this.check(parent);
    });
  }

  running(agentId: string): number {
    return this.counts.get(agentId) ?? 0;
  }

  check(agentId: string): void {
    if (this.stopped || !agentId || this.remoteHost(agentId) || !this.visible(agentId)) return;
    if (this.inflight.has(agentId)) {
      this.again.add(agentId);
      return;
    }
    this.inflight.add(agentId);
    void this.list(agentId).finally(() => {
      this.inflight.delete(agentId);
      if (this.again.delete(agentId)) this.check(agentId);
    });
  }

  private async list(agentId: string): Promise<void> {
    const prev = this.counts.get(agentId) ?? 0;
    let n = 0;
    try {
      const aux = this.bridge.aux;
      if (!aux?.isConnected) throw new Error("daemon connection not ready");
      const r = await aux.listProviderSubagents(agentId);
      // ponytail: a display-only count; nothing gates prompts or deltas on it.
      n = (r.subagents ?? []).filter((s) => s.status === "running").length;
      this.failures.delete(agentId);
    } catch (e) {
      if (bunnyEnv("DEBUG")) this.log(`subagents ${agentId.slice(0, 8)}: ${(e as Error).message}`);
      // A daemon blip must not flip a working frame to idle: keep the count and retry.
      // Remote, archived or non-Claude agents (never counted) just read as none.
      const f = (this.failures.get(agentId) ?? 0) + 1;
      if (prev > 0 && f < MAX_FAILURES) {
        this.failures.set(agentId, f);
        n = prev;
      } else this.failures.delete(agentId);
    }
    if (this.stopped) return;
    if (prev !== n) {
      if (n) this.counts.set(agentId, n);
      else this.counts.delete(agentId);
      this.onChange(agentId, n);
    }
    const t = this.timers.get(agentId);
    if (t) clearTimeout(t);
    this.timers.delete(agentId);
    if (n > 0 && this.visible(agentId)) {
      const next = setTimeout(() => {
        this.timers.delete(agentId);
        this.check(agentId);
      }, POLL_MS);
      (next as unknown as { unref?: () => void }).unref?.();
      this.timers.set(agentId, next);
    }
  }

  // After a daemon reconnect: pushes may have been missed, so re-list.
  // ponytail: bound agents plus any still counting; a watched card at 0 waits for its next
  // turn event or poll.
  recheck(agentIds: Iterable<string>): void {
    for (const id of new Set([...agentIds, ...this.counts.keys()])) this.check(id);
  }

  unwatch(agentId:string):void {const timer=this.timers.get(agentId);if(timer)clearTimeout(timer);this.timers.delete(agentId);this.again.delete(agentId);}

  stop(): void {
    this.stopped = true;
    this.offRaw?.();
    this.offRaw = null;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
