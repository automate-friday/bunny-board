// A small streaming tar.gz writer and reader for board backups (ustar with PAX path/size
// records), so a backup made on macOS restores on Linux with no dependence on the host's
// tar flavour (bsdtar's AppleDouble ._ files, xattrs, GNU long-name extensions).
// Regular files and directories only; the reader refuses links, devices, absolute paths
// and any path that would leave the destination directory.

import { createReadStream, createWriteStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

const BLOCK = 512;
const MAX_OCTAL_SIZE = 0o77777777777; // 11 octal digits: 8 GiB - 1

export interface TarEntry {
  name: string; // POSIX relative path
  mode: number;
  mtime: number; // ms since epoch
  size: number;
  // The bytes: yields exactly `size` bytes in total.
  body: () => AsyncIterable<Buffer>;
}

function octal(n: number, width: number): string {
  return `${n.toString(8).padStart(width - 1, "0")}\0`;
}

function header(name: string, size: number, mode: number, mtime: number, type: string): Buffer {
  const b = Buffer.alloc(BLOCK, 0);
  b.write(name, 0, 100, "utf8");
  b.write(octal(mode & 0o7777, 8), 100, "ascii");
  b.write(octal(0, 8), 108, "ascii");
  b.write(octal(0, 8), 116, "ascii");
  b.write(octal(Math.min(size, MAX_OCTAL_SIZE), 12), 124, "ascii");
  b.write(octal(Math.floor(mtime / 1000), 12), 136, "ascii");
  b.write("        ", 148, "ascii");
  b.write(type, 156, "ascii");
  b.write("ustar\0", 257, "ascii");
  b.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of b) sum += byte;
  b.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return b;
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (Buffer.byteLength(`${len}${body}`) !== len) len = Buffer.byteLength(`${len}${body}`);
  return `${len}${body}`;
}

const pad = (size: number) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK, 0);

async function* tarStream(entries: AsyncIterable<TarEntry> | Iterable<TarEntry>): AsyncGenerator<Buffer> {
  for await (const e of entries) {
    const long = Buffer.byteLength(e.name) > 100 || /[^\x20-\x7e]/.test(e.name);
    if (long || e.size > MAX_OCTAL_SIZE) {
      const pax = Buffer.from((long ? paxRecord("path", e.name) : "") + (e.size > MAX_OCTAL_SIZE ? paxRecord("size", String(e.size)) : ""), "utf8");
      yield header("PaxHeader/entry", pax.length, 0o644, e.mtime, "x");
      yield pax;
      yield pad(pax.length);
    }
    yield header(long ? e.name.replace(/[^\x20-\x7e]/g, "_").slice(-99) : e.name, e.size, e.mode, e.mtime, "0");
    let written = 0;
    for await (const chunk of e.body()) {
      written += chunk.length;
      if (written > e.size) throw new Error(`tar: ${e.name} produced more than its ${e.size} bytes`);
      yield chunk;
    }
    if (written !== e.size) throw new Error(`tar: ${e.name} produced ${written} of its ${e.size} bytes`);
    yield pad(e.size);
  }
  yield Buffer.alloc(BLOCK * 2, 0);
}

// Writes the entries as a gzipped tar to `file` (created with `mode`).
export async function writeTarGz(file: string, entries: AsyncIterable<TarEntry> | Iterable<TarEntry>, mode = 0o600): Promise<void> {
  await pipeline(Readable.from(tarStream(entries)), createGzip({ level: 6 }), createWriteStream(file, { mode }));
}

// A relative path inside the archive, normalized; null when it is not one we accept.
export function safeEntryPath(name: string): string | null {
  if (!name || name.includes("\0") || name.includes("\\")) return null;
  if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) return null;
  const parts = name.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0 || parts.some((p) => p === "..")) return null;
  return parts.join("/");
}

function parseOctal(b: Buffer, off: number, len: number): number {
  const s = b.toString("ascii", off, off + len).replace(/\0.*$/, "").trim();
  return s ? Number.parseInt(s, 8) : 0;
}

function parsePax(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i);
    if (sp < 0) break;
    const len = Number(buf.toString("ascii", i, sp));
    if (!Number.isFinite(len) || len <= 0) break;
    const rec = buf.toString("utf8", sp + 1, i + len - 1);
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

export interface ExtractedFile {
  path: string;
  size: number;
  mode: number;
}

// Extracts a tar.gz into `dest` (which must exist). Returns the regular files written.
// Throws on anything that is not a regular file or directory, on unsafe paths and on a
// truncated or corrupt archive.
export async function extractTarGz(file: string, dest: string): Promise<ExtractedFile[]> {
  const root = path.resolve(dest);
  const files: ExtractedFile[] = [];
  const seen = new Set<string>();
  let buf: Buffer = Buffer.alloc(0);
  let ended = false;
  let pax: Record<string, string> = {};
  // Current body: remaining bytes, padding to skip, and where it goes.
  let body: { left: number; pad: number; fh: fsp.FileHandle | null; collect: Buffer[] | null } | null = null;

  async function consume(source: AsyncIterable<Buffer>) {
    for await (const chunk of source) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (ended) {
          buf = Buffer.alloc(0);
          break;
        }
        if (body) {
          if (body.left > 0) {
            if (!buf.length) break;
            const n = Math.min(body.left, buf.length);
            const part = buf.subarray(0, n);
            if (body.fh) await body.fh.write(part);
            else body.collect?.push(Buffer.from(part));
            buf = buf.subarray(n);
            body.left -= n;
            if (body.left > 0) break;
          }
          if (buf.length < body.pad) break;
          buf = buf.subarray(body.pad);
          const done = body;
          body = null;
          if (done.fh) await done.fh.close();
          if (done.collect) pax = { ...pax, ...parsePax(Buffer.concat(done.collect)) };
          continue;
        }
        if (buf.length < BLOCK) break;
        const h = buf.subarray(0, BLOCK);
        buf = buf.subarray(BLOCK);
        if (h.every((x) => x === 0)) {
          ended = true;
          continue;
        }
        let sum = 0;
        for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
        if (sum !== parseOctal(h, 148, 8)) throw new Error("tar: header checksum mismatch (corrupt archive)");
        const type = String.fromCharCode(h[156] || 48);
        let size = parseOctal(h, 124, 12);
        if (pax.size) size = Number(pax.size);
        const padLen = (BLOCK - (size % BLOCK)) % BLOCK;
        if (type === "x" || type === "g") {
          if (size > 1 << 20) throw new Error("tar: oversized PAX header");
          body = { left: size, pad: padLen, fh: null, collect: type === "x" ? [] : null };
          if (type === "g") body.collect = null;
          continue;
        }
        const prefix = h.toString("utf8", 345, 500).replace(/\0.*$/s, "");
        const raw = pax.path ?? (prefix ? `${prefix}/` : "") + h.toString("utf8", 0, 100).replace(/\0.*$/s, "");
        const mode = parseOctal(h, 100, 8);
        pax = {};
        const rel = safeEntryPath(raw);
        if (!rel) throw new Error(`tar: refusing unsafe path ${JSON.stringify(raw)}`);
        const target = path.join(root, ...rel.split("/"));
        if (!target.startsWith(root + path.sep)) throw new Error(`tar: refusing path outside the destination: ${raw}`);
        if (type === "5") {
          await fsp.mkdir(target, { recursive: true });
          continue;
        }
        if (type !== "0") throw new Error(`tar: refusing entry type ${JSON.stringify(type)} for ${raw} (only regular files and directories)`);
        if (seen.has(rel)) throw new Error(`tar: duplicate entry ${rel}`);
        seen.add(rel);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        const fh = await fsp.open(target, "wx", 0o600);
        files.push({ path: rel, size, mode: mode & 0o777 });
        body = { left: size, pad: padLen, fh, collect: null };
      }
    }
    if (body || !ended) {
      await body?.fh?.close();
      throw new Error("tar: archive is truncated");
    }
  }

  // The first error from consume, not the AbortError the pipeline reports after it.
  let failure: unknown = null;
  const guarded = async (source: AsyncIterable<Buffer>) => {
    try {
      await consume(source);
    } catch (e) {
      failure = e;
      await body?.fh?.close().catch(() => {});
      throw e;
    }
  };
  try {
    await pipeline(createReadStream(file), createGunzip(), guarded);
  } catch (e) {
    throw failure ?? e;
  }
  return files;
}
