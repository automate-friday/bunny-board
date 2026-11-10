// Renders a transcript row from its Paseo timeline item (row.item) the way Paseo's app
// does: tool calls as one-line badges with live status that expand to their details,
// grouped tool runs, reasoning, todos, compaction markers, notices and assistant images.
// Rows without an item (remote agents, older servers) are not handled here: callers keep
// their kind/text rendering for those (see hasItemView).
// Behaviour follows Paseo v0.11.4 components/message.tsx (ToolCall, ExpandableBadge,
// TodoListCard, CompactionMarker, AssistantMarkdownImage) and tool-call-details.tsx,
// rewritten as DOM. The logic comes from ./paseo (see ./paseo/NOTICE.md).

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { TranscriptItem, TranscriptRow } from "../../shared/components/transcript";
import { MessageBody } from "./MessageBody";
import type { ToolCallDetail } from "./paseo/agent-types";
import { diffLineCode, diffLinePrefix } from "./paseo/diff-highlight";
import type { DisplayUnit } from "./paseo/grouping";
import { formatOverviewSummary } from "./paseo/grouping";
import { getCompactionMarkerLabel } from "./paseo/message-compaction-label";
import { formatSubAgentToolName } from "./paseo/sub-agent-log";
import { formatDuration } from "./paseo/time";
import type { DiffLine } from "./paseo/tool-call-parsers";
import { editDiffLines, presentToolCall, subAgentActions, timeMs, toolStatus, toToolCallDetail, truncatedNote } from "./timelineItems";
import { Glyph, type GlyphName, Spinner } from "./toolIcons";
import "./timelineItems.css";
import { variantUrl } from "../../shared/image-variants";
import { phoneGeometryOn } from "./mobile/phoneGeometry";

const ITEM_TYPES = new Set<TranscriptItem["type"]>(["assistant_message", "reasoning", "tool_call", "todo", "error", "notification", "compaction"]);

// True when TimelineItemView draws this row. User messages, board deltas, primers and
// silent acks keep the caller's own rendering.
export function hasItemView(row: TranscriptRow): boolean {
  return !!row.item && ITEM_TYPES.has(row.item.type) && !row.ack && !row.primer;
}

// Keeps pointer and key events inside board UI from reaching the tldraw canvas.
export const stop = (e: React.SyntheticEvent) => e.stopPropagation();

// Re-render every `ms` while `active` (live elapsed times).
export function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}

interface ItemViewContext {
  agentId?: string;
  // The exact-row route is available for this row (history capability).
  exact?: boolean;
  compact?: boolean;
}

export function TimelineItemView({ row, ctx }: { row: TranscriptRow; ctx: ItemViewContext }): ReactNode {
  const item = row.item;
  if (!item || !hasItemView(row)) return null;
  switch (item.type) {
    case "tool_call":
      return <ToolCallView row={row} item={item} ctx={ctx} />;
    case "assistant_message":
      return <AssistantItem row={row} item={item} ctx={ctx} />;
    case "reasoning":
      return <ReasoningView item={item} compact={ctx.compact} />;
    case "todo":
      return <TodoCard item={item} compact={ctx.compact} />;
    case "compaction":
      return <CompactionDivider item={item} />;
    case "notification":
    case "error":
      return <NoticeView item={item} fallback={row.text} />;
    default:
      return null;
  }
}

// --- the expandable one-line badge (Paseo ExpandableBadge) ---------------------------

function Badge({
  icon,
  iconColor,
  label,
  summary,
  meta,
  running,
  open,
  canOpen,
  onToggle,
  testId,
  labelStyle,
}: {
  icon: GlyphName;
  iconColor?: string;
  label: string;
  summary?: string;
  meta?: ReactNode;
  running?: boolean;
  open: boolean;
  canOpen: boolean;
  onToggle: () => void;
  testId?: string;
  labelStyle?: React.CSSProperties;
}) {
  return (
    <button type="button" className="tl-badge" data-testid={testId} aria-expanded={canOpen ? open : undefined} disabled={!canOpen} onPointerDown={stop} onClick={onToggle} title={summary ? `${label} ${summary}` : label}>
      {running ? <Spinner size={12} /> : <Glyph name={icon} color={iconColor} />}
      <span className={`tl-label${running ? " tl-shimmer" : ""}`} style={labelStyle}>{label}</span>
      {summary ? <span className="tl-summary">{summary}</span> : <span style={{ flex: 1 }} />}
      {meta ? <span className="tl-meta">{meta}</span> : null}
      {canOpen ? <Glyph name="chevron" size={12} style={{ color: "light-dark(#94a3b8, var(--bunny-muted))", transform: open ? "rotate(90deg)" : undefined, transition: "transform .12s ease" }} /> : null}
    </button>
  );
}

// --- tool calls ----------------------------------------------------------------------

function ToolCallView({ row, item, ctx }: { row: TranscriptRow; item: TranscriptItem; ctx: ItemViewContext }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState<TranscriptItem | null>(null);
  const shown = full ?? item;
  const status = toolStatus(item);
  const running = status === "running" || status === "executing";
  const now = useNow(running);
  const p = presentToolCall(shown);
  const started = timeMs(row.at);
  const elapsed = running && started !== null ? formatDuration(now - started) : null;
  const failed = status === "failed";
  const canceled = status === "canceled";
  const icon: GlyphName = failed ? "x" : p.icon;
  return (
    <div data-testid="tool-call" data-kind={row.kind} data-status={status} style={{ minWidth: 0 }}>
      <Badge
        icon={icon}
        iconColor={failed ? "#dc2626" : undefined}
        label={p.displayName}
        summary={p.summary}
        running={running}
        meta={elapsed ?? (canceled ? "canceled" : failed ? "failed" : null)}
        labelStyle={canceled ? { color: "light-dark(#94a3b8, var(--bunny-muted))", textDecoration: "line-through" } : failed ? { color: "light-dark(#b91c1c, hsl(0 74% 74%))" } : undefined}
        open={open}
        canOpen={p.canOpenDetails || !!p.errorText}
        onToggle={() => setOpen((o) => !o)}
        testId="tool-call-badge"
      />
      {failed && p.errorText && !open ? (
        <div style={{ margin: "0 0 0 20px", color: "light-dark(#b91c1c, hsl(0 74% 74%))", fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={p.errorText}>
          {p.errorText.split("\n")[0]}
        </div>
      ) : null}
      {open ? (
        <div className="tl-details" data-testid="tool-call-details">
          {p.isLoadingDetails ? <span className="tl-meta">Waiting for details…</span> : null}
          <ToolDetailView detail={toToolCallDetail(shown.detail)} errorText={p.errorText} />
          {!full ? <TruncatedNotice row={row} item={item} ctx={ctx} onLoaded={setFull} /> : <span className="tl-meta">{truncatedNote(full) ? `Full row · still cut to fit: ${truncatedNote(full)} · open in Paseo for the rest` : "Full output · secrets redacted"}</span>}
        </div>
      ) : null}
    </div>
  );
}

// "Show full output": the bounded item named its cut fields; the exact-row route has the rest.
function TruncatedNotice({ row, item, ctx, onLoaded, onText }: { row: TranscriptRow; item: TranscriptItem; ctx: ItemViewContext; onLoaded: (item: TranscriptItem) => void; onText?: (text: string) => void }) {
  const note = truncatedNote(item);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  if (!note) return null;
  const canLoad = !!ctx.agentId && typeof row.id === "string" && ctx.exact !== false;
  const load = async () => {
    if (!ctx.agentId || typeof row.id !== "string" || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/ui/agents/${encodeURIComponent(ctx.agentId)}/timeline/rows/${encodeURIComponent(row.id)}`);
      const body = await res.json().catch(() => ({}));
      if (!alive.current) return;
      if (res.status === 404 || res.status === 409) throw new Error("This row is no longer available. Refresh the log.");
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      const full = body.item as TranscriptItem | undefined;
      if (full && typeof full === "object" && typeof full.type === "string") onLoaded(full);
      else if (typeof body.text === "string") {
        if (onText) onText(body.text);
        else setText(body.text);
      } else throw new Error("The server did not send the full row.");
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return (
    <div data-testid="truncated-notice" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span className="tl-meta">
        Cut to fit: {note}.{" "}
        {canLoad ? (
          <button type="button" className="tl-link" data-testid="show-full-output" disabled={busy} onPointerDown={stop} onClick={() => void load()}>
            {busy ? "Loading…" : "Show full output"}
          </button>
        ) : null}
      </span>
      {error ? <span role="alert" style={{ color: "light-dark(#b91c1c, hsl(0 74% 74%))", fontSize: 11 }}>{error}</span> : null}
      {text !== null ? <pre className="tl-pre">{text}</pre> : null}
    </div>
  );
}

function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
      {title ? <span className="tl-section-title">{title}</span> : null}
      {children}
    </div>
  );
}

function json(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

const meaningful = (v: unknown) => v !== null && v !== undefined && !(typeof v === "string" && !v.trim()) && !(typeof v === "object" && Object.keys(v as object).length === 0);

// A preformatted block, or nothing for empty text.
function Pre({ text, style }: { text: string | undefined; style?: React.CSSProperties }) {
  return text ? <pre className="tl-pre" style={style}>{text}</pre> : null;
}

const link = { color: "light-dark(#2f80ed, hsl(214 84% 74%))", overflowWrap: "anywhere" } as const;

// The body for one detail type (Paseo tool-call-details.tsx buildDetailSections).
function DetailBody({ detail }: { detail: ToolCallDetail }) {
  switch (detail.type) {
    case "shell":
      return (
        <Section>
          <pre className="tl-pre" data-testid="detail-shell">
            <span style={{ color: "light-dark(#94a3b8, var(--bunny-muted))" }}>$ </span>
            {detail.command}
            {detail.output ? `\n\n${detail.output}` : ""}
          </pre>
          {typeof detail.exitCode === "number" ? (
            <span className="tl-chip" style={detail.exitCode !== 0 ? { background: "light-dark(#fef2f2, var(--bunny-surface))", color: "light-dark(#b91c1c, hsl(0 74% 74%))" } : undefined}>
              exit {detail.exitCode}
            </span>
          ) : null}
        </Section>
      );
    case "read":
      return <Section title={detail.offset ? `${detail.filePath} · from line ${detail.offset}` : detail.filePath}><Pre text={detail.content} /></Section>;
    case "edit":
      return <Section title={detail.filePath}><DiffView lines={editDiffLines(detail)} /></Section>;
    case "write":
      return <Section title={detail.filePath}><Pre text={detail.content} /></Section>;
    case "search": {
      const counts = [detail.numFiles !== undefined ? `${detail.numFiles} files` : "", detail.numMatches !== undefined ? `${detail.numMatches} matches` : ""].filter(Boolean).join(" · ");
      return (
        <Section title={counts || undefined}>
          <Pre text={detail.content} />
          <Pre text={detail.filePaths?.join("\n")} />
          {detail.webResults?.length ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12 }}>
              {detail.webResults.map((r) => (
                <a key={r.url} href={r.url} target="_blank" rel="noopener noreferrer" onPointerDown={stop} style={link}>
                  {r.title}
                </a>
              ))}
            </div>
          ) : null}
          <Pre text={detail.annotations?.join("\n")} />
        </Section>
      );
    }
    case "fetch":
      return (
        <Section>
          <a href={detail.url} target="_blank" rel="noopener noreferrer" onPointerDown={stop} style={{ ...link, fontSize: 12 }}>
            {detail.url}
          </a>
          {detail.code !== undefined ? <span className="tl-chip">{detail.code} {detail.codeText ?? ""}</span> : null}
          {detail.prompt ? <div style={{ fontSize: 12, color: "light-dark(#64748b, var(--bunny-muted))" }}>{detail.prompt}</div> : null}
          <Pre text={detail.result} />
        </Section>
      );
    case "worktree_setup":
      return (
        <Section title={[detail.branchName, detail.worktreePath].filter(Boolean).join(" · ")}>
          <Pre text={detail.commands?.map((c) => `${c.status === "failed" ? "✕" : c.status === "running" ? "…" : "✓"} $ ${c.command}`).join("\n")} />
          <Pre text={detail.log} />
        </Section>
      );
    case "sub_agent": {
      const { actions, log } = subAgentActions(detail);
      return (
        <Section title={[detail.subAgentType, detail.description].filter(Boolean).join(" · ") || undefined}>
          {actions.length ? (
            <div data-testid="detail-sub-agent-actions" style={{ display: "flex", flexDirection: "column", gap: 1, fontSize: 12 }}>
              {actions.map((a) => (
                <div key={`${a.index}:${a.toolName}`} style={{ display: "flex", gap: 6, minWidth: 0 }}>
                  <span style={{ color: "light-dark(#334155, hsl(215 50% 74%))", fontWeight: 550, flex: "none" }}>{formatSubAgentToolName(a.toolName)}</span>
                  {a.summary ? <span style={{ color: "light-dark(#64748b, var(--bunny-muted))", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "ui-monospace, monospace", fontSize: 11 }}>{a.summary}</span> : null}
                </div>
              ))}
            </div>
          ) : null}
          <Pre text={log} />
        </Section>
      );
    }
    case "plan":
      return (
        <Section>
          <div style={{ fontSize: 12.5 }}>
            <MessageBody text={detail.text} />
          </div>
        </Section>
      );
    case "plain_text":
      return <Pre text={detail.text} />;
    case "unknown":
      return (
        <>
          {meaningful(detail.input) ? <Section title="Input"><Pre text={json(detail.input)} /></Section> : null}
          {meaningful(detail.output) ? <Section title="Output"><Pre text={json(detail.output)} /></Section> : null}
        </>
      );
    default:
      return null;
  }
}

// One tool call's details and its error. Shared with the permission cards.
export function ToolDetailView({ detail, errorText }: { detail: ToolCallDetail | undefined; errorText?: string }) {
  return (
    <>
      {detail ? <DetailBody detail={detail} /> : null}
      {errorText ? <Section title="Error"><Pre text={errorText} style={{ background: "light-dark(#fef2f2, var(--bunny-surface))", color: "light-dark(#991b1b, hsl(0 70% 74%))" }} /></Section> : null}
    </>
  );
}

function DiffView({ lines }: { lines: DiffLine[] }) {
  if (!lines.length) return <span className="tl-meta">No changes shown.</span>;
  return (
    <div className="tl-diff" data-testid="detail-diff">
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no identity.
        <div key={i} className="tl-diff-line" data-type={line.type}>
          {line.type === "header" ? (
            line.content
          ) : (
            <>
              <span className="tl-diff-mark">{diffLinePrefix(line)}</span>
              <span style={{ minWidth: 0 }}>{line.segments ? line.segments.map((s, j) => (s.changed ? <mark key={j}>{s.text}</mark> : s.text)) : diffLineCode(line)}</span>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

// --- grouped tool runs ("Edited 3 files, ran 2 commands") ---------------------------

export function ToolGroupView<R extends TranscriptRow>({ unit, renderRow }: { unit: Extract<DisplayUnit<R>, { kind: "group" }>; renderRow: (row: R) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const label = formatOverviewSummary(unit.group.summary) || `${unit.hidden.length} tool calls`;
  const failed = unit.hidden.filter((r) => r.item?.status === "failed").length;
  return (
    <div data-testid="tool-call-group" style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
      <Badge icon="wrench" label={label} meta={failed ? `${failed} failed` : `${unit.hidden.length} calls`} open={open} canOpen onToggle={() => setOpen((o) => !o)} running={unit.group.isLoading} testId="tool-call-group-badge" />
      {open ? (
        <div data-testid="tool-call-group-calls" style={{ display: "flex", flexDirection: "column", gap: 2, margin: "0 0 0 14px", paddingLeft: 6, borderLeft: "2px solid light-dark(#f1f5f9, var(--bunny-line))" }}>
          {unit.hidden.map((r) => (
            <div key={r.item?.key ?? r.id ?? r.at}>{renderRow(r)}</div>
          ))}
        </div>
      ) : null}
      {unit.visible.map((r) => (
        <div key={r.item?.key ?? r.id ?? r.at}>{renderRow(r)}</div>
      ))}
    </div>
  );
}

// --- assistant messages with images --------------------------------------------------

function AssistantItem({ row, item, ctx }: { row: TranscriptRow; item: TranscriptItem; ctx: ItemViewContext }) {
  const [fullText, setFullText] = useState<string | null>(null);
  const text = fullText ?? item.text ?? row.text;
  return (
    <div data-kind={row.kind} data-testid="assistant-item" style={{ overflowWrap: "anywhere", lineHeight: 1.5, minWidth: 0 }}>
      {/* The images render below; drop their markdown so it does not show as "!Image". */}
      <MessageBody text={item.images?.length ? text.replace(/!\[[^\]]*\]\([^)]*\)/g, "").trim() : text} compact={ctx.compact} />
      {item.images?.length ? <MessageImages images={item.images} /> : null}
      {fullText === null ? <TruncatedNotice row={row} item={item} ctx={ctx} onLoaded={(full) => setFullText(full.text ?? "")} onText={setFullText} /> : null}
    </div>
  );
}

function MessageImages({ images }: { images: { src: string; alt: string }[] }) {
  return (
    <div className="tl-images" data-testid="message-images">
      {images.map((img, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the same image may appear twice.
        <MessageImage key={`${img.src}:${i}`} src={img.src} alt={img.alt} />
      ))}
    </div>
  );
}

function MessageImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  const safe = /^(https?:|data:image\/|\/)/i.test(src);
  if (!safe || failed)
    return (
      <span className="tl-chip" data-testid="message-image-failed" title={src} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        <Glyph name="image" size={12} /> {alt || "image"} unavailable
      </span>
    );
  return (
    <a href={src} target="_blank" rel="noopener noreferrer" onPointerDown={stop} title={alt || "Open full size"}>
      {/* Phone: a downscaled copy (full-size screenshots are ~15 MB decoded each); the link keeps the original. */}
      <img src={phoneGeometryOn() ? variantUrl(src, 1024, 0) : src} alt={alt} loading="lazy" decoding="async" onError={() => setFailed(true)} />
    </a>
  );
}

// --- reasoning, todos, compaction, notices ------------------------------------------

function ReasoningView({ item, compact }: { item: TranscriptItem; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const text = item.text ?? "";
  const first = text.replace(/\s+/g, " ").trim();
  return (
    <div data-testid="reasoning" style={{ minWidth: 0 }}>
      <Badge icon="brain" label="Thinking" summary={open ? undefined : first.slice(0, 160)} open={open} canOpen={!!text.trim()} onToggle={() => setOpen((o) => !o)} />
      {open ? (
        <div className="tl-details" style={{ color: "light-dark(#64748b, var(--bunny-muted))", fontSize: compact ? 11.5 : 12.5 }}>
          <MessageBody text={text} compact={compact} />
        </div>
      ) : null}
    </div>
  );
}

function TodoCard({ item, compact }: { item: TranscriptItem; compact?: boolean }) {
  const todos = item.todos ?? [];
  const done = todos.filter((t) => t.completed || t.status === "completed").length;
  const active = todos.find((t) => t.status === "in_progress");
  const [open, setOpen] = useState(!compact);
  return (
    <div data-testid="todo-card" style={{ minWidth: 0 }}>
      <Badge icon="list" label="Tasks" summary={active ? active.activeForm || active.text : undefined} meta={`${done}/${todos.length}`} open={open} canOpen={todos.length > 0} onToggle={() => setOpen((o) => !o)} />
      {open ? (
        <div className="tl-todo" style={{ marginTop: 2 }}>
          {todos.map((t, i) => {
            const status = t.status ?? (t.completed ? "completed" : "pending");
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: todo entries have no id.
              <div key={i} className="tl-todo-row" data-status={status}>
                <span aria-hidden style={{ flex: "none", width: 14, textAlign: "center", color: status === "completed" ? "light-dark(#16a34a, hsl(142 76% 74%))" : status === "in_progress" ? "light-dark(#2f80ed, hsl(214 84% 74%))" : "light-dark(#94a3b8, var(--bunny-muted))" }}>
                  {status === "completed" ? "☑" : status === "in_progress" ? "◐" : "☐"}
                </span>
                <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{status === "in_progress" && t.activeForm ? t.activeForm : t.text}</span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function CompactionDivider({ item }: { item: TranscriptItem }) {
  const loading = item.status === "loading" || item.status === "running";
  const label = getCompactionMarkerLabel({ status: loading ? "loading" : "completed", trigger: item.trigger, preTokens: item.preTokens });
  return (
    <div className="tl-divider" data-testid="compaction" role="separator">
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
        {loading ? <Spinner size={10} color="light-dark(#94a3b8, var(--bunny-muted))" /> : <Glyph name="scissors" size={12} />}
        {label}
      </span>
    </div>
  );
}

const LEVEL: Record<string, { color: string; icon: GlyphName }> = {
  info: { color: "light-dark(#475569, var(--bunny-muted))", icon: "info" },
  warning: { color: "light-dark(#b45309, hsl(26 88% 74%))", icon: "alert" },
  error: { color: "light-dark(#b91c1c, hsl(0 74% 74%))", icon: "x" },
};

function NoticeView({ item, fallback }: { item: TranscriptItem; fallback: string }) {
  const level = item.type === "error" ? "error" : (item.level ?? "info");
  const style = LEVEL[level] ?? LEVEL.info;
  const text = item.text ?? item.error ?? fallback;
  return (
    <div data-testid={item.type === "error" ? "timeline-error" : "notification"} data-level={level} role={level === "error" ? "alert" : undefined} style={{ display: "flex", gap: 6, alignItems: "flex-start", color: style.color, fontSize: 12, minWidth: 0 }}>
      <Glyph name={style.icon} size={13} style={{ marginTop: 2 }} />
      <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", minWidth: 0 }}>{text}</span>
    </div>
  );
}
