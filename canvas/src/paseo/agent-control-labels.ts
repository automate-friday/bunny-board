// Lifted from getpaseo/paseo v0.11.4: packages/app/src/agent-controls/labels.ts and
// packages/app/src/agent-controls/policy.ts (the composer/agent-controls folder re-uses these)
// Copyright (c) 2025-present Mohamed Boudra, Apache-2.0, from getpaseo/paseo v0.11.4
// (see ./NOTICE.md). Changes: i18n.t("agentControls.thinking.extraHigh") is the English
// string; AgentMode is the board ControlOption plus an optional colorTier; the feature-id
// constants and the planning-mode helpers (unused by the board) are dropped.

interface ControlLabelInput {
  id: string;
  label?: string | null;
}

function sentenceCase(value: string): string {
  if (!value) {
    return value;
  }
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function splitCompactLabel(value: string, splitHyphen: boolean): string {
  const separatorPattern = splitHyphen ? /[_-]+/g : /_+/g;

  return value
    .replace(separatorPattern, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

function formatControlLabel(option: ControlLabelInput, splitHyphen: boolean): string {
  const rawLabel = (option.label ?? option.id).trim();
  return sentenceCase(splitCompactLabel(rawLabel, splitHyphen));
}

export function formatAgentModeLabel(mode: ControlLabelInput): string {
  return formatControlLabel(mode, mode.label == null);
}

export function formatThinkingOptionLabel(option: ControlLabelInput): string {
  const rawLabel = (option.label ?? option.id).trim();
  const compactId = option.id.replace(/[\s_-]+/g, "").toLowerCase();
  const compactLabel = rawLabel.replace(/[\s_-]+/g, "").toLowerCase();

  if (compactId === "xhigh" || compactLabel === "xhigh") {
    return "Extra high";
  }

  return formatControlLabel(option, true);
}

