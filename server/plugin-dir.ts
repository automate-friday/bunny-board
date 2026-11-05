import { existsSync } from "node:fs";
import path from "node:path";

// BUNNY_PLUGIN_DIR wins; then the checkout this bundle sits in: the nearest directory above
// `from` holding paseo-plugin.json. core.cjs is loaded with require, so its __dirname is
// server/dist (the live plugin loads <checkout>/server/dist/core.cjs, so this is the live
// checkout there too). A bundle copied elsewhere (test/dev-server.mjs's /tmp/pb-dev) falls
// back to the cwd's checkout, then the cwd itself.
export function resolvePluginDir(env: string | undefined, from: string, cwd = process.cwd()): string {
  if (env) return env;
  for (const start of [from, cwd]) {
    for (let d = path.resolve(start); ; d = path.dirname(d)) {
      if (existsSync(path.join(d, "paseo-plugin.json"))) return d;
      if (path.dirname(d) === d) break;
    }
  }
  return path.resolve(cwd);
}
