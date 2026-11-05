import { CHECKLIST_TYPE, checklistMigrations, checklistOutline, checklistShapeProps, type ChecklistProps } from './checklist';
// Server-safe component registry: the record schema and the outline serializer for
// every custom board component. The canvas registry (canvas/src/components/registry.ts)
// adds the React parts on top of the same modules.

import { LINK_TYPE, type LinkTarget, linkMigrations, linkOutline, linkShapeProps } from "./link";
import { CLOUD_SESSION_TYPE, type CloudSessionProps, cloudSessionMigrations, cloudSessionOutline, cloudSessionShapeProps } from "./cloud-session";
import { TRANSCRIPT_TYPE, type TranscriptSnapshot, transcriptMigrations, transcriptOutline, transcriptShapeProps } from "./transcript";
import { STAMP_TYPE, type StampProps, stampMigrations, stampOutline, stampShapeProps } from "./stamp";
import { type AnyConfig, WIDGET_TYPE, type WidgetState, widgetMigrations, widgetOutline, widgetShapeProps } from "../widgets";

export interface OutlineContext {
  transcript(agentId: string): TranscriptSnapshot | null;
  link?(board: string, frameId: string): LinkTarget | null;
  // Last state of a plugin widget's data source (server/widgets), if one is running.
  widget?(widgetId: string, config: AnyConfig): WidgetState | null;
}

// biome-ignore lint/suspicious/noExplicitAny: records are validated by the schema.
type AnyShape = { type: string; props: Record<string, any> };

export const componentSchemas = {
  [CHECKLIST_TYPE]: { props: checklistShapeProps, migrations: checklistMigrations },
  [TRANSCRIPT_TYPE]: { props: transcriptShapeProps, migrations: transcriptMigrations },
  [LINK_TYPE]: { props: linkShapeProps, migrations: linkMigrations },
  [CLOUD_SESSION_TYPE]: { props: cloudSessionShapeProps, migrations: cloudSessionMigrations },
  // Every plugin widget (shared/widgets) is this one shape type.
  [WIDGET_TYPE]: { props: widgetShapeProps, migrations: widgetMigrations },
  // Stamps people (and agents) attach to shapes; parented to the shape they mark.
  [STAMP_TYPE]: { props: stampShapeProps, migrations: stampMigrations },
};

export const COMPONENT_TYPES = new Set<string>(Object.keys(componentSchemas));

export function isComponent(s: unknown): boolean {
  const t = (s as { type?: unknown } | null | undefined)?.type;
  return typeof t === "string" && COMPONENT_TYPES.has(t);
}

// One line describing a component shape for board_read, or null for other shapes.
export function componentOutline(s: AnyShape, ctx: OutlineContext | null): string | null {
  if (s.type === CHECKLIST_TYPE) return checklistOutline(s.props as unknown as ChecklistProps);
  if (s.type === TRANSCRIPT_TYPE) return transcriptOutline({ agentId: String(s.props.agentId) }, ctx?.transcript(String(s.props.agentId)) ?? null);
  if (s.type === LINK_TYPE) {
    const p = { board: String(s.props.board), frameId: String(s.props.frameId ?? ""), title: String(s.props.title ?? "") };
    return linkOutline(p, ctx?.link?.(p.board, p.frameId) ?? null);
  }
  if (s.type === CLOUD_SESSION_TYPE) return cloudSessionOutline(s.props as unknown as CloudSessionProps);
  if (s.type === WIDGET_TYPE) {
    const p = { widgetId: String(s.props.widgetId), config: (s.props.config ?? {}) as AnyConfig };
    return widgetOutline(p, ctx?.widget?.(p.widgetId, p.config) ?? null);
  }
  if (s.type === STAMP_TYPE) return stampOutline(s.props as unknown as StampProps);
  return null;
}

// Agent ids a component shape reads live data for (used for prefetch and access).
export function componentAgentIds(s: AnyShape): string[] {
  return s.type === TRANSCRIPT_TYPE && s.props.agentId ? [String(s.props.agentId)] : [];
}

// Props a person changes for their own view (not content). The frame watcher ignores them.
// (Since 2026-10-27 cards keep these per viewer in localStorage; the list stays for older tabs.)
// Widgets have none: their config is content (the agent hears about a changed channel),
// and their live data never touches the document.
export const VIEW_ONLY_PROPS: Record<string, string[]> = { [TRANSCRIPT_TYPE]: ["mode", "follow"], [WIDGET_TYPE]: [] };
