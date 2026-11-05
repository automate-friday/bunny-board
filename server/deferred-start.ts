// Yield plugin contribution immediately; cancel startup if unloading wins the race.
export function deferredStart(start: () => void | Promise<void>, failed: (error: unknown) => void) {
  let cancelled = false;
  const task = setImmediate(() => {
    if (cancelled) return;
    Promise.resolve().then(() => { if (!cancelled) return start(); }).catch(failed);
  });
  return () => { cancelled = true; clearImmediate(task); };
}
