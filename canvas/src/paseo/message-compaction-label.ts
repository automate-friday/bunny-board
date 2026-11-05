// Lifted from getpaseo/paseo v0.11.4: packages/app/src/components/message-compaction-label.ts
// Copyright (c) 2025-present Mohamed Boudra, Apache-2.0, from getpaseo/paseo v0.11.4
// (see ./NOTICE.md). Changes: i18n.t calls replaced by the English strings from
// packages/app/src/i18n/resources/en.ts (message.compaction.*).

export interface CompactionMarkerLabelInput {
  status: "loading" | "completed";
  trigger?: "auto" | "manual";
  preTokens?: number;
}

export function getCompactionMarkerLabel({ status, trigger, preTokens }: CompactionMarkerLabelInput): string {
  if (status === "loading") return "Compacting...";
  if (trigger === "auto") return "Context automatically compacted";
  if (trigger === "manual") return "Context manually compacted";
  if (preTokens) {
    return `Context compacted (${Math.round(preTokens / 1000)}K tokens)`;
  }
  return "Context compacted";
}
