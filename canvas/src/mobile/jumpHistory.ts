// Phone shell back/forward: a stack of frame jumps, like a browser's history. Opening a frame
// pushes it (dropping anything forward of where you are); back and forward walk the stack
// one level per tap without pushing. Frames that are gone (deleted, archived, a cancelled
// start) are skipped, and the back target is never the frame you are on.

export type JumpHistory = { stack: string[]; index: number };

export const MAX_JUMPS = 30;
export const emptyHistory = (first?: string | null): JumpHistory => (first ? { stack: [first], index: 0 } : { stack: [], index: -1 });

export function currentJump(h: JumpHistory): string | null {
  return h.stack[h.index] ?? null;
}

// A jump to `id`: pushed after the current entry; opening the frame you are on changes nothing.
export function visit(h: JumpHistory, id: string, max = MAX_JUMPS): JumpHistory {
  if (currentJump(h) === id) return h;
  const stack = [...h.stack.slice(0, h.index + 1), id].slice(-max);
  return { stack, index: stack.length - 1 };
}

// The nearest entry before (dir -1) or after (dir 1) the current one that still exists and is
// not the current frame, as a stack index, or -1.
export function stepIndex(h: JumpHistory, dir: 1 | -1, exists: (id: string) => boolean = () => true): number {
  const here = currentJump(h);
  for (let i = h.index + dir; i >= 0 && i < h.stack.length; i += dir) {
    const id = h.stack[i];
    if (id !== here && exists(id)) return i;
  }
  return -1;
}

export function stepTarget(h: JumpHistory, dir: 1 | -1, exists?: (id: string) => boolean): string | null {
  const i = stepIndex(h, dir, exists);
  return i < 0 ? null : h.stack[i];
}

// Move to a stack index (back, forward, or a pick from the long-press list) without pushing.
export function goTo(h: JumpHistory, index: number): JumpHistory {
  return index < 0 || index >= h.stack.length || index === h.index ? h : { ...h, index };
}

// The long-press list: earlier jumps, most recent first, each frame once, never the current
// one. `index` is where picking it moves the history.
export function recentJumps(h: JumpHistory, exists: (id: string) => boolean = () => true, max = 8): { id: string; index: number }[] {
  const here = currentJump(h);
  const seen = new Set<string>(here ? [here] : []);
  const out: { id: string; index: number }[] = [];
  for (let i = h.index - 1; i >= 0 && out.length < max; i--) {
    const id = h.stack[i];
    if (seen.has(id) || !exists(id)) continue;
    seen.add(id);
    out.push({ id, index: i });
  }
  return out;
}

// A frame that went away for good (a cancelled start's empty frame): out of the stack, the
// position kept on the same entry where possible, no two equal entries left side by side.
export function forget(h: JumpHistory, id: string): JumpHistory {
  if (!h.stack.includes(id)) return h;
  const stack: string[] = [];
  let index = -1;
  h.stack.forEach((x, i) => {
    if (x !== id && stack[stack.length - 1] !== x) stack.push(x);
    if (i <= h.index) index = stack.length - 1;
  });
  return { stack, index: Math.min(index, stack.length - 1) };
}
