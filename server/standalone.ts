import { migrateLegacyEnv } from "./bunny-env";
// Standalone board server: runs the board core (server/dist/core.cjs) outside the Paseo
// plugin host, against an agent runtime reachable over WebSocket. This is the entrypoint
// for deploy/compose; the original install still runs as a Paseo plugin (index.server.ts)
// and does not load this file.
//
//   RUNTIME_WS=ws://runtime:6767/ws BUNNY_STATE=/data/board node server/dist/standalone.cjs
//
// Settings come from the environment (deploy/compose/.env.example lists them):
//   RUNTIME_WS          agent runtime (Paseo daemon) WebSocket URL       (default ws://127.0.0.1:6767/ws)
//   BUNNY_STATE   board state dir (boards, assets, secret)         (default /data/board)
//   BOARD_PORT          HTTP port, bound on BOARD_HOST                   (default 8793, 0.0.0.0)
//   BOARD_PUBLIC_URL    the URL people open (behind the proxy)           (default http://localhost:<port>)
//   BOARD_AGENT_URL     the board's URL as seen from the agent runtime   (default http://127.0.0.1:<port>)
//   BOARD_DEFAULT_CWD   repo-context agents' working directory           (default /workspaces)
//   BOARD_MCP_ENTRY / BOARD_MCP_NODE  board-mcp.mjs and node on the runtime host (default: same paths here)
//   BOARD_FRAME_CONTEXT  board (scratch dir under the state dir, default) or repo (BOARD_DEFAULT_CWD)
//   BOARD_HUMAN_NAME, BOARD_DEFAULT_PROVIDER, BOARD_ALLOWED_ORIGINS, BOARD_RPC_PORT (optional)
//
// The plugin host delivers agent lifecycle hooks (turn started/ended, permissions, archive)
// to the core. Here they are derived from the runtime's agent_update stream instead, so a
// frame's status and its reply flush work the same way.

import { createServer } from "node:http";
import path from "node:path";
import { createPaseoClient, type PaseoClient } from "@getpaseo/client";
import { statusOf } from "./paseo-bridge";

const env = process.env;
migrateLegacyEnv(env);
// The core reads BUNNY_* at load time, so map the standalone names before requiring it.
const alias: Record<string, string> = {
  RUNTIME_WS: "BUNNY_DAEMON_WS",
  BOARD_PORT: "BUNNY_PORT",
  BOARD_HOST: "BUNNY_HOST",
  BOARD_PUBLIC_URL: "BUNNY_PUBLIC_BASE",
  BOARD_AGENT_URL: "BUNNY_AGENT_URL",
  BOARD_DEFAULT_CWD: "BUNNY_DEFAULT_CWD",
  BOARD_MCP_ENTRY: "BUNNY_MCP_ENTRY",
  BOARD_MCP_NODE: "BUNNY_MCP_NODE",
  BOARD_HUMAN_NAME: "BUNNY_HUMAN_NAME",
  BOARD_DEFAULT_PROVIDER: "BUNNY_DEFAULT_PROVIDER",
  BOARD_ALLOWED_ORIGINS: "BUNNY_ALLOWED_ORIGINS",
  BOARD_FRAME_CONTEXT: "BUNNY_FRAME_CONTEXT",
  BOARD_CWD_ROOT: "BUNNY_BOARD_CWD_ROOT",
};
for (const [from, to] of Object.entries(alias)) if (env[from] && !env[to]) env[to] = env[from];
env.BUNNY_DAEMON_WS ??= "ws://127.0.0.1:6767/ws";
env.BUNNY_STATE ??= "/data/board";
env.BUNNY_PORT ??= "8793";
env.BUNNY_PUBLIC_BASE ??= `http://localhost:${env.BUNNY_PORT}`;
env.BUNNY_DEFAULT_CWD ??= "/workspaces";
// Board-context agents work in /workspaces/boards/<board>: the persistent workspaces volume,
// which the runtime shares, and outside the private state directory, so the files they write
// can be attached to the board. Boards that already have a Paseo workspace keep its folder.
env.BUNNY_BOARD_CWD_ROOT ??= "/workspaces/boards";
// A stranger's board: agents call the person "User" (not the owner's name) unless BOARD_HUMAN_NAME says
// otherwise, and new frames start as plain agents (the cloud path is a workflow of the original install).
env.BUNNY_HUMAN_NAME ||= "User";
env.BUNNY_CLOUD_DEFAULT ??= "0";
// af-network (other Macs) is a tool of the original install; off unless asked for.
env.BUNNY_REMOTE ??= "0";
// The repo root: server/dist/standalone.cjs sits two levels below it.
env.BUNNY_PLUGIN_DIR ??= path.resolve(__dirname, "..", "..");

// biome-ignore lint/suspicious/noExplicitAny: hook payloads
type Handler = (event: any, ctx: { paseo: PaseoClient }) => unknown;
type Core = { contribute(server: unknown): () => Promise<void> };

const log = (m: string) => console.log(`[standalone] ${m}`);
const daemonWs = env.BUNNY_DAEMON_WS;
const paseo = createPaseoClient({ url: daemonWs, clientId: `board-standalone-${process.pid}`, appVersion: "0.11.4" });

// The plugin server context the core expects: RPC handlers, before-hooks and event hooks.
// biome-ignore lint/suspicious/noExplicitAny: RPC definitions from shared/rpc
const rpcs = new Map<string, { rpc: any; fn: Handler }>();
const hooks = new Map<string, Handler[]>();
const server = {
  // biome-ignore lint/suspicious/noExplicitAny: RPC definitions from shared/rpc
  handle(rpc: any, fn: Handler) {
    rpcs.set(rpc.name, { rpc, fn });
    // The core's bridge captures its PaseoApi through this RPC; there is no plugin host to call it.
    if (rpc.name === "board.bootstrap") fn({}, { paseo });
  },
  // agent.create before-hooks inject the board MCP into agents other tools create; a
  // standalone board only sees agents it creates itself, which already carry it.
  before() {},
  on(event: string, fn: Handler) {
    hooks.set(event, [...(hooks.get(event) ?? []), fn]);
  },
};
const emit = (event: string, payload: unknown) => {
  for (const fn of hooks.get(event) ?? []) {
    try {
      void Promise.resolve(fn(payload, { paseo })).catch((e) => log(`${event} hook failed: ${(e as Error).message}`));
    } catch (e) {
      log(`${event} hook failed: ${(e as Error).message}`);
    }
  }
};

// --- lifecycle hooks from agent_update --------------------------------------------------
// biome-ignore lint/suspicious/noExplicitAny: agent snapshot payload
type Seen = { inTurn: boolean; permission: boolean; archived: boolean; agent: any };
const seen = new Map<string, Seen>();
// biome-ignore lint/suspicious/noExplicitAny: agent snapshot payload
function observe(agent: any, announce: boolean) {
  if (!agent?.id) return;
  const status = statusOf(agent);
  const now: Seen = {
    inTurn: agent.status === "running" || !!agent.activeTurn,
    permission: status === "needs-permission",
    archived: status === "archived",
    agent,
  };
  const was = seen.get(agent.id);
  seen.set(agent.id, now);
  if (!was) {
    if (announce) emit("agent.created", { agent });
    return;
  }
  const e = { agent };
  if (!was.inTurn && now.inTurn) emit("agent.turn_started", e);
  if (!was.permission && now.permission) emit("agent.permission_requested", e);
  if (was.permission && !now.permission) emit("agent.permission_resolved", e);
  if (was.inTurn && !now.inTurn) emit("agent.turn_ended", { agent, outcome: { kind: agent.status === "error" ? "failed" : "completed" } });
  if (!was.archived && now.archived) emit("agent.archived", e);
}

paseo.agents.subscribe((u) => {
  // biome-ignore lint/suspicious/noExplicitAny: agent_update payload union
  const update = u as any;
  if (update.kind === "upsert") observe(update.agent, true);
  else if (update.kind === "remove") seen.delete(update.agentId);
});

// (Re)list on every connect: starts the daemon's agent_update stream and catches up on
// turns that ended while the connection was down.
async function resync() {
  try {
    const out = await paseo.agents.list({ subscribe: {} });
    // biome-ignore lint/suspicious/noExplicitAny: FetchAgentsEntry
    for (const entry of out.entries as any[]) observe(entry.agent ?? entry, false);
    log(`runtime ${daemonWs}: ${out.entries.length} agent(s)`);
  } catch (e) {
    log(`agent list failed: ${(e as Error).message}`);
  }
}
let connected = false;
setInterval(() => {
  const up = paseo.getConnectionState().status === "connected";
  if (up && !connected) void resync();
  connected = up;
}, 1000).unref();

// --- core ---------------------------------------------------------------------------------
// Loaded after the env mapping above; compile cache as in index.server.ts.
const nodeModule = require("node:module") as { enableCompileCache?: (dir?: string) => unknown };
nodeModule.enableCompileCache?.(path.join(__dirname, ".compile-cache"));
const core = require(path.join(__dirname, "core.cjs")) as Core;
log(`state ${env.BUNNY_STATE}, runtime ${daemonWs}, public ${env.BUNNY_PUBLIC_BASE}`);
const stop = core.contribute(server);
// Bind HTTP before the runtime answers; API actions await the connection.
void paseo.connect().catch((e) => log(`runtime connection: ${(e as Error).message}`));

// Optional loopback RPC port for the Paseo-side actions (board.add-agent, board.boards).
if (env.BOARD_RPC_PORT) {
  createServer(async (req, res) => {
    const name = decodeURIComponent((req.url ?? "").replace(/^\/rpc\//, ""));
    const h = rpcs.get(name);
    let body = "";
    for await (const c of req) body += c;
    try {
      if (!h) throw new Error(`no rpc ${name}`);
      const input = h.rpc.input.parse(body ? JSON.parse(body) : {});
      const out = h.rpc.output.parse(await h.fn(input, { paseo }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
  }).listen(Number(env.BOARD_RPC_PORT), "127.0.0.1");
}

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  log("stopping");
  await stop().catch((e) => log(`stop failed: ${(e as Error).message}`));
  await paseo.close().catch(() => undefined);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
