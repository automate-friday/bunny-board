// Phone sheets that must stay on screen (start, rename, Tell Bunny, agent settings, message
// menu, model picker, the "where is it" reveal) hold this while open, and the landscape
// immersive whiteboard (Immersive.tsx), which hides the shell's chrome, steps aside for them.

import { useEffect, useSyncExternalStore } from "react";

let open = 0;
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };

export function useModalHold(on = true) {
  useEffect(() => {
    if (!on) return;
    open++;
    notify();
    return () => {
      open--;
      notify();
    };
  }, [on]);
}

export function useModalOpen(): boolean {
  return useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => open > 0);
}
