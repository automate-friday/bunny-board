import {WorkerSettingsLive,workerSettingsRuntime} from '../tools/upstash/settings.mjs';
import {upstashDefault} from '../shared/conversation-links';
import { startFrame } from "./frame-start";
import { forkFrame } from "./frame-fork";
import { QuickStartsAi } from "./quick-starts-ai";
import type { BoardSnapshots } from "./board-snapshots";
import { imageVariant } from "./image-variants";
import { resolvePaseoServerId } from "./paseo-identity";
import { subtree as compressionContents } from "./frame-archive";
import { compressionPrompt } from "./frame-compression";
import {SnapshotStream} from './snapshot-stream';
import {hostMetrics} from './host-metrics';
import { readDeployStatus } from "./deploy-status";
import type { PromptOutbox } from "./prompt-outbox";
import { daemonFailureReason, hostOperation } from "./daemon-health";
import os from "node:os";
import type { Organizer } from "./organizer";
import {agentCapabilities} from "./agent-capabilities";
import {resolveBoardName} from "./board-resolve";
import type {FrameUploads} from "./frame-uploads";
import {timelinePage,timelineRow} from "./timeline-pages";
import { lastHumanMessage, type LastSent } from "../shared/last-message";
import {bundleFilePath} from "./artifact-bundle";
import { MAX_IMAGE_BYTES, persistImage, readImageUpload } from './file-intake';
import { transientDaemonError, withDaemonRead } from './daemon-health';
import { buildControls, MAX_FILE_BYTES, parseFeatureBody, parseModeBody, parseModelBody, parsePermissionBody, parseThinkingBody, resolveImagePath } from "./agent-controls";
import type { ObsRecordingSource } from './video-source';
import type { FrameChannels } from './frame-channels';
import { type BasicAuth, CHALLENGE, loadBasicAuth, requestAuthorized } from "./basic-auth";
import { checkBackupToken, FLUSH_PATH, flushForBackup, isLoopback } from "./backup/flush";
// One port, bound to 0.0.0.0: the built canvas, the tldraw sync websocket, the
// token-guarded agent API used by the board MCP server, and a small UI API that
// proxies the Paseo SDK for the canvas sidebar.

import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { WebSocketServer } from "ws";
import { type AgentApi, InputError, ScopeError, safeFileName } from "./agent-api";
import type { WidgetHub } from "./widgets";
import { handleWidgetHttp } from "./widgets/http";
import type { AgentDirectory } from "./agent-directory";
import { type BoardImporter, boardSummaries } from "./board-import";
import { type BoardConfig, checkFrameToken } from "./config";
import type { FrameWatcher } from "./frame-watcher";
import type { PaseoBridge } from "./paseo-bridge";
import type { RemoteAgents } from "./remote";
import { filterRows } from "./agent-directory";
import { statusOf } from "./paseo-bridge";
import { ancestors } from "./records";
import { BoardHost } from "./room-host";
import type { CloudSessions } from "./cloud-sessions";
import { COMPONENTS_VERSION } from "../shared/components/transcript";
import { perfSnapshot } from "./perf";
import { CLIENT_PERF, ClientPerfStore, clientPerfRoute, readCappedText } from "./client-perf";
import { CLIENT_LAUNCH, ClientLaunchStore, launchLogLine, sanitizeLaunch } from "./client-launch";
import { appendTouchLines, readTouchLines, sanitizeTouchBatch, TOUCH_DEBUG } from "./touch-debug";
import { FALLBACK_PROVIDERS, fallbackCatalogue, startCatalogue, withBaseModels, withLiveModels } from "../shared/start-catalogue";
import { ClaudeCliModels } from "./cli-models";
import { simplifyItem } from "./timeline";
import type { VideoWorkflow } from "./video-workflow";
import type { TranscriptHub } from "./transcripts";
import { frameActivity } from "./frame-history";
import { agentMachine } from "./agent-machine";

// This server accepts origin-form targets only. Parse before routing without allowing
// malformed input to throw out of Node's HTTP/upgrade event handler.
function requestUrl(target: string | undefined): URL | null {
  if (!target || !target.startsWith("/") || target.startsWith("//") || /[\\#\x00-\x20\x7f]/.test(target)) return null;
  try { return new URL(target, "http://localhost"); }
  catch { return null; }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
};

const FILE_MIME: Record<string, string> = {
  ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".woff": "font/woff", ".woff2": "font/woff2",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".jsonl": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".csv": "text/csv; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
};

const SETTERS = new Set(["/model", "/mode", "/thinking", "/feature"]);

const quickStartsAi = new QuickStartsAi();
// Claude models the installed CLI reports, merged into Paseo's list (server/cli-models.ts).
const claudeCliModels = new ClaudeCliModels();

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json" });
  res.end(text);
}

// Browsers send Origin on websocket upgrades and cross-site requests. Only the
// board's own origins may open the room or use the UI API; non-browser callers
// (no Origin header) are allowed, which keeps the tailnet-only posture explicit.
// The agent summary's lastUserMessage (no row index: the client has its own rows).
function summaryOf(m: LastSent | null): { text: string; at: string; images: number; files: number } | null {
  return m ? { text: m.text, at: m.at, images: m.images, files: m.files } : null;
}

function originAllowed(cfg: BoardConfig, req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  return !origin || cfg.allowedOrigins.includes(origin);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 2_000_000) throw new InputError("body too large");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InputError("body must be JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new InputError("body must be a JSON object");
  return parsed as Record<string, unknown>;
}

export function startHttp(opts: {
  cfg: BoardConfig;
  host: BoardHost;
  watcher: FrameWatcher;
  agentApi: AgentApi;
  bridge: PaseoBridge;
  transcripts: TranscriptHub;
  prompts?: PromptOutbox | null;
  directory: AgentDirectory;
  importer: BoardImporter;
  remote: RemoteAgents | null;
  video?: VideoWorkflow | null;
  videoSource?: Pick<ObsRecordingSource,'status'> | null;
  uploads?: FrameUploads | null;
  channels?: FrameChannels | null;
  organizer?: Organizer | null;
  // Plugin widget data sources (server/widgets); their SSE stream and config options.
  widgets?: WidgetHub | null;
  // Cloud session cards (server/cloud-sessions.ts): burst polling when someone opens one.
  cloud?: CloudSessions | null;
  // Basic auth for everything but the frame-token agent API. Undefined reads
  // BUNNYBOARD_AUTH_USERNAME/PASSWORD; null turns it off. Half-set env rejects startup.
  auth?: BasicAuth | null;
  snapshots?: BoardSnapshots | null;
  log: (m: string) => void;
}): Promise<Server> {
  const { cfg, host, watcher, agentApi, bridge, transcripts, directory, importer, remote, video, videoSource, channels, uploads, prompts, organizer, log } = opts;
  const clientErrors: { at: string; where: string; message: string; stack: string; ua: string; url: string }[] = [];
  const paseoServerId = () => resolvePaseoServerId(cfg.paseoServerId, bridge.aux);
  const paseoUrl = (agentId: string) => {
    const remoteHost = watcher.remoteHostOf(agentId);
    const id = remoteHost ? remote?.paseoServerIds[remoteHost] : paseoServerId();
    return id ? `paseo://h/${encodeURIComponent(id)}/agent/${encodeURIComponent(agentId)}` : null;
  };
  let sseClients = 0;
  let sseOpens=0,sseStalls=0;
  let auth: BasicAuth | null;
  try {
    auth = opts.auth === undefined ? loadBasicAuth() : opts.auth;
  } catch (e) {
    return Promise.reject(e);
  }
  log(auth ? "basic auth on: browser, UI API, assets and websocket need credentials" : "basic auth off (tailnet-only; see docs/AUTH.md)");
  // Browsers negotiate permessage-deflate: the main board's 1.7 MB connect frame is ~0.37 MB deflated.
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: true });
  const seenCallers = new Set<string>();

  async function handleAgent(req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray): Promise<void> {
    const boardId = decodeURIComponent(m[1]);
    const frameId = decodeURIComponent(m[2]);
    const op = m[3];
    const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const room = host.exists(boardId) ? host.get(boardId) : null;
    const bound = room?.records.get(frameId)?.meta?.paseo?.agentId as string | undefined;
    if (!room || !bound || !checkFrameToken(cfg.secret, boardId, frameId, bound, token)) {
      log(`host-authorization ${JSON.stringify({host:"local",reason:daemonFailureReason(Error("token does not authorise")),boardId,frameId,bound:!!bound})}`);
      send(res, 401, { error: `token does not authorise board ${boardId} frame ${frameId} (the frame may have been re-bound to another agent)` });
      return;
    }
    const caller = req.headers["x-paseo-agent-id"] as string | undefined;
    const seenKey = `${boardId}/${frameId}/${caller ?? "-"}`;
    if (!seenCallers.has(seenKey)) {
      seenCallers.add(seenKey);
      log(`agent api first call ${op} ${boardId}/${frameId} x-paseo-agent-id=${caller ?? "(absent)"}`);
    }
    agentApi.checkAgent(room, frameId, req.headers["x-paseo-agent-id"] as string | undefined);
    const body = req.method === "GET" ? Object.fromEntries(new URL(req.url ?? "", "http://x").searchParams) : await readBody(req);
    // biome-ignore lint/suspicious/noExplicitAny: validated inside AgentApi.
    const b = body as any;
    if (room.records.get(frameId)?.meta?.paseo?.compression?.status === "pending" && !["read","read-image","write","comment"].includes(op)) throw new InputError("Compression pending: submit the requested summary without resizing or adding other content");
    let out: unknown;
    if (op === 'channel' && channels) {
      if (body.action==='list') out={channels:channels.list(boardId).filter(c=>c.active&&c.members.some(m=>m.frame===frameId))};
      else if (body.action==='send') out=await channels.send(boardId,frameId,String(body.channelId??''),String(body.messageId??''),String(body.text??''));
      else throw new InputError('expected list or send');
    }
    else if (op === "video" && video) out = video.action(room, frameId, body);
    else if (op === "read") out = await agentApi.read(room, frameId, b);
    else if (op === "read-image") out = await agentApi.readImage(room, frameId, b);
    else if (op === "pin") out = await agentApi.pin(room, frameId, b);
    else if (op === "cloud") out = agentApi.cloud(room, frameId, b);
    else if (op === "write") out = agentApi.write(room, frameId, b);
    else if (op === "update") out = agentApi.update(room, frameId, b);
    else if (op === "delete") out = agentApi.delete(room, frameId, b);
    else if (op === "frame") out = await agentApi.frame(room, frameId, b);
    else if (op === "layout") out = agentApi.layout(room, frameId, b);
    else if (op === "artifact") out = await agentApi.runtimeArtifact(room, frameId, b);
    else if (op === "comment") out = agentApi.comment(room, frameId, b);
    else if (op === "widget") out = await agentApi.widget(room, frameId, b);
    else if (op === "stamp") out = agentApi.stamp(room, frameId, b);
    // Board clean-up: stale frames with reasons, and a proposal the user approves on the board.
    // Agents never archive or delete frames themselves (server/frame-archive.ts).
    else if (op === "archive-candidates" && watcher.archive) {
      const found = watcher.archive.candidates(room, { idleDays: typeof b.idleDays === "number" ? b.idleDays : undefined, exclude: frameId });
      const limit = Math.max(1, Math.min(500, Number(b.limit) || 200));
      out = { ...found, candidates: found.candidates.slice(0, limit), truncated: found.candidates.length > limit, note: `${found.candidates.length} stale frame(s); ${found.active} with an agent at work and ${found.recent} edited in the last ${found.idleDays} day(s) were left out. Your own frame is never listed. To clean up, call board_archive with the frameIds ${cfg.humanName} would want gone: it files a proposal he approves on the board.` };
    } else if (op === "archive" && watcher.archive) {
      const ids = Array.isArray(b.frameIds) ? (b.frameIds as unknown[]).map(String) : [];
      const self = room.records.get(frameId);
      const { proposal, skipped } = watcher.archive.propose(room, { agentId: String(self?.meta?.paseo?.agentId ?? "unknown"), frameId, frameName: String(self?.props?.name || "an agent") }, ids, typeof b.reason === "string" ? b.reason : "");
      out = { proposalId: proposal.id, status: proposal.status, proposed: proposal.items.length, skipped, note: `Nothing has been archived yet. ${cfg.humanName} reviews this proposal on the board (a "Clean-up proposal" banner) and approves all or some of it; approved frames go to the board's Archive, where they can be restored. A newer board_archive call replaces this proposal while it is pending.` };
    }
    else {
      send(res, 404, { error: `unknown op ${op}` });
      return;
    }
    send(res, 200, out);
  }

  // --- Paseo parity: agent controls and image files (server/agent-controls.ts) -------
  // Provider catalogues per cwd, for the model and thinking pickers.
  // ponytail: one-minute cache for at most 50 cwds, oldest evicted; shorten it if stale model lists show up.
  const providerCaches = new WeakMap<object, Map<string, { at: number; entries: unknown[] }>>();
  async function providerEntries(cwd: string, aux = bridge.aux): Promise<unknown[] | null> {
    if (!aux) return null;
    let providerCache = providerCaches.get(aux);
    if (!providerCache) { providerCache = new Map(); providerCaches.set(aux, providerCache); }
    let hit = providerCache.get(cwd);
    // Harnesses still loading their model lists are asked again after a few seconds.
    const loading = hit?.entries.some((x) => (x as { status?: string }).status === "loading");
    if (!hit || Date.now() - hit.at > (loading ? 5_000 : 60_000)) {
      try {
        const snap = await withDaemonRead(() => aux.getProvidersSnapshot({ cwd }));
        hit = { at: Date.now(), entries: Array.isArray(snap.entries) ? snap.entries : [] };
        providerCache.set(cwd, hit);
        if (providerCache.size > 50) providerCache.delete(providerCache.keys().next().value as string);
      } catch (e) {
        log(`providers snapshot for ${cwd} failed: ${(e as Error).message}`);
        if (!hit) return null;
      }
    }
    return hit.entries;
  }
  async function providerEntry(cwd: string, provider: string, aux = bridge.aux): Promise<unknown | null> {
    return (await providerEntries(cwd, aux))?.find((x) => (x as { provider?: string }).provider === provider) ?? null;
  }

  // biome-ignore lint/suspicious/noExplicitAny: PaseoAgentHandle from the SDK.
  async function handleControls(req: IncomingMessage, res: ServerResponse, url: URL, ref: any, agentId: string, route: string, controlAux = bridge.aux): Promise<boolean> {
    const isGet = route === "/files" || route === "/controls";
    if (isGet && req.method !== "GET") return send(res, 405, { error: "GET required" }), true;
    if (!isGet) {
      if (req.method !== "POST") return send(res, 405, { error: "POST required" }), true;
      if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) return send(res, 415, { error: "content-type must be application/json" }), true;
    }
    const aux = controlAux;
    if (!aux) return send(res, 503, { error: "Paseo daemon connection not ready" }), true;
    const fresh = await withDaemonRead(() => ref.refresh()).catch((e: Error & { status?: number }) => {
      if (e.status === 503) throw e;
      return null;
    });
    // biome-ignore lint/suspicious/noExplicitAny: agent snapshot payload.
    const agent: any = (fresh as { agent?: unknown } | null)?.agent ?? null;
    if (!agent) return send(res, 404, { error: `agent ${agentId} not found` }), true;
    if (route === "/files") {
      const target = resolveImagePath(agent.cwd, url.searchParams.get("path"));
      const file = await withDaemonRead(() => aux.readFile(target.cwd, target.path, undefined, MAX_FILE_BYTES), 15_000).catch((e: Error & { status?: number }) => {
        throw Object.assign(new Error(`could not read ${path.basename(target.path)}: ${e.message}`), { status: e.status ?? 404 });
      });
      const mime = typeof file.mime === "string" && /^image\/(png|jpeg|gif|webp|bmp|avif)$/i.test(file.mime) ? file.mime : target.mime;
      if (typeof file.mime === "string" && file.mime && !file.mime.startsWith("image/") && file.mime !== "application/octet-stream") return send(res, 415, { error: `not an image (${file.mime})` }), true;
      if (file.bytes.byteLength > MAX_FILE_BYTES) return send(res, 413, { error: "image is larger than 8 MB" }), true;
      res.writeHead(200, { "content-type": mime, "content-length": String(file.bytes.byteLength), "cache-control": "private, max-age=300", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" });
      res.end(Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength));
      return true;
    }
    if (route === "/controls") {
      const entry = await providerEntry(String(agent.cwd ?? ""), String(agent.provider ?? ""), controlAux);
      send(res, 200, buildControls(agent, entry, { bound: watcher.isBoundAgent(agentId), connected: !!aux.isConnected }));
      return true;
    }
    const body = await readBody(req);
    let notice: { message?: string } | null = null;
    try {
      if (route === "/model") await aux.setAgentModel(agentId, parseModelBody(body).modelId);
      else if (route === "/mode") notice = await aux.setAgentMode(agentId, parseModeBody(body).modeId);
      else if (route === "/thinking") notice = await aux.setAgentThinkingOption(agentId, parseThinkingBody(body).optionId);
      else if (route === "/feature") {
        const f = parseFeatureBody(body);
        await aux.setAgentFeature(agentId, f.featureId, f.value);
      } else {
        const requestId = decodeURIComponent(route.slice("/permissions/".length));
        if (!requestId || requestId.length > 256) throw new InputError("invalid permission request id");
        const response = parsePermissionBody(body);
        const pending = Array.isArray(agent.pendingPermissions) ? agent.pendingPermissions : [];
        if (!pending.some((r: { id?: string }) => r?.id === requestId)) return send(res, 404, { error: `no pending permission request ${requestId}` }), true;
        await aux.respondToPermissionAndWait(agentId, requestId, response as never, 15_000);
      }
    } catch (e) {
      const err = e as Error & { status?: number };
      if (err.status) throw err;
      log(`agent control ${route} for ${agentId} failed: ${err.message}`);
      return send(res, transientDaemonError(err) ? 503 : 422, { error: err.message }), true;
    }
    log(`agent control ${route} for ${agentId} from the board UI`);
    transcripts.poke(agentId);
    send(res, 200, { ok: true, ...(notice?.message ? { notice: notice.message } : {}) });
    return true;
  }

  const clientPerf = new ClientPerfStore();
  const clientLaunches = new ClientLaunchStore();

  async function handleUi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname;
    if (!originAllowed(cfg, req)) {
      send(res, 403, { error: `origin ${req.headers.origin} is not allowed` });
      return true;
    }
    if (p === "/api/ui/frames/start") {
      if (req.method !== "POST") { send(res, 405, {error:"POST required"}); return true; }
      send(res, 202, startFrame(host, watcher, await readBody(req)));
      return true;
    }
    // Client perf reports (?perf=1 / ?perf=report): POST …/perf/client, GET …/perf/clients.
    if (p === "/api/ui/debug/perf/client" || p === "/api/ui/debug/perf/clients") {
      const raw = req.method === "POST" ? await readCappedText(req, CLIENT_PERF.maxBodyBytes) : null;
      const r = clientPerfRoute(clientPerf, req.method ?? "GET", p, raw, url.searchParams);
      if (r?.status === 204) {
        res.writeHead(204, { "cache-control": "no-store" });
        res.end();
      } else if (r) send(res, r.status, r.body);
      return true;
    }
    // Launch timings (canvas/src/launchTiming.ts): one POST per page load, logged; the last 100
    // kept for GET …/launches (server/client-launch.ts).
    if (p === "/api/ui/debug/launch" && req.method === "POST") {
      const raw = await readCappedText(req, CLIENT_LAUNCH.maxBodyBytes).catch(() => null);
      let body: unknown = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }
      const launch = sanitizeLaunch(body, String(req.headers["user-agent"] ?? ""), new Date());
      if (!launch) { send(res, 400, { error: "no launch steps" }); return true; }
      clientLaunches.add(launch);
      log(launchLogLine(launch));
      res.writeHead(204, { "cache-control": "no-store" });
      res.end();
      return true;
    }
    if (p === "/api/ui/debug/launches" && req.method === "GET") {
      send(res, 200, { launches: clientLaunches.list(Number(url.searchParams.get("limit")) || undefined) });
      return true;
    }
    // Errors the phone shell caught (canvas/src/mobile/ShellErrorBoundary.tsx): logged, and the
    // last 50 kept for GET …/client-errors. Bodies are capped and stored as plain text fields.
    if (p === "/api/ui/debug/client-error" && req.method === "POST") {
      const raw = await readCappedText(req, 8192).catch(() => null);
      let body: Record<string, unknown> = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { /* not JSON: keep nothing but the time */ }
      const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");
      const entry = { at: new Date().toISOString(), where: str(body.where, 60), message: str(body.message, 500), stack: str(body.stack, 2000), ua: str(req.headers["user-agent"], 200), url: str(body.url, 300) };
      clientErrors.push(entry);
      if (clientErrors.length > 50) clientErrors.shift();
      log(`client-error ${JSON.stringify({ where: entry.where, message: entry.message, ua: entry.ua })}`);
      res.writeHead(204, { "cache-control": "no-store" });
      res.end();
      return true;
    }
    if (p === "/api/ui/debug/client-errors" && req.method === "GET") {
      send(res, 200, { errors: clientErrors });
      return true;
    }
    // Touch traces from phones (?touchdebug=1, canvas/src/mobile/touchTrace.ts): appended to
    // <state>/touch-debug/<YYYY-MM-DD>.jsonl (server/touch-debug.ts); GET reads the last lines.
    if (p === "/api/ui/debug/touch") {
      if (req.method === "POST") {
        const raw = await readCappedText(req, TOUCH_DEBUG.maxBodyBytes).catch(() => null);
        let body: unknown = null;
        try { body = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }
        const lines = body ? sanitizeTouchBatch({ ...(body as object), ua: (body as { ua?: unknown }).ua ?? req.headers["user-agent"] }, Date.now()) : null;
        if (!lines) {
          send(res, 400, { error: "a touch batch needs a session id and events" });
          return true;
        }
        const r = appendTouchLines(cfg.stateDir, lines, Date.now());
        send(res, 200, { ok: true, written: r.written, capped: r.capped });
        return true;
      }
      if (req.method === "GET") {
        const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
        send(res, 200, { date, lines: readTouchLines(cfg.stateDir, date, Number(url.searchParams.get("tail") ?? 500)) });
        return true;
      }
      send(res, 405, { error: "GET or POST" });
      return true;
    }
    const fileUpload=p.match(/^\/api\/ui\/boards\/([^/]+)\/frames\/([^/]+)\/uploads$/);
    if(fileUpload){
      if(!uploads)throw Object.assign(new Error("Frame file delivery is not available on this backend"),{status:503});
      const board=decodeURIComponent(fileUpload[1]),frameId=decodeURIComponent(fileUpload[2]);
      if(req.method==='GET'){const id=url.searchParams.get('id'),key=url.searchParams.get('uploadId');if(!!id===!!key)throw new InputError('Choose exactly one receipt id or uploadId');send(res,200,{ok:true,receipt:key?uploads.getByUploadId(board,frameId,key):uploads.get(board,frameId,id!)});return true;}
      if(req.method!=='POST'){send(res,405,{error:'GET or POST required'});return true;}
      const expected=req.headers['x-expected-agent-id'];if(typeof expected!=='string'||!expected||expected.length>200)throw new InputError('X-Expected-Agent-Id is required');
      const boundAgent=()=>{
      if(!host.exists(board))throw Object.assign(new Error('Board not found'),{status:404});
      const frame=host.get(board).records.get(frameId);const binding=frame?.meta?.paseo;
      if(frame?.type!=='frame'||!binding?.agentId||binding.request)throw Object.assign(new Error('Wait for a bound frame before dropping a file'),{status:409});
      if(binding.host||watcher.remoteHostOf(binding.agentId))throw Object.assign(new Error('Remote frames need host-owned file delivery; a local disk path would not reach that agent'),{status:409});
      if(binding.agentId!==expected)throw Object.assign(new Error('Original frame binding changed; upload was not stored or redirected'),{status:409});
      return binding.agentId;};boundAgent();
      if(Number(req.headers['content-length']??0)>MAX_IMAGE_BYTES)throw Object.assign(new Error('File exceeds20MB upload limit'),{status:413});
      let bytes:Buffer;try{bytes=await readImageUpload(req);}catch(e){const error=e as Error;error.message=error.message.replaceAll('Image','File');throw error;}
      const receipt=await uploads.accept(board,frameId,boundAgent(),String(req.headers['x-upload-id']??''),url.searchParams.get('name')??'',bytes);
      send(res,201,{ok:true,receipt});return true;
    }
    const imageUpload=p.match(/^\/api\/ui\/boards\/([^/]+)\/assets$/);
    if(imageUpload){
      if(req.method!=='POST'){send(res,405,{error:'POST an image file'});return true;}
      const board=decodeURIComponent(imageUpload[1]);if(!host.exists(board))throw Object.assign(new Error('board does not exist'),{status:404});
      if(Number(req.headers['content-length']??0)>MAX_IMAGE_BYTES)throw Object.assign(new Error('Image exceeds 20 MB upload limit'),{status:413});
      const stored=persistImage(cfg,await readImageUpload(req));send(res,201,{...stored,url:stored.src});return true;
    }
    if (req.method === "POST" && !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
      send(res, 415, { error: "POST bodies must be application/json" });
      return true;
    }
    const org = p.match(/^\/api\/ui\/boards\/([^/]+)\/organizer(?:\/(undo|warm))?$/);
    if (org && organizer) {
      const board = decodeURIComponent(org[1]);
      if (req.method === "GET" && !org[2]) send(res, 200, organizer.status(board));
      else if (req.method === "POST" && org[2] === "warm") send(res, 200, organizer.warm(board));
      else if (req.method === "POST" && org[2] === "undo") {
        const body = await readBody(req);
        send(res, 200, organizer.undo(board, String(body.runId ?? "")));
      } else if (req.method === "POST") {
        const body = await readBody(req);
        const v = body.viewport as Record<string, unknown> | undefined;
        if (!v || ![v.x, v.y, v.w, v.h].every((n) => typeof n === "number" && Number.isFinite(n))) throw new InputError("viewport {x,y,w,h} is required");
        const selected = Array.isArray(body.selected) ? body.selected.filter((s): s is string => typeof s === "string").slice(0, 50) : [];
        const scope = (["board", "view", "selection", "area"] as const).find((k) => k === body.scope) ?? "view";
        const a = body.area as Record<string, unknown> | undefined;
        const area = a && [a.x, a.y, a.w, a.h].every((n) => typeof n === "number" && Number.isFinite(n)) ? (a as { x: number; y: number; w: number; h: number }) : undefined;
        const pageId = typeof body.pageId === "string" ? body.pageId : undefined;
        send(res, 202, organizer.ask(board, String(body.text ?? ""), v as { x: number; y: number; w: number; h: number }, selected, scope, area, pageId));
      } else send(res, 405, { error: "GET or POST required" });
      return true;
    }
    const channelRoute=p.match(/^\/api\/ui\/boards\/([^/]+)\/channels(?:\/([^/]+)\/revoke)?$/);
    if(channelRoute&&channels){
      const board=decodeURIComponent(channelRoute[1]);
      if(!BoardHost.validId(board)||!host.exists(board))throw new InputError('unknown board');
      if(req.method==='GET'&&!channelRoute[2])send(res,200,{channels:channels.list(board)});
      else if(req.method==='POST'){
        const body=await readBody(req);
        if(channelRoute[2])send(res,200,channels.revoke(board,decodeURIComponent(channelRoute[2])));
        else {if(typeof body.arrowId!=='string'||!Array.isArray(body.members)||!body.members.every(m=>typeof m==='string'))throw new InputError('arrowId and explicit members required');send(res,200,channels.enroll(board,body.arrowId,body.members as string[]));}
      }else send(res,405,{error:'GET or POST required'});
      return true;
    }
    if (p === "/api/ui/video-intake" && video) {
      if (req.method === "GET") send(res, 200, { items: video.ledger.list(), source: videoSource?.status() ?? {kind:"completion-post",connected:null} });
      else if (req.method === "POST") { const body = await readBody(req); if (typeof body.path !== "string") throw new InputError("path is required"); send(res, 202, await video.intake(body.path)); }
      else send(res, 405, { error: "GET or POST required" });
      return true;
    }
    const va = p.match(/^\/api\/ui\/video-intake\/([a-f0-9]{64})\/(approval|review|deliver)$/);
    if (va && video) {
      const item=video.ledger.get(va[1]);
      if(va[2]==='approval' && req.method==='POST') {
        const body=await readBody(req);
        if(body.decision!=='approved' && body.decision!=='rejected') throw new InputError('decision must be approved or rejected');
        send(res,200,video.decide(item.id,body.decision,String(body.expectedReviewUrl??''))); return true;
      }
      if(va[2]==='deliver' && req.method==='POST') {
        const body=await readBody(req);
        if(typeof body.routeId!=='string'||typeof body.board!=='string'||typeof body.frame!=='string') throw new InputError('routeId, board and frame required');
        send(res,200,await video.deliver(item.id,body.routeId,body.board,body.frame,bridge)); return true;
      }
      if(va[2]==='review' && req.method==='GET') {
        const esc=(x:string)=>x.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
        const link=item.reviewUrl ? `<a href="${esc(item.reviewUrl)}" target="_blank" rel="noopener noreferrer">Open prepared cut in new window</a>` : '<p>Review cut pending.</p>';
        res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
        res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>Content approval</title><h1 id="review-version" data-review="${esc(item.reviewUrl??'')}">Content approval</h1><p>${esc(path.basename(item.path))}</p><p>State: <strong>${item.approval}</strong></p>${link}<p>Approval records this decision only. Nothing publishes automatically.</p><button ${item.reviewUrl?'':'disabled'} onclick="decide('approved')">Approve</button> <button ${item.reviewUrl?'':'disabled'} onclick="decide('rejected')">Reject</button><p id="result"></p><script>async function decide(decision){const r=await fetch('./approval',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({decision,expectedReviewUrl:document.getElementById('review-version').dataset.review})});if(r.ok)location.reload();else document.getElementById('result').textContent=await r.text();}</script>`); return true;
      }
      send(res,405,{error:'unsupported method'}); return true;
    }
    const vr = p.match(/^\/api\/ui\/video-intake\/([a-f0-9]{64})\/retry$/);
    if (vr && req.method === "POST" && video) { video.start(vr[1]); send(res, 202, video.ledger.get(vr[1])); return true; }
    if (opts.widgets && (await handleWidgetHttp(req, res, url, opts.widgets, send, readBody))) return true;
    // The person opened a cloud session card's session (or clicked the card): poll it every few
    // seconds for a while, since a message to the session is likely next.
    if (p === "/api/ui/cloud-sessions/burst" && opts.cloud) {
      if (req.method !== "POST") { send(res, 405, { error: "POST required" }); return true; }
      const body = await readBody(req);
      if (typeof body.board !== "string" || typeof body.id !== "string" || !/^shape:[A-Za-z0-9_-]{1,64}$/.test(body.id)) throw new InputError("board and id (the card's shape id) are required");
      try { send(res, 200, opts.cloud.burst(body.board, body.id)); }
      catch (e) { send(res, 404, { error: (e as Error).message }); }
      return true;
    }
    if(p==='/api/ui/health'){send(res,200,bridge.health());return true;}
    if (p === "/api/ui/worker-settings") {
      const file=process.env.BUNNY_UPSTASH_SETTINGS;
      if(!file){send(res,404,{error:"Worker settings are unavailable on this host"});return true;}
      const settings=workerSettingsRuntime(WorkerSettingsLive(file));
      try {
        if(req.method==='GET')send(res,200,await settings.read());
        else if(req.method==='PUT')send(res,200,await settings.save(await readBody(req)));
        else send(res,405,{error:'GET or PUT required'});
      }catch(error){send(res,400,{error:(error as Error).message});}
      return true;
    }
    if (p === "/api/ui/deploy-status") {
      send(res, 200, readDeployStatus(path.join(cfg.stateDir, "deploy-status.json")));
      return true;
    }
    if (p === "/api/ui/info") {
      send(res, 200, {
        workerSettings: !!process.env.BUNNY_UPSTASH_SETTINGS,
        publicBase: cfg.publicBase,
        defaultProvider: cfg.defaultProvider,
        promptReceipts: !!prompts,
        // Prompt receipts end at delivered (seen in the agent timeline), not at the daemon ack.
        promptDelivery: prompts ? "timeline" : null,
        humanName: cfg.humanName,
        cloudDefault: cfg.cloudDefault,
        boardHostname: os.hostname().replace(/\.local$/, ""),
        runtimeHostname: (process.env.BUNNY_RUNTIME_HOSTNAME || os.hostname()).replace(/\.local$/, ""),
        paseoServerIds: remote?.paseoServerIds ?? {},
        // This Mac's short name (e.g. mac-1), for "agent · model · machine · status".
        machine: os.hostname().replace(/\.local$/, ""),
        // The machine the board's local agents run on (server/agent-machine.ts), or null when
        // unknown. Differs from `machine` when the board server runs apart from the agents.
        agentMachine: agentMachine(bridge.aux?.getLastServerInfoMessage()?.hostname, process.env.BUNNY_RUNTIME_HOSTNAME),
        providers: FALLBACK_PROVIDERS,
        paseo: !!bridge.api,
        hostHealth: bridge.health(),
        capabilities: {textBoundsMeasurementsSafe:true,exactTimeline:true,frameUploads:!!uploads,frameUploadBindingGuard:!!uploads,frameUploadRecoveryByUploadId:!!uploads,reportBundles:true,directoryCursorScan:true,directoryFresh:true},
        paseoServerId: paseoServerId(),
        remote: !!remote?.enabled,
      });
      return true;
    }
    // Harnesses and models for Start conversation: Paseo's live catalogue, or the fixed list.
    if (p === "/api/ui/cloud-doctor" && req.method === "GET") {
      send(res, 200, { codex: await opts.cloud?.codexDoctor() ?? { ready: false, error: "Cloud sessions are unavailable" } });
      return true;
    }
    if (p === "/api/ui/start-options") {
      // Paseo's catalogue (its daemon's providers: Codex asks its CLI, Claude ships a list,
      // plus models from Claude settings.json and Paseo's additionalModels), with any Claude
      // model the installed CLI reports that Paseo does not list yet.
      const [paseoEntries, liveClaude] = await Promise.all([providerEntries(cfg.defaultCwd).catch(() => null), process.env.BUNNY_LIVE_MODELS === "0" ? null : claudeCliModels.models()]);
      const entries = paseoEntries ? withLiveModels(paseoEntries, "claude", liveClaude) : null;
      const workerEntries = upstashDefault(cfg) ? withBaseModels(entries).filter((e: any) => /^upstash-(codex|claude)$/.test(e.provider)) : entries;
      const catalogue = workerEntries ? startCatalogue(workerEntries, cfg.defaultProvider) : null;
      if (catalogue && upstashDefault(cfg)) for (const harness of catalogue.harnesses) harness.label = harness.label.replace(/^Upstash /, "");
      send(res, 200, catalogue?.harnesses.length ? catalogue : fallbackCatalogue(cfg.defaultProvider, entries ? "Paseo reported no harnesses" : "Paseo's model list is not available right now"));
      return true;
    }
    if (p === "/api/ui/debug/transcripts") {
      const mem = process.memoryUsage();
      send(res, 200, { sseClients, streams:{opens:sseOpens,stalls:sseStalls}, hub: transcripts.stats(), operations:hostMetrics(log).snapshot(), componentEdits: watcher.componentEdits, memory: { rss: mem.rss, heapUsed: mem.heapUsed } });
      return true;
    }
    // Multiplexed live transcripts: one EventSource per page for every agent it shows
    // (browsers allow ~6 HTTP/1.1 connections per origin, so one stream per card would
    // starve the page at six cards). Each message is a full snapshot for one agent.
    if (p === "/api/ui/events") {
      const all = [...new Set((url.searchParams.get("agents") ?? "").split(",").map((x) => x.trim()).filter(Boolean))];
      const ids = all.slice(0, 64);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
      res.write("retry: 2000\n: connected\n\n");
      sseClients++;sseOpens++;
      const disposers: Array<() => void> = [];
      let closed = false;
      const stream=new SnapshotStream(res,()=>{sseStalls++;hostMetrics(log).record('board','transcript-stream-stall',30000,'timeout');});
      const write=(id:string,obj:unknown)=>stream.push(id,obj);
      for (const id of all.slice(64,128)) write(id,{ type: "denied", agentId: id, error: "at most 64 agents per stream" });
      for (const id of ids) {
        if (!watcher.isVisibleAgent(id)) {
          write(id,{ type: "denied", agentId: id, error: `agent ${id} is not bound to a frame or shown on a board` });
          continue;
        }
        disposers.push(transcripts.watch(id, (snap) => write(id,{ type: "snapshot", snap: { ...snap, paseoUrl: paseoUrl(id) } })));
      }
      const ping = setInterval(() => stream.heartbeat(), 15000);
      res.on("close", () => {
        if (closed) return;
        closed = true;
        sseClients--;
        stream.close();
        clearInterval(ping);
        for (const d of disposers) d();
      });
      return true;
    }
    if (p === "/api/ui/deliveries") {
      send(res, 200, watcher.deliveries);
      return true;
    }
    if (p === "/api/ui/debug/perf") {
      send(res, 200, { ...perfSnapshot(url.searchParams.get("reset") === "1"), rooms: host.all().map((r) => r.stats()) });
      return true;
    }
    if (p === "/api/ui/debug/directory") {
      send(res, 200, directory.stats());
      return true;
    }
    const recovery=p.match(/^\/api\/ui\/boards\/([^/]+)\/frames\/([^/]+)\/delta-delivery$/);
    if(recovery&&req.method==='POST'){
      const body=await readBody(req);
      if(!['accepted','discard','retry'].includes(String(body.decision)))throw new InputError('choose accepted, discard or retry');
      send(res,200,watcher.resolveDelta(decodeURIComponent(recovery[1]),decodeURIComponent(recovery[2]),String(body.operationId),body.decision as 'accepted'|'discard'|'retry'));return true;
    }
    const archiveRoute=p.match(/^\/api\/ui\/boards\/([^/]+)\/(archive|restore)$/);
    if(archiveRoute){if(req.method!=="POST")return send(res,405,{error:"POST required"}),true;const body=await readBody(req);if(body.confirm!==true)throw new InputError('Explicit confirm:true is required');const id=decodeURIComponent(archiveRoute[1]);send(res,200,archiveRoute[2]==='archive'?host.archive(id):host.restore(id));return true;}
    // Board list for the canvas header's switcher (and the Paseo app's "Add to board").
    if(p==="/api/ui/boards/resolve"&&req.method==="GET"){const found=resolveBoardName(url.searchParams.get("name")??"",id=>host.exists(id),cfg.boardAliases);send(res,200,{...found,url:`${cfg.publicBase}/?board=${encodeURIComponent(found.boardId)}`});return true;}
    if (p === "/api/ui/boards" && req.method === "GET") {
      send(res, 200, { boards: boardSummaries(host, cfg.publicBase) });
      return true;
    }
    // Board locks (header switches): Lock layout, Pause agents. GET reads, POST changes.
    let lm = p.match(/^\/api\/ui\/boards\/([^/]+)\/locks$/);
    if (lm) {
      const boardId = decodeURIComponent(lm[1]);
      if (!BoardHost.validId(boardId)) throw new InputError(`invalid board id ${boardId}`);
      if (req.method === "POST") {
        // Changed from the board page. Not a security boundary (any caller can send an
        // Origin header; the board is tailnet-only), but an agent's plain curl is turned away.
        if (!req.headers.origin) return send(res, 403, { error: "board locks are changed from the board page (the header switches)" }), true;
        if (!host.exists(boardId)) return send(res, 404, { error: `no board ${boardId}` }), true;
        const body = await readBody(req);
        for (const k of ["layout", "agentsPaused", "discard"]) if (body[k] !== undefined && typeof body[k] !== "boolean") throw new InputError(`${k} must be true or false`);
        const out = watcher.setLocks(host.get(boardId), {
          layout: body.layout as boolean | undefined,
          agentsPaused: body.agentsPaused as boolean | undefined,
          discard: body.discard === true,
          by: typeof body.by === "string" ? body.by : undefined,
        });
        send(res, 200, { ...out, queued: watcher.queuedOn(boardId) });
        return true;
      }
      send(res, 200, { locks: watcher.locks(boardId), queued: { ...(host.exists(boardId) ? watcher.queuedOn(boardId) : { deltas: 0, frames: 0, intros: 0 }), replies: prompts?.pendingOn(boardId) ?? 0 } });
      return true;
    }
    lm = null;
    // Import existing conversations: one frame + transcript card per agent, or one agent
    // into an existing frame ({frameId}).
    let m = p.match(/^\/api\/ui\/boards\/([^/]+)\/import$/);
    if (m && req.method === "POST") {
      const boardId = decodeURIComponent(m[1]);
      if (!BoardHost.validId(boardId)) throw new InputError(`invalid board id ${boardId}`);
      const body = await readBody(req);
      const at = body.at as { x?: unknown; y?: unknown } | undefined;
      const out = await importer.import(boardId, {
        agentIds: Array.isArray(body.agentIds) ? body.agentIds.map(String) : [],
        at: at && typeof at.x === "number" && typeof at.y === "number" ? { x: at.x, y: at.y } : null,
        pageId: typeof body.pageId === "string" ? body.pageId : null,
        frameId: typeof body.frameId === "string" ? body.frameId : null,
        host: typeof body.host === "string" && body.host ? body.host.slice(0, 100) : null,
        requestId: typeof body.requestId === "string" ? body.requestId.slice(0, 100) : null,
        by: typeof body.by === "string" ? body.by.slice(0, 60) : null,
        occupied: Array.isArray(body.occupied) ? (body.occupied as Array<{ x: number; y: number; w: number; h: number }>) : null,
      });
      send(res, 200, out);
      return true;
    }
    // Unbind: the frame becomes a plain frame; the conversation stays in Paseo.
    m = p.match(/^\/api\/ui\/boards\/([^/]+)\/frames\/([^/]+)\/unbind$/);
    if (m && req.method === "POST") {
      const boardId = decodeURIComponent(m[1]);
      if (!host.exists(boardId)) return send(res, 404, { error: `no board ${boardId}` }), true;
      send(res, 200, { ok: true, ...watcher.unbind(host.get(boardId), decodeURIComponent(m[2])) });
      return true;
    }
    const compressRoute = p.match(/^\/api\/ui\/boards\/([^/]+)\/frames\/([^/]+)\/compress$/);
    if (compressRoute && prompts && watcher.archive) {
      if (req.method !== "POST") return send(res,405,{error:"POST required"}),true;
      if (!req.headers.origin) return send(res,403,{error:"Compress from the board page"}),true;
      const boardId=decodeURIComponent(compressRoute[1]), frameId=decodeURIComponent(compressRoute[2]);
      const room=host.get(boardId), frame=room.records.get(frameId);
      const binding=frame?.meta?.paseo?.agentId ? watcher.boundRef(frame.meta.paseo.agentId) : null;
      if (!frame || !binding || binding.boardId!==boardId || binding.frameId!==frameId) throw new InputError("Frame has no bound agent");
      if (watcher.layoutLocked(boardId) || watcher.locks(boardId).agentsPaused) throw new InputError("Unlock layout and resume agents before compressing");
      const body=await readBody(req);
      if (typeof body.messageId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(body.messageId)) throw new InputError("A stable messageId is required");
      const prior=frame.meta.paseo.compression;
      if (prior?.messageId===body.messageId) {
        if (prior.status==='pending') {
          prompts.submit({messageId:body.messageId,agentId:frame.meta.paseo.agentId,host:watcher.remoteHostOf(frame.meta.paseo.agentId),boardId,frameId,text:compressionPrompt(frame,body.messageId)});
          void prompts.drain();
        }
        return send(res,200,{ok:true,...prior}),true;
      }
      const offer=frame.meta.paseo.compressionOffer;
      if (!offer || body.w!==frame.props.w || body.h!==frame.props.h || offer.w!==body.w || offer.h!==body.h) throw new InputError("Frame size changed; resize again before compressing");
      const shapes=[...new Set<string>([...offer.shapeIds,...compressionContents(room.records,frameId).map(r=>r.id)])];
      const archived=watcher.archive.archiveContents(room,frameId,shapes,cfg.humanName);
      const compression={messageId:body.messageId,archiveId:archived.id,w:frame.props.w,h:frame.props.h,status:'pending'};
      room.write({kind:'server',reason:'compress-request'},ops=>{
        const current=ops.get(frameId)!;
        const paseo={...current.meta.paseo,compression};delete paseo.compressionOffer;
        ops.put({...current,meta:{...current.meta,paseo}});
      });
      room.save();
      const current=room.records.get(frameId)!;
      const receipt=prompts.submit({messageId:body.messageId,agentId:current.meta.paseo.agentId,host:watcher.remoteHostOf(current.meta.paseo.agentId),boardId,frameId,text:compressionPrompt(current,body.messageId)});
      void prompts.drain();
      send(res,202,{ok:true,...compression,receipt});return true;
    }
    // Frame Archive (server/frame-archive.ts): the list, one entry's records (preview),
    // archive, restore, delete forever, and approving or dismissing an agent's clean-up
    // proposal. Changes come from the board page, like the lock switches.
    m = p.match(/^\/api\/ui\/boards\/([^/]+)\/frame-archive(?:\/(restore|delete|proposals\/[a-z0-9-]+|arch-[a-z0-9-]+))?$/);
    if (m && watcher.archive) {
      const boardId = decodeURIComponent(m[1]);
      if (!host.exists(boardId)) return send(res, 404, { error: `no board ${boardId}` }), true;
      const archive = watcher.archive;
      const room = host.get(boardId);
      if (req.method === "GET") {
        if (m[2]?.startsWith("arch-")) {
          const entry = archive.get(boardId, m[2]);
          return send(res, entry ? 200 : 404, entry ?? { error: `no archived frame ${m[2]}` }), true;
        }
        if (m[2]) return send(res, 405, { error: "POST required" }), true;
        send(res, 200, { items: archive.list(boardId), proposals: archive.proposals(boardId) });
        return true;
      }
      if (req.method !== "POST") return send(res, 405, { error: "POST required" }), true;
      if (!req.headers.origin) return send(res, 403, { error: "frames are archived, restored and deleted from the board page (Archive)" }), true;
      const body = await readBody(req);
      const by = typeof body.by === "string" && body.by.trim() ? body.by.trim().slice(0, 60) : cfg.humanName;
      const ids = (k: string) => (Array.isArray(body[k]) ? (body[k] as unknown[]).map(String) : []);
      const locked = () => {
        if (watcher.layoutLocked(boardId)) throw Object.assign(new Error("The board's layout is locked; unlock it to archive or restore frames"), { status: 409 });
      };
      if (!m[2]) {
        locked();
        const out = archive.archive(room, ids("frameIds"), { by });
        watcher.releaseArchived(room, out.released, by);
        send(res, 200, { ok: true, items: out.items });
      } else if (m[2] === "restore") {
        locked();
        send(res, 200, { ok: true, ...archive.restore(room, ids("ids"), by) });
      } else if (m[2] === "delete") {
        send(res, 200, { ok: true, ...archive.purge(room, ids("ids"), by) });
      } else if (m[2].startsWith("proposals/")) {
        const decision = body.decision === "dismiss" ? "dismiss" : body.decision === "approve" ? "approve" : null;
        if (!decision) throw new InputError("decision must be approve or dismiss");
        if (decision === "approve") locked();
        const out = archive.decide(room, m[2].slice("proposals/".length), decision, by, Array.isArray(body.frameIds) ? ids("frameIds") : undefined);
        watcher.releaseArchived(room, out.released, by);
        send(res, 200, { ok: true, proposal: out.proposal, items: out.items });
      } else send(res, 404, { error: "not found" });
      return true;
    }
    // Last activity per frame, for the phone's tiles: the newest settled edit in the frame's
    // History (people or agents, bound or not) or the binding's own times, as epoch ms.
    m = p.match(/^\/api\/ui\/boards\/([^/]+)\/frame-activity$/);
    if (m && req.method === "GET") {
      const boardId = decodeURIComponent(m[1]);
      if (!host.exists(boardId)) return send(res, 404, { error: `no board ${boardId}` }), true;
      send(res, 200, { frames: frameActivity(host.get(boardId).records, (frameId) => watcher.history?.lastAt(boardId, frameId) ?? null) });
      return true;
    }
    // Board snapshots (server/board-snapshots.ts): the list, and a restore that makes a NEW
    // board from one (never an in-place overwrite).
    m = p.match(/^\/api\/ui\/boards\/([^/]+)\/snapshots(?:\/(\d{8}T\d{9}Z)\/restore-copy)?$/);
    if (m && opts.snapshots) {
      const boardId = decodeURIComponent(m[1]);
      if (!BoardHost.validId(boardId)) return send(res, 400, { error: "invalid board id" }), true;
      if (!m[2] && req.method === "GET") return send(res, 200, { boardId, snapshots: opts.snapshots.list(boardId) }), true;
      if (m[2] && req.method === "POST") {
        const id = opts.snapshots.restoreCopy(boardId, m[2]);
        return send(res, 200, { boardId: id, restoredFrom: { boardId, snapshot: m[2] }, url: `${cfg.publicBase}/?board=${encodeURIComponent(id)}` }), true;
      }
      return send(res, 405, { error: "GET the list, or POST .../<stamp>/restore-copy" }), true;
    }
    // Frame History: the timeline (summaries), one version's records, and "Restore this version".
    m = p.match(/^\/api\/ui\/boards\/([^/]+)\/frames\/([^/]+)\/history(?:\/([a-z0-9-]+)(\/restore)?)?$/);
    if (m && watcher.history) {
      const boardId = decodeURIComponent(m[1]);
      const frameId = decodeURIComponent(m[2]);
      if (!host.exists(boardId)) return send(res, 404, { error: `no board ${boardId}` }), true;
      if (m[4]) {
        if (req.method !== "POST") return send(res, 405, { error: "POST required" }), true;
        // Like the lock switches: from the board page, not an agent's plain curl.
        if (!req.headers.origin) return send(res, 403, { error: "versions are restored from the board page (History)" }), true;
        const body = await readBody(req);
        const by = typeof body.by === "string" && body.by.trim() ? body.by.trim().slice(0, 60) : cfg.humanName;
        send(res, 200, { ok: true, ...watcher.restoreVersion(host.get(boardId), frameId, m[3], by) });
        return true;
      }
      if (req.method !== "GET") return send(res, 405, { error: "GET required" }), true;
      if (m[3]) {
        const entry = watcher.history.get(boardId, frameId, m[3]);
        if (!entry) return send(res, 404, { error: `no version ${m[3]}` }), true;
        send(res, 200, entry);
        return true;
      }
      send(res, 200, { frameId, entries: watcher.history.list(boardId, frameId) });
      return true;
    }
    // What a board link card shows: the target board's counts or one frame's status.
    m = p.match(/^\/api\/ui\/boards\/([^/]+)\/summary$/);
    if (m && req.method === "GET") {
      const boardId = decodeURIComponent(m[1]);
      if (!BoardHost.validId(boardId)) throw new InputError(`invalid board id ${boardId}`);
      const frame = url.searchParams.get("frame") ?? "";
      if (frame && !/^shape:[A-Za-z0-9_-]{1,64}$/.test(frame)) throw new InputError("invalid frame id");
      send(res, 200, watcher.linkTarget(boardId, frame));
      return true;
    }
    // "Archive agent X?" after a bound frame was deleted or unbound (released agents only).
    m = p.match(/^\/api\/ui\/released\/([^/]+)\/archive$/);
    if (m && req.method === "POST") {
      await watcher.archiveReleased(decodeURIComponent(m[1]));
      send(res, 200, { ok: true });
      return true;
    }
    // Restart a linked frame's conversation as a fresh agent with the board tools.
    m = p.match(/^\/api\/ui\/boards\/([^/]+)\/frames\/([^/]+)\/restart$/);
    if (m && req.method === "POST") {
      const boardId = decodeURIComponent(m[1]);
      if (!host.exists(boardId)) return send(res, 404, { error: `no board ${boardId}` }), true;
      const body = await readBody(req);
      const out = await watcher.restartWithTools(host.get(boardId), decodeURIComponent(m[2]), { archiveOld: body.archiveOld === true });
      send(res, 200, out);
      return true;
    }
    // Fork a frame's conversation into a new sibling frame with a new agent (frame-fork.ts).
    m = p.match(/^\/api\/ui\/boards\/([^/]+)\/frames\/([^/]+)\/fork$/);
    if (m && req.method === "POST") {
      const boardId = decodeURIComponent(m[1]);
      if (!host.exists(boardId)) return send(res, 404, { error: `no board ${boardId}` }), true;
      send(res, 202, await forkFrame(host.get(boardId), watcher, bridge, decodeURIComponent(m[2])));
      return true;
    }
    m = p.match(/^\/api\/ui\/boards\/([^/]+)\/outline$/);
    if (m) {
      if (!host.exists(m[1])) return send(res, 404, { error: `no board ${m[1]}` }), true;
      const f = url.searchParams.get("frame") ?? undefined;
      // scope=frame: exactly what that frame's agent sees from board_read (cards included).
      if (f && url.searchParams.get("scope") === "frame") {
        const shown: string[] = [];
        const recs = host.get(m[1]).records;
        for (const r of recs.values()) if (r.type === "transcript" && ancestors(recs, r).includes(f)) shown.push(String(r.props.agentId));
        await transcripts.prime(shown).catch(() => undefined);
        send(res, 200, watcher.frameOutline(m[1], f));
        return true;
      }
      send(res, 200, watcher.boardOutline(m[1], f));
      return true;
    }
    // The import picker: every Paseo agent, searched and filtered server-side from a
    // short cache (see agent-directory.ts).
    if (p === "/api/ui/start-hosts" && req.method === "GET") {
      try { send(res,200,{...(remote?.enabled ? remote.startHostsSnapshot(url.searchParams.get("fresh")==="1") : {hosts:[],refreshing:false}),...(!remote?.enabled?{note:"Remote hosts disabled here (no remote connection configured for this board)."}:{})}); }
      catch(error){send(res,503,{error:(error as Error).message});}
      return true;
    }
    // Opt-in "Smarter with AI" starter cards: one small-model call per user per 4 hours.
    if (p === "/api/ui/quick-starts/suggest" && req.method === "POST") {
      const body = await readBody(req);
      try {
        const r = await quickStartsAi.suggest(String(body.by ?? ""), body.prompts, body.context);
        send(res, "retryAfterMs" in r ? 429 : 200, r);
      } catch (error) {
        send(res, 503, { error: (error as Error).message });
      }
      return true;
    }
    if (p === "/api/ui/recheck-start" && req.method === "POST") {
      const body=await readBody(req);
      const room=host.get(String(body.boardId));
      const frame=room.records.get(String(body.frameId));
      if(!frame?.meta?.paseo?.remoteStart || !frame.meta.paseo.request)return send(res,409,{error:'No pending remote start'}),true;
      void watcher.fulfil(room,String(body.frameId));
      send(res,202,{ok:true});return true;
    }
    if (p === "/api/ui/agents/list" && url.searchParams.get("source") === "remote") {
      // Agents on the user's other machines (af-network sessions, cached for a minute).
      const sp = url.searchParams;
      if (!remote?.enabled) return send(res, 200, { rows: [], total: 0, matched: 0, ms: 0, routeMs: 0, stale: false, scope: "all", boardWorkspaceId: null, source: "remote", disabled: true, hasSnapshot:false,refreshing:false,directoryState:"disabled",retryAfterMs:null,message:"Other Macs directory is disabled.", errors: { all: "the remote source is off (af-network is not installed, or config remoteAgents is false)" } }), true;
      const t0 = performance.now();
      const r = remote.directorySnapshot(sp.get("fresh") === "1");
      const { rows, matched } = filterRows(r.rows, { q: (sp.get("q") ?? "").slice(0, 200), statuses: (sp.get("status") ?? "").split(",").filter((x) => ["running", "idle", "attention"].includes(x)), includeBound: sp.get("bound") === "1", includeArchived: false, offset: Number(sp.get("offset") ?? 0) || 0, limit: Number(sp.get("limit") ?? 200) || 200 }, (id) => watcher.boundRef(id));
      const hostOf = new Map(r.rows.map((x) => [x.id, x.host]));
      send(res, 200, { rows: rows.map((x) => ({ ...x, host: hostOf.get(x.id) ?? null })), total: r.rows.length, matched, ms: 0, routeMs: Math.round((performance.now() - t0) * 100) / 100, stale: r.stale, cacheAgeMs: r.ageMs, hasSnapshot:r.hasSnapshot, refreshing:r.refreshing, directoryState:r.directoryState, retryAfterMs:r.retryAfterMs, message:r.message, scope: "all", boardWorkspaceId: null, source: "remote", errors: r.errors });
      return true;
    }
    const snapshotRoute=p.match(/^\/api\/ui\/agents\/([^/]+)\/snapshot$/);
    if(snapshotRoute && req.method==='GET'){
      const agentId=decodeURIComponent(snapshotRoute[1]);
      if(!watcher.isVisibleAgent(agentId))return send(res,403,{error:'Conversation is not visible on this board'}),true;
      transcripts.prefetch(agentId,url.searchParams.get('recent')==='1',url.searchParams.get('retry')==='1');
      const snap=transcripts.summary(agentId)??remote?.snapshot(agentId)??null;
      send(res,200,{snap:snap?{...snap,paseoUrl:paseoUrl(agentId)}:null});return true;
    }
    // Queueing must work before the local plugin API bootstraps, including remote
    // prompts whose host can be healthy while the local host is reconnecting.
    const promptRoute = p.match(/^\/api\/ui\/agents\/([^/]+)\/(prompt|prompts\/([A-Za-z0-9_-]{8,100}))$/);
    if(promptRoute && prompts) {
      const agentId=decodeURIComponent(promptRoute[1]);
      const bound=watcher.boundRef(agentId);
      // A frame whose start is still pending takes replies too: they wait for the start.
      if(!bound||!(watcher.isBoundAgent(agentId)||watcher.startPendingFor(agentId)))return send(res,403,{error:"Conversation is no longer bound to this board frame"}),true;
      let receipt;
      if(promptRoute[2]==="prompt" && req.method==="POST") {
        const body=await readBody(req);
        if(typeof body.messageId!=="string")throw new InputError("A stable messageId is required");
        receipt=prompts.submit({messageId:body.messageId,agentId,host:watcher.remoteHostOf(agentId),boardId:bound.boardId,frameId:bound.frameId,text:String(body.text??"").trim(),...(typeof body.prev==="string"?{prev:body.prev}:{})});
        void prompts.drain();
      } else if(promptRoute[3] && req.method==="GET")receipt=prompts.get(agentId,promptRoute[3]);
      // DELETE: take back a queued reply that has not gone out yet (Edit / Remove in the box).
      else if(promptRoute[3] && req.method==="DELETE")receipt=prompts.withdraw(agentId,promptRoute[3]);
      else return send(res,405,{error:"Use POST prompt, GET prompt receipt or DELETE a queued prompt"}),true;
      // ok only once the agent's timeline shows the prompt; accepted is still being checked.
      const ok=receipt.status==="delivered";
      // final: nothing more will be learned. An unknown one is unconfirmed (may have
      // arrived; never resent); an accepted one is as far as this host can confirm.
      const status=receipt.final&&receipt.status!=="accepted"?"unconfirmed":receipt.status;
      send(res,ok?200:202,{ok,status,final:!!receipt.final,messageId:receipt.messageId,reason:receipt.reason,host:receipt.host,mode:receipt.mode??null,receipt:{messageId:receipt.messageId,status,attempts:receipt.attempts,reason:receipt.reason??null,deliveredAt:receipt.deliveredAt??null}});
      return true;
    }
    // Capabilities come from the binding alone, so the reply box does not wait on the
    // plugin API (whose bootstrap RPC can time out on a busy daemon).
    const capabilityRoute=p.match(/^\/api\/ui\/agents\/([^/]+)\/capabilities$/);
    if(capabilityRoute){
      const agentId=decodeURIComponent(capabilityRoute[1]);
      if(!watcher.isVisibleAgent(agentId))return send(res,403,{error:`agent ${agentId} is not bound to a board frame`}),true;
      if(req.method!=="GET")return send(res,405,{error:"GET required"}),true;
      const binding=watcher.boundRef(agentId);
      // A pending remote start is not bound yet: its frame names the host.
      const frameHost=(binding?host.peek(binding.boardId)?.get(binding.frameId)?.meta?.paseo?.host:null)??null;
      const targetHost = watcher.remoteHostOf(agentId) ?? frameHost;
      const native = targetHost ? await remote?.nativeSession(targetHost).catch(() => null) : null;
      send(res,200,{agentId,starting:watcher.startPendingFor(agentId),capabilities:agentCapabilities(targetHost,watcher.isBoundAgent(agentId)||watcher.startPendingFor(agentId),{paseoServerId:targetHost?remote?.paseoServerIds[targetHost]:paseoServerId(),linked:binding?host.peek(binding.boardId)?.get(binding.frameId)?.meta?.paseo?.linked===true:false,remoteNative:!!native,remoteStop:!!targetHost&&!!remote?.canCancel(targetHost)})});
      return true;
    }
    const api = bridge.api;
    if (!api) {
      send(res, 503, { error: "Paseo API not connected yet" });
      return true;
    }
    if(p==="/api/ui/agents/scan"){
      if(req.method!=="GET")return send(res,405,{error:"GET required"}),true;
      const sp=url.searchParams;if(sp.get("source")==="remote")return send(res,501,{error:"SDK cursor scans are local only"}),true;
      const board=sp.get("board");const boardWs=board&&host.exists(board)?watcher.boardWorkspaceId(host.get(board)):undefined;
      const out=await directory.page({q:(sp.get("q")??"").slice(0,200),statuses:(sp.get("status")??"").split(",").filter(x=>["running","idle","attention"].includes(x)),includeBound:sp.get("bound")==="1",includeArchived:sp.get("archived")==="1",workspaceId:sp.get("scope")==="board"?(boardWs??"(this board has no workspace yet)"):undefined},sp.get("cursor")??undefined,id=>watcher.boundRef(id));
      send(res,200,out);return true;
    }
    if (p === "/api/ui/agents/list") {
      const sp = url.searchParams;
      const boardId = sp.get("board");
      const scope = sp.get("scope") === "board" ? "board" : "all";
      const boardWs = boardId && host.exists(boardId) ? watcher.boardWorkspaceId(host.get(boardId)) : undefined;
      const t0 = performance.now();
      const out = await directory.list(
        {
          fresh: sp.get("fresh") === "1",
          q: (sp.get("q") ?? "").slice(0, 200),
          statuses: (sp.get("status") ?? "").split(",").filter((x) => ["running", "idle", "attention"].includes(x)),
          workspaceId: scope === "board" ? (boardWs ?? "(this board has no workspace yet)") : undefined,
          includeBound: sp.get("bound") === "1",
          boundBoardId: sp.get("onBoard") === "1" ? (boardId ?? "") : undefined,
          includeArchived: sp.get("archived") === "1",
          offset: Number(sp.get("offset") ?? 0) || 0, limit: Number(sp.get("limit") ?? 200) || 200,
        },
        (id) => watcher.boundRef(id),
      );
      send(res, 200, { ...out, routeMs: Math.round((performance.now() - t0) * 100) / 100, scope, boardWorkspaceId: boardWs ?? null });
      return true;
    }
    if (p === "/api/ui/agents") {
      const page = await api.agents.list({ filter: { includeArchived: false }, page: { limit: 40 } } as never);
      send(
        res,
        200,
        page.entries.map(({ agent }) => ({ id: agent.id, title: agent.title, status: statusOf(agent), provider: agent.provider, cwd: agent.cwd, labels: agent.labels, updatedAt: agent.updatedAt })),
      );
      return true;
    }
    m = p.match(/^\/api\/ui\/agents\/([^/]+)(\/timeline(?:\/rows\/[^/]+)?|\/prompt|\/cancel|\/capabilities|\/files|\/controls|\/model|\/mode|\/thinking|\/feature|\/permissions\/[^/]+)?$/);
    if (!m) return false;
    const agentId = decodeURIComponent(m[1]);
    // The sidebar proxy only reaches agents bound to a frame or shown by a card on a
    // board, not every Paseo agent.
    if (!watcher.isVisibleAgent(agentId)) {
      send(res, 403, { error: `agent ${agentId} is not bound to a board frame` });
      return true;
    }
    const setter = !!m[2] && (SETTERS.has(m[2]) || m[2].startsWith("/permissions/"));
    // Prompting, stopping and the control setters are for agents bound to a frame; a
    // card grants reading only.
    if ((m[2] === "/prompt" || m[2] === "/cancel" || setter) && !watcher.isBoundAgent(agentId)) {
      send(res, 403, { error: `agent ${agentId} is shown on a board but not bound to a frame; open it in Paseo to prompt or stop it` });
      return true;
    }
    // A bound agent on another machine: replies go through af-network send (with a
    // receipt), the timeline is af-network read polled every 20 s, and it cannot be stopped.
    const remoteHost = watcher.remoteHostOf(agentId);
    const remoteNative = remoteHost ? await remote?.nativeSession(remoteHost).catch(() => null) : null;
    const binding=watcher.boundRef(agentId);
    const capabilities=agentCapabilities(remoteHost,watcher.isBoundAgent(agentId),{paseoServerId:watcher.remoteHostOf(agentId)?remote?.paseoServerIds[watcher.remoteHostOf(agentId)!]:paseoServerId(),linked:binding?host.peek(binding.boardId)?.get(binding.frameId)?.meta?.paseo?.linked===true:false,remoteNative:!!remoteNative,remoteStop:!!remoteHost&&!!remote?.canCancel(remoteHost)});
    if(m[2]==="/capabilities"){if(req.method!=="GET")send(res,405,{error:"GET required"});else send(res,200,{agentId,capabilities});return true;}
    if (remoteHost && (!remoteNative || m[2] === "/prompt" || m[2] === "/cancel")) {
      if (m[2] === "/files" || m[2] === "/controls" || setter) return send(res, 501, { error: `agent ${agentId} runs on ${remoteHost}; its controls and files are only available in Paseo on that machine` }), true;
      // Stop over the host's paired Paseo connection when there is one; otherwise say why not.
      if (m[2] === "/cancel") {
        if (req.method !== "POST") return send(res, 405, { error: "POST required" }), true;
        if (!remote?.canCancel(remoteHost)) return send(res, 409, { error: remote?.cancelBlocked(remoteHost) ?? `agent ${agentId} runs on ${remoteHost}; stop it in Paseo on that machine` }), true;
        try {
          await remote.cancel(remoteHost, agentId);
          log(`cancel ${agentId} on ${remoteHost} from the board UI`);
          send(res, 200, { ok: true, remote: remoteHost });
        } catch (e) {
          send(res, (e as { status?: number }).status ?? 502, { error: (e as Error).message });
        }
        return true;
      }
      if (m[2] === "/prompt" && req.method === "POST") {
        const body = await readBody(req);
        const text = String(body.text ?? "").trim();
        if (!text) throw new InputError("prompt text is empty");
        try {
          const receipt = await watcher.promptRemote(agentId, text);
          send(res, 200, { ok: true, remote: remoteHost, receipt });
        } catch (e) {
          const receipt = (e as { receipt?: unknown }).receipt;
          if (!receipt) throw e;
          send(res, 202, { ok: false, remote: remoteHost, receipt, error: (e as Error).message });
        }
        return true;
      }
      const snap = remote?.snapshot(agentId) ?? transcripts.summary(agentId) ?? null;
      const remoteState={coverage:"messages-only",stale:!snap?.remote?.polledAt||!!snap.error||Date.now()-snap.remote.polledAt>45000,staleAfterMs:45000,statusKnown:!!snap?.remote?.polledAt};
      if (m[2]?.startsWith("/timeline")) {
        if(m[2]!=="/timeline"||url.searchParams.has("before"))return send(res,501,{error:"Remote source has no exact row or older cursor capability",capabilities:{older:false,exact:false}}),true;
        return send(res,200,{agentId,rows:snap?.rows??[],remote:remoteHost,polledAt:snap?.remote?.polledAt??null,...remoteState,nextCursor:null,hasOlder:false,capabilities:{older:false,exact:false}}),true;
      }
      if (!m[2]) return send(res, 200, { id: agentId, title: snap?.title ?? null, status: snap?.status ?? "idle", remote: remoteHost, polledAt: snap?.remote?.polledAt ?? null, error: snap?.error ?? null, ...remoteState, capabilities, paseoUrl: null, lastUserMessage: summaryOf(lastHumanMessage(snap?.rows ?? [])) }), true;
      return false;
    }
    const ref = (remoteNative?.api ?? api).agents.ref(agentId);
    if (!m[2]) {
      const snap = await ref.refresh().catch(() => null);
      if (!snap) {
        send(res, 404, { error: `agent ${agentId} not found` });
        return true;
      }
      const a = snap.agent;
      const lastUserMessage = await lastUserMessageOf(agentId, (a as { lastUserMessageAt?: string | null }).lastUserMessageAt ?? null, ref.timeline).catch(() => null);
      send(res, 200, { id: a.id, title: a.title, status: statusOf(a), provider: a.provider, model: a.model, modeId: a.currentModeId, workspaceId: a.workspaceId, labels: a.labels, pendingPermissions: a.pendingPermissions?.length ?? 0, lastError: a.lastError, capabilities, paseoUrl: paseoUrl(a.id), lastUserMessage });
      return true;
    }
    if(m[2]?.startsWith("/timeline")) {
      if(req.method!=="GET")return send(res,405,{error:"GET required"}),true;
      const rowId=m[2].match(/^\/timeline\/rows\/(.+)$/)?.[1];
      send(res,200,rowId?await timelineRow(ref.timeline,agentId,decodeURIComponent(rowId)):await timelinePage(ref.timeline,agentId,url.searchParams.get("limit"),url.searchParams.get("before")));return true;
    }
    if (m[2] === "/prompt" && req.method === "POST") {
      const body = await readBody(req);
      const text = String(body.text ?? "").trim();
      if (!text) throw new InputError("prompt text is empty");
      const finish = hostOperation(log, "local", "prompt");
      try { await ref.send(text); finish(); }
      catch (error) { finish(error); throw error; }
      transcripts.poke(agentId);
      send(res, 200, { ok: true });
      return true;
    }
    if (m[2] === "/files" || m[2] === "/controls" || setter) return handleControls(req, res, url, ref, agentId, m[2], remoteNative?.daemon ?? bridge.aux);
    if (m[2] === "/cancel" && req.method === "POST") {
      await bridge.cancelAgent(agentId);
      log(`cancel ${agentId} from the board UI`);
      transcripts.poke(agentId);
      send(res, 200, { ok: true });
      return true;
    }
    return false;
  }

  // The last message the person sent an agent, for "You: …" on tiles and cards (the
  // agent summary above): from the rows the transcript hub already holds when they have
  // it, else from one tail page of the timeline (150 rows), kept until Paseo's
  // lastUserMessageAt changes. Never the whole timeline (shared/last-message.ts).
  const lastUserCache = new Map<string, { key: string | null; value: ReturnType<typeof summaryOf> }>();
  async function lastUserMessageOf(agentId: string, lastUserMessageAt: string | null, timeline: Parameters<typeof timelinePage>[0]) {
    const held = lastHumanMessage(transcripts.summary(agentId)?.rows ?? []);
    if (held) return summaryOf(held);
    const cached = lastUserCache.get(agentId);
    if (cached && cached.key === lastUserMessageAt) return cached.value;
    if (!lastUserMessageAt) return null;
    const value = summaryOf(lastHumanMessage((await timelinePage(timeline, agentId, "150", null)).rows));
    lastUserCache.set(agentId, { key: lastUserMessageAt, value });
    if (lastUserCache.size > 500) lastUserCache.delete(lastUserCache.keys().next().value!);
    return value;
  }

  // A file from board_add_artifact({kind:'file'}): streamed, with byte ranges (iOS needs
  // them for video). Active content (HTML, SVG, unknown types) gets a sandbox CSP, so
  // its scripts run in an opaque origin and cannot call the board's UI API.
  function serveFile(req: IncomingMessage, res: ServerResponse, sha: string, rawName: string, bundle = false): void {
    let name: string;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      return send(res, 404, "no such asset");
    }
    if (!bundle && name !== safeFileName(name)) return send(res, 404, "no such asset");
    let f: string;
    try { f = bundle ? bundleFilePath(path.join(cfg.assetsDir, "bundles", sha), name) : path.join(cfg.assetsDir, "files", sha, name); } catch { return send(res,404,"no such asset"); }
    let size: number;
    try {
      const st = statSync(f);
      if (!st.isFile()) return send(res, 404, "no such asset");
      size = st.size;
    } catch {
      return send(res, 404, "no such asset");
    }
    const type = FILE_MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream";
    const active = /html|svg|octet-stream|xml/.test(type);
    const headers: Record<string, string | number> = {
      "content-type": type,
      "x-content-type-options": "nosniff",
      "cache-control": "max-age=31536000, immutable",
      "accept-ranges": "bytes",
    };
    if(bundle)headers["access-control-allow-origin"]="*";
    if (active) headers["content-security-policy"] = "sandbox allow-scripts allow-popups allow-downloads";
    let start = 0;
    let end = size - 1;
    let status = 200;
    const range = String(req.headers.range ?? "").match(/^bytes=(\d*)-(\d*)$/);
    if (range && size > 0) {
      if (range[1] === "" && range[2] !== "") start = Math.max(0, size - Number(range[2]));
      else {
        start = Number(range[1] || 0);
        if (range[2] !== "") end = Math.min(size - 1, Number(range[2]));
      }
      if (start > end || start >= size) {
        res.writeHead(416, { "content-range": `bytes */${size}` });
        res.end();
        return;
      }
      status = 206;
      headers["content-range"] = `bytes ${start}-${end}/${size}`;
    }
    headers["content-length"] = size === 0 ? 0 : end - start + 1;
    res.writeHead(status, headers);
    if (req.method === "HEAD" || size === 0) {
      res.end();
      return;
    }
    const stream = createReadStream(f, { start, end });
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  }

  // Gzipped copies of canvas text files, per file and mtime: the 2.7 MB bundle is ~0.8 MB
  // gzipped, and slow links waited 30+ s for the raw bytes.
  // ponytail: compressed on the first request per file per deploy (~0.1 s for the bundle); precompress at build if that shows up.
  const gzipped = new Map<string, { mtimeMs: number; body: Buffer }>();

  // canvas/dist/assets/* names carry a content hash (Vite), so browsers keep them for good;
  // index.html is no-cache and names the current ones.
  function serveStatic(res: ServerResponse, pathname: string, range?: string, acceptEncoding?: string): void {
    const root = path.resolve(cfg.canvasDir);
    let file = path.normalize(path.join(root, decodeURIComponent(pathname)));
    const relative = path.relative(root, file);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return send(res, 403, "forbidden");
    if (!existsSync(file) || statSync(file).isDirectory()) {
      // A tab from an older deploy asking for a build file this deploy no longer has.
      if (pathname.startsWith("/assets/")) log(`static: ${pathname} is not in this build; served index.html`);
      file = path.join(root, "index.html");
    }
    if (!existsSync(file)) return send(res, 503, `canvas not built: ${root} (run npm run build:canvas)`);
    const type = MIME[path.extname(file)] ?? "application/octet-stream";
    // Plugin page clips (/plugin-media/*.webm): byte ranges, so players can seek (Safari needs them).
    if (type.startsWith("video/")) {
      const size = statSync(file).size;
      const m = range?.match(/^bytes=(\d*)-(\d*)$/);
      if (m && (m[1] || m[2])) {
        const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
        const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
        if (start >= size || start > end) {
          res.writeHead(416, { "content-range": `bytes */${size}` });
          res.end();
          return;
        }
        res.writeHead(206, { "content-type": type, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1, "cache-control": "max-age=3600" });
        createReadStream(file, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": size, "cache-control": "max-age=3600" });
      createReadStream(file).pipe(res);
      return;
    }
    const text = /^(text\/|application\/json|image\/svg)/.test(type);
    const gzip = text && /\bgzip\b/.test(acceptEncoding ?? "");
    let body: Buffer;
    if (gzip) {
      const { mtimeMs } = statSync(file);
      let hit = gzipped.get(file);
      if (hit?.mtimeMs !== mtimeMs) gzipped.set(file, (hit = { mtimeMs, body: gzipSync(readFileSync(file)) }));
      body = hit.body;
    } else body = readFileSync(file);
    res.writeHead(200, { "content-type": type, "cache-control": file.endsWith("index.html") ? "no-cache" : path.dirname(file) === path.join(root, "assets") || /^\d+\.\d+\.\d+$/.test(relative.split(path.sep)[0]) ? "private, max-age=31536000, immutable" : "max-age=3600", ...(text ? { vary: "accept-encoding" } : {}), ...(gzip ? { "content-encoding": "gzip" } : {}) });
    res.end(body);
  }

  const server = createServer((req, res) => {
    const url = requestUrl(req.url);
    if (!url) {
      res.writeHead(400, { "connection": "close" });
      res.end("Bad request target");
      return;
    }
    // Lets board-mcp.mjs tell this server from something else on its old port.
    res.setHeader("x-bunny", "1");
    res.setHeader("x-paseo-board", "1"); // Compatibility: older MCP processes discover by this header.
    void (async () => {
      try {
        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }
        // Frame agents send a bearer token, not basic credentials; handleAgent checks that
        // token against the frame binding. Only this route skips the basic auth gate.
        const am = url.pathname.match(/^\/api\/agent\/boards\/([^/]+)\/frames\/([^/]+)\/([a-z-]+)$/);
        if (am) return await handleAgent(req, res, am);
        // bunny backup: save every board now. Loopback only, with a token derived from the
        // state directory's secret (server/backup/flush.ts), so it also skips basic auth.
        if (url.pathname === FLUSH_PATH) {
          if (req.method !== "POST") return send(res, 405, { error: "POST only" });
          if (!isLoopback(req.socket.remoteAddress) || !checkBackupToken(cfg.secret, req.headers.authorization)) return send(res, 403, { error: "forbidden" });
          return send(res, 200, await flushForBackup(host, watcher.history, watcher.archive));
        }
        if (!requestAuthorized(auth, req)) {
          // Container health checks get liveness only, without board ids.
          if (url.pathname === "/api/health") return send(res, 200, { ok: true });
          res.writeHead(401, { "www-authenticate": CHALLENGE, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
          res.end("authentication required");
          return;
        }
        // Files from board_add_artifact({kind:'file'}). Sandboxed: an HTML report gets an
        // opaque origin, so its scripts cannot use the board's UI API (Origin check).
        const bundleAsset = url.pathname.match(/^\/api\/assets\/bundles\/([a-f0-9]{32})\/(.+)$/);
        if (bundleAsset) return serveFile(req,res,bundleAsset[1],bundleAsset[2],true);
        const fileAsset = url.pathname.match(/^\/api\/assets\/files\/([a-f0-9]{32})\/([^/]+)$/);
        if (fileAsset) return serveFile(req, res, fileAsset[1], fileAsset[2]);
        const asset = url.pathname.match(/^\/api\/assets\/([a-f0-9]{32}\.(png|jpg|gif|webp))$/);
        if (asset) {
          const f = path.join(cfg.assetsDir, asset[1]);
          if (!existsSync(f)) return send(res, 404, "no such asset");
          // ?w=<px>: a downscaled copy for phones (server/image-variants.ts); the original
          // when there is none.
          const w = Number(url.searchParams.get("w"));
          if (w) {
            const v = await imageVariant(cfg.assetsDir, asset[1], w).catch(() => null);
            if (v) {
              res.writeHead(200, { "content-type": MIME[`.${asset[2]}`], "cache-control": "max-age=31536000, immutable" });
              res.end(readFileSync(v));
              return;
            }
          }
          res.writeHead(200, { "content-type": MIME[`.${asset[2]}`], "cache-control": "max-age=31536000" });
          res.end(readFileSync(f));
          return;
        }
        if (url.pathname.startsWith("/api/ui/")) {
          if (await handleUi(req, res, url)) return;
          return send(res, 404, { error: "not found" });
        }
        if (url.pathname === "/api/health") return send(res, 200, { ok: true, boards: host.all().map((r) => r.id), paseo: !!bridge.api });
        if (url.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });
        serveStatic(res, url.pathname, req.headers.range, req.headers["accept-encoding"]);
      } catch (e) {
        const err = e as Error & { status?: number };
        const status = e instanceof ScopeError || e instanceof InputError || err.status ? err.status! : 500;
        if (status === 500) log(`http ${req.method} ${url.pathname} failed: ${err.stack}`);
        if (!res.headersSent) send(res, status, { error: err.message, ...((err as Error & {code?:string}).code ? {code:(err as Error & {code?:string}).code} : {}) });
        else res.end();
      }
    })();
  });

  server.on("upgrade", (req, socket, head) => {
    const url = requestUrl(req.url);
    if (!url) {
      socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    const m = url.pathname.match(/^\/api\/connect\/([^/]+)$/);
    const sessionId = connectionSessionId(url.searchParams.get("sessionId"), url.searchParams.get("lane"));
    if (!requestAuthorized(auth, req)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: " + CHALLENGE + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    if (!m || !sessionId || !BoardHost.validId(m[1]) || !originAllowed(cfg, req)) {
      if (m && !originAllowed(cfg, req)) log(`rejected websocket from origin ${req.headers.origin}`);
      socket.destroy();
      return;
    }
    // Canvases built before the current board components cannot validate their records
    // (they would reconnect forever). Close them with tldraw's CLIENT_TOO_OLD, which makes
    // the page ask for a refresh.
    if (Number(url.searchParams.get("components") ?? 0) < COMPONENTS_VERSION) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        log(`closing websocket from an outdated canvas (components=${url.searchParams.get("components") ?? "none"})`);
        ws.close(4099, "CLIENT_TOO_OLD");
      });
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      try{const room = host.get(m[1]);room.connect(ws, sessionId, url.searchParams.get("userId") ?? sessionId, url.searchParams.get("userName") || cfg.humanName);}catch{ws.close(4004,"BOARD_UNAVAILABLE");}
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, cfg.host, () => {
      log(`board server listening on ${cfg.host}:${cfg.port} (public ${cfg.publicBase})`);
      // Where the server is now, for MCP servers started with an older BOARD_URL (the
      // default port moved from 8791 to 8793 on 2026-10-27).
      try {
        writeFileSync(path.join(cfg.stateDir, "server.json"), JSON.stringify({ port: cfg.port, url: `http://127.0.0.1:${cfg.port}`, publicBase: cfg.publicBase, pid: process.pid, startedAt: new Date().toISOString() }));
      } catch (e) {
        log(`could not write server.json: ${(e as Error).message}`);
      }
      resolve(server);
    });
  });
}

// tldraw's useSync names its session after the browser tab (one id per tab), so a second
// connection from the same tab, the open portal's own editor, would take over the board's
// session. It asks for a separate lane (?lane=portal), which gets its own session id.
export function connectionSessionId(sessionId: string | null, lane: string | null): string | null {
  if (!sessionId) return null;
  if (!lane) return sessionId;
  return /^[a-z0-9-]{1,24}$/.test(lane) ? `${sessionId}~${lane}` : null;
}
