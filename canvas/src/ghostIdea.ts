// The ghost typewriter in an empty opening-message box: after GHOST_IDLE_MS with nothing
// typed, an idea types itself out as the placeholder, and a new one follows every
// GHOST_ROTATE_MS for GHOST_FOR_MS. Typing anything stops it; the form fills the box with
// `idea` on Tab (or the "Use" button). Reduced motion shows each idea whole.
import { useEffect, useRef, useState } from "react";

export const GHOST_IDLE_MS = 10_000;
export const GHOST_ROTATE_MS = 10_000;
export const GHOST_FOR_MS = 3 * 60_000;
const TYPE_MS = 28;

export function useGhostIdea(ideas: string[], empty: boolean): { text: string; idea: string | null } {
  // Read at each rotation, so new ideas (an AI answer) join without restarting the wait.
  const ideasRef = useRef(ideas);
  ideasRef.current = ideas;
  const [shown, setShown] = useState<{ idea: string; n: number } | null>(null);
  const has = ideas.length > 0;
  useEffect(() => {
    setShown(null);
    if (!empty || !has) return;
    const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    let i = 0;
    let startedAt = 0;
    let typing: ReturnType<typeof setInterval> | undefined;
    let next: ReturnType<typeof setTimeout> | undefined;
    const show = () => {
      clearInterval(typing);
      const list = ideasRef.current;
      if (!list.length || (startedAt && Date.now() - startedAt >= GHOST_FOR_MS)) return setShown(null);
      startedAt ||= Date.now();
      const idea = list[i++ % list.length];
      if (reduce) setShown({ idea, n: idea.length });
      else {
        let n = 0;
        setShown({ idea, n });
        typing = setInterval(() => {
          n = Math.min(idea.length, n + 1);
          setShown({ idea, n });
          if (n >= idea.length) clearInterval(typing);
        }, TYPE_MS);
      }
      next = setTimeout(show, GHOST_ROTATE_MS);
    };
    next = setTimeout(show, GHOST_IDLE_MS);
    return () => {
      clearTimeout(next);
      clearInterval(typing);
    };
  }, [empty, has]);
  if (!shown || !empty) return { text: "", idea: null };
  return { text: shown.idea.slice(0, shown.n) + (shown.n < shown.idea.length ? "▍" : ""), idea: shown.idea };
}

// True once `active` has held for `ms` without a break (an open, untouched form).
export function useIdle(active: boolean, ms = GHOST_IDLE_MS): boolean {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    setIdle(false);
    if (!active) return;
    const t = setTimeout(() => setIdle(true), ms);
    return () => clearTimeout(t);
  }, [active, ms]);
  return idle;
}
