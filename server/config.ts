import { bunnyEnv } from "./bunny-env";
// Runtime configuration. Everything is overridable by ~/.paseo/plugins/board/config.json
// or environment variables; secrets live only under the state directory.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface BoardConfig {
  port: number;
  host: string;
  publicBase: string;
  stateDir: string;
  boardsDir: string;
  assetsDir: string;
  canvasDir: string;
  mcpEntry: string;
  // Standalone/container mode: the node binary and board URL the agent host uses to run
  // board-mcp.mjs (unset: this process's node and http://127.0.0.1:<port>, as in plugin mode).
  mcpNode?: string;
  agentBoardUrl?: string;
  defaultProvider: string;
  defaultCwd: string;
  boardAliases?: Record<string,string>;
  frameAgents?: { defaultContext?: "board" | "repo"; boardCwdRoot?: string; repoWorkspaces?: boolean };
  debounceMs: number;
  humanName: string;
  // Start form's "Use cloud agent" default (off for the standalone/compose board).
  cloudDefault: boolean;
  secret: string;
  maxWaitMs: number;
  // Live frames steer deltas into a busy agent's turn at most once per this many ms.
  busyDeltaMs?: number;
  allowedOrigins: string[];
  // Session mode per provider for agents the board creates (the owner's call: bypass is fine).
  modeIds: Record<string, string>;
  // One Paseo workspace per board, titled from workspaceTitle ({board} = board id).
  workspacePerBoard: boolean;
  workspaceTitle: string;
  // Explicit server identity, or local-file fallback when no runtime is selected.
  paseoServerId: string | null;
  // The import picker's "Other Macs" source (agents on other machines via af-network).
  remoteAgents: boolean;
  videoIntake?: { recordingsDir: string; boardId: string; source?: 'directory'|'obs'; watchFrom?: string; columnX?: number; startY?: number; pageId?: string; pollMs?: number; settleMs?: number; obsUrl?: string; obsPasswordEnv?: string };
}

export const DEFAULT_PORT = 8793;

export const DEFAULT_MODE_IDS: Record<string, string> = { claude: "bypassPermissions", codex: "full-access", omp: "full" };

function readServerId(): string | null {
  const f = path.join(process.env.PASEO_HOME ?? path.join(os.homedir(), ".paseo"), "server-id");
  try {
    return readFileSync(f, "utf8").trim() || null;
  } catch {
    return null;
  }
}

// Tailscale's range, RFC 6598 shared address space (100.N.x.x with N from 64 to 127).
const isTailnet = (ip: string) => {
  const m = /^100\.(\d+)\.\d+\.\d+$/.exec(ip);
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
};

// This machine's tailnet IPv4 addresses, in interface order, each once.
export function tailnetIps(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs ?? []) if (a.family === "IPv4" && isTailnet(a.address) && !out.includes(a.address)) out.push(a.address);
  }
  return out;
}

// The host the board last served on, from <state>/server.json (written at every start).
function lastPublicHost(stateDir: string): string | null {
  try {
    const s = JSON.parse(readFileSync(path.join(stateDir, "server.json"), "utf8"));
    return typeof s.publicBase === "string" ? new URL(s.publicBase).hostname : null;
  } catch {
    return null;
  }
}

// publicHost when config and env leave it unset (or "auto"): the only tailnet address; with
// several (a Mac with a second 100.x tunnel), the one the board last served on if this
// machine still has it, so an existing install keeps its links and allowed origin across
// restarts; else the first; with none, loopback.
export function autoPublicHost(ips: string[], last: string | null, warn: (m: string) => void = () => {}): string {
  if (ips.length === 0) return "127.0.0.1";
  if (ips.length === 1) return ips[0];
  if (last && ips.includes(last)) return last;
  warn(`several tailnet addresses (${ips.join(", ")}) and no earlier one to keep; using ${ips[0]}. Set publicHost in config.json to choose.`);
  return ips[0];
}

// What agents call the person at the board unless BUNNY_HUMAN_NAME or config.json humanName
// says otherwise. A name is personal data, so it is never discovered.
export const DEFAULT_HUMAN_NAME = "User";

// Frame agent settings from config.json, with BUNNY_FRAME_CONTEXT and BUNNY_BOARD_CWD_ROOT
// (where board-context agents get their scratch folders) on top.
function frameAgentConfig(user: BoardConfig["frameAgents"], context: string | undefined, cwdRoot: string | undefined): BoardConfig["frameAgents"] {
  const out = { ...user };
  if (context === "repo" || context === "board") out.defaultContext = context;
  if (cwdRoot) out.boardCwdRoot = cwdRoot;
  return user || context === "repo" || context === "board" || cwdRoot ? out : undefined;
}

export function loadConfig(pluginDir: string): BoardConfig {
  const stateDir = bunnyEnv("STATE") ?? path.join(os.homedir(), ".paseo", "plugins", "board");
  mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, "config.json");
  // biome-ignore lint/suspicious/noExplicitAny: user JSON.
  let user: Record<string, any> = {};
  if (existsSync(file)) {
    try {
      user = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      user = {};
    }
  }
  if (user.debug) process.env.BUNNY_DEBUG = "1";
  const secretFile = path.join(stateDir, "secret");
  if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  const secret = readFileSync(secretFile, "utf8").trim();
  // 8793 since 2026-10-27: 8791 is the macropad STT daemon's default port.
  const port = Number(bunnyEnv("PORT") ?? user.port ?? DEFAULT_PORT);
  // The configured address, else (unset or "auto") this machine's tailnet address.
  const ip = user.publicHost || bunnyEnv("PUBLIC_HOST") || "auto";
  const publicHost = ip === "auto" ? autoPublicHost(tailnetIps(), lastPublicHost(stateDir), (m) => console.warn(`[bunny] ${m}`)) : ip;
  // Standalone/container settings (server/standalone.ts). None of these is set in plugin mode.
  const env = process.env;
  const frameContext = bunnyEnv("FRAME_CONTEXT", env);
  const envBase = bunnyEnv("PUBLIC_BASE", env)?.replace(/\/$/, "") || undefined;
  return {
    port,
    videoIntake: user.videoIntake && typeof user.videoIntake.recordingsDir === "string" && typeof user.videoIntake.boardId === "string" ? user.videoIntake : undefined,
    host: bunnyEnv("HOST", env) ?? user.host ?? "0.0.0.0",
    publicBase: envBase ?? user.publicBase ?? `http://${publicHost}:${port}`,
    stateDir,
    boardsDir: path.join(stateDir, "boards"),
    assetsDir: path.join(stateDir, "assets"),
    canvasDir: user.canvasDir ?? path.join(pluginDir, "canvas", "dist"),
    mcpEntry: bunnyEnv("MCP_ENTRY", env) ?? path.join(pluginDir, "mcp", "board-mcp.mjs"),
    mcpNode: bunnyEnv("MCP_NODE", env) || undefined,
    agentBoardUrl: bunnyEnv("AGENT_URL", env) || undefined,
    defaultProvider: bunnyEnv("DEFAULT_PROVIDER", env) ?? user.defaultProvider ?? "claude/claude-opus-5-5",
    boardAliases: user.boardAliases && typeof user.boardAliases === "object" && !Array.isArray(user.boardAliases) ? user.boardAliases : {},
    // BUNNY_FRAME_CONTEXT=repo: frame agents start in defaultCwd, not a board scratch dir
    // under stateDir (needed when the agent runtime is another machine).
    frameAgents: frameAgentConfig(user.frameAgents, frameContext, bunnyEnv("BOARD_CWD_ROOT", env)),
    // Unset: the directory holding the board checkout (its workspace).
    defaultCwd: bunnyEnv("DEFAULT_CWD", env) ?? user.defaultCwd ?? path.dirname(path.resolve(pluginDir)),
    debounceMs: Number(user.debounceMs ?? 2500),
    humanName: bunnyEnv("HUMAN_NAME", env) || user.humanName || DEFAULT_HUMAN_NAME,
    cloudDefault: bunnyEnv("CLOUD_DEFAULT", env) === undefined ? user.cloudDefault === true : bunnyEnv("CLOUD_DEFAULT", env) !== "0",
    secret,
    maxWaitMs: Number(user.maxWaitMs ?? 10000),
    busyDeltaMs: Number(user.busyDeltaMs ?? 20000),
    allowedOrigins: [
      `http://${publicHost}:${port}`,
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      ...(Array.isArray(user.allowedOrigins) ? user.allowedOrigins : []),
      // Behind a proxy (deploy/compose) the browser's origin is the public URL.
      ...(envBase ? [new URL(envBase).origin] : []),
      ...(bunnyEnv("ALLOWED_ORIGINS", env) ?? "").split(",").map((o) => o.trim()).filter(Boolean),
    ],
    modeIds: { ...DEFAULT_MODE_IDS, ...(user.modeIds && typeof user.modeIds === "object" ? user.modeIds : {}) },
    workspacePerBoard: user.workspacePerBoard !== false,
    workspaceTitle: typeof user.workspaceTitle === "string" && user.workspaceTitle ? user.workspaceTitle : "Board {board}",
    paseoServerId: user.paseoServerId ?? ((env.RUNTIME_WS || bunnyEnv("DAEMON_WS", env) || env.BUNNY_RUNTIME_HOSTNAME) ? null : readServerId()),
    remoteAgents: user.remoteAgents !== false && bunnyEnv("REMOTE") !== "0",
  };
}

// A frame token authorises exactly one (board, frame) pair. It is what the MCP
// server for that frame's agent presents; it cannot address any other frame.
// The token also names the agent, so re-binding a frame revokes the old agent's access.
export function frameToken(secret: string, boardId: string, frameId: string, agentId: string): string {
  return createHmac("sha256", secret).update(`frame:${boardId}:${frameId}:${agentId}`).digest("hex");
}

export function checkFrameToken(secret: string, boardId: string, frameId: string, agentId: string, token: string): boolean {
  const want = Buffer.from(frameToken(secret, boardId, frameId, agentId));
  const got = Buffer.from(token);
  return want.length === got.length && timingSafeEqual(want, got);
}
