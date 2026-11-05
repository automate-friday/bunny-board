// Where backups are kept. A BackupTarget stores whole backup files by name; the backup
// itself is always built locally first (bunny backup), then handed to a target. Only the
// local-directory target exists today. An object-store target (S3, R2) implements the same
// five methods with the same names, so retention and the CLI do not change; see
// docs/server-move.md, "Storage targets".

import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

export interface BackupObject {
  name: string; // e.g. bunny-backup-host-20261102T031500Z.tar.gz
  size: number;
  createdAt: string; // ISO time, from the name's stamp (else the store's modified time)
}

export interface BackupTarget {
  // For messages: "/Volumes/backup/bunny", "s3://bucket/prefix".
  readonly location: string;
  // Stores localFile under `name`, replacing nothing until it is complete. Returns its location.
  put(localFile: string, name: string): Promise<string>;
  // Backups held, oldest first.
  list(): Promise<BackupObject[]>;
  // Copies a stored backup to a local file (restore from a target).
  fetch(name: string, destFile: string): Promise<void>;
  remove(name: string): Promise<void>;
}

export const BACKUP_NAME = /^bunny-backup-.+-(\d{8}T\d{6}Z)\.tar\.gz$/;
// Files that travel with a backup and share its base name.
export const SIDECARS = [".sha256", ".manifest.json"];

export function stampOf(name: string): string | null {
  const m = BACKUP_NAME.exec(name);
  if (!m) return null;
  const s = m[1];
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`;
}

export class LocalDirTarget implements BackupTarget {
  constructor(readonly dir: string) {}

  get location(): string {
    return this.dir;
  }

  private safe(name: string): string {
    if (!name || name !== path.basename(name) || name.startsWith(".")) throw new Error(`invalid backup name ${JSON.stringify(name)}`);
    return path.join(this.dir, name);
  }

  async put(localFile: string, name: string): Promise<string> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const dest = this.safe(name);
    const part = `${dest}.partial`;
    await copyFile(localFile, part);
    await rename(part, dest);
    return dest;
  }

  async list(): Promise<BackupObject[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const out: BackupObject[] = [];
    for (const name of names) {
      if (!BACKUP_NAME.test(name)) continue;
      const s = await stat(path.join(this.dir, name));
      if (!s.isFile()) continue;
      out.push({ name, size: s.size, createdAt: stampOf(name) ?? s.mtime.toISOString() });
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name));
  }

  async fetch(name: string, destFile: string): Promise<void> {
    await copyFile(this.safe(name), destFile);
  }

  async remove(name: string): Promise<void> {
    await rm(this.safe(name), { force: true });
  }
}

// "/path", "./path" or "file:///path": a local directory. Object stores are not built yet.
export function createTarget(spec: string): BackupTarget {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(spec)?.[1]?.toLowerCase();
  if (!scheme) return new LocalDirTarget(path.resolve(spec));
  if (scheme === "file") return new LocalDirTarget(new URL(spec).pathname);
  if (scheme === "s3" || scheme === "r2") throw new Error(`${scheme}:// targets are not implemented yet; back up to a local directory and sync it (docs/server-move.md, "Storage targets")`);
  throw new Error(`unknown backup target ${JSON.stringify(spec)}`);
}

// Keeps the newest `keep` backups (and their sidecars); removes the rest. Returns the names removed.
export async function applyRetention(target: BackupTarget, keep: number): Promise<string[]> {
  if (!Number.isInteger(keep) || keep < 1) throw new Error("--keep must be a whole number of at least 1");
  const all = await target.list();
  const old = all.slice(0, Math.max(0, all.length - keep));
  for (const o of old) {
    await target.remove(o.name);
    for (const s of SIDECARS) await target.remove(o.name + s).catch(() => {});
  }
  return old.map((o) => o.name);
}
