// What the widget tray offers, given "My registry" (no React, no tldraw: unit-tested).
import { isDevPlugin, PLUGINS } from "../../../shared/plugins";
import { WIDGETS } from "../../../shared/widgets";

// Same shape as components/widget/dragSource's WidgetPreset.
export interface TrayPreset {
  id: string;
  label: string;
  description: string;
  config: Record<string, unknown>;
  title?: string;
  badge?: string;
  badgeTone?: "good" | "muted";
}

// Only plugins installed in "My registry" (/plugins) show here: installed widgets, then
// installed apps (an App window preconfigured for one app; frameable ones first, tagged
// "embeds", the rest "card": the server re-checks framing at runtime, so a tag is a hint).
// "Browse plugins" opens the store. Developer plugins (shared/plugins.ts) show only when
// the board server offers them.
export function trayContents(installed: readonly string[] | null, devPlugins = false) {
  const has = (id: string) => (installed === null || installed.includes(id)) && (devPlugins || !isDevPlugin(id));
  const widgets = WIDGETS.filter((m) => installed !== null && has(m.id));
  const apps: TrayPreset[] = PLUGINS.filter((p) => p.kind === "app" && installed !== null && has(p.id))
    .sort((a, b) => Number(!!b.app?.frameable) - Number(!!a.app?.frameable))
    .map((p) => ({
      id: p.id,
      label: p.name,
      description: p.tagline,
      badge: p.app?.frameable ? "embeds" : "card",
      badgeTone: p.app?.frameable ? "good" : "muted",
      config: p.preset ?? {},
      title: `${p.name}: ${p.app?.demo}\n${p.app?.frameable ? "Shows inside the window" : "Blocks framing: shows a status card with Open"} (checked ${p.app?.checkedAt}: ${p.app?.observed}; re-checked live)\nSource: ${p.source.url} (${p.source.license})\nDrag onto the board, or tap to add it`,
    }));
  return { widgets, apps };
}

