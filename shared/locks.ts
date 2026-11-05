// Board-wide locks, kept in the tldraw document record's meta (`meta.paseoLocks`) so
// every tab sees the same state and it survives restarts. Only the board server writes
// them (POST /api/ui/boards/:id/locks); a person's push that changes them is reverted.
//
// - layout: nothing already on the board may be moved, resized, rotated or deleted by a
//   person or an agent. Drawing new shapes still works.
// - agentsPaused: the frame watcher queues every frame's board deltas and sends none
//   until the pause ends (the sidebar reply box still sends).

export const LOCKS_KEY = "paseoLocks";
export const DOCUMENT_ID = "document:document";

export interface BoardLocks {
  layout: boolean;
  agentsPaused: boolean;
  layoutBy?: string;
  layoutAt?: number;
  pausedBy?: string;
  pausedAt?: number;
}

export const NO_LOCKS: BoardLocks = { layout: false, agentsPaused: false };

// biome-ignore lint/suspicious/noExplicitAny: document meta is untyped JSON.
export function readLocks(docMeta: any): BoardLocks {
  const l = docMeta?.[LOCKS_KEY];
  if (!l || typeof l !== "object") return NO_LOCKS;
  return {
    layout: l.layout === true,
    agentsPaused: l.agentsPaused === true,
    ...(typeof l.layoutBy === "string" ? { layoutBy: l.layoutBy } : {}),
    ...(typeof l.layoutAt === "number" ? { layoutAt: l.layoutAt } : {}),
    ...(typeof l.pausedBy === "string" ? { pausedBy: l.pausedBy } : {}),
    ...(typeof l.pausedAt === "number" ? { pausedAt: l.pausedAt } : {}),
  };
}

// biome-ignore lint/suspicious/noExplicitAny: tldraw records.
type Shape = { type?: string; x?: number; y?: number; rotation?: number; parentId?: string; props?: Record<string, any> };

// Fields that place a shape: position, rotation, parent and box size. Text that grows a
// note (growY) or an auto-sized text label (w) is content, not layout; arrows are laid
// out by their end points.
export function layoutChange(before: Shape, after: Shape): string[] {
  const out: string[] = [];
  for (const k of ["x", "y", "rotation", "parentId"] as const) if (before[k] !== after[k]) out.push(k);
  const pb = before.props ?? {};
  const pa = after.props ?? {};
  const autoText = after.type === "text" && pa.autoSize !== false;
  for (const k of ["w", "h", "scale"]) {
    if (k === "w" && autoText) continue;
    if (k in pb || k in pa) if (pb[k] !== pa[k]) out.push(`props.${k}`);
  }
  if (after.type === "arrow" || after.type === "line") {
    for (const k of ["start", "end", "points", "bend"]) if (JSON.stringify(pb[k]) !== JSON.stringify(pa[k])) out.push(`props.${k}`);
  }
  return out;
}

export function lockSummary(l: BoardLocks, human: string): string | null {
  const parts: string[] = [];
  if (l.layout) parts.push(`${human} locked the layout: nothing on the board can be moved, resized or deleted (by you or ${human}); new shapes are still allowed`);
  if (l.agentsPaused) parts.push(`${human} paused agents: board deltas are queued and sent when the pause ends`);
  return parts.length ? `Board locks: ${parts.join("; ")}.` : null;
}
