// Widget registry and the one generic `widget` shape every plugin widget uses. Adding a
// widget adds a manifest here (and a data source and renderer); it never changes the
// tldraw schema, because the shape only holds {widgetId, config, w, h}. The config is
// checked against the widget's own validators whenever it is written (widgetProps).

import { createShapePropsMigrationSequence } from "@tldraw/tlschema";
import { T } from "@tldraw/validate";
import { appWidget } from "./app";
import { claudeActivityWidget } from "./claude-activity";
import { helloWidget } from "./hello";
import { slackWidget } from "./slack";
import type { AnyConfig, WidgetField, WidgetManifest, WidgetState } from "./types";

export * from "./types";

export const WIDGET_TYPE = "widget" as const;

export interface WidgetProps {
  widgetId: string;
  config: AnyConfig;
  w: number;
  h: number;
}

// biome-ignore lint/suspicious/noExplicitAny: each manifest has its own config type.
export const WIDGETS: WidgetManifest<any, any>[] = [helloWidget, slackWidget, claudeActivityWidget, appWidget];

export function widgetManifest(id: string): WidgetManifest | undefined {
  return WIDGETS.find((w) => w.id === id);
}

const MAX_CONFIG_BYTES = 4000;

const dimension = T.number.check((v) => {
  if (!Number.isFinite(v) || v <= 0) throw new Error("Widget dimensions must be positive and finite");
});

// The record schema stays generic: any small JSON object. The per-widget check runs on
// write (widgetProps) and again in the data source, which reports a bad config as error.
export const widgetShapeProps = {
  widgetId: T.string.check((v) => {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(v)) throw new Error("widgetId must be a short lowercase id");
  }),
  config: T.jsonValue.check((v) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("widget config must be an object");
    if (JSON.stringify(v).length > MAX_CONFIG_BYTES) throw new Error(`widget config must be under ${MAX_CONFIG_BYTES} bytes`);
  }) as unknown as T.Validator<AnyConfig>,
  w: dimension,
  h: dimension,
};

export const widgetMigrations = createShapePropsMigrationSequence({ sequence: [] });

export class WidgetConfigError extends Error {}

// A widget's config with blanks dropped and every key validated; throws WidgetConfigError.
export function widgetConfig(widgetId: string, input: unknown): AnyConfig {
  const m = widgetManifest(widgetId);
  if (!m) throw new WidgetConfigError(`unknown widget ${JSON.stringify(widgetId)}; installed: ${WIDGETS.map((w) => w.id).join(", ")}`);
  if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input))) throw new WidgetConfigError("config must be an object");
  const given = (input ?? {}) as AnyConfig;
  for (const k of Object.keys(given))
    if (!(k in m.configProps)) throw new WidgetConfigError(`${widgetId} config has no field ${JSON.stringify(k)}; fields: ${Object.keys(m.configProps).join(", ")}`);
  const defaults = m.defaults();
  const out: AnyConfig = {};
  for (const [k, validator] of Object.entries(m.configProps as Record<string, T.Validator<unknown>>)) {
    let v = given[k] ?? defaults[k];
    const required = !!m.fields.find((f) => f.key === k)?.required;
    // A blank required field stays "" (not set up yet; configured() says so); blank
    // optional fields are left out, so equal configs get equal keys.
    if (v === "" && required) {
      out[k] = "";
      continue;
    }
    if (v === "") v = undefined;
    if (v === undefined) continue;
    try {
      out[k] = validator.validate(v);
    } catch (e) {
      throw new WidgetConfigError(`${widgetId} config.${k}: ${(e as Error).message}`);
    }
  }
  if (JSON.stringify(out).length > MAX_CONFIG_BYTES) throw new WidgetConfigError("config is too large");
  return out;
}

export function widgetProps(widgetId: string, config: unknown, size?: { w?: number; h?: number }): WidgetProps {
  const m = widgetManifest(widgetId);
  const c = widgetConfig(widgetId, config);
  return { widgetId, config: c, w: size?.w ?? m!.size.w, h: size?.h ?? m!.size.h };
}

// Stable key for one (widget, config) pair: shapes with the same config share one watch.
export function widgetKey(widgetId: string, config: AnyConfig): string {
  const sorted = Object.fromEntries(Object.entries(config).sort(([a], [b]) => a.localeCompare(b)));
  return `${widgetId}:${JSON.stringify(sorted)}`;
}

export function isConfigured(widgetId: string, config: AnyConfig): boolean {
  const m = widgetManifest(widgetId);
  if (!m) return false;
  try {
    return m.configured(widgetConfig(widgetId, config));
  } catch {
    return false;
  }
}

// One line for board_read: `widget slack #project (live): 3 new messages…`.
export function widgetOutline(props: Pick<WidgetProps, "widgetId" | "config">, state: WidgetState | null): string {
  const m = widgetManifest(props.widgetId);
  if (!m) return `widget ${props.widgetId} (not installed)`;
  if (!isConfigured(props.widgetId, props.config)) return `widget ${m.id} (not set up yet; configure it with board_widget configure)`;
  const detail = state ? (m.statusDetail?.(props.config, state) ?? "") : "";
  const st = state ? `${state.status}${detail ? `, ${detail}` : ""}${state.reason ? `: ${state.reason}` : ""}` : "not open";
  const desc = m.describe(props.config, state);
  return `widget ${m.id} ${m.summary(props.config, state)} (${st})${desc ? ` ${JSON.stringify(desc.length > 160 ? `${desc.slice(0, 159)}…` : desc)}` : ""}`;
}

// JSON schema of a widget's config, for board_widget list.
export function widgetJsonSchema(m: WidgetManifest): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const f of m.fields as WidgetField[])
    properties[f.key] = {
      type: "string",
      title: f.label,
      ...(f.help ? { description: f.help } : {}),
      ...(f.choices ? { enum: f.choices.map((c) => c.value) } : {}),
      ...(f.suggestions ? { examples: f.suggestions } : {}),
    };
  return { type: "object", properties, required: m.fields.filter((f) => f.required).map((f) => f.key), additionalProperties: false };
}
