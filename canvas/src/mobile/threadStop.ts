// Phone shell: the stop the next thread sheet opens at. A thread normally opens near full
// height; right after a start (MobileShell `started`) it opens at half, so the new frame
// stays in view above it. Taken once, by the Sidebar mounted for that frame.
let next: string | null = null;
export function openThreadAtHalf(frameId: string) {
  next = frameId;
}
export function takeHalfStop(frameId: string | null | undefined): boolean {
  if (!frameId || next !== frameId) return false;
  next = null;
  return true;
}
