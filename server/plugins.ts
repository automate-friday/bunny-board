// "My registry": which plugins (shared/plugins.ts) this board server has installed. One
// small JSON file in the state dir, written atomically. The tray shows only installed
// plugins, and board_widget list marks the rest as available. Uninstalling hides a plugin
// from the tray and the agent list; widgets already on boards keep working.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_INSTALLED, isDevPlugin, PLUGINS, pluginInfo } from "../shared/plugins";
import { bunnyEnv } from "./bunny-env";

export class UnknownPluginError extends Error {}
// A developer plugin (shared/plugins.ts RELEASED_PLUGINS) asked for without the flag.
export class PluginNotAvailableError extends Error {}

// BUNNY_DEV_PLUGINS=1: offer developer plugins (slack, hello, App window and its apps) too.
export function devPluginsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = bunnyEnv("DEV_PLUGINS", env)?.trim().toLowerCase();
  return !!v && v !== "0" && v !== "false" && v !== "no";
}

export const notAvailableMessage = (id: string) =>
  `${JSON.stringify(id)} is a developer plugin and is not available on this board yet (only released plugins are offered; the board server enables developer plugins with BUNNY_DEV_PLUGINS=1)`;

export class PluginRegistry {
  private set: Set<string>;

  // file: null keeps the registry in memory (tests). devPlugins: offer developer plugins
  // too; without it they are hidden, but a stored choice for them is kept for when it is on.
  constructor(
    private readonly file: string | null,
    private readonly log: (m: string) => void = () => {},
    readonly devPlugins: boolean = devPluginsEnabled(),
  ) {
    this.set = new Set(this.load());
  }

  static inStateDir(stateDir: string, log?: (m: string) => void, devPlugins?: boolean): PluginRegistry {
    return new PluginRegistry(path.join(stateDir, "plugins.json"), log, devPlugins);
  }

  private load(): string[] {
    if (!this.file || !existsSync(this.file)) return DEFAULT_INSTALLED;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as { installed?: unknown };
      if (!Array.isArray(raw.installed)) throw new Error("no installed list");
      return raw.installed.filter((x): x is string => typeof x === "string" && !!pluginInfo(x));
    } catch (e) {
      this.log(`plugins: ${this.file} unreadable (${(e as Error).message}); using defaults`);
      return DEFAULT_INSTALLED;
    }
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, installed: this.stored(), updatedAt: new Date().toISOString() }, null, 2)}\n`);
    renameSync(tmp, this.file);
  }

  // Every stored id (developer plugins included), in catalogue order.
  private stored(): string[] {
    return PLUGINS.filter((p) => this.set.has(p.id)).map((p) => p.id);
  }

  isAvailable(id: string): boolean {
    return this.devPlugins || !isDevPlugin(id);
  }

  // Installed plugin ids this server offers, in catalogue order.
  installed(): string[] {
    return this.stored().filter((id) => this.isAvailable(id));
  }

  isInstalled(id: string): boolean {
    return this.set.has(id) && this.isAvailable(id);
  }

  install(id: string): string[] {
    if (!pluginInfo(id)) throw new UnknownPluginError(`unknown plugin ${JSON.stringify(id)}`);
    if (!this.isAvailable(id)) throw new PluginNotAvailableError(notAvailableMessage(id));
    if (!this.set.has(id)) {
      this.set.add(id);
      this.save();
      this.log(`plugins: installed ${id}`);
    }
    return this.installed();
  }

  uninstall(id: string): string[] {
    if (!pluginInfo(id)) throw new UnknownPluginError(`unknown plugin ${JSON.stringify(id)}`);
    if (this.set.delete(id)) {
      this.save();
      this.log(`plugins: uninstalled ${id}`);
    }
    return this.installed();
  }
}
