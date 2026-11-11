// Live thumbnail of one frame's own canvas content for the phone tiles. A store listener
// bumps a version for every frame a changed shape sits in. A tile shows at once a vector
// sketch of the frame's shapes (their outlines from tldraw's geometry, in their colours),
// then, while visible, swaps in tldraw's own image export 600 ms after the last change (one
// at a time page-wide, only when the page is idle, cached by content; an export that fails
// or takes over 4 s keeps the sketch: frames on another page, images from an old host).
// Both show the frame's content, cropped to the tile's shape (no empty frame margin and no
// bars beside it), with its words on top at a size a phone can read (stickies, text, titles):
// at tile scale the real lettering is a few pixels high.

import { useEffect, useMemo, useRef, useState } from "react";
import { useValue, type Editor, type TLRecord, type TLShape, type TLShapeId } from "tldraw";
import { richTextPlain } from "./fuzzySearch";
import { type Box, cropBox } from "./thumbCrop";
import { contentSignature } from "./thumbnailSignature";
import { isFrameOnScreen, withFrameShown } from "./visibility";

type Versions = { of: Map<string, number>; listeners: Set<() => void> };
const perEditor = new WeakMap<Editor, Versions>();

function versions(editor: Editor): Versions {
  let v = perEditor.get(editor);
  if (v) return v;
  const made: Versions = { of: new Map(), listeners: new Set() };
  v = made;
  perEditor.set(editor, made);
  // Frames holding a shape record, walking parents in the store (or the removed record's own chain).
  const framesOf = (rec: TLRecord, out: Set<string>) => {
    let cur: TLRecord | undefined = rec;
    const seen = new Set<string>();
    while (cur && cur.typeName === "shape" && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.type === "frame") out.add(cur.id);
      cur = editor.store.get(cur.parentId as TLShapeId) as TLRecord | undefined;
    }
  };
  editor.store.listen(
    ({ changes }) => {
      const hit = new Set<string>();
      for (const r of Object.values(changes.added)) framesOf(r, hit);
      for (const [, to] of Object.values(changes.updated)) framesOf(to, hit);
      for (const r of Object.values(changes.removed)) {
        if (r.typeName !== "shape") continue;
        const parent = editor.store.get(r.parentId as TLShapeId) as TLRecord | undefined;
        if (parent) framesOf(parent, hit);
      }
      if (!hit.size) return;
      for (const id of hit) made.of.set(id, (made.of.get(id) ?? 0) + 1);
      for (const fn of made.listeners) fn();
    },
    { scope: "document" },
  );
  return made;
}

// ---- exports: idle-only, one at a time, cached by content -------------------------------
// tldraw's image export is the costly part of a tile (it copies the computed style of every
// element of the frame, cards included: 100-300 ms of main thread each at 4x CPU throttle,
// bench/phone.ts). So an export only starts when the page is idle (requestIdleCallback),
// at least 2.5 s after the first tile asked for one and 0.9 s after the last touch, scroll
// or key; one per idle slot, a second apart, so the page keeps quiet stretches. Finished images are kept by frame and content signature, in memory
// and in IndexedDB, so tiles that come back (and the next visit) show them without exporting.

let started = 0;
let lastInput = 0;
if (typeof window !== "undefined")
  for (const ev of ["pointerdown", "keydown", "wheel", "scroll", "touchmove"]) window.addEventListener(ev, () => (lastInput = performance.now()), { capture: true, passive: true });
const idle = () =>
  new Promise<void>((resolve) => {
    const ric = (window as unknown as { requestIdleCallback?: (cb: (d: { timeRemaining(): number }) => void, o?: { timeout: number }) => number }).requestIdleCallback;
    const check = () => {
      const now = performance.now();
      if (!started) started = now;
      if (now - started < 2500 || now - lastInput < 900) return void setTimeout(check, 300);
      if (ric) ric((d) => (d.timeRemaining() > 10 ? resolve() : setTimeout(check, 100)), { timeout: 3000 });
      else setTimeout(resolve, 50);
    };
    check();
  });

// In memory: at most MEMORY_CAP images (least recently used go first, and are released), so
// browsing a big board does not keep every thumbnail's bitmap alive (iOS Safari reloads a tab
// that holds too much). IndexedDB keeps the rest.
export const MEMORY_CAP = 48;
const memory = new Map<string, { sig: string; url: string }>();
function remember(key: string, sig: string, url: string) {
  const old = memory.get(key);
  memory.delete(key);
  memory.set(key, { sig, url });
  if (old && old.url !== url) setTimeout(() => URL.revokeObjectURL(old.url), 5000);
  while (memory.size > MEMORY_CAP) {
    const [k, v] = memory.entries().next().value as [string, { url: string }];
    memory.delete(k);
    setTimeout(() => URL.revokeObjectURL(v.url), 5000);
  }
}
// For the soak test (bench/phone.ts --soak): how many images are held.
(globalThis as unknown as { __thumbCache?: () => number }).__thumbCache = () => memory.size;
const DB = "bunny-phone-thumbs";
let dbp: Promise<IDBDatabase | null> | null = null;
const db = () =>
  (dbp ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("thumbs");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  }));
async function stored(key: string, sig: string): Promise<Blob | null> {
  const d = await db();
  if (!d) return null;
  return new Promise((resolve) => {
    try {
      const req = d.transaction("thumbs").objectStore("thumbs").get(key);
      req.onsuccess = () => resolve(req.result?.sig === sig ? (req.result.blob as Blob) : null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}
async function store(key: string, sig: string, blob: Blob) {
  const d = await db();
  try {
    d?.transaction("thumbs", "readwrite").objectStore("thumbs").put({ sig, blob, at: Date.now() }, key);
  } catch {
    /* storage full or blocked: the memory cache still works */
  }
}

// A frame's thumbnail in parts, one idle slot each: the frame alone, then its contents a few
// shapes at a time (in z-order), drawn onto one canvas. tldraw's export copies the computed
// style of every HTML element in it (note and text labels, cards) in one synchronous pass:
// 200-350 ms per frame at 4x CPU throttle in bench/phone.ts, a long task each. In parts each
// task copies one shape's styles. The open frame (its contents cannot be hidden from the
// screen for the frame-alone part) is exported whole.
// Shapes without HTML labels (nothing for the style copy): up to three per part; others alone.
const LIGHT = new Set(["draw", "line", "highlight", "image"]);
async function exportInParts(editor: Editor, id: TLShapeId, crop: Box, scale: number, wanted: () => boolean): Promise<Blob | null> {
  const px = 2;
  // The phone does not load every font on the page before rendering (App.tsx): this frame's.
  const fonts = new Set<Parameters<Editor["fonts"]["ensureFontIsLoaded"]>[0]>();
  for (const sid of editor.getShapeAndDescendantIds([id])) {
    const s = editor.getShape(sid);
    if (s) for (const f of editor.fonts.getShapeFontFaces(s)) fonts.add(f);
  }
  await Promise.all([...fonts].map((f) => editor.fonts.ensureFontIsLoaded(f).catch(() => undefined)));
  const fb = editor.getShapePageBounds(id);
  if (!fb) return null;
  // The crop of the frame the tile shows; parts are drawn at their place in it.
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(crop.w * scale * px));
  canvas.height = Math.max(1, Math.round(crop.h * scale * px));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = editor.user.getIsDarkMode() ? "#20242c" : "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const draw = async (blob: Blob, at: { x: number; y: number }, width: number, height: number) => {
    if (blob.size <= 200) return;
    const bmp = await createImageBitmap(blob);
    ctx.drawImage(bmp, (at.x - crop.x) * scale * px, (at.y - crop.y) * scale * px, width, height);
    bmp.close();
  };
  const done = () => new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
  if (isFrameOnScreen(id)) {
    const res = await withFrameShown(id, () => editor.toImage([id], { format: "png", scale, pixelRatio: px, background: true, padding: 0 }));
    await draw(res.blob, fb, res.width, res.height);
    return done();
  }
  const paint = async (ids: TLShapeId[], alone: boolean) => {
    const at = alone ? fb : editor.getShapesPageBounds(ids);
    if (!at?.w || !at.h) return;
    const res = await withFrameShown(id, () => editor.toImage(ids, { format: "png", scale, pixelRatio: px, background: alone, padding: 0 }), alone);
    await draw(res.blob, at, res.width, res.height);
  };
  await paint([id], true);
  const kids = editor.getSortedChildIdsForParent(id);
  for (let i = 0; i < kids.length; ) {
    const batch: TLShapeId[] = [];
    while (i < kids.length && batch.length < 3) {
      const light = LIGHT.has(editor.getShape(kids[i])?.type ?? "");
      if (!light && batch.length) break;
      batch.push(kids[i++]);
      if (!light) break;
    }
    await idle();
    if (!wanted()) return null;
    await paint(batch, false);
  }
  return done();
}

function cropOf(editor: Editor, id: string, w: number, h: number): Box | null {
  const fb = editor.getShapePageBounds(id as TLShapeId);
  if (!fb?.w || !fb.h) return null;
  const kids = editor.getSortedChildIdsForParent(id as TLShapeId);
  return cropBox(fb, kids.length ? (editor.getShapesPageBounds(kids) ?? null) : null, w, h);
}

let queue: Promise<unknown> = Promise.resolve();
// The image for a frame as it is now: from memory, IndexedDB, or (when idle) a fresh export.
function render(editor: Editor, id: string, w: number, h: number, wanted: () => boolean): Promise<string | null> {
  // Keyed by board, not the whole URL: the open frame is in the URL too (places.ts), and a key
  // per frame would export every thumbnail again. Same form as the old "?board=<id>" keys.
  const key = `?${new URLSearchParams({ board: new URLSearchParams(location.search).get("board") || "main" })}|${id}|${w}x${h}`;
  const sig = contentSignature(editor, id);
  const hit = memory.get(key);
  if (hit?.sig === sig) {
    memory.delete(key);
    memory.set(key, hit);
    return Promise.resolve(hit.url);
  }
  const next = queue
    .then(async () => {
      if (!wanted()) return null;
      const cached = await stored(key, sig);
      if (cached && wanted() && contentSignature(editor, id) === sig) {
        const url = URL.createObjectURL(cached);
        remember(key, sig, url);
        return url;
      }
      await idle();
      if (!wanted()) return null;
      const crop = cropOf(editor, id, w, h);
      if (!crop) return null;
      // tldraw exports from the current page only; elsewhere the export is blank.
      if (editor.getAncestorPageId(id as TLShapeId) !== editor.getCurrentPageId()) return null;
      const scale = Math.min(1, w / crop.w);
      const shot = exportInParts(editor, id as TLShapeId, crop, scale, wanted).then((blob) => {
        if (!blob || blob.size <= 200 || !wanted() || contentSignature(editor, id) !== sig) return null;
        const url = URL.createObjectURL(blob);
        remember(key, sig, url);
        void store(key, sig, blob);
        return url;
      });
      const url = await Promise.race([shot, new Promise<null>((r) => setTimeout(() => r(null), 15000))]);
      await new Promise((r) => setTimeout(r, 1000));
      return url;
    })
    .catch(() => null);
  queue = next;
  return next;
}

const COLORS: Record<string, string> = {
  black: "#1d1d1d", grey: "#9fa8b2", "light-violet": "#e085f4", violet: "#ae3ec9", blue: "#4465e9", "light-blue": "#4ba1f1",
  yellow: "#f1ac4b", orange: "#e16919", green: "#099268", "light-green": "#4cb05e", "light-red": "#f87777", red: "#e03131", white: "#ffffff",
};
const NOTE_FILL: Record<string, string> = { black: "#e8e8e8", grey: "#d9dde1", "light-violet": "#f2c9fa", violet: "#e0b3ea", blue: "#bccafa", "light-blue": "#b9dafb", yellow: "#fde9b6", orange: "#fbcfa7", green: "#b2e2cc", "light-green": "#c4ecc8", "light-red": "#fdd0d0", red: "#f6b8b8", white: "#ffffff" };

type Mark = { d: string; fill: string; stroke: string; width: number };
// A readable word block over a shape: its page box, its text, and its backing (a sticky's colour).
type Label = { box: Box; text: string; kind: "note" | "text" | "title"; fill?: string };
const plainOf = (props: Record<string, unknown>): string => {
  if (props.richText) return richTextPlain(props.richText);
  for (const k of ["text", "title", "name"]) if (typeof props[k] === "string" && props[k]) return props[k] as string;
  return "";
};
// The frame's shapes as SVG paths in page space (decimated), read once per version.
function sketch(editor: Editor, frameId: string): { box: Box; marks: Mark[]; labels: Label[] } | null {
  const b = editor.getShapePageBounds(frameId as TLShapeId);
  if (!b?.w || !b.h) return null;
  const marks: Mark[] = [];
  const labels: Label[] = [];
  const walk = (parent: string, depth: number) => {
    for (const childId of editor.getSortedChildIdsForParent(parent as TLShapeId)) {
      const s = editor.getShape(childId) as TLShape | undefined;
      if (!s || marks.length > 400) continue;
      try {
        const geo = editor.getShapeGeometry(s);
        const pts = editor.getShapePageTransform(s).applyToPoints(geo.vertices);
        if (pts.length < 2) continue;
        const step = Math.max(1, Math.ceil(pts.length / 80));
        const kept = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
        const d = `M${kept.map((p) => `${Math.round(p.x)} ${Math.round(p.y)}`).join("L")}${geo.isClosed ? "Z" : ""}`;
        const props = s.props as { color?: string; fill?: string };
        const color = COLORS[props.color ?? "black"] ?? "#555";
        const kind = s.type;
        if (kind === "note") marks.push({ d, fill: NOTE_FILL[props.color ?? "yellow"] ?? "light-dark(#fde9b6, hsl(43 45% 21%))", stroke: "light-dark(rgba(0,0,0,.08), color-mix(in srgb, #edf0f7 55%, transparent))", width: 2 });
        else if (kind === "frame") marks.push({ d, fill: "light-dark(rgba(255,255,255,.6), color-mix(in srgb, #20242c 60%, transparent))", stroke: "light-dark(#c9c2b8, var(--bunny-muted))", width: 2 });
        else if (kind === "text") marks.push({ d, fill: "light-dark(rgba(46,31,22,.18), color-mix(in srgb, hsl(23 35% 21%) 18%, transparent))", stroke: "none", width: 0 });
        else if (kind === "image" || kind === "video" || kind === "bookmark" || kind === "embed") marks.push({ d, fill: "light-dark(#e4ddd2, var(--bunny-raised))", stroke: "light-dark(#cfc6b8, var(--bunny-muted))", width: 2 });
        else if (!geo.isClosed) marks.push({ d, fill: "none", stroke: color, width: 4 });
        else marks.push({ d, fill: props.fill && props.fill !== "none" ? `${color}33` : "light-dark(#fff, var(--bunny-surface))", stroke: kind === "geo" || kind === "arrow" ? color : "light-dark(#d8d0c4, var(--bunny-muted))", width: 3 });
        const text = kind === "arrow" || kind === "draw" || kind === "line" || kind === "highlight" ? "" : plainOf(s.props as Record<string, unknown>).slice(0, 200);
        const at = editor.getShapePageBounds(s);
        if (text && at?.w && at.h)
          labels.push({ box: { x: at.x, y: at.y, w: at.w, h: at.h }, text, kind: kind === "note" ? "note" : kind === "text" || kind === "geo" ? "text" : "title", fill: kind === "note" ? (NOTE_FILL[props.color ?? "yellow"] ?? "#fde9b6") : undefined });
      } catch {
        /* a shape without geometry: skipped */
      }
      if (depth < 3) walk(childId, depth + 1);
    }
  };
  walk(frameId, 0);
  return { box: { x: b.x, y: b.y, w: b.w, h: b.h }, marks, labels: labels.slice(0, 60) };
}

// The words over the tile, placed in percent of the crop so they sit on their shapes in the
// image or the sketch; font in screen pixels (readable), clipped to the shape.
function Labels({ labels, crop, tileW }: { labels: Label[]; crop: Box; tileW: number }) {
  const k = tileW / crop.w;
  return (
    <span className="bm-thumb-labels">
      {labels.map((l, i) => {
        // Measure only the part inside the tile, so a shape cut by the edge does not show "St".
        const pw = (Math.min(l.box.x + l.box.w, crop.x + crop.w) - Math.max(l.box.x, crop.x)) * k;
        const ph = l.box.h * k;
        // Below ~44px a label only fits a few letters per line and splits words mid-way
        // ("Merge/d"); the coloured shape alone reads better.
        if (pw < 44 || ph < 12) return null;
        const font = Math.max(8, Math.min(12, pw / 7));
        const style = {
          left: `${((l.box.x - crop.x) / crop.w) * 100}%`,
          top: `${((l.box.y - crop.y) / crop.h) * 100}%`,
          width: `${(l.box.w / crop.w) * 100}%`,
          height: l.kind === "title" ? undefined : `${(l.box.h / crop.h) * 100}%`,
          maxHeight: `${(l.box.h / crop.h) * 100}%`,
          fontSize: font,
          background: l.fill,
          WebkitLineClamp: Math.max(1, Math.floor((ph - 4) / (font * 1.25))),
        };
        // biome-ignore lint/suspicious/noArrayIndexKey: a static drawing.
        return <span key={i} className="bm-thumb-label" data-kind={l.kind} style={style}>{l.text}</span>;
      })}
    </span>
  );
}

export function LiveThumb({ editor, id, w = 220, h = 140 }: { editor: Editor; id: string; w?: number; h?: number }) {
  const box = useRef<HTMLSpanElement>(null);
  // The tile's own size (the crop takes its shape), rounded so a pixel of layout does not re-export.
  const [size, setSize] = useState({ w, h });
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      if (r.width > 8 && r.height > 8) setSize((o) => (Math.abs(o.w - r.width) < 4 && Math.abs(o.h - r.height) < 4 ? o : { w: Math.round(r.width), h: Math.round(r.height) }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const dark = useValue("thumbnail-theme", () => editor.user.getIsDarkMode(), [editor]);
  const [image, setImage] = useState<{ url: string; dark: boolean } | null>(null);
  const url = image?.dark === dark ? image.url : null;
  const [visible, setVisible] = useState(false);
  const [version, setVersion] = useState(() => versions(editor).of.get(id) ?? 0);
  useEffect(() => {
    const v = versions(editor);
    const fn = () => setVersion(v.of.get(id) ?? 0);
    v.listeners.add(fn);
    return () => {
      v.listeners.delete(fn);
    };
  }, [editor, id]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => setVisible(entries.some((e) => e.isIntersecting)));
    io.observe(el);
    return () => io.disconnect();
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the redraw trigger.
  // Off screen for a while: let go of the image (the sketch stays the fallback; the cache
  // brings the image back when the tile returns).
  useEffect(() => {
    if (visible || !url) return;
    const t = setTimeout(() => setImage(null), 3000);
    return () => clearTimeout(t);
  }, [visible, url]);
  useEffect(() => {
    if (!visible) return;
    let live = true;
    // Images are shared through the cache (memory), so a tile never revokes one.
    const t = setTimeout(() => {
      void render(editor, id, size.w, size.h, () => live).then((next) => {
        if (live && next) setImage({ url: next, dark });
      });
    }, url ? 600 : 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [editor, id, visible, version, size.w, size.h, dark]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the redraw trigger.
  const drawn = useMemo(() => (visible ? sketch(editor, id) : null), [editor, id, visible, version, dark]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the redraw trigger.
  const crop = useMemo(() => (drawn ? cropOf(editor, id, size.w, size.h) : null), [editor, id, drawn, size.w, size.h, version]);
  return (
    <span ref={box} className="bm-thumb" data-thumb={url ? "ready" : drawn ? "sketch" : "pending"} data-thumb-theme={dark ? "dark" : "light"} data-marks={drawn?.marks.length ?? 0} data-version={version} aria-hidden="true">
      {url ? (
        <img src={url} alt="" />
      ) : drawn && crop ? (
        <svg viewBox={`${crop.x} ${crop.y} ${crop.w} ${crop.h}`} preserveAspectRatio="xMidYMin slice">
          <rect x={drawn.box.x} y={drawn.box.y} width={drawn.box.w} height={drawn.box.h} fill="light-dark(#fff, var(--bunny-surface))" />
          {drawn.marks.map((m, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a static drawing.
            <path key={i} d={m.d} fill={m.fill} stroke={m.stroke} strokeWidth={m.width} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          ))}
        </svg>
      ) : null}
      {drawn && crop && drawn.labels.length ? <Labels labels={drawn.labels} crop={crop} tileW={size.w} /> : null}
    </span>
  );
}
