// Downscaled copies of board images, for phones (GET /api/assets/<file>?w=<px>).
//
// A phone screenshot is 1320x2868: ~15 MB once decoded, whatever size it is drawn at, and
// a frame of a dozen of them took a phone tab to ~600 MB (bench/phone.ts --images) until iOS
// killed it and the page reloaded. The canvas asks for the width it will draw
// (shared/image-variants.ts); this serves the nearest variant width at or above it, made
// once per image and kept in <assetsDir>/variants.
//
// PNG is decoded with node:zlib, JPEG with jpeg-js (EXIF orientation applied, since the copy
// drops the EXIF block). Anything else, interlaced PNGs and images already that small are
// served as they are (null here).
//
// The work (~0.1-0.4 s per screenshot, longer for a camera JPEG) runs in a worker thread, so the
// board server's event loop (sync, the API) never waits on it: the server bundle (core.cjs) is
// loaded again as the worker, one job at a time, and the worker stops after 30 s idle. Only
// the width asked for is made; the worker keeps the last decoded image for the next width.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { deflateSync, inflateSync } from "node:zlib";
import { decode as decodeJpeg, encode as encodeJpeg } from "jpeg-js";

import { VARIANT_WIDTHS } from "../shared/image-variants";

export { VARIANT_WIDTHS };

export type Rgba = { w: number; h: number; data: Uint8Array };

// --------------------------------------------------------------------------- PNG ---------

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function decodePng(buf: Buffer): Rgba | null {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  let o = 8;
  let w = 0, h = 0, depth = 0, type = 0, interlace = 0;
  let palette: Buffer | null = null, trns: Buffer | null = null;
  const idat: Buffer[] = [];
  while (o + 8 <= buf.length) {
    const len = buf.readUInt32BE(o);
    const kind = buf.toString("latin1", o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (kind === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      type = data[9];
      interlace = data[12];
    } else if (kind === "PLTE") palette = data;
    else if (kind === "tRNS") trns = data;
    else if (kind === "IDAT") idat.push(data);
    else if (kind === "IEND") break;
    o += 12 + len;
  }
  if (!w || !h || interlace !== 0 || ![1, 2, 4, 8, 16].includes(depth)) return null;
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type];
  if (!channels || (type === 3 && !palette)) return null;
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = Math.max(1, (channels * depth) >> 3); // bytes per pixel for filtering
  const stride = (w * channels * depth + 7) >> 3;
  if (raw.length < (stride + 1) * h) return null;
  const out = new Uint8Array(w * h * 4);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
    // Samples to RGBA8.
    const sample = (i: number): number => {
      if (depth === 8) return cur[i];
      if (depth === 16) return cur[i * 2];
      const bit = i * depth, byte = cur[bit >> 3], shift = 8 - depth - (bit & 7);
      return (byte >> shift) & ((1 << depth) - 1);
    };
    const scale = depth < 8 && type !== 3 ? 255 / ((1 << depth) - 1) : 1;
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      if (type === 3) {
        const idx = sample(x);
        out[p] = palette![idx * 3];
        out[p + 1] = palette![idx * 3 + 1];
        out[p + 2] = palette![idx * 3 + 2];
        out[p + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else if (type === 0 || type === 4) {
        const g = Math.round(sample(x * channels) * scale);
        out[p] = out[p + 1] = out[p + 2] = g;
        out[p + 3] = type === 4 ? sample(x * channels + 1) : 255;
      } else {
        out[p] = sample(x * channels);
        out[p + 1] = sample(x * channels + 1);
        out[p + 2] = sample(x * channels + 2);
        out[p + 3] = type === 6 ? sample(x * channels + 3) : 255;
      }
    }
    [prev, cur] = [cur, prev];
  }
  return { w, h, data: out };
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(kind: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(kind, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
  return Buffer.concat([head, data, tail]);
}

// RGB when fully opaque (smaller), RGBA otherwise; the "Up" filter on every row (close to
// the best filter per row for screenshots, at a quarter of the work).
export function encodePng(img: Rgba): Buffer {
  let opaque = true;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] !== 255) { opaque = false; break; }
  const ch = opaque ? 3 : 4;
  const stride = img.w * ch;
  const raw = Buffer.alloc((stride + 1) * img.h);
  for (let y = 0; y < img.h; y++) {
    const o = y * (stride + 1);
    raw[o] = 2;
    for (let x = 0; x < img.w; x++) {
      const s = (y * img.w + x) * 4;
      for (let c = 0; c < ch; c++) raw[o + 1 + x * ch + c] = (img.data[s + c] - (y ? img.data[s - img.w * 4 + c] : 0)) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.w, 0);
  ihdr.writeUInt32BE(img.h, 4);
  ihdr[8] = 8;
  ihdr[9] = opaque ? 2 : 6;
  return Buffer.concat([PNG_SIG, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw, { level: 6 })), pngChunk("IEND", Buffer.alloc(0))]);
}

// --------------------------------------------------------------------------- JPEG --------

// EXIF orientation (1-8) from a JPEG's APP1 block; 1 when absent.
export function jpegOrientation(buf: Buffer): number {
  let o = 2;
  while (o + 4 < buf.length && buf[o] === 0xff) {
    const marker = buf[o + 1];
    const len = buf.readUInt16BE(o + 2);
    if (marker === 0xe1 && buf.toString("latin1", o + 4, o + 10) === "Exif\0\0") {
      const t = o + 10;
      const le = buf.toString("latin1", t, t + 2) === "II";
      const u16 = (p: number) => (le ? buf.readUInt16LE(p) : buf.readUInt16BE(p));
      const u32 = (p: number) => (le ? buf.readUInt32LE(p) : buf.readUInt32BE(p));
      const ifd = t + u32(t + 4);
      if (ifd + 2 > buf.length) return 1;
      const n = u16(ifd);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 12 > buf.length) break;
        if (u16(e) === 0x0112) {
          const v = u16(e + 8);
          return v >= 1 && v <= 8 ? v : 1;
        }
      }
      return 1;
    }
    if (marker === 0xda) break; // start of scan: no EXIF before the image data
    o += 2 + len;
  }
  return 1;
}

// Applies an EXIF orientation to decoded pixels.
export function orient(img: Rgba, o: number): Rgba {
  if (o <= 1 || o > 8) return img;
  const swap = o >= 5;
  const W = swap ? img.h : img.w, H = swap ? img.w : img.h;
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < img.h; y++)
    for (let x = 0; x < img.w; x++) {
      let X = x, Y = y;
      switch (o) {
        case 2: X = img.w - 1 - x; break;
        case 3: X = img.w - 1 - x; Y = img.h - 1 - y; break;
        case 4: Y = img.h - 1 - y; break;
        case 5: X = y; Y = x; break;
        case 6: X = img.h - 1 - y; Y = x; break;
        case 7: X = img.h - 1 - y; Y = img.w - 1 - x; break;
        case 8: X = y; Y = img.w - 1 - x; break;
      }
      const s = (y * img.w + x) * 4, d = (Y * W + X) * 4;
      out[d] = img.data[s];
      out[d + 1] = img.data[s + 1];
      out[d + 2] = img.data[s + 2];
      out[d + 3] = img.data[s + 3];
    }
  return { w: W, h: H, data: out };
}

// --------------------------------------------------------------------------- resize ------

// Area-average downscale to width w (aspect kept): each output pixel is the coverage-weighted
// mean of the source pixels under it, one axis at a time.
export function downscale(img: Rgba, w: number): Rgba {
  if (w >= img.w) return img;
  const h = Math.max(1, Math.round((img.h * w) / img.w));
  const pass = (src: Float32Array | Uint8Array, sw: number, sh: number, dw: number, horizontal: boolean): Float32Array => {
    const len = horizontal ? sw : sh, dlen = dw, other = horizontal ? sh : sw;
    const out = new Float32Array((horizontal ? dw * sh : sw * dw) * 4);
    const scale = len / dlen;
    for (let d = 0; d < dlen; d++) {
      const start = d * scale, end = start + scale;
      const i0 = Math.floor(start), i1 = Math.min(len, Math.ceil(end));
      for (let k = 0; k < other; k++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let i = i0; i < i1; i++) {
          const wgt = Math.min(end, i + 1) - Math.max(start, i);
          const s = (horizontal ? k * sw + i : i * sw + k) * 4;
          const al = src[s + 3] * wgt;
          r += src[s] * al;
          g += src[s + 1] * al;
          b += src[s + 2] * al;
          a += al;
        }
        const o = (horizontal ? k * dw + d : d * sw + k) * 4;
        out[o] = a ? r / a : 0;
        out[o + 1] = a ? g / a : 0;
        out[o + 2] = a ? b / a : 0;
        out[o + 3] = a / scale;
      }
    }
    return out;
  };
  const across = pass(img.data, img.w, img.h, w, true);
  const down = pass(across, w, img.h, h, false);
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < data.length; i++) data[i] = Math.max(0, Math.min(255, Math.round(down[i])));
  return { w, h, data };
}

// --------------------------------------------------------------------------- store -------

type Job = { assetsDir: string; file: string; width: number };
let lastDecoded: { key: string; img: Rgba | null } | null = null;

// Makes one variant (in the worker, or in-process where there is no worker): its path, or null
// to serve the original.
export function makeVariant({ assetsDir, file, width }: Job): string | null {
  const m = file.match(/^([a-f0-9]{32})\.(png|jpg)$/);
  if (!m) return null;
  const dir = path.join(assetsDir, "variants");
  const target = path.join(dir, `${m[1]}-w${width}.${m[2]}`);
  const none = path.join(dir, `${m[1]}.none`);
  try {
    if (existsSync(target)) return target;
    let img: Rgba | null;
    if (lastDecoded?.key === m[1]) img = lastDecoded.img;
    else {
      const src = readFileSync(path.join(assetsDir, file));
      if (m[2] === "png") img = decodePng(src);
      else {
        const j = decodeJpeg(src, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 512 });
        img = orient({ w: j.width, h: j.height, data: j.data }, jpegOrientation(src));
      }
      lastDecoded = { key: m[1], img };
    }
    mkdirSync(dir, { recursive: true });
    if (!img || img.w <= VARIANT_WIDTHS[0]) {
      writeFileSync(none, "");
      return null;
    }
    if (width >= img.w) return null;
    const small = downscale(img, width);
    const bytes = m[2] === "png" ? encodePng(small) : Buffer.from(encodeJpeg({ width: small.w, height: small.h, data: small.data }, 82).data);
    writeFileSync(`${target}.tmp`, bytes);
    renameSync(`${target}.tmp`, target);
    return target;
  } catch {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(none, "");
    } catch {}
    return null;
  }
}

// Worker side: this module loaded again (as part of core.cjs) in a worker thread.
if (!isMainThread && (workerData as { bunnyImageVariants?: boolean } | null)?.bunnyImageVariants) {
  parentPort?.on("message", (job: Job & { id: number }) => parentPort?.postMessage({ id: job.id, path: makeVariant(job) }));
}

// The worker's entry: the server bundle itself, when this runs from it.
const ENTRY = typeof __filename === "string" && /core\.cjs$/.test(__filename) ? __filename : null;
let worker: Worker | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let nextId = 0;
const waiting = new Map<number, (p: string | null) => void>();
function runInWorker(job: Job): Promise<string | null> {
  if (!ENTRY) return Promise.resolve(makeVariant(job));
  if (!worker) {
    const w = new Worker(ENTRY, { workerData: { bunnyImageVariants: true } });
    w.unref();
    w.on("message", (r: { id: number; path: string | null }) => {
      waiting.get(r.id)?.(r.path);
      waiting.delete(r.id);
    });
    const fail = () => {
      if (worker === w) worker = null;
      for (const done of waiting.values()) done(null);
      waiting.clear();
    };
    w.on("error", fail);
    w.on("exit", fail);
    worker = w;
  }
  if (idleTimer) clearTimeout(idleTimer);
  const id = ++nextId;
  const result = new Promise<string | null>((resolve) => waiting.set(id, resolve));
  worker.postMessage({ ...job, id });
  return result.finally(() => {
    if (waiting.size) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      void worker?.terminate();
      worker = null;
    }, 30_000);
    idleTimer.unref?.();
  });
}

const inflight = new Map<string, Promise<string | null>>();
let queue: Promise<unknown> = Promise.resolve();

// The path of the variant of assets/<file> at width `width` (one of VARIANT_WIDTHS), made on
// first use (one at a time, off the event loop); null to serve the original.
export function imageVariant(assetsDir: string, file: string, width: number): Promise<string | null> {
  const m = file.match(/^([a-f0-9]{32})\.(png|jpg)$/);
  if (!m || !(VARIANT_WIDTHS as readonly number[]).includes(width)) return Promise.resolve(null);
  const dir = path.join(assetsDir, "variants");
  const target = path.join(dir, `${m[1]}-w${width}.${m[2]}`);
  if (existsSync(target)) return Promise.resolve(target);
  if (existsSync(path.join(dir, `${m[1]}.none`))) return Promise.resolve(null);
  const key = `${m[1]}-${width}`;
  let job = inflight.get(key);
  if (!job) {
    job = queue.then(() => runInWorker({ assetsDir, file, width })).catch(() => null);
    queue = job;
    inflight.set(key, job);
    void job.finally(() => inflight.delete(key));
  }
  return job;
}
