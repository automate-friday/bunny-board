// bunny backup / verify / restore: the board state directory as one checked tarball, so a
// board can move from one server to another (docs/server-move.md).
//
// Archive layout (gzipped tar, server/backup/tar.ts):
//   state/<path>     every file of the state directory, except the excluded ones below
//   manifest.json    what was backed up: boards and record counts, sha256 and size per file,
//                    source host and version, and how the files were quiesced
//
// Each file is read from one open descriptor, exactly the size it had when opened, and
// hashed as it streams into the archive, so the manifest describes exactly the bytes in the
// archive. Every state file is replaced by rename, never rewritten in place, so an open
// descriptor holds one whole version even while the server keeps saving.

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { backupToken, FLUSH_PATH, type FlushResult } from "./flush";
import { extractTarGz, type TarEntry, writeTarGz } from "./tar";

export const FORMAT = "bunny-backup";
export const FORMAT_VERSION = 1;

// Never part of a backup. Top-level names belong to this host, not to the board:
//   server.json          where this host's server listens (rewritten at every start)
//   releases, deploy-src, deploy.log, deploy.lock, server-pending   board-deploy's working files
// and anywhere: *.tmp (a save in progress; the finished file is the one that counts).
export const EXCLUDED_TOP = ["server.json", "releases", "deploy-src", "deploy.log", "deploy.lock", "server-pending"];
const isTemp = (name: string) => name.endsWith(".tmp") || name.endsWith(".partial");
const STAGING = /^\.bunny-(restore|backup)-/;

export interface ManifestFile {
  path: string; // relative to the state directory, POSIX separators
  size: number;
  sha256: string;
  mode: number;
  mtime: string;
}

export interface BoundFrame {
  board: string;
  frameId: string;
  name: string;
  agentId: string;
  host?: string; // a remote agent (af-network) on another machine
}

export interface ManifestBoard {
  id: string;
  file: string;
  records: number;
  shapes: number;
  frames: number;
  archived: boolean;
  boundFrames: BoundFrame[];
}

export interface Manifest {
  format: typeof FORMAT;
  formatVersion: number;
  createdAt: string;
  bunny: { version: string; commit: string | null };
  source: { hostname: string; platform: string; stateDir: string; publicBase: string | null; port: number | null };
  quiesce: { via: "server" | "at-rest" | "skipped"; savedAt?: string; boards?: FlushResult["boards"]; note?: string };
  boards: ManifestBoard[];
  files: ManifestFile[];
  skipped: { path: string; reason: string }[];
  totals: { files: number; bytes: number; boards: number; records: number };
}

export class BackupError extends Error {
  constructor(message: string, readonly problems: string[] = []) {
    super(problems.length ? `${message}:\n  - ${problems.join("\n  - ")}` : message);
  }
}

export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.BUNNY_STATE || env.PASEO_BOARD_STATE || path.join(os.homedir(), ".paseo", "plugins", "board");
}

// --- reading boards ------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: snapshot JSON.
type Json = any;

const boardIdOf = (rel: string): string | null => {
  const m = /^boards\/([^/]+)\.json$/.exec(rel);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
};

export function boardStats(id: string, rel: string, text: string, archived: boolean): ManifestBoard {
  const data: Json = JSON.parse(text);
  const docs: Json[] = data?.snapshot?.documents;
  if (!Array.isArray(docs)) throw new Error(`${rel}: not a board snapshot (no snapshot.documents)`);
  let shapes = 0;
  let frames = 0;
  const boundFrames: BoundFrame[] = [];
  for (const d of docs) {
    const r = d?.state;
    if (r?.typeName !== "shape") continue;
    shapes++;
    if (r.type !== "frame") continue;
    frames++;
    const p = r.meta?.paseo;
    if (typeof p?.agentId === "string")
      boundFrames.push({ board: id, frameId: r.id, name: String(r.props?.name ?? ""), agentId: p.agentId, ...(typeof p.host === "string" ? { host: p.host } : {}) });
  }
  return { id, file: rel, records: docs.length, shapes, frames, archived, boundFrames };
}

// --- backup ----------------------------------------------------------------------------

export interface BackupOptions {
  stateDir: string;
  outFile: string; // the .tar.gz to write (a .sha256 and .manifest.json are written beside it)
  serverUrl?: string; // default: <state>/server.json's url
  flush?: "required" | "if-running" | "skip"; // default if-running
  exclude?: string[]; // extra relative paths (a directory excludes everything under it)
  bunnyRoot?: string; // checkout, for the commit in the manifest
  fetchImpl?: typeof fetch;
  log?: (m: string) => void;
}

export interface BackupResult {
  file: string;
  sha256: string;
  size: number;
  manifest: Manifest;
}

function readJson(file: string): Json | null {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function pidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Asks the running server to save everything now. Returns how the files were quiesced.
export async function quiesce(stateDir: string, opts: Pick<BackupOptions, "serverUrl" | "flush" | "fetchImpl">): Promise<Manifest["quiesce"]> {
  const mode = opts.flush ?? "if-running";
  if (mode === "skip") return { via: "skipped", note: "--no-flush: files copied as the background saves left them" };
  const info = readJson(path.join(stateDir, "server.json"));
  const url = opts.serverUrl ?? (typeof info?.url === "string" ? info.url : null);
  const secret = readFileSync(path.join(stateDir, "secret"), "utf8").trim();
  const doFetch = opts.fetchImpl ?? fetch;
  if (url) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 30_000);
      const res = await doFetch(new URL(FLUSH_PATH, url), { method: "POST", headers: { authorization: `Bearer ${backupToken(secret)}` }, signal: ac.signal }).finally(() => clearTimeout(timer));
      if (!res.ok) throw new BackupError(`the board server at ${url} refused the flush (HTTP ${res.status}: ${(await res.text()).slice(0, 200)}); a server older than bunny backup needs updating first, or pass --no-flush`);
      const body = (await res.json()) as FlushResult;
      return { via: "server", savedAt: body.savedAt, boards: body.boards };
    } catch (e) {
      if (e instanceof BackupError) throw e;
      // Not answering. A live process behind it means the files are still changing.
      if (mode === "required" || pidAlive(info?.pid))
        throw new BackupError(`could not reach the board server at ${url} to flush it (${(e as Error).message}); start it, stop it, or pass --no-flush`);
    }
  } else if (mode === "required") {
    throw new BackupError(`no server.json in ${stateDir} and no --server URL: cannot flush`);
  }
  return { via: "at-rest", note: "no board server running for this state directory" };
}

interface Found {
  rel: string;
  abs: string;
}

function walk(stateDir: string, exclude: string[]): { files: Found[]; skipped: Manifest["skipped"] } {
  const files: Found[] = [];
  const skipped: Manifest["skipped"] = [];
  const excluded = (rel: string) => exclude.some((x) => rel === x || rel.startsWith(`${x}/`));
  const visit = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      const rel = prefix ? `${prefix}/${name}` : name;
      const abs = path.join(dir, name);
      if (!prefix && (EXCLUDED_TOP.includes(name) || STAGING.test(name))) continue;
      if (isTemp(name) || excluded(rel)) continue;
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(abs);
      } catch {
        continue; // removed while walking (a rename target replaced, a temp file gone)
      }
      if (st.isSymbolicLink()) skipped.push({ path: rel, reason: "symbolic link (not followed; recreate it on the new host if needed)" });
      else if (st.isDirectory()) visit(abs, rel);
      else if (st.isFile()) files.push({ rel, abs });
      else skipped.push({ path: rel, reason: "not a regular file" });
    }
  };
  visit(stateDir, "");
  return { files, skipped };
}

function bunnyCommit(root: string | undefined): string | null {
  if (!root) return null;
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

function bunnyVersion(root: string | undefined): string {
  return (root && readJson(path.join(root, "package.json"))?.version) || "unknown";
}

export function backupName(hostname: string, at: Date): string {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const host = hostname.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "") || "host";
  return `bunny-backup-${host}-${stamp}.tar.gz`;
}

export async function sha256File(file: string): Promise<string> {
  const h = createHash("sha256");
  const fh = await fsp.open(file, "r");
  try {
    for await (const chunk of fh.createReadStream()) h.update(chunk as Buffer);
  } finally {
    await fh.close().catch(() => {});
  }
  return h.digest("hex");
}

const CHUNK = 1 << 20;

export async function createBackup(opts: BackupOptions): Promise<BackupResult> {
  const log = opts.log ?? (() => {});
  const stateDir = path.resolve(opts.stateDir);
  if (!existsSync(path.join(stateDir, "secret")) && !existsSync(path.join(stateDir, "boards")))
    throw new BackupError(`${stateDir} is not a board state directory (no secret, no boards/)`);
  const quiesced = await quiesce(stateDir, opts);
  log(`quiesce: ${quiesced.via}${quiesced.boards ? ` (${quiesced.boards.length} open board(s) saved)` : ""}`);
  const { files: found, skipped } = walk(stateDir, (opts.exclude ?? []).map((x) => x.replace(/^\.?\/+|\/+$/g, "")));
  const server = readJson(path.join(stateDir, "server.json"));
  const archivedIds = new Set(
    found.map((f) => /^boards\/\.archived\/(.+)\.marker\.json$/.exec(f.rel)?.[1]).filter((x): x is string => !!x).map((x) => decodeURIComponent(x)),
  );

  const manifestFiles: ManifestFile[] = [];
  const boards: ManifestBoard[] = [];
  const problems: string[] = [];
  const createdAt = new Date();

  async function* entries(): AsyncGenerator<TarEntry> {
    for (const f of found) {
      let fh: fsp.FileHandle;
      try {
        fh = await fsp.open(f.abs, "r");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          skipped.push({ path: f.rel, reason: "removed while the backup ran" });
          continue;
        }
        throw e;
      }
      const st = await fh.stat();
      const size = st.size;
      const hash = createHash("sha256");
      const id = boardIdOf(f.rel);
      const keep: Buffer[] | null = id ? [] : null;
      const rel = f.rel;
      yield {
        name: `state/${rel}`,
        mode: st.mode & 0o777,
        mtime: st.mtimeMs,
        size,
        body: async function* () {
          try {
            let pos = 0;
            while (pos < size) {
              const buf = Buffer.alloc(Math.min(CHUNK, size - pos));
              const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
              if (bytesRead === 0) throw new BackupError(`${rel} shrank while it was read (rewritten in place?)`);
              const part = buf.subarray(0, bytesRead);
              hash.update(part);
              keep?.push(part);
              pos += bytesRead;
              yield part;
            }
          } finally {
            await fh.close().catch(() => {});
          }
          manifestFiles.push({ path: rel, size, sha256: hash.digest("hex"), mode: st.mode & 0o777, mtime: st.mtime.toISOString() });
          if (id && keep) {
            try {
              boards.push(boardStats(id, rel, Buffer.concat(keep).toString("utf8"), archivedIds.has(id)));
            } catch (e) {
              problems.push(`${rel}: ${(e as Error).message}`);
            }
          }
        },
      };
    }
    // Written last: it describes the bytes above.
    const manifest = buildManifest();
    const json = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    yield { name: "manifest.json", mode: 0o600, mtime: createdAt.getTime(), size: json.length, body: async function* () { yield json; } };
  }

  let manifest: Manifest | null = null;
  function buildManifest(): Manifest {
    manifest = {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      createdAt: createdAt.toISOString(),
      bunny: { version: bunnyVersion(opts.bunnyRoot), commit: bunnyCommit(opts.bunnyRoot) },
      source: {
        hostname: os.hostname(),
        platform: `${process.platform}-${process.arch}`,
        stateDir,
        publicBase: typeof server?.publicBase === "string" ? server.publicBase : null,
        port: typeof server?.port === "number" ? server.port : null,
      },
      quiesce: quiesced,
      boards: boards.sort((a, b) => a.id.localeCompare(b.id)),
      files: manifestFiles,
      skipped,
      totals: {
        files: manifestFiles.length,
        bytes: manifestFiles.reduce((n, f) => n + f.size, 0),
        boards: boards.length,
        records: boards.reduce((n, b) => n + b.records, 0),
      },
    };
    return manifest;
  }

  const out = path.resolve(opts.outFile);
  await fsp.mkdir(path.dirname(out), { recursive: true });
  const partial = `${out}.partial`;
  try {
    await writeTarGz(partial, entries(), 0o600);
    if (problems.length) throw new BackupError("some board snapshots could not be read; nothing was written", problems);
    await fsp.rename(partial, out);
  } catch (e) {
    await fsp.rm(partial, { force: true });
    throw e;
  }
  chmodSync(out, 0o600);
  const sha256 = await sha256File(out);
  const size = (await fsp.stat(out)).size;
  const final = manifest as unknown as Manifest;
  await fsp.writeFile(`${out}.sha256`, `${sha256}  ${path.basename(out)}\n`, { mode: 0o600 });
  await fsp.writeFile(`${out}.manifest.json`, `${JSON.stringify(final, null, 2)}\n`, { mode: 0o600 });
  log(`wrote ${out} (${final.totals.files} files, ${final.totals.boards} boards, ${final.totals.records} records, ${size} bytes)`);
  return { file: out, sha256, size, manifest: final };
}

// --- verify ------------------------------------------------------------------------------

export interface Verified {
  manifest: Manifest;
  dir: string; // extracted tree: <dir>/state/... and <dir>/manifest.json
}

// Checks an extracted backup against its manifest: every listed file present with its size
// and sha256, nothing unlisted, board snapshots readable with the recorded record counts.
export async function checkExtracted(dir: string): Promise<Manifest> {
  const mfile = path.join(dir, "manifest.json");
  if (!existsSync(mfile)) throw new BackupError("not a bunny backup: manifest.json is missing");
  const manifest = readJson(mfile) as Manifest | null;
  if (!manifest || manifest.format !== FORMAT) throw new BackupError("not a bunny backup: manifest.json has the wrong format");
  if (manifest.formatVersion > FORMAT_VERSION) throw new BackupError(`backup format ${manifest.formatVersion} is newer than this bunny understands (${FORMAT_VERSION}); update bunny first`);
  const problems: string[] = [];
  const listed = new Set<string>();
  for (const f of manifest.files) {
    listed.add(f.path);
    const abs = path.join(dir, "state", ...f.path.split("/"));
    if (!existsSync(abs)) {
      problems.push(`${f.path}: missing from the archive`);
      continue;
    }
    const size = (await fsp.stat(abs)).size;
    if (size !== f.size) problems.push(`${f.path}: size ${size}, manifest says ${f.size}`);
    const sum = await sha256File(abs);
    if (sum !== f.sha256) problems.push(`${f.path}: sha256 ${sum.slice(0, 12)}…, manifest says ${f.sha256.slice(0, 12)}…`);
  }
  const extra: string[] = [];
  const visit = (d: string, prefix: string) => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d)) {
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = lstatSync(path.join(d, name));
      if (st.isDirectory()) visit(path.join(d, name), rel);
      else if (!listed.has(rel)) extra.push(rel);
    }
  };
  visit(path.join(dir, "state"), "");
  for (const rel of extra) problems.push(`${rel}: in the archive but not in the manifest`);
  for (const b of manifest.boards) {
    const abs = path.join(dir, "state", ...b.file.split("/"));
    if (!existsSync(abs)) continue; // reported above
    try {
      const again = boardStats(b.id, b.file, readFileSync(abs, "utf8"), b.archived);
      if (again.records !== b.records) problems.push(`board ${b.id}: ${again.records} records, manifest says ${b.records}`);
    } catch (e) {
      problems.push(`board ${b.id}: ${(e as Error).message}`);
    }
  }
  if (problems.length) throw new BackupError("backup failed verification", problems);
  return manifest;
}

export async function extractAndVerify(tarball: string, dir: string): Promise<Manifest> {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await extractTarGz(tarball, dir);
  } catch (e) {
    throw new BackupError(`could not read ${tarball}: ${(e as Error).message}`);
  }
  return checkExtracted(dir);
}

// Verifies a backup without restoring it (into a temp directory that is removed again).
export async function verifyBackup(tarball: string): Promise<Manifest> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "bunny-verify-"));
  try {
    return await extractAndVerify(tarball, dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

// --- restore -----------------------------------------------------------------------------

export interface RestoreOptions {
  tarball: string;
  stateDir: string;
  force?: boolean; // replace a non-empty state directory (it is kept, renamed aside)
  publicHost?: string; // the new host's address for config.json (default: "auto")
  keepBindings?: boolean; // the Paseo daemon's agents moved too: leave frames bound
  dryRun?: boolean;
  log?: (m: string) => void;
}

export interface RestoreReport {
  stateDir: string;
  dryRun: boolean;
  manifest: Pick<Manifest, "createdAt" | "source" | "bunny" | "totals">;
  boards: { id: string; records: number; archived: boolean }[];
  config: { changed: { key: string; from: unknown; to: unknown }[]; pathsMissing: { key: string; path: string }[] };
  unboundFrames: BoundFrame[]; // frames whose agent is on the old host: kept, unbound, offered for re-linking
  remoteFrames: BoundFrame[]; // bound to an agent on another machine (af-network): may still exist
  assetLinks: { board: string; count: number }[]; // links to the old host rewritten
  pendingPrompts: number; // prompt-outbox entries addressed to old-host agents (they will not be sent)
  modifiedFiles: string[]; // differ from the backup's checksums because of the changes above
  previousStateDir: string | null; // where --force moved the existing directory
  targetNotEmpty: boolean; // the target already had files (a real restore needs --force)
}

function nonEmpty(dir: string): boolean {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

// The frame as FrameArchive leaves a restored frame: unbound, its old agent offered for
// re-linking (canvas/src/RelinkFrame.tsx: "Restored conversation: <agent>. The frame is unbound.").
function unbindFrame(r: Json): Json {
  const p = r.meta.paseo;
  const meta = { ...r.meta };
  delete meta.paseoFlushAt;
  meta.paseo = { relink: { agentId: p.agentId, ...(typeof p.host === "string" ? { host: p.host } : {}), reason: "restored-or-copied", requiresConfirmation: true } };
  return { ...r, props: { ...r.props, color: "black" }, meta };
}

// Rewrites one board snapshot for the new host. Returns what changed (nothing: null).
function rewriteBoard(text: string, oldOrigins: Set<string>, keepBindings: boolean): { json: string; unbound: number; links: number } | null {
  const data: Json = JSON.parse(text);
  const snap = data.snapshot;
  const docs: Json[] = snap.documents;
  const clock = (Number.isSafeInteger(snap.documentClock) ? snap.documentClock : docs.reduce((n: number, d: Json) => Math.max(n, d.lastChangedClock ?? 0), 0)) + 1;
  let unbound = 0;
  let links = 0;
  // The old host's asset links become loopback links; the server's migrateAssetOrigins moves
  // loopback asset links to its own public address when it loads the board.
  const relink = (url: unknown): string | null => {
    if (typeof url !== "string") return null;
    try {
      const u = new URL(url);
      if (!u.pathname.startsWith("/api/assets/") || !oldOrigins.has(u.origin)) return null;
      return `http://127.0.0.1${u.port ? `:${u.port}` : ""}${u.pathname}${u.search}`;
    } catch {
      return null;
    }
  };
  for (const d of docs) {
    let r = d.state;
    let changed = false;
    if (!keepBindings && r?.typeName === "shape" && r.type === "frame" && typeof r.meta?.paseo?.agentId === "string") {
      r = unbindFrame(r);
      unbound++;
      changed = true;
    }
    if (r?.typeName === "asset") {
      const src = relink(r.props?.src);
      if (src) {
        r = { ...r, props: { ...r.props, src } };
        links++;
        changed = true;
      }
    } else if (r?.typeName === "shape" && r.type === "bookmark") {
      const url = relink(r.props?.url);
      if (url) {
        r = { ...r, props: { ...r.props, url } };
        links++;
        changed = true;
      }
    }
    if (changed) {
      d.state = r;
      d.lastChangedClock = clock;
    }
  }
  if (!unbound && !links) return null;
  snap.documentClock = clock;
  return { json: JSON.stringify(data), unbound, links };
}

// config.json keys that name the old host. publicHost goes back to "auto" (this machine's
// tailnet address) unless --public-host says otherwise.
const HOST_KEYS = ["publicHost", "publicBase", "paseoServerId"] as const;
const PATH_KEYS = ["defaultCwd", "canvasDir"] as const;

function rewriteConfig(text: string, publicHost: string | undefined, oldOrigins: Set<string>): { json: string; changed: RestoreReport["config"]["changed"]; paths: RestoreReport["config"]["pathsMissing"] } {
  const cfg: Json = JSON.parse(text);
  const changed: RestoreReport["config"]["changed"] = [];
  for (const k of HOST_KEYS) {
    const want = k === "publicHost" && publicHost && publicHost !== "auto" ? publicHost : undefined;
    if (cfg[k] === want || (cfg[k] === undefined && want === undefined)) continue;
    changed.push({ key: k, from: cfg[k], to: want ?? "(removed)" });
    if (want === undefined) delete cfg[k];
    else cfg[k] = want;
  }
  if (publicHost && publicHost !== "auto" && !changed.some((c) => c.key === "publicHost")) {
    cfg.publicHost = publicHost;
    changed.push({ key: "publicHost", from: undefined, to: publicHost });
  }
  if (Array.isArray(cfg.allowedOrigins)) {
    const kept = cfg.allowedOrigins.filter((o: unknown) => {
      try {
        return !oldOrigins.has(new URL(String(o)).origin);
      } catch {
        return true;
      }
    });
    if (kept.length !== cfg.allowedOrigins.length) {
      changed.push({ key: "allowedOrigins", from: cfg.allowedOrigins, to: kept });
      cfg.allowedOrigins = kept;
    }
  }
  const paths: RestoreReport["config"]["pathsMissing"] = [];
  for (const k of PATH_KEYS) if (typeof cfg[k] === "string" && !existsSync(cfg[k])) paths.push({ key: k, path: cfg[k] });
  if (typeof cfg.videoIntake?.recordingsDir === "string" && !existsSync(cfg.videoIntake.recordingsDir)) paths.push({ key: "videoIntake.recordingsDir", path: cfg.videoIntake.recordingsDir });
  if (typeof cfg.frameAgents?.boardCwdRoot === "string" && !existsSync(cfg.frameAgents.boardCwdRoot)) paths.push({ key: "frameAgents.boardCwdRoot", path: cfg.frameAgents.boardCwdRoot });
  return { json: `${JSON.stringify(cfg, null, 2)}\n`, changed, paths };
}

export async function restoreBackup(opts: RestoreOptions): Promise<RestoreReport> {
  const log = opts.log ?? (() => {});
  const target = path.resolve(opts.stateDir);
  const targetNotEmpty = nonEmpty(target);
  if (targetNotEmpty && !opts.force && !opts.dryRun)
    throw new BackupError(`${target} already holds a board state directory; stop its server and pass --force to replace it (the existing directory is kept, renamed aside)`);
  const parent = path.dirname(target);
  await fsp.mkdir(parent, { recursive: true });
  const staging = path.join(parent, `.bunny-restore-${path.basename(target)}-${randomBytes(4).toString("hex")}`);
  try {
    const manifest = await extractAndVerify(opts.tarball, staging);
    log(`verified ${manifest.totals.files} files against their checksums (backup of ${manifest.source.hostname}, ${manifest.createdAt})`);
    const state = path.join(staging, "state");
    await fsp.mkdir(state, { recursive: true, mode: 0o700 });
    const oldOrigins = new Set<string>();
    if (manifest.source.publicBase) {
      try {
        const u = new URL(manifest.source.publicBase);
        if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") oldOrigins.add(u.origin);
      } catch {}
    }
    const report: RestoreReport = {
      stateDir: target,
      dryRun: !!opts.dryRun,
      manifest: { createdAt: manifest.createdAt, source: manifest.source, bunny: manifest.bunny, totals: manifest.totals },
      boards: manifest.boards.map((b) => ({ id: b.id, records: b.records, archived: b.archived })),
      config: { changed: [], pathsMissing: [] },
      unboundFrames: [],
      remoteFrames: [],
      assetLinks: [],
      pendingPrompts: 0,
      modifiedFiles: [],
      previousStateDir: null,
      targetNotEmpty,
    };
    for (const b of manifest.boards) {
      for (const f of b.boundFrames) {
        if (f.host) report.remoteFrames.push(f);
        if (!opts.keepBindings) report.unboundFrames.push(f);
      }
      const abs = path.join(state, ...b.file.split("/"));
      const out = rewriteBoard(readFileSync(abs, "utf8"), oldOrigins, !!opts.keepBindings);
      if (!out) continue;
      if (out.links) report.assetLinks.push({ board: b.id, count: out.links });
      report.modifiedFiles.push(b.file);
      if (!opts.dryRun) await fsp.writeFile(abs, out.json);
    }
    const cfgFile = path.join(state, "config.json");
    if (existsSync(cfgFile)) {
      const c = rewriteConfig(readFileSync(cfgFile, "utf8"), opts.publicHost, oldOrigins);
      report.config = { changed: c.changed, pathsMissing: c.paths };
      if (c.changed.length) {
        report.modifiedFiles.push("config.json");
        if (!opts.dryRun) await fsp.writeFile(cfgFile, c.json, { mode: 0o600 });
      }
    } else if (opts.publicHost && opts.publicHost !== "auto") {
      report.config.changed.push({ key: "publicHost", from: undefined, to: opts.publicHost });
      report.modifiedFiles.push("config.json");
      if (!opts.dryRun) await fsp.writeFile(cfgFile, `${JSON.stringify({ publicHost: opts.publicHost }, null, 2)}\n`, { mode: 0o600 });
    }
    const outbox = path.join(state, "prompt-outbox");
    if (!opts.keepBindings && existsSync(outbox)) report.pendingPrompts = readdirSync(outbox).filter((f) => f.endsWith(".json")).length;
    if (opts.dryRun) return report;
    // File modes as backed up (the secret stays 0600), then swap the directory in.
    for (const f of manifest.files) await fsp.chmod(path.join(state, ...f.path.split("/")), f.mode & 0o777).catch(() => {});
    await fsp.writeFile(
      path.join(state, "RESTORED.json"),
      `${JSON.stringify({ restoredAt: new Date().toISOString(), restoredOn: os.hostname(), backup: report.manifest, modifiedFiles: report.modifiedFiles, unboundFrames: report.unboundFrames, config: report.config }, null, 2)}\n`,
      { mode: 0o600 },
    );
    if (existsSync(target)) {
      if (nonEmpty(target)) {
        const aside = `${target}.pre-restore-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
        await fsp.rename(target, aside);
        report.previousStateDir = aside;
        log(`moved the existing ${target} to ${aside}`);
      } else {
        await fsp.rmdir(target);
      }
    }
    await fsp.rename(state, target);
    await fsp.chmod(target, 0o700);
    return report;
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
  }
}
