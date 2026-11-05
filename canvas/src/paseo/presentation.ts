// Lifted from getpaseo/paseo v0.11.4: packages/app/src/tool-calls/presentation.ts
// Copyright (c) 2025-present Mohamed Boudra, Apache-2.0, from getpaseo/paseo v0.11.4
// (see ./NOTICE.md). Changes: the icon type is a generic the caller's resolver picks
// (the board draws its own glyphs, no lucide); `openFilePath` (extract-tool-call-file-path)
// is dropped because the board has no file viewer; PlanOutcome is inlined; import paths.

import type { ToolCallDetail, ToolCallStatus } from "./agent-types";
import type { ToolCallDisplayInput } from "./tool-call-display";
import { buildToolCallDisplayModel } from "./tool-call-display";
import { hasMeaningfulToolCallDetail, isPendingToolCallDetail } from "./tool-call-detail-state";

export type PlanOutcome = "pending" | "approved" | "rejected" | "canceled";

interface BuildToolCallPresentationInput<TIcon> {
  toolName: string;
  status: ToolCallStatus;
  error: unknown;
  detail?: ToolCallDetail;
  cwd?: string;
  metadata?: Record<string, unknown>;
  resolveIcon: ToolCallIconResolver<TIcon>;
}

export interface ToolCallPresentation<TIcon> {
  displayName: string;
  summary?: string;
  errorText?: string;
  icon: TIcon;
  isLoadingDetails: boolean;
  hasDetails: boolean;
  canOpenDetails: boolean;
  isPlan: boolean;
  planOutcome?: PlanOutcome;
}

export type ToolCallIconResolver<TIcon> = (toolName: string, detail: ToolCallDetail | undefined) => TIcon;

function displayStatus(status: ToolCallStatus): ToolCallDisplayInput["status"] {
  return status === "executing" ? "running" : status;
}

function displayDetail(detail: ToolCallDetail | undefined): ToolCallDetail {
  return detail ?? { type: "unknown", input: null, output: null };
}

export function buildToolCallPresentation<TIcon>(input: BuildToolCallPresentationInput<TIcon>): ToolCallPresentation<TIcon> {
  const detailForDisplay = displayDetail(input.detail);
  const displayModel = buildToolCallDisplayModel({
    name: input.toolName,
    status: displayStatus(input.status),
    error: input.error ?? null,
    detail: detailForDisplay,
    metadata: input.metadata,
    cwd: input.cwd,
  });
  const isLoadingDetails = isPendingToolCallDetail({
    detail: input.detail,
    status: input.status,
    error: input.error,
  });
  const hasDetails = Boolean(input.error) || hasMeaningfulToolCallDetail(input.detail);

  return {
    displayName: displayModel.displayName,
    summary: displayModel.summary,
    errorText: displayModel.errorText,
    icon: input.resolveIcon(input.toolName, input.detail),
    isLoadingDetails,
    hasDetails,
    canOpenDetails: hasDetails || isLoadingDetails,
    isPlan: input.detail?.type === "plan",
    planOutcome: input.detail?.type === "plan" ? resolvePlanOutcome(input) : undefined,
  };
}

function resolvePlanOutcome<TIcon>(input: BuildToolCallPresentationInput<TIcon>): PlanOutcome | undefined {
  if (input.status === "canceled") return "canceled";
  if (input.metadata?.approved === false) return "rejected";
  if (input.metadata?.approved === true) return "approved";
  if (input.status === "running" || input.status === "executing") return "pending";
  return undefined;
}
