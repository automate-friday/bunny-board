// bunny: board backup and restore (bin/bunny runs server/dist/bunny.cjs, built from bin.ts).
//
//   bunny backup  [--state DIR] [--out FILE | --to TARGET [--keep N]] [--server URL]
//                 [--no-flush] [--require-flush] [--exclude PATH]... [--json]
//   bunny verify  <backup.tar.gz> [--json]
//   bunny restore <backup.tar.gz> [--state DIR] [--force] [--public-host HOST|auto]
//                 [--keep-bindings] [--dry-run] [--json]
//   bunny backups --to TARGET [--json]
//
// The state directory defaults to $BUNNY_STATE, else ~/.paseo/plugins/board.
// TARGET is a directory (or file:///dir); see docs/server-move.md.

import { existsSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BackupError, backupName, createBackup, defaultStateDir, type Manifest, type RestoreReport, restoreBackup, verifyBackup } from "./backup";
import { applyRetention, createTarget, SIDECARS } from "./targets";

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
  multi: Record<string, string[]>;
}

const VALUED = new Set(["state", "out", "to", "keep", "server", "exclude", "public-host"]);

export function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {}, multi: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (VALUED.has(key)) {
      const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (v === undefined) throw new BackupError(`--${key} needs a value`);
      out.flags[key] = v;
      (out.multi[key] ??= []).push(v);
    } else out.flags[key] = true;
  }
  return out;
}

const USAGE = `usage:
  bunny backup  [--state DIR] [--out FILE | --to DIR [--keep N]] [--server URL] [--no-flush] [--require-flush] [--exclude PATH]... [--json]
  bunny verify  <backup.tar.gz> [--json]
  bunny restore <backup.tar.gz> [--state DIR] [--force] [--public-host HOST|auto] [--keep-bindings] [--dry-run] [--json]
  bunny backups --to DIR [--json]
See docs/server-move.md.`;

function mb(n: number): string {
  return n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function printManifest(m: Manifest, say: (s: string) => void) {
  say(`backup of ${m.source.hostname} (${m.source.publicBase ?? "no public address recorded"}), ${m.createdAt}, bunny ${m.bunny.commit?.slice(0, 7) ?? m.bunny.version}`);
  say(`  quiesce: ${m.quiesce.via}${m.quiesce.note ? ` (${m.quiesce.note})` : ""}`);
  say(`  ${m.totals.files} files, ${mb(m.totals.bytes)}, ${m.totals.boards} boards, ${m.totals.records} records`);
  for (const b of m.boards) say(`    ${b.id}: ${b.records} records, ${b.frames} frames${b.boundFrames.length ? `, ${b.boundFrames.length} bound to agents` : ""}${b.archived ? " (archived)" : ""}`);
  for (const s of m.skipped) say(`  skipped ${s.path}: ${s.reason}`);
}

function printRestore(r: RestoreReport, say: (s: string) => void) {
  say(`${r.dryRun ? "would restore" : "restored"} ${r.manifest.totals.files} files into ${r.stateDir} (backup of ${r.manifest.source.hostname}, ${r.manifest.createdAt})`);
  for (const b of r.boards) say(`  board ${b.id}: ${b.records} records${b.archived ? " (archived)" : ""}`);
  if (r.dryRun && r.targetNotEmpty) say(`  ${r.stateDir} is not empty: the real restore needs --force (the existing directory is kept, renamed aside)`);
  if (r.previousStateDir) say(`  the previous state directory is kept at ${r.previousStateDir}`);
  for (const c of r.config.changed) say(`  config.json ${c.key}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`);
  for (const p of r.config.pathsMissing) say(`  config.json ${p.key} points at ${p.path}, which does not exist on this host: fix it before starting the board`);
  for (const a of r.assetLinks) say(`  board ${a.board}: ${a.count} asset link(s) to the old host now point at this server`);
  if (r.unboundFrames.length) {
    say(`  ${r.unboundFrames.length} frame(s) were bound to agents on the old host; they are kept, unbound, and offer their old agent for re-linking:`);
    for (const f of r.unboundFrames) say(`    ${f.board} / ${f.name || f.frameId}  agent ${f.agentId}${f.host ? ` on ${f.host}` : ""}`);
  }
  if (r.remoteFrames.length) say(`  ${r.remoteFrames.length} of them were agents on other machines (af-network); they may still exist and can be re-linked`);
  if (r.pendingPrompts) say(`  ${r.pendingPrompts} queued prompt(s) to old-host agents will not be sent (their frames are unbound)`);
  if (r.modifiedFiles.length) say(`  changed for this host (their checksums now differ from the backup): ${r.modifiedFiles.join(", ")}`);
}

export async function main(argv: string[], io: { out: (s: string) => void; err: (s: string) => void; bunnyRoot?: string } = { out: (s) => console.log(s), err: (s) => console.error(s) }): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    io.err((e as Error).message);
    return 2;
  }
  const [cmd, file] = args._;
  const json = !!args.flags.json;
  const say = json ? () => {} : io.out;
  const state = path.resolve(String(args.flags.state ?? defaultStateDir()));
  try {
    if (cmd === "backup") {
      if (args.flags.out && args.flags.to) throw new BackupError("pass --out or --to, not both");
      if (args.flags.keep && !args.flags.to) throw new BackupError("--keep needs --to");
      const name = backupName(os.hostname(), new Date());
      const target = args.flags.to ? createTarget(String(args.flags.to)) : null;
      const work = target ? await fsp.mkdtemp(path.join(os.tmpdir(), "bunny-backup-")) : null;
      const outFile = args.flags.out ? path.resolve(String(args.flags.out)) : path.join(work ?? process.cwd(), name);
      try {
        const res = await createBackup({
          stateDir: state,
          outFile,
          serverUrl: args.flags.server ? String(args.flags.server) : undefined,
          flush: args.flags["no-flush"] ? "skip" : args.flags["require-flush"] ? "required" : "if-running",
          exclude: args.multi.exclude,
          bunnyRoot: io.bunnyRoot,
          log: (m) => say(m),
        });
        let stored: string | null = null;
        let removed: string[] = [];
        if (target) {
          const base = path.basename(outFile);
          for (const s of SIDECARS) await target.put(outFile + s, base + s);
          stored = await target.put(outFile, base);
          if (args.flags.keep) removed = await applyRetention(target, Number(args.flags.keep));
        }
        if (json) io.out(JSON.stringify({ file: stored ?? res.file, sha256: res.sha256, size: res.size, removed, manifest: res.manifest }, null, 2));
        else {
          printManifest(res.manifest, say);
          say(`sha256 ${res.sha256}  ${stored ?? res.file}`);
          for (const r of removed) say(`retention: removed ${r}`);
        }
      } finally {
        if (work) await fsp.rm(work, { recursive: true, force: true });
      }
      return 0;
    }
    if (cmd === "verify") {
      if (!file) throw new BackupError(USAGE);
      const m = await verifyBackup(path.resolve(file));
      if (json) io.out(JSON.stringify({ ok: true, manifest: m }, null, 2));
      else {
        printManifest(m, say);
        say(`ok: every file matches its sha256`);
      }
      return 0;
    }
    if (cmd === "restore") {
      if (!file) throw new BackupError(USAGE);
      if (!existsSync(file)) throw new BackupError(`no such file: ${file}`);
      const r = await restoreBackup({
        tarball: path.resolve(file),
        stateDir: state,
        force: !!args.flags.force,
        publicHost: typeof args.flags["public-host"] === "string" ? args.flags["public-host"] : undefined,
        keepBindings: !!args.flags["keep-bindings"],
        dryRun: !!args.flags["dry-run"],
        log: (m) => say(m),
      });
      if (json) io.out(JSON.stringify(r, null, 2));
      else printRestore(r, say);
      return 0;
    }
    if (cmd === "backups") {
      if (!args.flags.to) throw new BackupError("--to is required");
      const list = await createTarget(String(args.flags.to)).list();
      if (json) io.out(JSON.stringify(list, null, 2));
      else for (const o of list) say(`${o.createdAt}  ${mb(o.size).padStart(9)}  ${o.name}`);
      return 0;
    }
    io.err(USAGE);
    return cmd === undefined || cmd === "help" || args.flags.help ? 0 : 2;
  } catch (e) {
    io.err(e instanceof BackupError ? `bunny ${cmd}: ${e.message}` : `bunny ${cmd}: ${(e as Error).stack}`);
    return 1;
  }
}
