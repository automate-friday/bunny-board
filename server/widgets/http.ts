// Widget routes on the board's UI API (same auth as the rest of /api/ui):
//   GET  /api/ui/widgets/events?ids=<key>&ids=<key>  one multiplexed SSE stream for every
//        widget on the page; each message is {key, state}.
//   GET  /api/ui/widgets/options?key=<key>&field=<field>   choices for a config field.
//   POST /api/ui/widgets/action  {key, action, input}      e.g. Slack "post".
//   POST /api/ui/widgets/<widgetId>/admin {…}              test controls (Slack mock faults).
//   GET  /api/ui/debug/widgets                             running watches and counters.
//   GET  /api/ui/plugins                                   installed plugin ids ("My registry").
//   POST /api/ui/plugins/install|uninstall {id}            change it; returns the new list.
// A key is "<widgetId>:<config json>" (shared/widgets widgetKey); the server re-validates
// the config, so a page can only start watches a person could configure on the board.

import type { IncomingMessage, ServerResponse } from "node:http";
import { visiblePlugins } from "../../shared/plugins";
import { WidgetConfigError } from "../../shared/widgets";
import { devPluginsEnabled, PluginNotAvailableError, UnknownPluginError } from "../plugins";
import { SnapshotStream } from "../snapshot-stream";
import type { WidgetHub } from "./index";

const MAX_STREAM_WIDGETS = 32;

export async function handleWidgetHttp(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  hub: WidgetHub,
  send: (res: ServerResponse, code: number, body: unknown) => void,
  readBody: (req: IncomingMessage) => Promise<Record<string, unknown>>,
): Promise<boolean> {
  const p = url.pathname;
  if (p === "/api/ui/debug/widgets") {
    send(res, 200, hub.stats());
    return true;
  }
  if (p === "/api/ui/plugins" && req.method === "GET") {
    // devPlugins: whether this server offers developer plugins (BUNNY_DEV_PLUGINS=1); the
    // store and tray show only released ones otherwise.
    const devPlugins = hub.plugins ? hub.plugins.devPlugins : devPluginsEnabled();
    send(res, 200, { installed: hub.plugins ? hub.plugins.installed() : visiblePlugins(devPlugins).map((x) => x.id), persistent: !!hub.plugins, devPlugins });
    return true;
  }
  const pm = p.match(/^\/api\/ui\/plugins\/(install|uninstall)$/);
  if (pm && req.method === "POST") {
    if (!hub.plugins) {
      send(res, 503, { error: "this board server has no plugin registry" });
      return true;
    }
    const body = await readBody(req);
    try {
      const id = String(body.id ?? "");
      send(res, 200, { installed: pm[1] === "install" ? hub.plugins.install(id) : hub.plugins.uninstall(id) });
    } catch (e) {
      send(res, e instanceof UnknownPluginError ? 404 : e instanceof PluginNotAvailableError ? 403 : 400, { error: (e as Error).message });
    }
    return true;
  }
  if (!p.startsWith("/api/ui/widgets/")) return false;
  const parse = (key: string) => {
    const k = hub.parseKey(key);
    if (!k) throw new WidgetConfigError(`bad widget key ${JSON.stringify(key.slice(0, 80))}`);
    return k;
  };
  try {
    if (p === "/api/ui/widgets/events" && req.method === "GET") {
      const keys = [...new Set(url.searchParams.getAll("ids").filter(Boolean))];
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
      res.write("retry: 2000\n: connected\n\n");
      const stream = new SnapshotStream(res, () => undefined);
      const disposers: Array<() => void> = [];
      for (const key of keys.slice(MAX_STREAM_WIDGETS))
        stream.push(key, { key, state: { status: "error", data: null, reason: `at most ${MAX_STREAM_WIDGETS} widgets per page`, syncedAt: null, updatedAt: Date.now() } });
      for (const key of keys.slice(0, MAX_STREAM_WIDGETS)) {
        const k = hub.parseKey(key);
        if (!k) {
          stream.push(key, { key, state: { status: "error", data: null, reason: "bad widget key", syncedAt: null, updatedAt: Date.now() } });
          continue;
        }
        disposers.push(hub.watch(k.widgetId, k.config, (state) => stream.push(key, { key, state })));
      }
      const ping = setInterval(() => stream.heartbeat(), 15000);
      let closed = false;
      res.on("close", () => {
        if (closed) return;
        closed = true;
        stream.close();
        clearInterval(ping);
        for (const d of disposers) d();
      });
      return true;
    }
    if (p === "/api/ui/widgets/options" && req.method === "GET") {
      const k = parse(url.searchParams.get("key") ?? "");
      send(res, 200, { options: await hub.options(k.widgetId, url.searchParams.get("field") ?? "", k.config) });
      return true;
    }
    if (p === "/api/ui/widgets/action" && req.method === "POST") {
      const body = await readBody(req);
      const k = parse(String(body.key ?? ""));
      const input = body.input && typeof body.input === "object" && !Array.isArray(body.input) ? (body.input as Record<string, unknown>) : {};
      send(res, 200, await hub.action(k.widgetId, k.config, String(body.action ?? ""), input));
      return true;
    }
    const admin = p.match(/^\/api\/ui\/widgets\/([a-z][a-z0-9-]{0,39})\/admin$/);
    if (admin && req.method === "POST") {
      const out = hub.admin(admin[1], await readBody(req));
      if (out === null) send(res, 404, { error: `widget ${admin[1]} has no admin controls here` });
      else send(res, 200, out);
      return true;
    }
  } catch (e) {
    if (res.headersSent) return true;
    send(res, 400, { error: (e as Error).message });
    return true;
  }
  return false;
}
