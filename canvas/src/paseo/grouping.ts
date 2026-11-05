// Lifted from getpaseo/paseo v0.11.4: packages/app/src/tool-calls/detail-level/grouping.ts
// and packages/app/src/tool-calls/detail-level/overview/model.ts, plus joinSummaryParts and
// the summary wording from overview/view.tsx (English strings from i18n/resources/en.ts,
// toolCallGroup.*).
// Copyright (c) 2025-present Mohamed Boudra, Apache-2.0, from getpaseo/paseo v0.11.4
// (see ./NOTICE.md).
// Changes: adapted from Paseo's StreamItem (tail/head split, host ids, lookup maps) to a
// flat list of board rows. The caller supplies `describe` (row → ToolCallDescriptor, or
// null when the row is not a tool call) and `idOf`. The rule that decides what a run is
// (isGroupableToolCall: tool calls except plans and "speak", broken by any other row) and
// the sealed/unsealed rule (a trailing run stays open while the turn is active or a call
// is running) are Paseo's. New for the board: a run of one call is not grouped, and
// running calls are never folded into a group: they stay visible after the group badge
// (`visible`), and the group summarises only the calls it hides.

import type { ToolCallDetail, ToolCallStatus } from "./agent-types";
import { isPaseoToolName } from "./tool-name-normalization";

export interface ToolCallDescriptor {
  detail: ToolCallDetail;
  name: string;
  status: ToolCallStatus;
  error: unknown;
  metadata?: Record<string, unknown>;
}

export interface ToolCallRun<R> {
  id: string;
  calls: readonly R[];
  latest: R;
  isSealed: boolean;
}

export interface OverviewSummary {
  editedFileCount: number;
  commandCount: number;
  readFileCount: number;
  searchCount: number;
  otherToolCount: number;
  paseoCallCount: number;
}

export interface OverviewToolCallGroup<R> {
  mode: "overview";
  run: ToolCallRun<R>;
  summary: OverviewSummary;
  isLoading: boolean;
}

export type DisplayUnit<R> =
  | { kind: "row"; row: R }
  // `hidden` are the calls behind the badge; `visible` the running calls shown after it.
  | { kind: "group"; id: string; group: OverviewToolCallGroup<R>; hidden: readonly R[]; visible: readonly R[] };

type Describe<R> = (row: R) => ToolCallDescriptor | null;

export function isGroupableToolCall(descriptor: ToolCallDescriptor | null): descriptor is ToolCallDescriptor {
  if (!descriptor) return false;
  return descriptor.detail.type !== "plan" && descriptor.name.trim().toLowerCase() !== "speak";
}

function isRunningStatus(status: ToolCallStatus): boolean {
  return status === "running" || status === "executing";
}

function createRun<R>(calls: readonly R[], isSealed: boolean, idOf: (row: R) => string): ToolCallRun<R> {
  const first = calls[0];
  const latest = calls.at(-1);
  if (first === undefined || latest === undefined) {
    throw new Error("Cannot group an empty tool call run");
  }
  return { id: idOf(first), calls, latest, isSealed };
}

const DIRECT_PASEO_TOOL_PREFIX = "paseo_";
const DIRECT_SEARCH_TOOL_SUFFIX_PATTERN = /(?:^|[_.:/])(?:web_search|llm_context)$/;

function isPaseoCall(name: string, normalizedName: string): boolean {
  return isPaseoToolName(name) || normalizedName.startsWith(DIRECT_PASEO_TOOL_PREFIX);
}

function isSearchCall(name: string): boolean {
  return DIRECT_SEARCH_TOOL_SUFFIX_PATTERN.test(name);
}

export function buildOverviewGroup<R>(run: ToolCallRun<R>, describe: Describe<R>): OverviewToolCallGroup<R> {
  const editedFiles = new Set<string>();
  const readFiles = new Set<string>();
  let isLoading = false;
  let commandCount = 0;
  let searchCount = 0;
  let otherToolCount = 0;
  let paseoCallCount = 0;

  for (const call of run.calls) {
    const descriptor = describe(call);
    if (!descriptor) continue;
    const normalizedName = descriptor.name.trim().toLowerCase();
    isLoading ||= isRunningStatus(descriptor.status);
    if (isPaseoCall(descriptor.name, normalizedName)) {
      paseoCallCount += 1;
    } else if (descriptor.detail.type === "edit" || descriptor.detail.type === "write") {
      editedFiles.add(descriptor.detail.filePath);
    } else if (descriptor.detail.type === "shell") {
      commandCount += 1;
    } else if (descriptor.detail.type === "read") {
      readFiles.add(descriptor.detail.filePath);
    } else if (descriptor.detail.type === "search" || isSearchCall(normalizedName)) {
      searchCount += 1;
    } else {
      otherToolCount += 1;
    }
  }

  return {
    mode: "overview",
    run,
    isLoading,
    summary: {
      editedFileCount: editedFiles.size,
      commandCount,
      readFileCount: readFiles.size,
      searchCount,
      otherToolCount,
      paseoCallCount,
    },
  };
}

function joinSummaryParts(parts: string[], conjunction: string): string {
  if (parts.length === 0) {
    return "";
  }
  let joined = parts[0] ?? "";
  if (parts.length === 2) {
    joined = `${parts[0]} ${conjunction} ${parts[1]}`;
  } else if (parts.length > 2) {
    joined = `${parts.slice(0, -1).join(", ")}, ${conjunction} ${parts.at(-1)}`;
  }
  const firstCharacter = joined[0];
  return firstCharacter ? `${firstCharacter.toLocaleUpperCase()}${joined.slice(1)}` : joined;
}

const SUMMARY_WORDS: [keyof OverviewSummary, string, string][] = [
  ["editedFileCount", "edited {{count}} file", "edited {{count}} files"],
  ["commandCount", "ran {{count}} command", "ran {{count}} commands"],
  ["readFileCount", "read {{count}} file", "read {{count}} files"],
  ["searchCount", "searched {{count}} time", "searched {{count}} times"],
  ["otherToolCount", "used {{count}} other tool", "used {{count}} other tools"],
  ["paseoCallCount", "called Paseo {{count}} time", "called Paseo {{count}} times"],
];

// "Edited 3 files, ran 2 commands, and read 1 file".
export function formatOverviewSummary(summary: OverviewSummary): string {
  const parts: string[] = [];
  for (const [key, one, other] of SUMMARY_WORDS) {
    const count = summary[key];
    if (count > 0) parts.push((count === 1 ? one : other).replace("{{count}}", String(count)));
  }
  return joinSummaryParts(parts, "and");
}

// prepareGroupedHistory + groupLiveToolCalls, flattened for the board's row list.
export function groupToolCallRows<R>(input: {
  rows: readonly R[];
  describe: Describe<R>;
  idOf: (row: R) => string;
  isTurnActive: boolean;
}): DisplayUnit<R>[] {
  const output: DisplayUnit<R>[] = [];
  let pending: R[] = [];

  const flush = (isSealed: boolean) => {
    if (pending.length === 0) return;
    const calls = pending;
    pending = [];
    if (calls.length < 2) {
      for (const row of calls) output.push({ kind: "row", row });
      return;
    }
    const visible = calls.filter((row) => {
      const d = input.describe(row);
      return !!d && isRunningStatus(d.status);
    });
    const hidden = calls.filter((row) => !visible.includes(row));
    if (hidden.length < 2) {
      for (const row of calls) output.push({ kind: "row", row });
      return;
    }
    const run = createRun(hidden, isSealed, input.idOf);
    output.push({ kind: "group", id: run.id, group: buildOverviewGroup(run, input.describe), hidden, visible });
  };

  for (const row of input.rows) {
    if (isGroupableToolCall(input.describe(row))) {
      pending.push(row);
      continue;
    }
    flush(true);
    output.push({ kind: "row", row });
  }
  const trailingRunIsActive =
    input.isTurnActive ||
    pending.some((row) => {
      const d = input.describe(row);
      return !!d && isRunningStatus(d.status);
    });
  flush(!trailingRunIsActive);
  return output;
}
