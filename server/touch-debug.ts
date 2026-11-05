// Touch traces from real phones (canvas ?touchdebug=1, canvas/src/mobile/touchTrace.ts): the
// tab POSTs batches of the pointer / touch / iOS gesture events it saw to
// /api/ui/debug/touch, and they are appended, one JSON line per event, to
// <state>/touch-debug/<YYYY-MM-DD>.jsonl (UTC date). GET /api/ui/debug/touch?date=YYYY-MM-DD&tail=N
// reads the last lines back. Bounded: a request body is at most maxBodyBytes, a batch at most
// maxEvents, every field clamped or truncated on the way in, and a day's file stops growing at
// maxFileBytes (a final "capped" line says so).

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const TOUCH_DEBUG = {
  maxBodyBytes: 256 * 1024,
  maxEvents: 600,
  maxFileBytes: 20 * 1024 * 1024,
  maxTail: 2000,
};

const num = (v: unknown, lo = -1e7, hi = 1e7): number | undefined => {
  const n = typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n * 100) / 100)) : undefined;
};
const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v ? v.slice(0, max) : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const clean = <T extends Record<string, unknown>>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

export type TouchEventLine = Record<string, unknown>;

// Accepts an untrusted batch; returns the lines to append (the batch header on each), or null.
export function sanitizeTouchBatch(body: unknown, at: number): TouchEventLine[] | null {
  const b = obj(body);
  const session = str(b.session, 40)?.replace(/[^\w-]/g, "");
  if (!session) return null;
  const head = clean({
    at: new Date(at).toISOString(),
    session,
    board: str(b.board, 80),
    ua: str(b.ua, 240),
    vw: num(b.vw, 0, 10000),
    vh: num(b.vh, 0, 10000),
    dpr: num(b.dpr, 0, 10),
    build: str(b.build, 40),
  });
  const out: TouchEventLine[] = [];
  for (const raw of arr(b.events).slice(0, TOUCH_DEBUG.maxEvents)) {
    const e = obj(raw);
    const type = str(e.type, 24);
    if (!type) continue;
    const state = obj(e.state);
    out.push(
      clean({
        ...head,
        t: num(e.t, 0, 1e9),
        type,
        pt: str(e.pt, 8),
        id: num(e.id, -1e6, 1e6),
        primary: bool(e.primary),
        x: num(e.x),
        y: num(e.y),
        touches: num(e.touches, 0, 20),
        changed: arr(e.changed).slice(0, 5).map((c) => clean({ id: num(obj(c).id, -1e6, 1e6), x: num(obj(c).x), y: num(obj(c).y) })),
        target: str(e.target, 120),
        prevented: bool(e.prevented),
        cancelable: bool(e.cancelable),
        scale: num(e.scale, 0, 100),
        rotation: num(e.rotation, -1000, 1000),
        note: str(e.note, 200),
        state: Object.keys(state).length ? clean({ held: str(state.held, 60), mode: str(state.mode, 12), tool: str(state.tool, 20), dragging: bool(state.dragging), sheet: str(state.sheet, 12), zoom: num(state.zoom, 0, 100) }) : undefined,
      }),
    );
  }
  return out;
}

export const touchDebugFile = (stateDir: string, at: number) => path.join(stateDir, "touch-debug", `${new Date(at).toISOString().slice(0, 10)}.jsonl`);

// Appends the lines to today's file, up to maxFileBytes. Returns how many were written.
export function appendTouchLines(stateDir: string, lines: TouchEventLine[], at: number, maxFileBytes = TOUCH_DEBUG.maxFileBytes): { written: number; capped: boolean; file: string } {
  const file = touchDebugFile(stateDir, at);
  mkdirSync(path.dirname(file), { recursive: true });
  let size = existsSync(file) ? statSync(file).size : 0;
  if (size >= maxFileBytes) return { written: 0, capped: true, file };
  let text = "";
  let written = 0;
  let capped = false;
  for (const l of lines) {
    const s = `${JSON.stringify(l)}\n`;
    if (size + text.length + s.length > maxFileBytes) {
      capped = true;
      text += `${JSON.stringify({ at: new Date(at).toISOString(), type: "capped", note: `file reached ${maxFileBytes} bytes; later events dropped` })}\n`;
      break;
    }
    text += s;
    written++;
  }
  if (text) appendFileSync(file, text);
  size += text.length;
  return { written, capped, file };
}

// The last `tail` lines of a day's file, parsed.
export function readTouchLines(stateDir: string, date: string, tail: number): TouchEventLine[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
  const file = path.join(stateDir, "touch-debug", `${date}.jsonl`);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  return lines.slice(-Math.max(1, Math.min(TOUCH_DEBUG.maxTail, tail))).flatMap((l) => {
    try {
      return [JSON.parse(l) as TouchEventLine];
    } catch {
      return [];
    }
  });
}
