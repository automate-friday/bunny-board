import { bunnyEnv } from "./bunny-env";
import { missingAgent, withDaemonRead } from './daemon-health';
// The import picker's view of every Paseo agent: a cached, filterable list.
//
// Listing is the slow part (the daemon pages at 200 and archived pages take seconds
// on a loaded machine), searching is not. So the list is cached and searched in
// memory: active agents for 5 s, archived ones for 60 s, served stale while a refresh
// runs (the response says `stale: true` and the picker asks again). Whether an agent
// is bound to a frame is never cached; it comes from the frame watcher per request.

import { type AgentStatus, type PaseoBridge, statusOf } from "./paseo-bridge";

export type DirectoryStatus = Exclude<AgentStatus, "missing">;

export interface DirectoryRow {
  id: string;
  title: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  provider: string;
  model: string | null;
  status: DirectoryStatus;
  // Paseo's own attention flag ("finished", "permission", "error"), or null.
  attention: string | null;
  needsAttention: boolean;
  attentionTimestamp?: string | null;
  lastActivityAt: string;
  createdAt: string | null;
  archived: boolean;
  cwd: string | null;
  // Lower-cased title + workspace name, for search.
  hay: string;
}

export interface ListQuery {
  fresh?: boolean;
  q?: string;
  // Any of: running, idle, attention. Empty = all.
  statuses?: string[];
  // Only agents in this workspace (the board's), plus agents bound on `boardId`.
  workspaceId?: string | null;
  includeBound?: boolean;
  boundBoardId?: string;
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}

export interface BoundRef {
  boardId: string;
  frameId: string;
}

export interface ListedRow extends Omit<DirectoryRow, "hay" | "cwd"> {
  bound: BoundRef | null;
}

export interface ListResult {
  rows: ListedRow[];
  total: number;
  matched: number;
  ms: number;
  cacheAgeMs: number;
  stale: boolean;
  truncated: boolean;
}

const ACTIVE_TTL_MS = 5_000;
const ARCHIVED_TTL_MS = 60_000;
const PAGE = 200;
const MAX_PAGES = 50;

interface Slot {
  rows: DirectoryRow[];
  at: number;
  inflight: Promise<void> | null;
  error: string | null;
  truncated?: boolean;
  generation?: number;
}

// biome-ignore lint/suspicious/noExplicitAny: SDK list entry.
export function toRow(entry: any): DirectoryRow {
  const a = entry.agent ?? entry;
  const status = statusOf(a);
  const project = entry.project ?? null;
  const workspaceName: string | null = project?.workspaceName ?? null;
  const last = [a.updatedAt, a.lastUserMessageAt, a.attentionTimestamp].filter(Boolean).sort().pop() ?? a.createdAt ?? new Date(0).toISOString();
  const title: string | null = a.title ?? null;
  return {
    id: a.id,
    title,
    workspaceId: a.workspaceId ?? null,
    workspaceName,
    provider: a.provider,
    model: a.model ?? null,
    status: status === "missing" ? "idle" : status,
    attention: a.requiresAttention ? (a.attentionReason ?? "attention") : null,
    needsAttention: status === "needs-permission" || status === "error" || !!a.requiresAttention,
    attentionTimestamp: a.attentionTimestamp ?? null,
    lastActivityAt: last,
    createdAt: a.createdAt ?? null,
    archived: !!a.archivedAt,
    cwd: a.cwd ?? null,
    hay: `${title ?? ""}\n${workspaceName ?? ""}`.toLowerCase(),
  };
}

// Pure filter + sort, shared by the route and the benchmark script.
export function filterRows(rows: DirectoryRow[], query: ListQuery, boundOf: (agentId: string) => BoundRef | null): { rows: ListedRow[]; matched: number } {
  const needle = (query.q ?? "").trim().toLowerCase();
  const tokens = needle.split(/\s+/).filter(Boolean);
  // A pasted agent id (or its first 6+ characters) finds that agent.
  const idPrefix = /^[0-9a-f-]{6,}$/.test(needle) ? needle : null;
  const statuses = new Set(query.statuses ?? []);
  const out: Array<ListedRow> = [];
  for (const r of rows) {
    if (r.archived && !query.includeArchived) continue;
    const bound = boundOf(r.id);
    if (bound && !query.includeBound) continue;
    if (query.boundBoardId !== undefined && bound?.boardId !== query.boundBoardId) continue;
    if (query.workspaceId !== undefined && r.workspaceId !== query.workspaceId) continue;
    if (statuses.size) {
      const ok =
        (statuses.has("running") && r.status === "running") ||
        (statuses.has("idle") && r.status === "idle" && !r.needsAttention) ||
        (statuses.has("attention") && r.needsAttention);
      if (!ok) continue;
    }
    if (tokens.length && !tokens.every((t) => r.hay.includes(t)) && !(idPrefix && r.id.startsWith(idPrefix))) continue;
    // cwd stays server-side (the picker does not need folder paths).
    const { hay: _hay, cwd: _cwd, ...rest } = r;
    out.push({ ...rest, bound });
  }
  out.sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : 0));
  const limit = Math.max(1, Math.min(1000, query.limit ?? 200));
  const offset = Number.isFinite(query.offset) ? Math.max(0, Math.floor(query.offset!)) : 0;
  return { rows: out.slice(offset, offset + limit), matched: out.length };
}

export class AgentDirectory {
  private readonly active: Slot = { rows: [], at: 0, inflight: null, error: null };
  private readonly archived: Slot = { rows: [], at: 0, inflight: null, error: null };
  fetches = 0;
  private generation = 0;

  constructor(
    private readonly bridge: PaseoBridge,
    private readonly log: (m: string) => void,
  ) {}

  // Warm both lists at boot so the first picker open is fast (archived pages are slow).
  warm(): void {
    void this.bridge.ready
      .then(() => this.refresh(this.active, false))
      .then(() => this.refresh(this.archived, true))
      .catch(() => undefined);
  }

  async list(query: ListQuery, boundOf: (agentId: string) => BoundRef | null): Promise<ListResult> {
    const stale = await this.ensure(this.active, ACTIVE_TTL_MS, false, query.fresh);
    let staleArchived = false;
    if (query.includeArchived) staleArchived = await this.ensure(this.archived, ARCHIVED_TTL_MS, true, query.fresh);
    if (this.active.generation !== this.generation || (query.includeArchived && this.archived.generation !== this.generation)) throw Object.assign(new Error('Conversation directory changed during refresh; retry.'), { status: 503 });
    const t0 = performance.now();
    const all = query.includeArchived ? [...this.active.rows, ...this.archived.rows] : this.active.rows;
    const { rows, matched } = filterRows(all, query, boundOf);
    const ms = performance.now() - t0;
    return { rows, total: all.length, matched, ms: Math.round(ms * 100) / 100, cacheAgeMs: Date.now() - this.active.at, stale: stale || staleArchived, truncated: !!this.active.truncated || (query.includeArchived === true && !!this.archived.truncated) };
  }

  // Cursor scan reads one SDK page, independent of the bounded search cache.
  async page(query:ListQuery,cursor:string|undefined,boundOf:(id:string)=>BoundRef|null){
    let native:string|undefined;
    if(cursor){
      try{if(cursor.length>8192)throw Error();const parsed=JSON.parse(Buffer.from(cursor,'base64url').toString());if(!Array.isArray(parsed)||parsed.length!==3||parsed[0]!==1||parsed[1]!==!!query.includeArchived||typeof parsed[2]!=='string'||!parsed[2])throw Error();native=parsed[2];}
      catch{throw Object.assign(Error('Invalid directory cursor or changed archive filter; restart scan'),{status:400});}
    }
    const result=await withDaemonRead(async()=>{const api=await this.bridge.ready;return api.agents.list({filter:{includeArchived:!!query.includeArchived},page:{limit:PAGE,...(native?{cursor:native}:{})}}as never);});
    const info=result.pageInfo;
    if(!info||typeof info.hasMore!=='boolean'||(info.hasMore&&(!info.nextCursor||info.nextCursor===native)))throw Object.assign(Error('Daemon returned an incomplete directory cursor; retry this page'),{status:503});
    const unique=[...new Map(result.entries.map(e=>{const row=toRow(e);return [row.id,row]as const;})).values()];
    const filtered=filterRows(unique,{...query,offset:0,limit:PAGE},boundOf);
    return {rows:filtered.rows,scanned:result.entries.length,matchedInPage:filtered.matched,hasMore:info.hasMore,nextCursor:info.hasMore?Buffer.from(JSON.stringify([1,!!query.includeArchived,info.nextCursor])).toString('base64url'):null,total:null,coverage:'one-sdk-page' as const};
  }

  // One agent, from the cache or the daemon (null when Paseo does not know it).
  async get(agentId: string): Promise<DirectoryRow | null> {
    const hit = this.active.rows.find((r) => r.id === agentId) ?? this.archived.rows.find((r) => r.id === agentId);
    if (hit && Date.now() - this.active.at < ACTIVE_TTL_MS) return hit;
    const snap = await withDaemonRead(async()=>{
      const api = await this.bridge.ready;
      return api.agents.ref(agentId).refresh().catch((e:unknown)=>{if(missingAgent(e))return null;throw e;});
    });
    if (!snap) return null;
    const row = toRow({ agent: snap.agent, project: hit ? { workspaceName: hit.workspaceName } : null });
    return row;
  }

  // Lifecycle hooks keep cached statuses current between refreshes.
  noteStatus(agentId: string, status: AgentStatus): void {
    const r = this.active.rows.find((x) => x.id === agentId);
    if (!r || status === "missing") return;
    r.status = status;
    r.lastActivityAt = new Date().toISOString();
    if (status === "needs-permission" || status === "error") r.needsAttention = true;
  }

  invalidate(): void {
    this.generation++;
    for (const slot of [this.active, this.archived]) { slot.at = 0; slot.error = null; }
  }

  stats() {
    return { active: this.active.rows.length, archived: this.archived.rows.length, activeAgeMs: Date.now() - this.active.at, fetches: this.fetches, error: this.active.error };
  }

  // Returns true when the rows served are stale (a refresh is running).
  private async ensure(slot: Slot, ttl: number, archived: boolean, fresh = false): Promise<boolean> {
    if (!fresh && slot.at && Date.now() - slot.at < ttl) return false;
    if (!fresh && slot.at) { void this.refresh(slot, archived); return true; }
    // Join one in-flight scan; if a lifecycle event invalidates its generation,
    // run one replacement scan. The shared read deadline still bounds the caller.
    await withDaemonRead(async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        await this.refresh(slot, archived);
        if (slot.error) throw Object.assign(new Error('Paseo host disconnected or slow. Could not refresh conversations; retry in a few seconds.'), { status: 503 });
        if (slot.at) return;
      }
      throw Object.assign(new Error('Conversation directory changed during refresh; retry.'), { status: 503 });
    });
    return false;
  }

  private refresh(slot: Slot, archived: boolean): Promise<void> {
    if (slot.inflight) return slot.inflight;
    slot.inflight = (async () => {
      const t0 = Date.now();
      const generation = this.generation;
      try {
        const api = await this.bridge.ready;
        const rows: DirectoryRow[] = [];
        let cursor: string | undefined;
        let truncated = false;
        const seen=new Set<string>();
        for (let i = 0; i < MAX_PAGES; i++) {
          const page = await api.agents.list({ filter: { includeArchived: archived }, page: { limit: PAGE, ...(cursor ? { cursor } : {}) } } as never);
          for (const e of page.entries) {
            const row = toRow(e);
            if (!archived || row.archived) rows.push(row);
          }
          if (!page.pageInfo || typeof page.pageInfo.hasMore!=='boolean')throw Error('Incomplete daemon directory page');
          if (!page.pageInfo.hasMore) break;
          if (!page.pageInfo.nextCursor||seen.has(page.pageInfo.nextCursor))throw Error('Daemon directory cursor missing or repeated');
          cursor = page.pageInfo.nextCursor;seen.add(cursor);
          if (i === MAX_PAGES - 1) truncated = true;
        }
        if (generation !== this.generation) return;
        slot.generation = generation;
        slot.rows = rows;
        slot.truncated = truncated;
        slot.at = Date.now();
        slot.error = null;
        this.fetches++;
        if (bunnyEnv("DEBUG")) this.log(`agent directory: ${rows.length} ${archived ? "archived" : "active"} agents in ${Date.now() - t0} ms`);
      } catch (e) {
        if (generation !== this.generation) return;
        slot.error = (e as Error).message;
        this.log(`agent directory refresh failed: ${slot.error}`);
      } finally {
        slot.inflight = null;
      }
    })();
    return slot.inflight;
  }
}
