// Board workspace policy. Directory registration requests no worktree, branch or
// fetch. A daemon must also support non-Git registration to bypass Git discovery;
// Paseo0.11.4 still probes directory sources (see PLAIN-WORKSPACE receipt).
import { createHash } from 'node:crypto';
import type { PaseoApi } from '@getpaseo/client';
import type { BoardConfig } from './config';
import type { BoardRoom } from './room-host';
import { ensureBoardDirectory } from './agent-context';

export interface WorkspaceSelection {
  id: string;
  mode: 'plain' | 'repo' | 'stored';
  cwd?: string;
  reason?: string;
  fallbackFrom?: string;
}
const PROVISION_MS = 60_000;
const FALLBACK_MS = 10_000;
export function workspaceDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  })]).finally(() => clearTimeout(timer));
}
export class BoardWorkspaces {
  private readonly creates = new Map<string, Promise<{ id: string }>>();
  constructor(private readonly cfg: BoardConfig) {}

  async select(api: PaseoApi, room: BoardRoom, repo: boolean, requested?: string,
    phase: (value: Record<string, unknown>) => void = () => {}, alive: () => boolean = () => true): Promise<WorkspaceSelection> {
    const started = Date.now();
    const remaining = () => Math.max(1, PROVISION_MS - (Date.now() - started));
    const doc = room.records.get('document:document');
    const stored = requested ?? doc?.meta?.bunnyWorkspaceId ?? doc?.meta?.paseoWorkspaceId;
    phase({phase:'provisioning',mode:repo?'repo':'plain',startedAt:started,workspaceId:stored});
    try {
      const list = await workspaceDeadline(api.workspaces.list(), remaining(), 'Workspace lookup');
      const entries = list.entries;
      if (stored) {
        const hit = entries.find(w => w.id === stored && !w.archivingAt && !(w as {archivedAt?: string}).archivedAt);
        if (hit) {
          const kind = (hit as {workspaceKind?: string}).workspaceKind;
          if (kind === 'worktree' || (hit as {worktreeRoot?: string}).worktreeRoot) {
            const fresh = await workspaceDeadline(api.workspaces.ref(stored).refresh(), remaining(), 'Stored worktree provisioning');
            if (!fresh || fresh.archivingAt || (fresh as {archivedAt?: string}).archivedAt) throw new Error('Stored worktree provisioning failed: workspace missing');
          }
          return { id: stored, mode: 'stored', cwd: hit.workspaceDirectory ?? hit.projectRootPath };
        }
        throw new Error('Stored workspace missing or archived: '+stored);
      }
      const cwd = repo ? this.cfg.defaultCwd : await ensureBoardDirectory(this.cfg, room.id);
      const title = repo ? (this.cfg.workspaceTitle ?? 'Board {board}').replaceAll('{board}', room.id) : `Whiteboard ${room.id}`;
      const hit = entries.find(w => !w.archivingAt && !(w as {archivedAt?: string}).archivedAt && (w.title ?? w.name) === title && (w.workspaceDirectory ?? w.projectRootPath) === cwd);
      if (hit) return { id: hit.id, mode: repo ? 'repo' : 'plain', cwd };
      if(!alive())throw new Error('Workspace setup stopped');
      const w = await workspaceDeadline(this.create(api, room.id, cwd, title, repo ? 'repo' : 'plain'), remaining(), 'Workspace provisioning');
      return { id: w.id, mode: repo ? 'repo' : 'plain', cwd };
    } catch (error) {
      if(!alive())throw new Error('Workspace setup stopped');
      const reason = (error as Error).message;
      // Never retry an uncertain create under a new identity. A plain timeout is
      // already the fallback path; retain its in-flight operation for reconciliation.
      if (!repo && !stored) {
        phase({phase:'queued',mode:'plain',reason,startedAt:started});
        throw new Error(`Plain workspace provisioning remains queued: ${reason}`);
      }
      const cwd = await ensureBoardDirectory(this.cfg, room.id);
      phase({phase:'fallback',mode:'plain',reason,fallbackFrom:stored,startedAt:started});
      let w: {id:string};
      try { w = await workspaceDeadline(this.create(api, room.id, cwd, `Whiteboard ${room.id}`, 'plain'), FALLBACK_MS, 'Plain workspace fallback'); }
      catch(fallbackError) {
        phase({phase:'queued',mode:'plain',reason:`${reason}; ${(fallbackError as Error).message}`,fallbackFrom:stored,startedAt:started});
        throw fallbackError;
      }
      return { id: w.id, mode: 'plain', cwd, reason, ...(stored ? {fallbackFrom: stored} : {}) };
    }
  }

  private create(api: PaseoApi, board: string, cwd: string, title: string, mode: 'plain'|'repo'): Promise<{id: string}> {
    const key = createHash('sha256').update(JSON.stringify([this.cfg.stateDir, board, cwd, mode])).digest('hex');
    let pending = this.creates.get(key);
    if (!pending) {
      pending = api.workspaces.create({
        workspaceId: `wks_${key.slice(0,16)}`,
        idempotencyKey: `board-workspace-v1:${key}`,
        source: {kind: 'directory', path: cwd},
        title,
      });
      // Keep unknown outcomes. Subsequent attempts await the same operation; a
      // restart reuses its persisted daemon idempotency key and workspace ID.
      this.creates.set(key, pending);
      void pending.catch(() => { if (this.creates.get(key) === pending) this.creates.delete(key); });
    }
    return pending;
  }
}
