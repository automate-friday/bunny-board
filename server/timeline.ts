// Paseo timeline entries projected to the small rows the sidebar and transcript
// cards render.

import { INTRO_MARK, INTRO_ROW, isSilentAck, PRIMER_MARK, type TranscriptItem, type TranscriptRow } from "../shared/components/transcript";

const MAX_TEXT = 4000;

// Display/export only. Never alter the credentials used by the actual transport.
export function redactBoardTokens(text: string): string {
  return text.replace(/((?:Bearer\s+|BOARD_(?:FRAME_)?TOKEN['"]?\s*[:=]\s*)['"]?)[a-f0-9]{64}/gi, '$1[REDACTED]');
}

// biome-ignore lint/suspicious/noExplicitAny: timeline items are wide unions.
export function simplifyItem(entry: any): TranscriptRow | null {
  const item = entry.item;
  const at = entry.timestamp;
  const cap = (t: unknown) => redactBoardTokens(String(t ?? "")).slice(0, MAX_TEXT);
  switch (item.type) {
    case "user_message": {
      const text = String(item.text ?? "");
      // The board's opening prompt is a long primer; cards show "opening prompt" (plus
      // The user's opening line, if they typed one) and the sidebar expands it on request.
      if (text.includes(PRIMER_MARK)) {
        const line = text.match(/^[^\n]*? says: ([\s\S]*?)\n\nYou are the agent for one frame/);
        return { kind: "user", text: cap(line?.[1]?.trim() ?? ""), at, primer: true, full: cap(text) };
      }
      if (text.slice(0, 300).includes(INTRO_MARK)) return { kind: "user", text: INTRO_ROW, at };
      return { kind: "user", text: cap(text), at };
    }
    case "assistant_message":
      return isSilentAck(String(item.text ?? "")) ? { kind: "assistant", text: cap(item.text), at, ack: true } : { kind: "assistant", text: cap(item.text), at };
    case "tool_call": {
      const detail = item.detail?.type === "shell" ? item.detail.command : (item.detail?.filePath ?? "");
      return { kind: "tool", text: `${item.name}${detail ? ` ${redactBoardTokens(String(detail)).slice(0, 120)}` : ""}`, at, status: item.status };
    }
    case "plugin":
      return { kind: `plugin:${item.kind}`, text: cap(item.data?.text ?? JSON.stringify(item.data)), at };
    case "error":
      return { kind: "error", text: cap(item.message), at };
    case "notification":
      return { kind: "notice", text: cap(item.message), at };
    // Shown by the sidebar and cards from row.item; outlines (transcriptOutline) only
    // read user/assistant rows, so these never reach board_read.
    case "reasoning":
      return { kind: "reasoning", text: oneLine(redactBoardTokens(String(item.text ?? "")), 160), at };
    case "todo": {
      const todos: { text?: string; completed?: boolean; status?: string; activeForm?: string }[] = Array.isArray(item.items) ? item.items : [];
      const done = todos.filter((t) => t.completed || t.status === "completed").length;
      const now = todos.find((t) => t.status === "in_progress") ?? todos.find((t) => !t.completed && t.status !== "completed");
      const label = now ? `: ${oneLine(redactBoardTokens(String(now.status === "in_progress" && now.activeForm ? now.activeForm : (now.text ?? ""))), 120)}` : "";
      return { kind: "todo", text: `todos ${done}/${todos.length}${label}`, at };
    }
    case "compaction":
      return { kind: "compaction", text: item.status === "loading" ? "compacting context…" : `context compacted${item.trigger ? ` (${item.trigger})` : ""}`, at, status: item.status };
    default:
      return null;
  }
}

function oneLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// --- full items (Paseo parity) ---------------------------------------------------------

// ponytail: fixed per-field bounds (2 KB head, 4 KB tail, 50 array items, depth 4); "Show full output" fetches the exact row for the rest.
export const ITEM_HEAD = 2048; // most large strings keep their head
export const ITEM_TAIL = 4096; // tool output keeps its tail (the end is what matters)
const MESSAGE_HEAD = MAX_TEXT; // message and reasoning text: same bound as row.text
const MAX_ARRAY = 50;
const MAX_IMAGES = 12;
const MAX_DATA_IMAGE = 256 * 1024;

interface ItemBounds {
  head: number;
  tail: number;
  message: number;
}
const DEFAULT_BOUNDS: ItemBounds = { head: ITEM_HEAD, tail: ITEM_TAIL, message: MESSAGE_HEAD };

// Output-like detail fields keep their tail; everything else its head.
const TAIL_FIELDS: Record<string, string[]> = { shell: ["output"], fetch: ["result"], sub_agent: ["log"], worktree_setup: ["log"], unknown: ["output"] };

class Bounder {
  readonly cut = new Set<string>();
  constructor(readonly b: ItemBounds) {}
  str(value: unknown, name: string, tail = false, max = tail ? this.b.tail : this.b.head): string {
    const t = redactBoardTokens(String(value ?? ""));
    if (t.length <= max) return t;
    this.cut.add(name);
    return tail ? `…${t.slice(t.length - max)}` : `${t.slice(0, max)}…`;
  }
  // Any JSON-ish value: strings bounded and redacted, arrays capped, depth limited.
  value(value: unknown, name: string, tail = false, depth = 0): unknown {
    if (typeof value === "string") return this.str(value, name, tail);
    if (value === null || typeof value !== "object") return value;
    if (depth > 4) {
      this.cut.add(name);
      return this.str(safeJson(value), name, tail);
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY) this.cut.add(name);
      const kept = value.length > MAX_ARRAY ? (tail ? value.slice(-MAX_ARRAY) : value.slice(0, MAX_ARRAY)) : value;
      return kept.map((v) => this.value(v, name, tail, depth + 1));
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = this.value(v, name, tail, depth + 1);
    return out;
  }
  // unknown.input / unknown.output: kept as-is when small, else a cut JSON string.
  json(value: unknown, name: string, tail = false): unknown {
    if (typeof value === "string") return this.str(value, name, tail);
    const text = safeJson(value);
    const max = tail ? this.b.tail : this.b.head;
    if (text.length <= max) return this.value(value, name, tail);
    return this.str(text, name, tail);
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

// biome-ignore lint/suspicious/noExplicitAny: ToolCallDetail union.
export function boundDetail(detail: any, bounder: Bounder): { type: string; [field: string]: unknown } | undefined {
  if (!detail || typeof detail !== "object" || typeof detail.type !== "string") return undefined;
  const tails = TAIL_FIELDS[detail.type] ?? [];
  const out: { type: string; [field: string]: unknown } = { type: detail.type };
  for (const [k, v] of Object.entries(detail as Record<string, unknown>)) {
    if (k === "type") continue;
    const tail = tails.includes(k);
    const name = `detail.${k}`;
    out[k] = detail.type === "unknown" && (k === "input" || k === "output") ? bounder.json(v, name, tail) : bounder.value(v, name, tail);
  }
  return out;
}

/** A Bounder for code outside this file (permission request details). */
export function makeBounder(bounds: Partial<ItemBounds> = {}): Bounder {
  return new Bounder({ ...DEFAULT_BOUNDS, ...bounds });
}

// Markdown images in assistant text (Paseo provider-image-output writes
// ![alt](/abs/path) for generated images). Local paths go through the board's file
// route; http(s) and small data: URIs pass through.
const IMAGE_RE = /!\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;
export function markdownImages(text: string, agentId: string): { src: string; alt: string }[] {
  const out: { src: string; alt: string }[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(IMAGE_RE)) {
    if (out.length >= MAX_IMAGES) break;
    let raw = m[2].trim();
    if (raw.startsWith("<") && raw.endsWith(">")) raw = raw.slice(1, -1).trim();
    let src: string | null = null;
    if (/^https?:\/\//i.test(raw)) src = raw;
    else if (/^data:image\//i.test(raw)) src = raw.length <= MAX_DATA_IMAGE ? raw : null;
    else {
      let local: string | null = null;
      if (/^file:\/\//i.test(raw)) {
        try {
          local = decodeURIComponent(new URL(raw).pathname);
        } catch {
          local = null;
        }
      } else if (raw.startsWith("/")) {
        try {
          local = decodeURIComponent(raw);
        } catch {
          local = raw;
        }
      }
      if (local) src = `/api/ui/agents/${encodeURIComponent(agentId)}/files?path=${encodeURIComponent(local)}`;
    }
    if (!src || seen.has(src)) continue;
    seen.add(src);
    out.push({ src, alt: redactBoardTokens(m[1]).slice(0, 200) });
  }
  return out;
}

// biome-ignore lint/suspicious/noExplicitAny: timeline entries are wide unions.
export function itemKey(entry: any): string {
  const item = entry?.item ?? {};
  const turnId = typeof entry?.turnId === "string" && entry.turnId ? entry.turnId : typeof item.turnId === "string" && item.turnId ? item.turnId : null;
  if (item.type === "tool_call" && typeof item.callId === "string" && item.callId) return turnId ? `tool:${turnId}/${item.callId}` : `tool:${item.callId}`;
  if (typeof item.messageId === "string" && item.messageId) return `msg:${item.messageId}`;
  if (item.type === "plugin" && typeof item.id === "string" && item.id) return `plugin:${item.id}`;
  return `seq:${entry?.seqStart ?? "?"}`;
}

// The bounded, redacted TranscriptItem behind a row (shared/components/transcript.ts).
// biome-ignore lint/suspicious/noExplicitAny: timeline entries are wide unions.
export function projectItem(entry: any, agentId: string, bounds: Partial<ItemBounds> = {}): TranscriptItem | null {
  const item = entry?.item;
  if (!item || typeof item.type !== "string") return null;
  const b = makeBounder(bounds);
  const turnId = typeof entry.turnId === "string" && entry.turnId ? entry.turnId : undefined;
  const base = { key: itemKey(entry), ...(turnId ? { turnId } : {}) };
  let out: TranscriptItem;
  switch (item.type) {
    case "user_message":
      out = { ...base, type: "user_message", text: b.str(item.text, "text", false, b.b.message) };
      break;
    case "assistant_message": {
      const full = String(item.text ?? "");
      const images = markdownImages(full, agentId);
      out = { ...base, type: "assistant_message", text: b.str(full, "text", false, b.b.message), ...(images.length ? { images } : {}) };
      break;
    }
    case "reasoning":
      out = { ...base, type: "reasoning", text: b.str(item.text, "text", false, b.b.message) };
      break;
    case "tool_call": {
      const status = ["running", "completed", "failed", "canceled"].includes(item.status) ? item.status : undefined;
      const detail = boundDetail(item.detail, b);
      const err = item.error === null || item.error === undefined ? undefined : b.str(typeof item.error === "string" ? item.error : safeJson(item.error), "error");
      out = {
        ...base,
        type: "tool_call",
        callId: String(item.callId ?? ""),
        name: b.str(item.name, "name", false, 200),
        ...(status ? { status } : {}),
        ...(detail ? { detail } : {}),
        ...(err ? { error: err } : {}),
      };
      break;
    }
    case "todo": {
      const items: unknown[] = Array.isArray(item.items) ? item.items : [];
      if (items.length > MAX_ARRAY) b.cut.add("todos");
      out = {
        ...base,
        type: "todo",
        todos: items.slice(0, MAX_ARRAY).map((raw) => {
          const t = (raw ?? {}) as { text?: unknown; completed?: unknown; status?: unknown; activeForm?: unknown };
          const status = t.status === "pending" || t.status === "in_progress" || t.status === "completed" ? t.status : undefined;
          return {
            text: b.str(t.text, "todos", false, 500),
            completed: t.completed === true,
            ...(status ? { status } : {}),
            ...(typeof t.activeForm === "string" ? { activeForm: b.str(t.activeForm, "todos", false, 500) } : {}),
          };
        }),
      };
      break;
    }
    case "error":
      out = { ...base, type: "error", text: b.str(item.message, "text") };
      break;
    case "notification":
      out = { ...base, type: "notification", text: b.str(item.message, "text"), ...(["info", "warning", "error"].includes(item.level) ? { level: item.level } : {}) };
      break;
    case "compaction":
      out = {
        ...base,
        type: "compaction",
        status: item.status === "loading" ? "loading" : "completed",
        ...(item.trigger === "auto" || item.trigger === "manual" ? { trigger: item.trigger } : {}),
        ...(typeof item.preTokens === "number" ? { preTokens: item.preTokens } : {}),
      };
      break;
    case "plugin": {
      const data = item.data;
      const text = data && typeof data === "object" && !Array.isArray(data) && typeof data.text === "string" ? data.text : safeJson(data);
      out = { ...base, type: "plugin", name: b.str(item.kind, "name", false, 200), text: b.str(text, "text", false, b.b.message) };
      break;
    }
    default:
      return null;
  }
  if (b.cut.size) out.truncatedFields = [...b.cut];
  return out;
}
