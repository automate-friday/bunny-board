// Plugin widget contract shared by the board server and the canvas. A widget is a small
// live window (like an Android widget) with a manifest (this file's WidgetManifest), a
// canvas renderer (canvas/src/widgets/<id>/) and a server data source
// (server/widgets/<id>.ts). Kept free of React and `tldraw` so the server bundle can
// import it. Spec: specs/plugin-widgets.md.

import type { Validator } from "@tldraw/validate";

export type WidgetStatus = "connecting" | "live" | "stale" | "error";

// What the data source last reported for one widget config. Lives on the side channel
// (SSE, board_widget read), never in the document.
export interface WidgetState<D = unknown> {
  status: WidgetStatus;
  data: D | null;
  // One line for stale/error, e.g. "invalid_auth" or "ratelimited (retry in 3s)".
  reason?: string;
  // When the source last confirmed fresh data (ms since epoch); null before the first.
  syncedAt: number | null;
  updatedAt: number;
}

// One field of a widget's config form (and of its board_widget JSON schema).
export interface WidgetField {
  key: string;
  label: string;
  // "select" fields ask the data source for options (GET /api/ui/widgets/options).
  kind: "text" | "select";
  required?: boolean;
  help?: string;
  placeholder?: string;
  // Options depend on these fields; the form clears this field when they change.
  dependsOn?: string[];
  // A "select" field with a fixed list (no options request), e.g. the stamp's colour.
  choices?: { value: string; label: string }[];
  // Presets offered for a "text" field; any other valid text is allowed too.
  suggestions?: string[];
}

// biome-ignore lint/suspicious/noExplicitAny: config shapes differ per widget.
export type AnyConfig = Record<string, any>;

// --- Plugin page fields (the /plugins store and /plugins/<id> detail pages) ---------
// Media lives in canvas/public/plugin-media/<plugin id>/ and is served at
// /plugin-media/<plugin id>/<file>. A placeholder is a clearly labelled stand-in for a
// real screenshot not captured yet; the page says so on the image.
export interface PluginMedia {
  kind: "image" | "video";
  src: string;
  caption: string;
  // Video: a still shown before it plays.
  poster?: string;
  placeholder?: boolean;
}

// What a plugin reaches, in plain words, for the Permissions section.
export interface PluginPermission {
  kind: "network" | "data" | "board" | "browser" | "none";
  text: string;
}

export interface PluginPageFields {
  // One line under the name: what it is.
  tagline: string;
  // "What it does", plain language, a short paragraph.
  about: string;
  // "Why it matters": a concrete use case on a board.
  whyItMatters: string;
  category: string;
  permissions: PluginPermission[];
  // First image is the store tile's poster.
  media: PluginMedia[];
  version: string;
}

export interface WidgetManifest<C extends AnyConfig = AnyConfig, D = unknown> extends PluginPageFields {
  id: string;
  label: string;
  // A line icon name (canvas/src/components/widget/icons.tsx) for the tray and title bar.
  // Not an emoji: widget UI uses tldraw-style line icons only.
  icon: string;
  description: string;
  size: { w: number; h: number };
  // No fresh data for this long while "live" turns the widget "stale".
  staleMs: number;
  // Optional: a deadline that depends on the config (e.g. the app widget's probe interval).
  staleMsFor?(config: C): number;
  fields: WidgetField[];
  // Validators for each config key; unknown keys are rejected.
  configProps: { [K in keyof C]-?: Validator<C[K]> };
  defaults(): C;
  // Enough config to start the data source; otherwise the canvas shows the form.
  configured(config: C): boolean;
  // Short title-bar text, e.g. "#project" (state may name things the config only ids).
  summary(config: C, state: WidgetState<D> | null): string;
  // Optional extra inside the status parens of board_read, e.g. "120ms" -> "(live, 120ms)".
  statusDetail?(config: C, state: WidgetState<D> | null): string;
  // One-line data summary for board_read and board_widget read.
  describe(config: C, state: WidgetState<D> | null): string;
  // Optional: a link out to the service behind the widget (e.g. "Open in Postiz"). The
  // generic header shows it as a new-tab link (http(s) only), and board_widget returns it
  // as `link` so agents can hand it on. Null when there is nothing to link to.
  headerLink?(config: C, state: WidgetState<D> | null): { href: string; label: string; title?: string } | null;
}

// A header link's href, if it is a plain http(s) URL without credentials; else null.
export function safeHttpUrl(href: unknown): string | null {
  if (typeof href !== "string" || href.length > 2000) return null;
  try {
    const u = new URL(href);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export const WIDGET_STATUSES: WidgetStatus[] = ["connecting", "live", "stale", "error"];
