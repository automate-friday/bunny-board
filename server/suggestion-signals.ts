// What the suggestion model (quick-starts-ai.ts) is given beyond what the canvas sends: the
// outcome of the work around the frame, and the state of the workspace repository. A model
// that only sees what a person asked for can do no more than recombine their requests; what
// agents reported back and what the repository shows are where the next task comes from.
// For someone new, the repository is the only signal there is.
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { TranscriptRow } from "../shared/components/transcript";

const clip = (t: string, max: number) => {
  const one = t.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
};

// Pure: what a frame's agent was asked and what it said last, from its transcript rows (the
// tail of the conversation). `asked` is the opening line when the tail still holds it, else
// the person's latest message. The report keeps its opening and its closing words: reports
// lead with the result and end with what is still open.
export function frameReport(rows: TranscriptRow[]): { asked: string; report: string } {
  const said = rows.filter((r) => r.kind === "user" && r.text.trim() && !/^(Board delta|Stamp |Channel |Operator notice)/.test(r.text));
  const asked = said.find((r) => r.primer) ?? said[said.length - 1];
  let last = "";
  for (let i = rows.length - 1; i >= 0 && !last; i--) if (rows[i].kind === "assistant" && !rows[i].ack && rows[i].text.trim()) last = rows[i].text.replace(/\s+/g, " ").trim();
  const report = last.length > 520 ? `${last.slice(0, 300).trimEnd()} … ${last.slice(-200).trimStart()}` : last;
  return { asked: clip(asked?.text ?? "", 240), report };
}

export type RepoDigest = { name: string; commits: string[]; branches: string[]; todos: string[]; readme: string; folders: string[] };

type Git = (cwd: string, args: string[]) => Promise<string>;
const git: Git = (cwd, args) =>
  new Promise((resolve) => {
    execFile("git", ["-C", cwd, ...args], { timeout: 3000, maxBuffer: 400_000 }, (err, stdout) => resolve(err ? "" : stdout));
  });
const lines = (out: string, n: number, max: number) => out.split("\n").map((l) => clip(l, max)).filter(Boolean).slice(0, n);

// The workspace directory as a short digest: recent commit subjects, the branches worked on
// last, a few TODO lines and the README's opening. Not a repository: its folder names.
// Null when there is nothing to read.
export async function repoDigest(cwd: string, run: Git = git): Promise<RepoDigest | null> {
  if (!cwd) return null;
  const [log, branches, todos, readme, entries] = await Promise.all([
    run(cwd, ["log", "-12", "--no-merges", "--pretty=%s (%cr)"]),
    run(cwd, ["branch", "--sort=-committerdate", "--format=%(refname:short)"]),
    // Comment markers only (a string that mentions TODO is not one), and not in tests.
    run(cwd, ["grep", "-n", "-I", "-E", "(//|#|/\\*|<!--) ?(TODO|FIXME)[:( ]", "--", "*.ts", "*.tsx", "*.js", "*.mjs", "*.py", "*.go", "*.rs", "*.rb", "*.swift", ":!*test*", ":!*spec*"]),
    readFile(path.join(cwd, "README.md"), "utf8").catch(() => ""),
    readdir(cwd, { withFileTypes: true }).catch(() => []),
  ]);
  const digest: RepoDigest = {
    name: path.basename(cwd),
    commits: lines(log, 12, 120),
    branches: lines(branches, 6, 60).filter((b) => !/^(main|master)$/.test(b)),
    todos: lines(todos, 6, 160),
    readme: clip(readme.replace(/^#+\s*/gm, ""), 400),
    folders: entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules").map((e) => e.name).slice(0, 24),
  };
  return digest.commits.length || digest.readme || digest.folders.length ? digest : null;
}

// One digest per directory for REPO_TTL_MS: a start form opens far more often than the
// repository changes.
export const REPO_TTL_MS = 5 * 60 * 1000;
export class RepoSignals {
  private cache = new Map<string, { at: number; digest: Promise<RepoDigest | null> }>();
  constructor(private read: (cwd: string) => Promise<RepoDigest | null> = repoDigest, private now: () => number = Date.now) {}
  get(cwd: string): Promise<RepoDigest | null> {
    const hit = this.cache.get(cwd);
    if (hit && this.now() - hit.at < REPO_TTL_MS) return hit.digest;
    const digest = this.read(cwd).catch(() => null);
    this.cache.set(cwd, { at: this.now(), digest });
    return digest;
  }
}

// Adds what each nearby frame's agent was asked and what it reported last, for the nearest
// MAX_REPORTS frames that have an agent. Bounded: a slow daemon costs at most REPORT_WAIT_MS
// and the frames then go without a report.
export const MAX_REPORTS = 8;
const REPORT_WAIT_MS = 3000;
type Hub = { prime(agentIds: string[], maxAgeMs?: number, timeoutMs?: number): Promise<void>; summary(agentId: string): { rows: TranscriptRow[] } | null };
export async function addReports<F extends { id: string; asked?: string; report?: string }>(frames: F[], agentOf: (frameId: string) => string | undefined, hub: Hub): Promise<F[]> {
  const bound = frames.map((f) => ({ f, agentId: f.id ? agentOf(f.id) : undefined })).filter((x): x is { f: F; agentId: string } => !!x.agentId).slice(0, MAX_REPORTS);
  if (!bound.length) return frames;
  await hub.prime(bound.map((x) => x.agentId), 60_000, REPORT_WAIT_MS).catch(() => undefined);
  for (const { f, agentId } of bound) {
    const rows = hub.summary(agentId)?.rows;
    if (!rows?.length) continue;
    const { asked, report } = frameReport(rows);
    if (asked) f.asked = asked;
    if (report) f.report = report;
  }
  return frames;
}
