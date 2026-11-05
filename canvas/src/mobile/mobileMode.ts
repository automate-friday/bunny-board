import { createContext, useEffect, useState } from "react";
import { phoneShapeVisibility } from "./visibility";

// True inside the phone shell (App provides it; the Overlay reads it).
export const MobileCtx = createContext(false);

// When the phone shell (MobileShell.tsx) replaces tldraw's own toolbars.
// A touch-first device (coarse primary pointer) whose short side is at most 500 CSS px:
// every iPhone in either orientation (the largest, Pro Max, is 440 x 956), not an iPad
// (the smallest, mini, is 744 wide). ?mobile=1 forces it on, ?mobile=0 off.
export const MOBILE_SHORT_SIDE = 500;

export function mobileShellWanted(env: { coarse: boolean; width: number; height: number; param: string | null }): boolean {
  if (env.param === "1") return true;
  if (env.param === "0") return false;
  return env.coarse && Math.min(env.width, env.height) <= MOBILE_SHORT_SIDE;
}

function read(): boolean {
  const param = new URLSearchParams(window.location.search).get("mobile");
  const coarse = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  return mobileShellWanted({ coarse, width: window.innerWidth, height: window.innerHeight, param });
}

// Re-evaluated on resize, orientation change and a change of primary pointer.
export function useMobileShell(): boolean {
  const [on, setOn] = useState(read);
  useEffect(() => {
    const update = () => setOn(read());
    const mq = typeof window.matchMedia === "function" ? window.matchMedia("(pointer: coarse)") : null;
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    mq?.addEventListener?.("change", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
      mq?.removeEventListener?.("change", update);
    };
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("bunny-mobile", on);
  }, [on]);
  return on;
}

// Frames that wait on the person: their agent asked for permission or a question answer.
export type ShellFrame = { id: string; agentId: string; rawStatus: string; name: string };
export function needsYou<T extends ShellFrame>(frames: readonly T[]): T[] {
  return frames.filter((f) => f.agentId && f.rawStatus === "needs-permission");
}

// The pill cycles: the frame after the one last jumped to, wrapping round.
export function nextNeedsYou(ids: readonly string[], last: string | null): string | null {
  if (!ids.length) return null;
  const i = last ? ids.indexOf(last) : -1;
  return ids[(i + 1) % ids.length];
}

// The innermost frame under a tap, preferring frames bound to an agent.
export function frameAtTap<T extends { id: string; bound: boolean; x: number; y: number; w: number; h: number }>(frames: readonly T[], p: { x: number; y: number }): T | null {
  const hits = frames.filter((f) => p.x >= f.x && p.x <= f.x + f.w && p.y >= f.y && p.y <= f.y + f.h);
  const pool = hits.some((f) => f.bound) ? hits.filter((f) => f.bound) : hits;
  return pool.reduce<T | null>((best, f) => (!best || f.w * f.h < best.w * best.h ? f : best), null);
}

// The tiles home: Pinned (in pin order; with nothing pinned, the `fallback` most recent),
// Recent (the last-interaction row, newest first) and every frame not in the Pinned grid,
// most recent first (then waiting-on-you, then agents, then by name).
export function tileSections<T extends { id: string; agentId: string; rawStatus: string; name: string }>(frames: readonly T[], pins: readonly string[], touched: ReadonlyMap<string, number>, recentMax = 10, fallback = 6): { pinned: T[]; pinnedFallback: boolean; recent: T[]; rest: T[] } {
  const byId = new Map(frames.map((f) => [f.id, f]));
  const rank = (f: T) => (f.rawStatus === "needs-permission" ? 0 : f.agentId ? 1 : 2);
  const order = (a: T, b: T) => (touched.get(b.id) ?? -Infinity) - (touched.get(a.id) ?? -Infinity) || rank(a) - rank(b) || a.name.localeCompare(b.name);
  const byRecent = frames.filter((f) => touched.has(f.id)).sort(order);
  const real = pins.map((id) => byId.get(id)).filter((f): f is T => !!f);
  const pinnedFallback = !real.length;
  const pinned = pinnedFallback ? byRecent.slice(0, fallback) : real;
  const shown = new Set(pinned.map((f) => f.id));
  const recent = byRecent.slice(0, recentMax);
  const rest = frames.filter((f) => !shown.has(f.id)).sort(order);
  return { pinned, pinnedFallback, recent, rest };
}

// Where Start agent puts a new frame: right of everything on the page, top-aligned with it.
export function newFrameSpot(boxes: readonly { x: number; y: number; w: number; h: number }[], size = { w: 960, h: 640 }, gap = 80): { x: number; y: number } {
  if (!boxes.length) return { x: 0, y: 0 };
  return { x: Math.round(Math.max(...boxes.map((b) => b.x + b.w)) + gap), y: Math.round(Math.min(...boxes.map((b) => b.y))) };
}

// "claude" → "Claude" for the tile's "Claude · mac-1" line.
export function harnessLabel(provider: string): string {
  const known: Record<string, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode", copilot: "Copilot", pi: "Pi" };
  return known[provider] ?? provider;
}

// Frame mode camera: padding and origin that fit the frame between the top bar and the bottom
// dock with a small margin. tldraw's padding is the same on both sides of an axis, so the
// origin moves the fitted frame to the middle of the band between the bars.
export function frameFit(view: { w: number; h: number }, frame: { w: number; h: number }, bars: { top: number; bottom: number }, margin = 10): { padding: { x: number; y: number }; origin: { x: number; y: number } } {
  const py = Math.max(bars.top, bars.bottom) + margin;
  // tldraw's fit zoom for this padding (baseZoom "fit-max").
  const z = Math.min((view.w - 2 * margin) / frame.w, (view.h - 2 * py) / frame.h);
  const fh = frame.h * z;
  const free = view.h - 2 * py - fh;
  const want = bars.top + (view.h - bars.top - bars.bottom - fh) / 2;
  const oy = free > 0 ? Math.min(1, Math.max(0, (want - py) / free)) : 0.5;
  return { padding: { x: margin, y: py }, origin: { x: 0.5, y: oy } };
}

// The machine an agent runs on, or "" when unknown (never the board server's own name: the
// board may run on a VPS while agents run on a Mac). A remote agent's binding names its host;
// a local agent runs where the board's Paseo daemon runs (/api/ui/info agentMachine); a
// board-env copy keeps the host its preview recorded.
export function agentHost(binding: { host?: unknown } | null | undefined, localAgentMachine: string | null | undefined): string {
  const own = typeof binding?.host === "string" ? binding.host.trim() : "";
  if (own) return own;
  return typeof localAgentMachine === "string" ? localAgentMachine.trim() : "";
}

// "Claude · mac-1", "Claude" when the machine is unknown, "agent" when both are.
export function agentLabel(harness: string, host: string, fallback = "agent"): string {
  return [harness, host].filter((s) => s && s.trim()).join(" · ") || fallback;
}

// Jump back: the frame you were on before the latest jump. Opening the frame you are already
// on changes nothing; going back swaps the two, so the pill can bounce between them.
export type Nav = { current: string | null; previous: string | null };
export function navTo(nav: Nav, id: string): Nav {
  return id === nav.current ? nav : { current: id, previous: nav.current };
}

// Quick switch: frames with an agent, most recent first.
export function recentConversations<T extends { id: string; agentId: string }>(frames: readonly T[], touched: ReadonlyMap<string, number>, max = 12): T[] {
  return frames.filter((f) => f.agentId).sort((a, b) => (touched.get(b.id) ?? -Infinity) - (touched.get(a.id) ?? -Infinity)).slice(0, max);
}

// The next (dir 1) or previous (dir -1) id in a list, wrapping; the first when `id` is absent.
export function neighbour(ids: readonly string[], id: string | null, dir: 1 | -1): string | null {
  if (!ids.length) return null;
  const i = id ? ids.indexOf(id) : -1;
  if (i < 0) return ids[0];
  return ids[(i + dir + ids.length) % ids.length];
}

// The thread sheet on a phone. With the keyboard up (the visual viewport well short of the
// window), it fills the visible viewport so the reply box sits right above the keyboard;
// otherwise it takes `ratio` of the screen and leaves room for the home indicator.
export function threadSheet(v: { height: number; top: number; innerHeight: number }, ratio: number): { top: number; height: number; keyboard: boolean } {
  const keyboard = v.innerHeight - v.height > 120;
  if (keyboard) return { top: v.top, height: v.height, keyboard };
  const height = Math.min(v.height * 0.92, Math.max(180, v.height * ratio));
  return { top: v.top + v.height - height, height, keyboard };
}

// The reply box grows with its text up to this, so the thread above always keeps room.
export function composerMaxHeight(visibleHeight: number): number {
  return Math.round(Math.min(160, Math.max(72, visibleHeight * 0.28)));
}

// The camera that fits a frame (page bounds) into the band between `top` and `bottom` (screen
// px from the top and bottom edges), centred, never above 100%. For when the open thread
// covers so much of the screen that tldraw's symmetric padding cannot express the band.
export function fitInBand(view: { w: number; h: number }, frame: { x: number; y: number; w: number; h: number }, bars: { top: number; bottom: number }, margin = 10): { x: number; y: number; z: number } {
  const band = Math.max(40, view.h - bars.top - bars.bottom);
  const z = Math.min(1, (view.w - 2 * margin) / frame.w, (band - 2 * margin) / frame.h);
  const cx = frame.x + frame.w / 2, cy = frame.y + frame.h / 2;
  return { x: view.w / 2 / z - cx, y: (bars.top + band / 2) / z - cy, z };
}

// tldraw merges camera options, so lifting the frame lock must name `constraints` (undefined
// when the board had none), or the lock would outlive the frame visit.
export function unlocked<T extends { constraints?: unknown }>(saved: T): T {
  return { ...saved, constraints: saved.constraints };
}

// Phone shell: what tldraw starts with (bench/phone.ts measured each at 4x CPU throttle).
// - The hand tool: the select tool's start state runs a hover hit test, which builds the
//   spatial index and measures every note's label on the first frame (~3 s on a 150-frame
//   board); a phone has no hover.
// - Zoom steps 0.1x to 2x: tldraw pre-renders its hatch-fill pattern for every power of two
//   up to (largest step / smallest step) at the screen's pixel ratio. 8/0.1 at DPR 3 meant
//   3072-px squares (~3.4 s); 2/0.1 needs 16x fewer pixels.
export const MOBILE_ZOOM_STEPS = [0.1, 0.25, 0.5, 1, 2];
// - getShapeVisibility: render only what the shell shows (mobile/visibility.ts).
// - hideUi: tldraw's toolbars and menus are replaced by the shell (they were hidden with CSS,
//   but still rendered and measured their overflow on every layout).
export const MOBILE_TLDRAW = { initialState: "hand", cameraOptions: { zoomSteps: MOBILE_ZOOM_STEPS }, getShapeVisibility: phoneShapeVisibility, hideUi: true } as const;
