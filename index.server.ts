import type { PluginServerContext } from "@getpaseo/plugin/server";

// The board core (tldraw sync room, frame watcher, HTTP server) is pre-bundled by
// `npm run build:server` into server/dist/core.cjs. Paseo's compiler follows type
// declarations into every dependency, and tldraw's declarations reach React, which
// the server bundle may not import. Loading the pre-built file at runtime keeps
// that graph out of the plugin compile. The bundle is eval'd, so the plugin
// directory is configured rather than derived from __dirname: BUNNY_PLUGIN_DIR (or the older
// PASEO_BOARD_PLUGIN_DIR), else the path Paseo installed the plugin from
// (plugins.board.path in $PASEO_HOME/config.json).
function pluginDir(): string {
  const env = process.env.BUNNY_PLUGIN_DIR ?? process.env.PASEO_BOARD_PLUGIN_DIR;
  if (env) return env;
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const home = process.env.PASEO_HOME ?? `${(require("node:os") as typeof import("node:os")).homedir()}/.paseo`;
  try {
    const dir = JSON.parse(readFileSync(`${home}/config.json`, "utf8"))?.plugins?.board?.path;
    if (typeof dir === "string" && dir) return dir;
  } catch {
    // Reported below.
  }
  throw new Error(`Bunny plugin: set BUNNY_PLUGIN_DIR to the board checkout (no plugins.board.path in ${home}/config.json)`);
}
const PLUGIN_DIR = pluginDir();

type Core = { contribute(server: PluginServerContext): () => Promise<void> };

export default function contribute(server: PluginServerContext) {
  // Paseo gives a plugin 30 s to report ready, and parsing this ~10 MB bundle alone took
  // 9-19 s on a busy machine (2026-10-30), so restarts timed out. Node's compile cache keeps
  // the compiled bundle on disk, so later loads skip most of that work.
  (require("node:module") as { enableCompileCache?: (dir?: string) => unknown }).enableCompileCache?.(`${PLUGIN_DIR}/server/dist/.compile-cache`);
  const load = require as (id: string) => Core;
  const core = load(`${PLUGIN_DIR}/server/dist/core.cjs`);
  return core.contribute(server);
}
