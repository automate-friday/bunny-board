// Pure helpers between the board's transcript rows (shared/components/transcript.ts,
// `row.item`) and the logic lifted from Paseo (./paseo). No React here, so the unit
// tests can bundle it.

import type { TranscriptItem, TranscriptRow, TranscriptUsage } from "../../shared/components/transcript";
import type { ToolCallDetail, ToolCallStatus } from "./paseo/agent-types";
import { formatTokenCount } from "./paseo/context-window-meter.utils";
import { type DisplayUnit, groupToolCallRows, type ToolCallDescriptor } from "./paseo/grouping";
import { buildToolCallPresentation, type ToolCallPresentation } from "./paseo/presentation";
import { buildLineDiff, type DiffLine, parseUnifiedDiff } from "./paseo/tool-call-parsers";
import { resolveToolCallIconName, type ToolCallIcon } from "./paseo/tool-call-icon-name";
import { parseSubAgentLog, type SubAgentActivityRow } from "./paseo/sub-agent-log";

type RawDetail = { type: string; [field: string]: unknown } | undefined;

const str = (v: unknown): v is string => typeof v === "string";
const optStr = (v: unknown) => (typeof v === "string" ? v : undefined);
const optNum = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

// The server sends the protocol's ToolCallDetail with large strings bounded, typed loosely.
// Check the fields each variant needs; anything else becomes { type: "unknown" } so the
// lifted display code (which throws on unknown variants) never sees a stray type.
export function toToolCallDetail(raw: RawDetail): ToolCallDetail | undefined {
  if (!raw || typeof raw !== "object" || typeof raw.type !== "string") return undefined;
  const d = raw as Record<string, unknown>;
  switch (raw.type) {
    case "shell":
      if (str(d.command)) return { type: "shell", command: d.command, cwd: optStr(d.cwd), output: optStr(d.output), exitCode: typeof d.exitCode === "number" ? d.exitCode : d.exitCode === null ? null : undefined };
      break;
    case "read":
      if (str(d.filePath)) return { type: "read", filePath: d.filePath, content: optStr(d.content), offset: optNum(d.offset), limit: optNum(d.limit) };
      break;
    case "edit":
      if (str(d.filePath)) return { type: "edit", filePath: d.filePath, oldString: optStr(d.oldString), newString: optStr(d.newString), unifiedDiff: optStr(d.unifiedDiff) };
      break;
    case "write":
      if (str(d.filePath)) return { type: "write", filePath: d.filePath, content: optStr(d.content) };
      break;
    case "search":
      if (str(d.query))
        return {
          ...(d as object),
          type: "search",
          query: d.query,
          content: optStr(d.content),
          filePaths: Array.isArray(d.filePaths) ? d.filePaths.filter(str) : undefined,
          webResults: Array.isArray(d.webResults) ? (d.webResults as { title?: unknown; url?: unknown }[]).filter((r) => r && str(r.url)).map((r) => ({ title: str(r.title) ? r.title : String(r.url), url: String(r.url) })) : undefined,
          annotations: Array.isArray(d.annotations) ? d.annotations.filter(str) : undefined,
        } as ToolCallDetail;
      break;
    case "fetch":
      if (str(d.url)) return { type: "fetch", url: d.url, prompt: optStr(d.prompt), result: optStr(d.result), code: optNum(d.code), codeText: optStr(d.codeText), bytes: optNum(d.bytes), durationMs: optNum(d.durationMs) };
      break;
    case "worktree_setup":
      if (str(d.branchName) || str(d.worktreePath))
        return { type: "worktree_setup", worktreePath: optStr(d.worktreePath) ?? "", branchName: optStr(d.branchName) ?? "", log: optStr(d.log) ?? "", commands: Array.isArray(d.commands) ? (d.commands as never[]) : [], truncated: d.truncated === true };
      break;
    case "sub_agent":
      return {
        type: "sub_agent",
        subAgentType: optStr(d.subAgentType),
        description: optStr(d.description),
        childSessionId: optStr(d.childSessionId),
        log: optStr(d.log) ?? "",
        actions: Array.isArray(d.actions) ? (d.actions as { index?: unknown; toolName?: unknown; summary?: unknown }[]).filter((a) => a && str(a.toolName)).map((a, i) => ({ index: optNum(a.index) ?? i + 1, toolName: String(a.toolName), summary: optStr(a.summary) })) : undefined,
      };
    case "plain_text":
      return { type: "plain_text", label: optStr(d.label), text: optStr(d.text), icon: optStr(d.icon) as never };
    case "plan":
      if (str(d.text)) return { type: "plan", text: d.text };
      break;
    case "unknown":
      return { type: "unknown", input: d.input ?? null, output: d.output ?? null };
  }
  const { type: _type, ...rest } = d;
  return { type: "unknown", input: "input" in rest ? rest.input : rest, output: "output" in rest ? rest.output : null };
}

export function toolStatus(item: Pick<TranscriptItem, "status">): ToolCallStatus {
  switch (item.status) {
    case "completed":
    case "failed":
    case "canceled":
    case "running":
      return item.status;
    case "loading":
      return "running";
    default:
      return "completed";
  }
}

function describeRow(row: Pick<TranscriptRow, "item">): ToolCallDescriptor | null {
  const item = row.item;
  if (!item || item.type !== "tool_call") return null;
  return {
    detail: toToolCallDetail(item.detail) ?? { type: "unknown", input: null, output: null },
    name: item.name ?? "tool",
    status: toolStatus(item),
    error: item.error ?? null,
  };
}

// React key for a row: the item's stable key, else the history id, else its position.
export function rowKey(row: Pick<TranscriptRow, "item" | "id" | "at" | "kind">, index: number): string {
  return row.item?.key ?? row.id ?? `${row.at}:${row.kind}:${index}`;
}

// Group consecutive tool calls (Paseo's overview grouping). Running calls stay visible.
export function groupRows<R extends TranscriptRow>(rows: readonly R[], isTurnActive: boolean): DisplayUnit<R>[] {
  const index = new Map(rows.map((row, i) => [row, i] as const));
  return groupToolCallRows({ rows, describe: describeRow, idOf: (row) => rowKey(row, index.get(row) ?? 0), isTurnActive });
}

export function presentToolCall(item: TranscriptItem): ToolCallPresentation<ToolCallIcon> {
  return buildToolCallPresentation({
    toolName: item.name ?? "tool",
    status: toolStatus(item),
    error: item.error ?? null,
    detail: toToolCallDetail(item.detail),
    resolveIcon: resolveToolCallIconName,
  });
}

// LCS over lines is O(m·n): beyond this many cells, show the old text removed and the
// new text added instead of a line-by-line diff.
// ponytail: 400k LCS cells; move the diff to a worker or a Myers diff if large edits need line detail.
const MAX_DIFF_CELLS = 400_000;

export function editDiffLines(detail: Extract<ToolCallDetail, { type: "edit" }>): DiffLine[] {
  if (detail.unifiedDiff) return parseUnifiedDiff(detail.unifiedDiff);
  const before = detail.oldString ?? "";
  const after = detail.newString ?? "";
  const cells = (before.split("\n").length + 1) * (after.split("\n").length + 1);
  if (cells > MAX_DIFF_CELLS) {
    const lines = (t: string, type: "add" | "remove", mark: string): DiffLine[] => (t ? t.replace(/\r\n/g, "\n").split("\n").map((l) => ({ type, content: `${mark}${l}` })) : []);
    return [...lines(before, "remove", "-"), ...lines(after, "add", "+")];
  }
  return buildLineDiff(before, after);
}

export function subAgentActions(detail: Extract<ToolCallDetail, { type: "sub_agent" }>): { actions: SubAgentActivityRow[]; log: string } {
  const parsed = parseSubAgentLog(detail.log ?? "");
  return { actions: detail.actions?.length ? detail.actions : parsed.actions, log: parsed.remainingLog };
}

export function timeMs(at: string | number | undefined | null): number | null {
  if (at === undefined || at === null || at === "") return null;
  const n = typeof at === "number" ? at : Date.parse(at);
  return Number.isFinite(n) ? n : null;
}

// "45k / 200k · 23%" for the header, or null when the host reports no window.
export function contextMeter(usage: TranscriptUsage | undefined): { label: string; fraction: number; title: string } | null {
  const used = usage?.contextWindowUsedTokens;
  const max = usage?.contextWindowMaxTokens;
  if (typeof used !== "number" || typeof max !== "number" || !(max > 0) || used < 0) return null;
  const fraction = Math.min(1, used / max);
  return {
    label: `${formatTokenCount(used)}/${formatTokenCount(max)}`,
    fraction,
    title: `Context window: ${used.toLocaleString()} of ${max.toLocaleString()} tokens used (${Math.round(fraction * 100)}%)`,
  };
}

// Which fields were cut by the server, in words, e.g. "output".
export function truncatedNote(item: TranscriptItem): string | null {
  const fields = item.truncatedFields?.filter(Boolean) ?? [];
  if (!fields.length) return null;
  return fields.map((f) => f.replace(/^detail\./, "")).join(", ");
}

// A tool call's running → completed updates share item.key. Should a list ever hold both
// (a history page joined to live rows), keep one row in the first one's place with the
// newest content.
export function dedupeItemRows<R extends Pick<TranscriptRow, "item">>(rows: R[]): R[] {
  const last = new Map<string, number>();
  rows.forEach((row, i) => {
    if (row.item?.key) last.set(row.item.key, i);
  });
  if (last.size === rows.filter((r) => r.item?.key).length) return rows;
  const placed = new Set<string>();
  const out: R[] = [];
  for (const row of rows) {
    const key = row.item?.key;
    if (!key) {
      out.push(row);
      continue;
    }
    if (placed.has(key)) continue;
    placed.add(key);
    out.push(rows[last.get(key) ?? 0]);
  }
  return out;
}
