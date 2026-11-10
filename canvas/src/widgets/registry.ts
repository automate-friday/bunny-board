// Canvas half of each plugin widget: its body renderer. The frame around it (title bar,
// status dot, config form) is generic: ../components/widget/Render.tsx.

import type { ComponentType } from "react";
import type { TLShapeId } from "tldraw";
import type { AnyConfig, WidgetState } from "../../../shared/widgets";
import { AppBody } from "./app/Render";
import { ClaudeActivityBody } from "./claude-activity/Render";
import { ContentCalendarBody } from "./content-calendar/Render";
import { GitHubPrBody } from "./github-pr/Render";
import { HelloBody } from "./hello/Render";
import { SlackBody } from "./slack/Render";

export interface WidgetBodyProps {
  config: AnyConfig;
  state: WidgetState | null;
  // The key the widget's state streams under (for actions: POST /api/ui/widgets/action).
  widgetKey: string;
  readOnly: boolean;
  // The widget's own shape.
  shapeId: TLShapeId;
  // Change config fields (e.g. open a thread from a channel view).
  setConfig(patch: AnyConfig): void;
}

// biome-ignore lint/suspicious/noExplicitAny: bodies narrow config and data themselves.
export const widgetBodies: Record<string, ComponentType<WidgetBodyProps & any>> = {
  "github-pr": GitHubPrBody,
  hello: HelloBody,
  slack: SlackBody,
  "claude-activity": ClaudeActivityBody,
  app: AppBody,
  "content-calendar": ContentCalendarBody,
};
