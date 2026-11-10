import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitHubPrConfig, GitHubPrData } from "../../shared/widgets/github-pr";
import { widgetProps } from "../../shared/widgets";
import { ancestors, baseShape, nextIndex, type Rec } from "../records";
import type { BoardHost, BoardRoom } from "../room-host";
import type { PluginRegistry } from "../plugins";
import type { WidgetEmit, WidgetSource } from "./types";

export interface GitHubResponse { status: number; headers: Record<string, string>; body?: any }
export type GitHubRead = (endpoint: string, options?: { etag?: string }) => Promise<any>;
const exec = promisify(execFile);
// REST only. Include headers even on failures, so quota errors can pause the tracker.
export function parseGitHubResponse(stdout: string): GitHubResponse {
  const split = stdout.search(/\r?\n\r?\n/);
  if (split < 0) throw Error("Missing GitHub response headers");
  const head = stdout.slice(0, split);
  const status = Number(/^HTTP\/\S+ (\d+)/.exec(head)?.[1]);
  if (!status) throw Error("Invalid GitHub response status");
  const headers: Record<string, string> = {};
  for (const line of head.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  const body = stdout.slice(split).trim();
  let data: unknown;
  if (body) {
    try { data = JSON.parse(body); }
    catch (error) { if (status < 400) throw error; data = { message: body }; }
  }
  return { status, headers, ...(body ? { body: data } : {}) };
}
export const githubRead: GitHubRead = async (endpoint, options) => {
  const args = ["api", "--include", endpoint];
  if (options?.etag) args.push("--header", `If-None-Match: ${options.etag}`);
  let stdout: string;
  try { ({ stdout } = await exec(process.env.BUNNY_GH || "gh", args, { timeout: 25000, maxBuffer: 8 * 1024 * 1024 })); }
  catch (error) {
    const output = (error as { stdout?: string }).stdout;
    if (!output?.startsWith("HTTP/")) throw error;
    stdout = output;
  }
  return parseGitHubResponse(stdout);
};
interface TrackerOptions { now?: () => number; repoCacheMs?: number; reserve?: number }
class QuotaPause extends Error {}
const setting = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const key = (repo: string, number: number | string) => `${repo.toLowerCase()}#${number}`;

export class GitHubPrTracker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private stopped = false;
  private listeners = new Set<{ config: GitHubPrConfig; emit: WidgetEmit }>();
  private data = new Map<string, GitHubPrData>();
  private lastScan = new Map<string, number>();
  private nextPoll = new Map<string, number>();
  private responses = new Map<string, { etag?: string; body: any }>();
  private repos = new Map<string, { expires: number; names: string[] }>();
  private pausedUntil = 0;
  private failureReason = "";
  private groupFailures = new Set<string>();
  private now: () => number;
  private repoCacheMs: number;
  private reserve: number;
  readonly source: WidgetSource<GitHubPrConfig> = {
    id: "github-pr",
    watch: (config, emit) => {
      const listener = { config, emit };
      this.listeners.add(listener);
      const stored = this.findStored(config);
      emit({ status: "connecting", ...(stored ? { data: stored } : {}) });
      void this.tick();
      return () => { this.listeners.delete(listener); };
    },
  };
  constructor(private host: Pick<BoardHost, "all">, private plugins: Pick<PluginRegistry, "isInstalled">,
    private read: GitHubRead = githubRead, private log: (message: string) => void = () => {},
    private intervalMs = setting("BUNNY_PR_POLL_MS", 300000), options: TrackerOptions = {}) {
      this.now = options.now ?? Date.now;
      this.repoCacheMs = options.repoCacheMs ?? setting("BUNNY_PR_REPO_CACHE_MS", 3600000);
      this.reserve = options.reserve ?? setting("BUNNY_PR_QUOTA_RESERVE", 100);
    }

  private announce(failed = false, inactive = false) {
    const paused = this.pausedUntil > this.now();
    const reason = paused ? `GitHub quota low; polling paused until ${new Date(this.pausedUntil).toISOString()}.`
      : inactive ? "GitHub polling paused: add a PR tracker control widget to a board."
      : failed ? this.failureReason || "GitHub refresh failed. Check gh authentication and repository/check access on the board host." : "";
    for (const { config, emit } of this.listeners) {
      const data = this.findStored(config);
      emit({ status: paused || failed || inactive ? "stale" : "live", ...(data ? { data } : {}), ...(reason ? { reason } : {}) });
    }
  }

  private async request(endpoint: string): Promise<any> {
    if (this.stopped || !this.plugins.isInstalled("github-pr") || this.pausedUntil > this.now() ||
      ![...this.host.all()].some(room => !room.closed && !room.isArchived() && [...room.records.values()].some(r => r.type === "widget" && r.props.widgetId === "github-pr" && !r.props.config.repo))) throw new QuotaPause();
    const cached = this.responses.get(endpoint);
    const raw = await this.read(endpoint, { etag: cached?.etag });
    // Existing embedders may provide a plain JSON reader.
    if (!raw || typeof raw.status !== "number" || !raw.headers) return raw;
    const response = raw as GitHubResponse;
    const headers = Object.fromEntries(Object.entries(response.headers).map(([k, v]) => [k.toLowerCase(), v]));
    const remaining = headers["x-ratelimit-remaining"];
    const low = remaining !== undefined && Number(remaining) <= this.reserve;
    const limited = response.status === 429 || (response.status === 403 && (low || !!headers["retry-after"] || /rate limit/i.test(response.body?.message || "")));
    if (low || limited) {
      const reset = Number(headers["x-ratelimit-reset"]) * 1000;
      const retry = Number(headers["retry-after"]) * 1000;
      this.pausedUntil = Math.max(this.now() + 1000, Number.isFinite(reset) && reset > this.now() ? reset : this.now() + (retry > 0 ? retry : 3600000));
    }
    if (response.status === 304) {
      if (!cached) throw Error("GitHub returned 304 without cached data");
      if (low) throw new QuotaPause();
      return cached.body;
    }
    if (response.status >= 400) {
      if (limited || low) throw new QuotaPause();
      throw Error(`GitHub HTTP ${response.status}`);
    }
    this.responses.set(endpoint, { etag: headers.etag, body: response.body });
    if (low) throw new QuotaPause();
    return response.body;
  }

  private async repositories(org: string): Promise<string[]> {
    const cached = this.repos.get(org.toLowerCase());
    if (cached && cached.expires > this.now()) return cached.names;
    const names = (await this.pages(`orgs/${org}/repos?type=all`)).filter(r => !r.archived && !r.disabled).map(r => r.full_name);
    this.repos.set(org.toLowerCase(), { names, expires: this.now() + this.repoCacheMs });
    return names;
  }

  start() {
    this.stopped = false;
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), Math.max(1000, this.intervalMs));
    this.timer.unref?.();
    void this.tick();
  }
  stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = null; }

  private findStored(config: GitHubPrConfig): GitHubPrData | null {
    const id = key(config.repo || "", config.number || "");
    for (const room of this.host.all()) for (const r of room.records.values()) {
      const pr = r.meta?.githubPr as GitHubPrData | undefined;
      if (pr && key(pr.repo, pr.number) === id) return pr;
    }
    return this.data.get(id) ?? null;
  }
  private async pages(endpoint: string, until?: (item: any) => boolean): Promise<any[]> {
    const result: any[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.request(`${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw Error("Unexpected GitHub response");
      for (const item of batch) { if (until?.(item)) return result; result.push(item); }
      if (batch.length < 100) return result;
    }
  }
  async tick(): Promise<void> {
    if (this.busy || this.stopped || !this.plugins.isInstalled("github-pr")) return;
    if (this.pausedUntil > this.now()) { this.announce(); return; }
    this.busy = true;
    let failed = false;
    try {
      const groups = new Map<string, { org: string; repositories: string; rooms: BoardRoom[] }>();
      for (const room of this.host.all()) {
        if (room.closed || room.isArchived()) continue;
        const control = [...room.records.values()].find(r => r.type === "widget" && r.props.widgetId === "github-pr" && !r.props.config.repo);
        if (!control) continue;
        const { org, repositories = "" } = control.props.config;
        if (!/^[\w-]+$/.test(org) || (repositories && !repositories.split(",").every((s: string) => /^[\w.-]+$/.test(s.trim())))) { failed = true; continue; }
        const id = `${org}/${repositories}`;
        const group = groups.get(id) ?? { org, repositories, rooms: [] as BoardRoom[] };
        group.rooms.push(room); groups.set(id, group);
      }
      if (!groups.size) { this.announce(false, true); return; }
      const invalid = failed;
      for (const [groupId, group] of groups) {
        if ((this.nextPoll.get(groupId) ?? 0) > this.now()) continue;
        this.nextPoll.set(groupId, this.now() + this.intervalMs);
        failed = false;
        this.groupFailures.delete(groupId);
        try {
          const started = this.now();
          const repos: string[] = group.repositories
            ? group.repositories.split(",").map(s => `${group.org}/${s.trim()}`)
            : await this.repositories(group.org);
          const cutoff = (this.lastScan.get(groupId) ?? started) - 120000;
          for (const repo of repos) {
            try {
              // Open PRs are always enumerated, including ones that predate installation.
              // Recently closed PRs cover open-and-close between two polls.
              const open = await this.pages(`repos/${repo}/pulls?state=open&sort=updated&direction=desc`);
              const closed = await this.pages(`repos/${repo}/pulls?state=closed&sort=updated&direction=desc`, p => Date.parse(p.updated_at) < cutoff);
              const candidates = new Map<number, any>([...open, ...closed].map(p => [p.number, p]));
              for (const room of group.rooms) for (const r of room.records.values()) {
                const pr = r.meta?.githubPr as GitHubPrData | undefined;
                if (pr?.repo.toLowerCase() === repo.toLowerCase() && pr.state === "open" && !candidates.has(pr.number)) candidates.set(pr.number, { number: pr.number });
              }
              for (const number of candidates.keys()) {
                if (this.stopped || !this.plugins.isInstalled("github-pr")) return;
                const pull = await this.request(`repos/${repo}/pulls/${number}`);
                const checks: GitHubPrData["checks"] = [];
                try {
                  // check-runs has an envelope; statuses is a paginated list. Keep only
                  // the latest legacy status per context, as GitHub returns newest first.
                  for (let page = 1; ; page++) {
                    const batch = await this.request(`repos/${repo}/commits/${pull.head.sha}/check-runs?filter=latest&per_page=100&page=${page}`);
                    if (!Array.isArray(batch.check_runs)) throw Error("Unexpected checks response");
                    checks.push(...batch.check_runs.map((c: any) => ({ name: c.name, state: c.conclusion || c.status })));
                    if (batch.check_runs.length < 100) break;
                  }
                  const seen = new Set<string>();
                  for (const status of await this.pages(`repos/${repo}/commits/${pull.head.sha}/statuses`)) {
                    if (seen.has(status.context)) continue;
                    seen.add(status.context); checks.push({ name: status.context, state: status.state });
                  }
                } catch (error) {
                  if (error instanceof QuotaPause) throw error;
                  failed = true;
                  checks.push({ name: "CI checks", state: "unavailable — check GitHub permissions" });
                }
                const pr: GitHubPrData = {
                  title: pull.title, repo, number, author: pull.user?.login || "unknown", agent: "",
                  state: pull.merged_at ? "merged" : pull.state === "closed" ? "closed" : "open",
                  url: `https://github.com/${repo}/pull/${number}`,
                  checks,
                };
                this.data.set(key(repo, number), pr);
                for (const room of group.rooms) this.upsert(room, pr, pull, group);
              }
            } catch (error) { if (error instanceof QuotaPause) throw error; failed = true; this.log(`GitHub PR tracker: unable to refresh ${repo}; retaining existing cards`); }
          }
          if (!failed) this.lastScan.set(groupId, started);
        } catch (error) { if (error instanceof QuotaPause) throw error; failed = true; this.log(`GitHub PR tracker: unable to list ${group.org}; retaining existing cards`); }
        if (failed) this.groupFailures.add(groupId);
      }
      failed = invalid || [...this.groupFailures].some(id => groups.has(id));
      this.failureReason = failed ? "GitHub refresh failed. Check gh authentication and repository/check access on the board host." : "";
      if (!this.stopped) this.announce(failed);
    } catch (error) {
      if (!(error instanceof QuotaPause)) this.log(`GitHub PR tracker: ${String(error)}`);
      if (!this.stopped) this.announce(true);
    } finally { this.busy = false; }
  }

  private upsert(room: BoardRoom, input: GitHubPrData, pull: any, group: { org: string; repositories: string }) {
    if (this.stopped || room.closed || room.isArchived()) return;
    const all = [...room.records.values()];
    const existing = all.find(r => r.type === "widget" && r.props.widgetId === "github-pr" && key(r.props.config.repo || "", r.props.config.number || "") === key(input.repo, input.number));
    const matches = all.filter(r => r.type === "cloud-session" && r.props.repo?.toLowerCase() === input.repo.toLowerCase() &&
      ((r.props.branch && r.props.branch === pull.head?.ref) || (r.props.session && (pull.body || "").includes(r.props.session)) || r.props.prUrl === input.url));
    const frames = new Map<string, Rec>();
    for (const session of matches) {
      const frame = ancestors(room.records, session).map(id => room.records.get(id)).find(r => r?.type === "frame");
      if (frame) frames.set(frame.id, frame);
    }
    // Ambiguous branch/session links go to the inbox, never an arbitrary agent.
    let frame = frames.size === 1 ? [...frames.values()][0] : undefined;
    const agent = frame && matches.length ? `${matches[0].props.provider} · ${matches[0].props.session}` : "";
    const pr = { ...input, agent };
    if (existing) {
      if (JSON.stringify(existing.meta?.githubPr) !== JSON.stringify(pr)) room.write({ kind: "server", reason: "github-pr" }, ops => ops.put({ ...existing, meta: { ...existing.meta, githubPr: pr } }));
      return;
    }
    const page = all.find(r => r.typeName === "page");
    if (!page) return;
    room.write({ kind: "server", reason: "github-pr" }, ops => {
      if (!frame) frame = all.find(r => r.type === "frame" && r.meta?.githubPrInbox);
      if (!frame) {
        const x = Math.max(0, ...all.filter(r => r.typeName === "shape" && r.parentId === page.id).map(r => r.x + (r.props.w || 400))) + 80;
        frame = baseShape("frame", page.id, nextIndex(room.records, page.id), x, 80, { name: "PR inbox", w: 1180, h: 650, color: "black" }, { githubPrInbox: true });
        ops.put(frame);
      }
      const children = all.filter(r => r.parentId === frame!.id && r.typeName === "shape");
      // Append below existing content rather than covering the agent's work.
      const y = Math.max(40, ...children.map(r => r.y + (r.props.h || 240) + 20));
      const props = widgetProps("github-pr", { org: group.org, repositories: group.repositories, repo: input.repo, number: String(input.number) });
      ops.put(baseShape("widget", frame.id, nextIndex(room.records, frame.id), 20, y, props, { githubPr: pr }));
      if (y + props.h + 20 > frame.props.h) ops.put({ ...frame, props: { ...frame.props, h: y + props.h + 20 } });
    });
  }
}
