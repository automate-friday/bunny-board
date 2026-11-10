// The plugin registry's catalogue: every installable plugin with its page (/plugins/<id>).
// Two kinds:
//   - "widget": a widget manifest (shared/widgets), e.g. hello, slack, app;
//   - "app": an app-catalog entry (shared/widgets/app-catalog.ts) — an App window widget
//     preconfigured for one open-source app; installing it adds that ready-made window
//     to the tray.
// Which ones are installed ("My registry") lives on the board server
// (server/plugins.ts, <state>/plugins.json). No React or tldraw imports.

import { APP_CATALOG, APP_CATALOG_CHECKED_AT, appPreview, PREVIEW_OF } from "./widgets/app-catalog";
import { type AnyConfig, type PluginMedia, type PluginPermission, type WidgetField, WIDGETS } from "./widgets";

export interface PluginInfo {
  id: string;
  kind: "widget" | "app";
  // The widget it adds to the board.
  widgetId: string;
  name: string;
  icon: string;
  tagline: string;
  about: string;
  whyItMatters: string;
  category: string;
  permissions: PluginPermission[];
  media: PluginMedia[];
  version: string;
  source: { label: string; url: string; license: string };
  // The settings a person (or agent) fills in; for an app, which are pre-filled.
  fields: WidgetField[];
  preset?: AnyConfig;
  app?: { demo: string; frameable: boolean; observed: string; checkedAt: string };
  // Shown on its page and tile: this plugin is on its way out.
  retiring?: string;
}

const BUNNY_SOURCE = { label: "automate-friday/bunny-board", url: "https://github.com/automate-friday/bunny-board", license: "Bundled with Bunny" };

// Plugins on their way out (id -> one line for the page and tile). Empty today: the stamp
// button retired for good with Stamps v2 (a built-in toolbar tool, not a plugin).
const RETIRING: Record<string, string> = {};

const widgetPlugins: PluginInfo[] = WIDGETS.map((m) => ({
  id: m.id,
  kind: "widget",
  widgetId: m.id,
  name: m.label,
  icon: m.icon,
  tagline: m.tagline,
  about: m.about,
  whyItMatters: m.whyItMatters,
  category: m.category,
  permissions: m.permissions,
  media: m.media,
  version: m.version,
  source: BUNNY_SOURCE,
  fields: m.fields,
  ...(RETIRING[m.id] ? { retiring: RETIRING[m.id] } : {}),
}));

const appWindow = WIDGETS.find((m) => m.id === "app");

const appPlugins: PluginInfo[] = APP_CATALOG.map((a) => {
  const host = new URL(a.demo).host;
  const shared: PluginMedia = a.frameable
    ? { kind: "image", src: "/plugin-media/app/framed.png", caption: "How a frameable app shows on the board: inside the window, with its health light (local stand-in page)." }
    : { kind: "image", src: "/plugin-media/app/card.png", caption: "How an app that refuses framing shows on the board: a card with health and Open (local stand-in page)." };
  return {
    id: a.id,
    kind: "app",
    widgetId: "app",
    name: a.name,
    icon: "app",
    tagline: a.tagline,
    about: a.about,
    whyItMatters: a.whyItMatters,
    category: a.category,
    permissions: [
      { kind: "network", text: `The board server checks ${host} every 30 s (status, response time and framing headers only; never the page).` },
      { kind: "browser", text: a.frameable ? `Your browser loads ${host} in a sandboxed window on the board.` : `Open takes you to ${host} in a new tab; the board shows a card, not the page.` },
    ],
    media: [{ kind: "image", src: appPreview(a.id), caption: PREVIEW_OF[a.id] ? `${a.name}: ${PREVIEW_OF[a.id]}.` : `${a.name}: its public demo.` }, shared],
    version: appWindow?.version ?? "1.0.0",
    source: { label: a.repo.replace("https://github.com/", ""), url: a.repo, license: a.license },
    fields: appWindow?.fields ?? [],
    preset: { url: a.demo, title: a.name },
    app: { demo: a.demo, frameable: a.frameable, observed: a.observed, checkedAt: APP_CATALOG_CHECKED_AT },
  };
});

export const PLUGINS: PluginInfo[] = [...widgetPlugins, ...appPlugins];

// Released plugins: the only ones the store (/plugins), the widget tray and board_widget
// list offer. A plugin is listed only after real use on the board and the board owner's approval
// (specs/plugin-widgets.md › Direction). Everything else (slack, hello, the App window and
// its catalogue apps) is a developer plugin: hidden unless the board server runs with
// BUNNY_DEV_PLUGINS=1. Their code, shapes and data sources stay, so widgets already on a
// board keep loading.
// TODO(#27): add the wait clock / timer once "Wait clock card + a Components drawer" lands
// (it is a board component there, not a widget; list it here when it becomes one).
// content-calendar: released at the board owner's request so agents can put a Postiz
// content calendar on a board with board_widget add.
export const RELEASED_PLUGINS: readonly string[] = ["claude-activity", "content-calendar", "github-pr"];

export const isDevPlugin = (id: string): boolean => !RELEASED_PLUGINS.includes(id);

// The plugins a board server offers: released ones, or every one with developer plugins on.
export function visiblePlugins(devPlugins: boolean): PluginInfo[] {
  return PLUGINS.filter((p) => devPlugins || !isDevPlugin(p.id));
}

export const DEV_PLUGIN_NOTE = "Developer plugin: not released yet, so it is hidden from the store, the tray and agents (BUNNY_DEV_PLUGINS=1 shows it).";

export function pluginInfo(id: string): PluginInfo | undefined {
  return PLUGINS.find((p) => p.id === id);
}

// A fresh board has every widget installed (as before the registry) and no app presets;
// people install the apps they want from /plugins.
export const DEFAULT_INSTALLED: string[] = widgetPlugins.map((p) => p.id);

export function pluginPoster(p: PluginInfo): PluginMedia | undefined {
  return p.media.find((m) => m.kind === "image") ?? p.media[0];
}

// Built-in features that live on the toolbar rather than in the widget tray (like Stamps
// v2). Listed on /plugins so people find them where the plugins are, with a page each,
// but never installed or uninstalled: every board has them. Not part of PLUGINS, so My
// registry, the tray and board_widget list are unchanged.
export interface BuiltinInfo {
  id: string;
  name: string;
  tagline: string;
  about: string;
  whyItMatters: string;
  howTo: string[];
  category: string;
  permissions: PluginPermission[];
  media: PluginMedia[];
  version: string;
  source: { label: string; url: string; license: string };
}

export const BUILTINS: BuiltinInfo[] = [
  {
    id: "portals",
    name: "Portals",
    tagline: "Link a sticky to another place on the board, open it in place, or jump there and back.",
    about:
      "A sticky can be a portal to a shape (another sticky, a frame, a card, in any frame) or to an area of the board. Its portal button opens a window under the sticky through which the destination is live: you can select, move, type into stickies and add shapes there, and it changes the real content. Jump there moves the board to it; the Back pill returns you to exactly where you were.",
    whyItMatters:
      "Boards outgrow their frames. When an agent runs out of room and writes the details somewhere else, or a note depends on research in another frame, a portal keeps the link: you see and edit the other place without losing your spot. Agents make portals too (board_write / board_update with portal), and board_read shows them.",
    howTo: [
      "Select a sticky, pick Portal in the bottom toolbar (next to Arrow), then click a shape, or drag a box around an area.",
      "No sticky selected? Pick Portal and click the sticky first. Esc cancels.",
      "Or draw an arrow from a sticky to the target and choose Make portal from the right-click menu. Remove portal is there too.",
      "Click the sticky's portal button to open the portal; Jump there to go; Back to return.",
    ],
    category: "Navigation",
    permissions: [{ kind: "none", text: "Nothing outside the board: a portal is a link stored on the sticky, and the open portal shows this board's own content." }],
    media: [
      { kind: "image", src: "/plugin-media/portals/open.png", caption: "An open portal under its sticky: the destination is live and editable." },
      { kind: "image", src: "/plugin-media/portals/tool.png", caption: "The Portal tool: with a sticky selected, click a shape or drag an area." },
      { kind: "image", src: "/plugin-media/portals/badges.png", caption: "Portal buttons in each sticky's colour." },
    ],
    version: "1.0.0",
    source: BUNNY_SOURCE,
  },
];

export function builtinInfo(id: string): BuiltinInfo | undefined {
  return BUILTINS.find((b) => b.id === id);
}
