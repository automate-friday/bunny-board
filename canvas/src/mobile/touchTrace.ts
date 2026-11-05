// Touch trace (?touchdebug=1, phone shell): records what a real phone sends while it is used
// (pointer, touch and iOS gesture events, where they land, whether anything prevented their
// default) with the shell's state at that moment, and POSTs batches to /api/ui/debug/touch;
// the board server appends them to <state>/touch-debug/<YYYY-MM-DD>.jsonl
// (server/touch-debug.ts). The flag sticks for the tab (sessionStorage), so moving between
// frames keeps recording; ?touchdebug=0 turns it off. A small badge shows it is on.

import type { Editor } from "tldraw";
import { api } from "../api";
import { getEdit, onEdit } from "./editGestures";

const KEY = "bunny-touchdebug";
const TYPES = ["pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture", "touchstart", "touchmove", "touchend", "touchcancel", "gesturestart", "gesturechange", "gestureend", "contextmenu"];
// At most one move per pointer / touch every MOVE_MS (the rest add nothing to a trace).
const MOVE_MS = 40;
const FLUSH_MS = 2000;
const MAX_BUFFER = 1500;

export function touchTraceWanted(): boolean {
  try {
    const q = new URLSearchParams(window.location.search).get("touchdebug");
    if (q === "1") sessionStorage.setItem(KEY, "1");
    if (q === "0") sessionStorage.removeItem(KEY);
    return sessionStorage.getItem(KEY) === "1";
  } catch {
    return new URLSearchParams(window.location.search).get("touchdebug") === "1";
  }
}

type Ev = Record<string, unknown>;

const describe = (t: EventTarget | null): string => {
  if (!(t instanceof Element)) return t === window ? "window" : t === document ? "document" : "";
  const tid = t.closest("[data-testid]")?.getAttribute("data-testid");
  const cls = typeof t.className === "string" ? t.className.split(/\s+/).filter(Boolean).slice(0, 2).join(".") : "";
  return [t.tagName.toLowerCase() + (cls ? `.${cls}` : ""), tid ? `[${tid}]` : ""].join("");
};

export function installTouchTrace(editor: Editor, board: string): () => void {
  const session = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const t0 = performance.now();
  let buffer: Ev[] = [];
  const lastMove = new Map<string, number>();
  const shell = () => {
    const s = getEdit();
    return { held: s.held ?? "", mode: s.mode, tool: editor.getCurrentToolId(), dragging: s.dragging, sheet: document.querySelector('[data-testid="sidebar"][data-sheet="1"]')?.getAttribute("data-stop") ?? "", zoom: editor.getZoomLevel() };
  };
  const push = (ev: Ev) => {
    if (buffer.length >= MAX_BUFFER) buffer.shift();
    buffer.push(ev);
  };

  const record = (e: Event) => {
    const now = performance.now();
    const pe = e as PointerEvent;
    const te = e as TouchEvent;
    const ge = e as Event & { scale?: number; rotation?: number };
    const isMove = e.type === "pointermove" || e.type === "touchmove";
    if (isMove) {
      const key = `${e.type}:${"pointerId" in e ? pe.pointerId : te.changedTouches?.[0]?.identifier}`;
      if (now - (lastMove.get(key) ?? -Infinity) < MOVE_MS) return;
      lastMove.set(key, now);
    }
    const ev: Ev = { t: Math.round(now - t0), type: e.type, target: describe(e.target), cancelable: e.cancelable, state: shell() };
    if ("pointerId" in e) Object.assign(ev, { pt: pe.pointerType, id: pe.pointerId, primary: pe.isPrimary, x: pe.clientX, y: pe.clientY });
    if ("changedTouches" in e && te.changedTouches) Object.assign(ev, { touches: te.touches.length, changed: Array.from(te.changedTouches).map((c) => ({ id: c.identifier, x: c.clientX, y: c.clientY })) });
    if (e.type.startsWith("gesture")) Object.assign(ev, { scale: ge.scale, rotation: ge.rotation });
    push(ev);
    // Whether a handler prevented the default is known once the event has been dispatched.
    setTimeout(() => {
      ev.prevented = e.defaultPrevented;
    }, 0);
  };
  // The shell's own steps (picked up, mode, dropped) as lines of their own.
  let lastNote = "";
  const stopEdit = onEdit(() => {
    const s = getEdit();
    const note = `held=${s.held ?? "-"} mode=${s.mode} dragging=${s.dragging}`;
    if (note === lastNote) return;
    lastNote = note;
    push({ t: Math.round(performance.now() - t0), type: "shell", note, state: shell() });
  });

  const opts = { capture: true, passive: true } as const;
  for (const t of TYPES) window.addEventListener(t, record, opts);

  const body = () => {
    const events = buffer;
    buffer = [];
    return { session, board, ua: navigator.userAgent, vw: window.innerWidth, vh: window.innerHeight, dpr: window.devicePixelRatio, events };
  };
  const flush = () => {
    if (!buffer.length) return;
    void api("/api/ui/debug/touch", { method: "POST", body: JSON.stringify(body()) }).catch(() => undefined);
  };
  const timer = setInterval(flush, FLUSH_MS);
  const onHide = () => {
    if (!buffer.length) return;
    try {
      navigator.sendBeacon?.("/api/ui/debug/touch", new Blob([JSON.stringify(body())], { type: "application/json" }));
    } catch {
      flush();
    }
  };
  window.addEventListener("pagehide", onHide);
  push({ t: 0, type: "start", note: `touch trace on (${navigator.userAgent.slice(0, 80)})`, state: shell() });

  const badge = document.createElement("div");
  badge.setAttribute("data-testid", "touch-trace-badge");
  badge.textContent = "● touch trace";
  badge.style.cssText = "position:fixed;left:8px;bottom:calc(env(safe-area-inset-bottom) + 4px);z-index:2000;pointer-events:none;font:600 10px Inter,system-ui,sans-serif;color:#b42318;background:#fff8;padding:1px 6px;border-radius:999px";
  document.body.appendChild(badge);

  return () => {
    flush();
    clearInterval(timer);
    stopEdit();
    for (const t of TYPES) window.removeEventListener(t, record, opts);
    window.removeEventListener("pagehide", onHide);
    badge.remove();
  };
}
