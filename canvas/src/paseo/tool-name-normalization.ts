// Lifted from getpaseo/paseo v0.11.4: packages/protocol/src/tool-name-normalization.ts
// Copyright (c) 2025-present Mohamed Boudra, Apache-2.0, from getpaseo/paseo v0.11.4
// (see ./NOTICE.md). Changes: isLikelyNamespacedToolName and isLikelyExternalToolName
// (unused by the board) are dropped.

const TOOL_TOKEN_REGEX = /[a-z0-9]+/g;

export function normalizeToolName(name: string): string {
  return name.trim().toLowerCase();
}

export function tokenizeToolName(name: string): string[] {
  const normalized = normalizeToolName(name);
  return normalized.match(TOOL_TOKEN_REGEX) ?? [];
}

export function getToolLeafName(name: string): string | null {
  const tokens = tokenizeToolName(name);
  return tokens.length > 0 ? tokens[tokens.length - 1] : null;
}

export function isSpeakToolName(name: string): boolean {
  return getToolLeafName(name) === "speak";
}

export function isPaseoToolName(name: string): boolean {
  const normalized = normalizeToolName(name);
  if (isSpeakToolName(normalized)) {
    return false;
  }
  if (normalized.includes("__")) {
    const segments = normalized.split("__").filter((s) => s.length > 0);
    return (
      segments.length >= 3 &&
      segments[0] === "mcp" &&
      (segments[1] === "paseo" || segments[1].startsWith("paseo_"))
    );
  }
  if (normalized.includes(".")) {
    const firstSegment = normalized.split(".")[0];
    return firstSegment === "paseo" || firstSegment.startsWith("paseo_");
  }
  return false;
}

export function getPaseoToolLeafName(name: string): string | null {
  const normalized = normalizeToolName(name);
  if (normalized.includes("__")) {
    const segments = normalized.split("__").filter((s) => s.length > 0);
    if (
      segments.length >= 3 &&
      segments[0] === "mcp" &&
      (segments[1] === "paseo" || segments[1].startsWith("paseo_"))
    ) {
      return segments.slice(2).join("__");
    }
    return null;
  }
  if (normalized.includes(".")) {
    const firstSegment = normalized.split(".")[0];
    if (firstSegment === "paseo" || firstSegment.startsWith("paseo_")) {
      return normalized.split(".").slice(1).join(".");
    }
    return null;
  }
  return null;
}
