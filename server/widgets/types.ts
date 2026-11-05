// Server half of a plugin widget: the data source. It keeps one config's live data in
// sync and reports it through emit; the hub (./index.ts) adds the status bookkeeping
// (stale deadline, last synced) and fans states out to SSE streams and board_read.

import type { AnyConfig, WidgetStatus } from "../../shared/widgets";

export interface WidgetUpdate {
  status: WidgetStatus;
  // Omitted: keep the last data (a stale or error widget still shows what it had).
  data?: unknown;
  reason?: string;
}

export type WidgetEmit = (update: WidgetUpdate) => void;

export interface WidgetOption {
  value: string;
  label: string;
}

export interface WidgetSource<C extends AnyConfig = AnyConfig> {
  id: string;
  // Start syncing one config (already validated); returns a dispose function.
  watch(config: C, emit: WidgetEmit): () => void;
  // Choices for a "select" config field, given the fields filled in so far.
  options?(field: string, config: C): Promise<WidgetOption[]>;
  // A person's action from the widget (e.g. Slack "post"); errors become 400s.
  action?(config: C, action: string, input: Record<string, unknown>): Promise<unknown>;
  // Test and demo controls (the Slack mock's fault injection); null when unavailable.
  admin?(input: Record<string, unknown>): unknown;
}
