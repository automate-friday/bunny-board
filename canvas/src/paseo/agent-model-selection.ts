// Lifted from getpaseo/paseo v0.11.4: packages/app/src/composer/agent-controls/utils.ts
// Copyright (c) 2025-present Mohamed Boudra, Apache-2.0, from getpaseo/paseo v0.11.4
// (see ./NOTICE.md). Changes: AgentModelDefinition is a local shape that the board's
// ModelOption satisfies (aliases/isDefault optional); i18n strings are the English ones;
// the hint-key, tooltip, isFeatureActive and feature-highlight helpers are dropped.

import { formatThinkingOptionLabel } from "./agent-control-labels";

interface AgentModelDefinition {
  id: string;
  label: string;
  aliases?: string[];
  isDefault?: boolean;
  thinkingOptions?: { id: string; label?: string | null }[];
  defaultThinkingOptionId?: string | null;
}

export function normalizeModelId(modelId: string | null | undefined): string | null {
  const normalized = typeof modelId === "string" ? modelId.trim() : "";
  if (!normalized) {
    return null;
  }
  return normalized;
}

function findModelById(
  models: AgentModelDefinition[] | null,
  modelId: string | null,
): AgentModelDefinition | null {
  if (!models || !modelId) {
    return null;
  }
  return (
    models.find((model) => model.id === modelId) ??
    models.find((model) => model.aliases?.includes(modelId)) ??
    null
  );
}

function getFallbackModel(models: AgentModelDefinition[] | null): AgentModelDefinition | null {
  return models?.find((model) => model.isDefault) ?? models?.[0] ?? null;
}

function resolvePreferredModelId(
  runtimeSelectedModel: AgentModelDefinition | null,
  normalizedConfiguredModelId: string | null,
  normalizedRuntimeModelId: string | null,
): string | null {
  return runtimeSelectedModel?.id ?? normalizedConfiguredModelId ?? normalizedRuntimeModelId;
}

function pickSelectedModel(
  models: AgentModelDefinition[] | null,
  preferredModelId: string | null,
  fallbackModel: AgentModelDefinition | null,
): AgentModelDefinition | null {
  if (!preferredModelId) {
    return fallbackModel;
  }
  return findModelById(models, preferredModelId);
}

function resolveThinkingId(
  runtimeThinkingOptionId: string | null | undefined,
  explicitThinkingOptionId: string | null | undefined,
  selectedModel: AgentModelDefinition | null,
): string | null {
  const runtimeThinkingOption = selectedModel?.thinkingOptions?.find(
    (option) => option.id === runtimeThinkingOptionId,
  );
  if (runtimeThinkingOption) {
    return runtimeThinkingOption.id;
  }
  if (explicitThinkingOptionId && explicitThinkingOptionId !== "default") {
    return explicitThinkingOptionId;
  }
  return selectedModel?.defaultThinkingOptionId ?? null;
}

type ThinkingOption = NonNullable<AgentModelDefinition["thinkingOptions"]>[number];

function resolveEffectiveThinking(
  thinkingOptions: ThinkingOption[] | null,
  resolvedThinkingId: string | null,
): ThinkingOption | null {
  const selectedThinking =
    thinkingOptions?.find((option) => option.id === resolvedThinkingId) ?? null;
  return selectedThinking ?? thinkingOptions?.[0] ?? null;
}

function resolveModelDisplay(
  selectedModel: AgentModelDefinition | null,
  preferredModelId: string | null,
  fallbackModel: AgentModelDefinition | null,
  unknownModelLabel: string,
): { activeModelId: string | null; displayModel: string } {
  return {
    activeModelId: selectedModel?.id ?? preferredModelId ?? null,
    displayModel:
      selectedModel?.label ?? preferredModelId ?? fallbackModel?.label ?? unknownModelLabel,
  };
}

function resolveThinkingDisplay(
  effectiveThinking: ThinkingOption | null,
  selectedThinkingId: string | null,
  unknownThinkingLabel: string,
): string {
  if (effectiveThinking) {
    return formatThinkingOptionLabel(effectiveThinking);
  }

  if (selectedThinkingId) {
    return formatThinkingOptionLabel({ id: selectedThinkingId });
  }

  return unknownThinkingLabel;
}

export function resolveAgentModelSelection<M extends AgentModelDefinition>(input: {
  models: M[] | null;
  runtimeModelId: string | null | undefined;
  configuredModelId: string | null | undefined;
  runtimeThinkingOptionId: string | null | undefined;
  explicitThinkingOptionId: string | null | undefined;
}) {
  const {
    models,
    runtimeModelId,
    configuredModelId,
    runtimeThinkingOptionId,
    explicitThinkingOptionId,
  } = input;
  const normalizedRuntimeModelId = normalizeModelId(runtimeModelId);
  const normalizedConfiguredModelId = normalizeModelId(configuredModelId);

  const runtimeSelectedModel = findModelById(models, normalizedRuntimeModelId);
  const preferredModelId = resolvePreferredModelId(
    runtimeSelectedModel,
    normalizedConfiguredModelId,
    normalizedRuntimeModelId,
  );
  const fallbackModel = getFallbackModel(models);
  const selectedModel = pickSelectedModel(models, preferredModelId, fallbackModel);

  const { activeModelId, displayModel } = resolveModelDisplay(
    selectedModel,
    preferredModelId,
    fallbackModel,
    "Unknown model",
  );

  const thinkingOptions = selectedModel?.thinkingOptions ?? null;
  const resolvedThinkingId = resolveThinkingId(
    runtimeThinkingOptionId,
    explicitThinkingOptionId,
    selectedModel,
  );
  const effectiveThinking = resolveEffectiveThinking(thinkingOptions, resolvedThinkingId);
  const selectedThinkingId = effectiveThinking?.id ?? resolvedThinkingId;
  const displayThinking = resolveThinkingDisplay(
    effectiveThinking,
    selectedThinkingId,
    "Unknown",
  );

  return {
    selectedModel,
    activeModelId,
    displayModel,
    thinkingOptions,
    selectedThinkingId,
    displayThinking,
  };
}
